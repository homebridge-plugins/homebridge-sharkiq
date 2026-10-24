import { describe, expect, it, vi } from 'vitest'

// The three collaborators login() reaches for. Replaced whole, so no network
// call or token file is involved.
const { aylaDevices, skegoxDevices, skegoxValues } = vi.hoisted(() => ({
  aylaDevices: { current: [] as any[] },
  skegoxDevices: { current: [] as any[] },
  skegoxValues: { current: {} as Record<string, unknown> },
}))

vi.mock('./login.js', () => ({
  Login: class {
    async checkLogin() {}
  },
}))

vi.mock('./sharkiq-js/ayla_api.js', () => ({
  get_ayla_api: () => ({
    sign_in: async () => {},
    get_devices: async () => aylaDevices.current,
  }),
}))

vi.mock('./sharkiq-js/skegox_api.js', () => ({
  SkegoxApi: class {
    async init() {
      return skegoxDevices.current.length
    }

    listDevices() {
      return skegoxDevices.current
    }

    available(dsn: string) {
      return skegoxDevices.current.some(d => d.dsn === String(dsn).toUpperCase())
    }

    async getPropertyValues() {
      return skegoxValues.current
    }
  },
}))

const { SharkIQPlatform } = await import('./platform.js')

function makePlatform(config: Record<string, unknown> = {}) {
  const log: any = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  }
  const api: any = {
    on: vi.fn(),
    hap: {
      Service: {},
      Characteristic: {},
      uuid: {
        generate: (s: string) => `uuid-${s}`,
      },
    },
    user: {
      storagePath: () => '/tmp',
    },
  }
  return {
    platform: new SharkIQPlatform(log, { platform: 'SharkIQ', ...config } as any, api),
    log,
  }
}

describe('login', () => {
  it('falls back to the newer API when the Ayla account lists no vacuums', async () => {
    aylaDevices.current = []
    skegoxDevices.current = [
      {
        dsn: 'AC000W123456789',
        deviceId: 'SND1',
        name: 'Shark',
        model: 'RV761',
        connected: true,
      },
    ]
    skegoxValues.current = { Operating_Mode: 2 }

    const { platform } = makePlatform()

    const devices = await platform.login()

    expect(devices).toHaveLength(1)
    expect(devices[0]._dsn).toBe('AC000W123456789')
  })

  it('leaves the Ayla list alone when it does have vacuums', async () => {
    // The fallback must not double up an account that works today
    aylaDevices.current = [
      { _dsn: 'AYLA1', roomCleanOptions: {} },
    ]
    skegoxDevices.current = [
      {
        dsn: 'AYLA1',
        deviceId: 'SND1',
        name: 'Shark',
        model: 'RV761',
        connected: true,
      },
    ]
    skegoxValues.current = { Operating_Mode: 2 }

    const { platform } = makePlatform()

    const devices = await platform.login()

    expect(devices).toHaveLength(1)
    expect(devices[0]._dsn).toBe('AYLA1')
  })
})
