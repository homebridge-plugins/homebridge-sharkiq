import { afterEach, describe, expect, it, vi } from 'vitest'

import { AylaApi } from './ayla_api.js'

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
} as any

// A SharkNinja account holds every appliance of the brand, so the device list
// can carry a Ninja grill next to a Shark vacuum (#85)
const WOODFIRE = {
  dsn: 'AC000W033162165',
  key: 1,
  oem_model: 'woodfire',
  product_name: 'Woodfire ',
}
const VACUUM = {
  dsn: 'AC000W012345678',
  key: 2,
  oem_model: 'shark_iq',
  product_name: 'Shark IQ Robot',
}

function apiWithDevices(devices: any[], propertiesByDsn: Record<string, any>): AylaApi {
  const api = new AylaApi('/tmp/sharkiq-test-auth.json', 'app-id', 'app-secret', log, false)
  vi.spyOn(api, 'list_devices').mockResolvedValue(devices as any)
  // Stand in for the per-device property fetch each vacuum does on startup
  vi.spyOn(api as any, 'makeRequest').mockImplementation((async (..._args: unknown[]) => {
    const url = String(_args[1] ?? '')
    return {
      ok: true,
      status: 200,
      response: JSON.stringify(propertiesByDsn[Object.keys(propertiesByDsn).find(dsn => url.includes(dsn)) ?? ''] ?? []),
    }
  }) as any)
  vi.spyOn(api as any, 'auth_header').mockResolvedValue({ Authorization: 'auth' })
  return api
}

function props(names: string[]): any[] {
  return names.map(name => ({
    property: {
      name,
      value: 1,
      key: 1,
      base_type: 'integer',
    },
  }))
}

describe('aylaApi.get_devices', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('keeps devices that report Operating_Mode', async () => {
    const api = apiWithDevices([VACUUM], {
      [VACUUM.dsn]: props(['Operating_Mode', 'Docked_Status', 'Battery_Capacity']),
    })
    const devices = await api.get_devices()
    expect(devices).toHaveLength(1)
    expect(devices[0].serial_number).toBe(VACUUM.dsn)
  })

  it('drops a non-vacuum appliance such as a Ninja Woodfire grill (#85)', async () => {
    const api = apiWithDevices([WOODFIRE], {
      [WOODFIRE.dsn]: props(['Cook_Mode', 'Probe_Temperature']),
    })
    const devices = await api.get_devices()
    expect(devices).toHaveLength(0)
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('is not a vacuum'))
  })

  it('keeps the vacuum and drops the grill when an account holds both', async () => {
    const api = apiWithDevices([WOODFIRE, VACUUM], {
      [WOODFIRE.dsn]: props(['Cook_Mode']),
      [VACUUM.dsn]: props(['Operating_Mode']),
    })
    const devices = await api.get_devices()
    expect(devices.map(device => device.serial_number)).toEqual([VACUUM.dsn])
  })

  it('does not filter when the caller skips the property update', async () => {
    const api = apiWithDevices([WOODFIRE, VACUUM], {})
    const devices = await api.get_devices(false)
    expect(devices).toHaveLength(2)
  })
})
