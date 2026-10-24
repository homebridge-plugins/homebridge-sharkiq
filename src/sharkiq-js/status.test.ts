import { RvcOperationalState } from '@matter/types/clusters/rvc-operational-state'
import { describe, expect, it } from 'vitest'

import { ERROR_MESSAGES, OperatingModes } from './properties.js'
import {
  MATTER_ERROR_STATE,
  matterOperationalError,
  PAUSED_OPERATING_MODE,
  readFlag,
  readVacuumFault,
  readWaterTank,
} from './sharkiq.js'

/**
 * Water tank, error codes and the mop plate (#88). The vacuum reports all of
 * these and none of them reached HomeKit on either protocol.
 */

describe('readFlag', () => {
  it('accepts every shape this api reports a flag in', () => {
    for (const truthy of [true, 1, '1', 'true', 'True']) {
      expect(readFlag(truthy)).toBe(true)
    }
    for (const falsy of [false, 0, '0', 'false']) {
      expect(readFlag(falsy)).toBe(false)
    }
  })

  // "Not reported" and "reported as off" must stay distinguishable, so a vacuum
  // that has no mop plate sensor does not get a sensor stuck at off.
  it('returns undefined when the vacuum has not reported the property', () => {
    expect(readFlag(undefined)).toBeUndefined()
    expect(readFlag(null)).toBeUndefined()
    expect(readFlag('')).toBeUndefined()
  })
})

describe('readVacuumFault', () => {
  it('reports no fault for code 0, or no code at all', () => {
    expect(readVacuumFault(0)).toBeUndefined()
    expect(readVacuumFault('0')).toBeUndefined()
    expect(readVacuumFault(undefined)).toBeUndefined()
    expect(readVacuumFault(null)).toBeUndefined()
  })

  it('uses the vacuum\'s own wording for a code it knows', () => {
    const fault = readVacuumFault(4)
    expect(fault?.code).toBe(4)
    expect(fault?.message).toBe(ERROR_MESSAGES[4])
    expect(fault?.matterErrorStateId).toBe(MATTER_ERROR_STATE.brushJammed)
  })

  // An unrecognised fault is still a fault. Swallowing it would leave the vacuum
  // looking healthy while stuck under the sofa.
  it('still reports an unknown code, with the number in the message', () => {
    const fault = readVacuumFault(99, 12)
    expect(fault?.code).toBe(99)
    expect(fault?.extendedCode).toBe(12)
    expect(fault?.message).toContain('99')
    expect(fault?.message).toContain('12')
    expect(fault?.matterErrorStateId).toBe(MATTER_ERROR_STATE.unableToCompleteOperation)
  })

  it('omits an extended code of zero rather than reporting it', () => {
    expect(readVacuumFault(4, 0)?.extendedCode).toBeUndefined()
  })

  it('maps every known error code to a matter error state', () => {
    for (const code of Object.keys(ERROR_MESSAGES).map(Number)) {
      const fault = readVacuumFault(code)
      expect(fault?.matterErrorStateId).toBeDefined()
    }
  })
})

describe('readWaterTank', () => {
  // The vacuum runs perfectly well with no tank when it is not mopping, so a
  // missing tank must never count as needing a refill.
  it('only needs a refill when a tank is installed and empty', () => {
    expect(readWaterTank(true, true).needsRefill).toBe(true)
    expect(readWaterTank(true, false).needsRefill).toBe(false)
    expect(readWaterTank(false, true).needsRefill).toBe(false)
    expect(readWaterTank(undefined, undefined).needsRefill).toBe(false)
  })

  it('keeps both flags undefined when the vacuum does not report them', () => {
    const tank = readWaterTank(undefined, undefined)
    expect(tank.installed).toBeUndefined()
    expect(tank.empty).toBeUndefined()
  })
})

describe('matterOperationalError', () => {
  const noTank = readWaterTank(undefined, undefined)
  const emptyTank = readWaterTank(true, true)

  it('uses the real matter error state numbers, not hand-written ones', () => {
    expect(MATTER_ERROR_STATE.noError).toBe(RvcOperationalState.ErrorState.NoError)
    expect(MATTER_ERROR_STATE.unableToStartOrResume).toBe(RvcOperationalState.ErrorState.UnableToStartOrResume)
    expect(MATTER_ERROR_STATE.unableToCompleteOperation).toBe(RvcOperationalState.ErrorState.UnableToCompleteOperation)
    expect(MATTER_ERROR_STATE.stuck).toBe(RvcOperationalState.ErrorState.Stuck)
    expect(MATTER_ERROR_STATE.dustBinMissing).toBe(RvcOperationalState.ErrorState.DustBinMissing)
    expect(MATTER_ERROR_STATE.waterTankEmpty).toBe(RvcOperationalState.ErrorState.WaterTankEmpty)
    expect(MATTER_ERROR_STATE.lowBattery).toBe(RvcOperationalState.ErrorState.LowBattery)
    expect(MATTER_ERROR_STATE.wheelsJammed).toBe(RvcOperationalState.ErrorState.WheelsJammed)
    expect(MATTER_ERROR_STATE.brushJammed).toBe(RvcOperationalState.ErrorState.BrushJammed)
    expect(MATTER_ERROR_STATE.navigationSensorObscured).toBe(RvcOperationalState.ErrorState.NavigationSensorObscured)
  })

  it('reports no error when nothing is wrong', () => {
    expect(matterOperationalError(undefined, noTank, false).errorStateId).toBe(MATTER_ERROR_STATE.noError)
    expect(matterOperationalError(undefined, noTank, true).errorStateId).toBe(MATTER_ERROR_STATE.noError)
  })

  it('carries the vacuum\'s own wording as the details', () => {
    const error = matterOperationalError(readVacuumFault(9), noTank, true)
    expect(error.errorStateId).toBe(MATTER_ERROR_STATE.dustBinMissing)
    expect(error.errorStateDetails).toBe(ERROR_MESSAGES[9])
  })

  /**
   * ⚠️ The spec only permits `errorStateLabel` on manufacturer-specific IDs
   * (0x80-0xBF). Setting it on the standard IDs used here is a conformance
   * error that rolls back the whole registration — the same trap that took the
   * accessory offline in #83.
   */
  it('never sets errorStateLabel, which is only legal on manufacturer ids', () => {
    for (const fault of [
      undefined,
      readVacuumFault(4),
      readVacuumFault(99),
    ]) {
      const error = matterOperationalError(fault, emptyTank, true)
      expect(error).not.toHaveProperty('errorStateLabel')
      expect(error.errorStateId).toBeLessThan(0x80)
    }
  })

  /**
   * ⚠️ Setting operationalError forces the device into the Error state in
   * matter.js. An empty tank on a docked vacuum would therefore show every
   * mop-less user a permanent error, so it only counts while running.
   */
  it('only reports an empty water tank while the vacuum is running', () => {
    expect(matterOperationalError(undefined, emptyTank, false).errorStateId).toBe(MATTER_ERROR_STATE.noError)
    expect(matterOperationalError(undefined, emptyTank, true).errorStateId).toBe(MATTER_ERROR_STATE.waterTankEmpty)
  })

  it('prefers a real fault over an empty water tank', () => {
    const error = matterOperationalError(readVacuumFault(4), emptyTank, true)
    expect(error.errorStateId).toBe(MATTER_ERROR_STATE.brushJammed)
  })
})

/**
 * Pause (#88). Home showed "Paused" while the vacuum carried on cleaning,
 * because the Matter handler wrote a mode this vacuum does not use.
 */
describe('pAUSED_OPERATING_MODE', () => {
  it('is STOP, which is what a paused vacuum actually reports', () => {
    expect(PAUSED_OPERATING_MODE).toBe(OperatingModes.STOP)
  })

  // ⚠️ The trap: `OperatingModes.PAUSE` reads like the right constant and is
  // not. Writing it does nothing, and testing for it never matches, so pause
  // and resume both silently failed over Matter while HAP worked fine.
  it('is NOT OperatingModes.PAUSE, despite the name', () => {
    expect(PAUSED_OPERATING_MODE).not.toBe(OperatingModes.PAUSE)
  })
})
