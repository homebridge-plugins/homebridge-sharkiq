import { Buffer } from 'node:buffer'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SkegoxApi } from './skegox_api.js'

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any

function fakeJwt(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url')
  return `header.${payload}.signature`
}

function writeAuth0File(dir: string, msUntilExpiry = 3600 * 1000): string {
  const file = join(dir, '.sharkiq_auth0.json')
  writeFileSync(file, JSON.stringify({
    id_token: fakeJwt('auth0|user123'),
    refresh_token: 'refresh-1',
    expiration: new Date(Date.now() + msUntilExpiry),
  }))
  return file
}

// A fetch stub that answers the discovery, command and token-refresh routes
function stubFetch(overrides: { failFirstPatch?: boolean } = {}): ReturnType<typeof vi.fn> {
  let patchCount = 0
  const mock = vi.fn(async (url: string, options: any = {}) => {
    const ok = (data: unknown) => ({
      ok: true,
      status: 200,
      json: async () => data,
      text: async () => '',
    })
    if (url.includes('/oauth/token')) {
      return ok({
        id_token: fakeJwt('auth0|user123'),
        refresh_token: 'refresh-2',
        expires_in: 3600,
      })
    }
    if (url.includes('/householdsEndUser')) {
      return ok({
        households: ['HH1'],
      })
    }
    if (url.includes('/users/user123')) {
      return ok({
        items: [
          { deviceId: 'SND1' },
        ],
      })
    }
    if (url.includes('/devices/SND1') && options.method === 'GET') {
      return ok({
        registry: { Battery_Serial_Num: 'DSN123-SND1' },
        telemetry: { Battery_Capacity: 88 },
        shadow: {
          properties: {
            reported: {
              Operating_Mode: { value: 2 },
              DockedStatus: 0,
            },
          },
        },
        connectivityStatus: { connected: true },
      })
    }
    if (options.method === 'PATCH') {
      patchCount += 1
      if (overrides.failFirstPatch && patchCount === 1) {
        return {
          ok: false,
          status: 401,
          json: async () => ({}),
          text: async () => 'expired',
        }
      }
      return ok({})
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => 'not found',
    }
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

describe('skegoxApi', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skegox-test-'))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('discovers the household and maps vacuums by their Ayla DSN', async () => {
    stubFetch()
    const api = new SkegoxApi(log, writeAuth0File(dir))
    await expect(api.init()).resolves.toBe(1)
    expect(api.available('DSN123')).toBe(true)
    expect(api.available(' dsn123 ')).toBe(true)
    expect(api.available('OTHER')).toBe(false)
  })

  it('names a vacuum the registry has no name for, rather than calling it "unnamed"', async () => {
    // One24th's RV761 (#91) came back with no Product_Name, no name and no
    // Model_Number. Since these vacuums are now what the accessory is built
    // from, "unnamed" would have become its name in HomeKit for good.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const ok = (data: unknown) => ({
        ok: true,
        status: 200,
        json: async () => data,
        text: async () => '',
      })
      if (url.includes('/householdsEndUser')) {
        return ok({
          households: ['HH1'],
        })
      }
      if (url.includes('/users/user123')) {
        return ok({
          items: [
            { deviceId: 'SND00000ABCD' },
          ],
        })
      }
      if (url.includes('/devices/SND00000ABCD')) {
        return ok({
          registry: { Battery_Serial_Num: 'DSN123-SND00000ABCD' },
          connectivityStatus: { connected: true },
        })
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => 'not found',
      }
    }))

    const api = new SkegoxApi(log, writeAuth0File(dir))
    await api.init()

    const [device] = api.listDevices()
    expect(device.name).not.toBe('unnamed')
    expect(device.name).toBe('Shark ABCD')
  })

  it('sends commands as a desired-state shadow patch', async () => {
    const fetchMock = stubFetch()
    const api = new SkegoxApi(log, writeAuth0File(dir))
    await api.init()
    await api.setProperty('dsn123', 'Operating_Mode', 2)

    const patch = fetchMock.mock.calls.find(([, options]) => options?.method === 'PATCH')
    expect(patch).toBeDefined()
    expect(patch![0]).toContain('/devicesEndUserController/HH1/devices/SND1')
    expect(JSON.parse(patch![1].body)).toEqual({
      shadow: {
        properties: {
          desired: { Operating_Mode: 2 },
        },
      },
    })
  })

  it('refreshes an expired token first and stores the rotated refresh token', async () => {
    const fetchMock = stubFetch()
    const file = writeAuth0File(dir, -1000)
    const api = new SkegoxApi(log, file)
    await api.init()

    expect(fetchMock.mock.calls[0][0]).toContain('/oauth/token')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved.refresh_token).toBe('refresh-2')
  })

  it('retries a command once with a fresh token after a 401', async () => {
    const fetchMock = stubFetch({ failFirstPatch: true })
    const api = new SkegoxApi(log, writeAuth0File(dir))
    await api.init()
    await api.setProperty('DSN123', 'Operating_Mode', 2)

    const patches = fetchMock.mock.calls.filter(([, options]) => options?.method === 'PATCH')
    expect(patches).toHaveLength(2)
    const refreshes = fetchMock.mock.calls.filter(([url]) => url.includes('/oauth/token'))
    expect(refreshes).toHaveLength(1)
  })

  it('rejects init when no token set is stored', async () => {
    stubFetch()
    const api = new SkegoxApi(log, join(dir, 'missing.json'))
    await expect(api.init()).rejects.toThrow()
  })

  it('rejects a command for an unmapped vacuum', async () => {
    stubFetch()
    const api = new SkegoxApi(log, writeAuth0File(dir))
    await api.init()
    await expect(api.setProperty('UNKNOWN', 'Operating_Mode', 2)).rejects.toThrow('not mapped')
  })

  it('reads live state keyed by clean property names', async () => {
    stubFetch()
    const api = new SkegoxApi(log, writeAuth0File(dir))
    await api.init()
    const values = await api.getPropertyValues('DSN123')
    expect(values.Battery_Capacity).toBe(88)
    expect(values.Operating_Mode).toBe(2)
    expect(values.DockedStatus).toBe(0)
  })

  it('describes the shadow state for a mapped vacuum', async () => {
    stubFetch()
    const api = new SkegoxApi(log, writeAuth0File(dir))
    await api.init()
    const state = await api.describeState('DSN123')
    expect(state).toContain('desired Operating_Mode=')
    expect(state).toContain('connected=')
  })
})
