import { describe, expect, it, vi } from 'vitest'

import { SharkIQPlatform } from './platform.js'

function makeLog(): any {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  }
}

function makeApi(): any {
  return {
    // didFinishLaunching and shutdown are never fired here, so the platform is
    // built without starting any discovery
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
}

// Only the three calls the adoption path makes on the newer API
function makeSkegox(devices: Array<{ dsn: string, name: string, model: string }>, values: Record<string, unknown>): any {
  const known = new Set(devices.map(d => d.dsn))
  return {
    listDevices: () => devices.map(d => ({ ...d, deviceId: `SND-${d.dsn}`, connected: true })),
    available: (dsn: string) => known.has(String(dsn).toUpperCase()),
    getPropertyValues: async () => values,
  }
}

// Anything reaching the Ayla API is a failure of the point of this feature, so
// its stub throws rather than answering
const aylaThatMustNotBeUsed: any = {
  auth_header: () => {
    throw new Error('the Ayla API must not be called for a new-API-only vacuum')
  },
  makeRequest: () => {
    throw new Error('the Ayla API must not be called for a new-API-only vacuum')
  },
}

function makePlatform() {
  const log = makeLog()
  const platform: any = new SharkIQPlatform(log, { platform: 'SharkIQ' } as any, makeApi())
  return { platform, log }
}

describe('vacuums that only exist on the newer SharkNinja API', () => {
  it('builds an accessory for a vacuum the Ayla account no longer lists', async () => {
    const { platform, log } = makePlatform()
    const skegox = makeSkegox(
      [
        { dsn: 'AC000W123456789', name: 'Shark', model: 'RV761' },
      ],
      { Operating_Mode: 2, Device_Serial_Num: 'RV761 S12345', Robot_Firmware_Version: '1.2.3' },
    )

    const adopted = await platform.adoptNewApiVacuums(aylaThatMustNotBeUsed, skegox, false)

    expect(adopted).toHaveLength(1)
    expect(adopted[0]._dsn).toBe('AC000W123456789')
    expect(adopted[0].name).toBe('Shark')
    expect(adopted[0].newApiOnly).toBe(true)
    expect(adopted[0].get_property_value('Operating_Mode')).toBe(2)
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('taken from the newer one instead'))
  })

  it('takes the model number from the registry when the properties do not carry one', async () => {
    const { platform } = makePlatform()
    const skegox = makeSkegox(
      [
        { dsn: 'AC000W123456789', name: 'Shark', model: 'RV761RO1US' },
      ],
      { Operating_Mode: 0 },
    )

    const adopted = await platform.adoptNewApiVacuums(aylaThatMustNotBeUsed, skegox, false)

    expect(adopted[0]._vac_model_number).toBe('RV761RO1US')
  })

  it('ignores an appliance on the account that is not a vacuum', async () => {
    const { platform, log } = makePlatform()
    // A Ninja grill has no operating mode, which is what every vacuum control
    // in this plugin reads and writes (#85)
    const skegox = makeSkegox(
      [
        { dsn: 'AC000W999999999', name: 'Woodfire Grill', model: 'OG701' },
      ],
      { Battery_Capacity: 100 },
    )

    const adopted = await platform.adoptNewApiVacuums(aylaThatMustNotBeUsed, skegox, false)

    expect(adopted).toHaveLength(0)
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('is not a vacuum'))
  })

  it('keeps polling through the newer API instead of the Ayla one', async () => {
    const { platform } = makePlatform()
    const skegox = makeSkegox(
      [
        { dsn: 'AC000W123456789', name: 'Shark', model: 'RV761' },
      ],
      { Operating_Mode: 2 },
    )
    const [vacuum] = await platform.adoptNewApiVacuums(aylaThatMustNotBeUsed, skegox, false)

    // A partial read, which is what the accessory polls with. The Ayla stub
    // throws, so anything but a clean 0 means the read went to the wrong API.
    await expect(vacuum.update(['Operating_Mode'])).resolves.toBe(0)
    // And a full one, which used to be the only path to the Ayla API
    await expect(vacuum.update([])).resolves.toBe(0)
  })
})
