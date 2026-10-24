import type { PlatformConfig } from 'homebridge'

import type { SharkIQPluginConfig } from './settings.js'

import { DEFAULT_CONFIG } from './settings.js'

// Add seconds to a date
function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000)
}

// Subtract seconds from a date
function subtractSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() - seconds * 1000)
}

function isValidDate(d: Date): boolean {
  return d instanceof Date && !Number.isNaN(d.getTime())
}

// Safely parse JSON with better error handling
function safeJsonParse(jsonString: string): { success: boolean, data?: any, error?: string } {
  try {
    // Check if input is a string
    if (typeof jsonString !== 'string') {
      return { success: false, error: 'Input is not a string' }
    }

    // Check if string is empty
    if (!jsonString.trim()) {
      return { success: false, error: 'Input is empty' }
    }

    // Check if string looks like HTML (common error response)
    if (jsonString.trim().startsWith('<')) {
      return { success: false, error: 'Input appears to be HTML, not JSON' }
    }

    const parsed = JSON.parse(jsonString)
    return { success: true, data: parsed }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error
        ? error.message
        : 'Unknown parsing error',
    }
  }
}

/**
 * Factory function that creates a proxy constructor which selects between the
 * HAP platform and the Matter platform at runtime.
 *
 * Selection logic:
 * 1. If `enableMatter` and `preferMatter` are set in config AND the Homebridge
 *    API reports that Matter is both available and enabled, the Matter platform
 *    is instantiated.
 * 2. Otherwise the HAP platform is instantiated as a fallback.
 *
 * {@link DEFAULT_CONFIG} is merged with the user config to apply defaults for
 * `preferMatter` and `enableMatter` before the platform is selected.
 *
 * @param HAPPlatform  - The existing HAP (HomeKit Accessory Protocol) platform class.
 * @param MatterPlatform - The Matter platform class to use when Matter is available.
 * @returns A constructor that Homebridge can register with `api.registerPlatform`.
 */
function createPlatformProxy(HAPPlatform: any, MatterPlatform: any): any {
  return class SharkIQPlatformProxy {
    constructor(log: any, config: PlatformConfig, api: any) {
      const cfg: SharkIQPluginConfig & PlatformConfig = {
        ...DEFAULT_CONFIG,
        ...config,
      }
      const preferMatter = cfg.preferMatter ?? true
      const enableMatter = cfg.enableMatter ?? true
      const matterAvailable = !!(api?.isMatterAvailable?.() && api?.isMatterEnabled?.())

      if (enableMatter && preferMatter && MatterPlatform && matterAvailable) {
        return new MatterPlatform(log, cfg, api)
      }

      return new HAPPlatform(log, cfg, api)
    }
  }
}

export { addSeconds, createPlatformProxy, isValidDate, safeJsonParse, subtractSeconds }

/**
 * The largest delay a Node timer can hold, because it is stored in a signed
 * 32-bit integer. Roughly 24.85 days.
 */
export const MAX_TIMER_MS = 2147483647

/**
 * Keep a computed delay inside the range a Node timer can represent.
 *
 * Going over the limit does not throw. Node prints a TimeoutOverflowWarning and
 * quietly sets the delay to 1 ms, so a timer meant to fire in weeks fires a
 * thousand times a second instead - which for a polling loop means hammering
 * the service it polls.
 *
 * Clamping means a delay longer than 24.85 days simply fires at 24.85 days,
 * which for every setting here is early rather than wrong.
 */
export function safeTimerMs(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) {
    return 1
  }
  return Math.min(Math.floor(ms), MAX_TIMER_MS)
}
