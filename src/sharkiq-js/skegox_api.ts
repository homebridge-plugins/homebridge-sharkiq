import type { Logger } from 'homebridge'

import type { Auth0Data } from '../type'

import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'

import { getAuth0Data, setAuth0Data } from '../config.js'
import { global_vars } from './const.js'

// One vacuum as the newer SharkNinja API describes it
export interface SkegoxDevice {
  /** The Ayla DSN, read from the battery serial number */
  dsn: string
  /** This API's own id for the device */
  deviceId: string
  /** The name shown in the SharkClean app */
  name: string
  /** The model number the registry holds, which can be empty */
  model: string
  /** Whether the device is currently live on this API */
  connected: boolean
}

// Client for the newer SharkNinja device API used by the current SharkClean
// app. Newer vacuums only act on commands sent through this API - the Ayla
// API accepts the same commands but the vacuum ignores them (#68).
// Protocol details are from the MIT-licensed shark2mqtt project
// (github.com/CamSoper/shark2mqtt).
export class SkegoxApi {
  private log: Logger
  private auth0_file: string
  private europe: boolean
  private base_url: string
  private api_key: string
  private user_id: string | null = null
  private household_id: string | null = null
  private dsn_to_device_id: Map<string, string> = new Map()
  private mapped_devices: SkegoxDevice[] = []
  private state_cache: Map<string, { at: number, values: Record<string, unknown> }> = new Map()

  constructor(log: Logger, auth0_file: string, europe = false) {
    this.log = log
    this.auth0_file = auth0_file
    this.europe = europe
    const skegox = europe ? global_vars.EU_SKEGOX : global_vars.SKEGOX
    this.base_url = skegox.BASE_URL
    this.api_key = skegox.API_KEY
  }

  // Load the stored Auth0 token set, refreshing it first when it is close to
  // expiry. Rejects when no token set is stored (the user has not signed in
  // through the OAuth Assistant since this feature was added).
  private async getIdToken(forceRefresh = false): Promise<string> {
    const auth0Data = await getAuth0Data(this.auth0_file)
    const expiration = new Date(auth0Data.expiration)
    if (!forceRefresh && expiration.getTime() - Date.now() > 120 * 1000) {
      return auth0Data.id_token
    }
    return this.refreshIdToken(auth0Data)
  }

  private async refreshIdToken(auth0Data: Auth0Data): Promise<string> {
    const oauthConfig = this.europe ? global_vars.EU_OAUTH : global_vars.OAUTH
    const response = await fetch(oauthConfig.TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Auth0-Client': oauthConfig.AUTH0_CLIENT,
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: oauthConfig.CLIENT_ID,
        refresh_token: auth0Data.refresh_token,
      }),
    })
    if (!response.ok) {
      return Promise.reject(new Error(`Unable to refresh the SharkNinja sign-in token. HTTP ${response.status}`))
    }
    const tokenData = await response.json() as { id_token: string, refresh_token?: string, expires_in?: number }
    const updated: Auth0Data = {
      id_token: tokenData.id_token,
      // Auth0 may rotate the refresh token - keep the old one when it does not
      refresh_token: tokenData.refresh_token ?? auth0Data.refresh_token,
      expiration: new Date(Date.now() + (tokenData.expires_in ?? 3600) * 1000),
    }
    await setAuth0Data(this.auth0_file, updated)
    this.log.debug('Refreshed the SharkNinja sign-in token for the new API.')
    return updated.id_token
  }

  // The signature header is required to be present but its value is not
  // validated by the server, so random bytes are sufficient.
  private headers(idToken: string): Record<string, string> {
    const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    return {
      'Authorization': `Bearer ${idToken}`,
      'content-type': 'application/json',
      'x-api-key': this.api_key,
      'x-iotn-request-signature': `SN-HMAC-SHA256 Credential=x/${now}/*/end-user-api/sn_request, `
        + 'SignedHeaders=host;x-sn-date;x-sn-nonce, '
        + `Signature=${crypto.randomBytes(32).toString('hex')}`,
      'x-iotn-caller': 'ENDUSER_MOBILEAPP',
      'x-sn-nonce': crypto.randomBytes(16).toString('hex'),
      'x-sn-date': now,
    }
  }

  private async request(method: string, path: string, body?: unknown, attempt = 0): Promise<any> {
    const idToken = await this.getIdToken(attempt > 0)
    const response = await fetch(`${this.base_url}${path}`, {
      method,
      headers: this.headers(idToken),
      body: body === undefined
        ? undefined
        : JSON.stringify(body),
    })
    if (response.status === 401 && attempt === 0) {
      return this.request(method, path, body, attempt + 1)
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return Promise.reject(new Error(`SharkNinja API error (HTTP ${response.status}): ${text}`))
    }
    // Some endpoints reply with an empty body, which is still a success
    return response.json().catch(() => null)
  }

  // Discover the user id (from the signed-in token), the household, and each
  // device, and build a map from each vacuum's Ayla DSN to its device id on
  // this API. Returns the number of vacuums that were mapped.
  async init(): Promise<number> {
    const idToken = await this.getIdToken()

    // The user id is the JWT subject claim, minus the identity-provider prefix
    const payload = idToken.split('.')[1]
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    const sub: string = claims.sub ?? ''
    this.user_id = sub.includes('|')
      ? sub.split('|', 2)[1]
      : sub

    const householdData = await this.request('GET', `/householdsEndUser?userId=${encodeURIComponent(this.user_id ?? '')}`)
    const households: string[] = householdData?.households ?? []
    if (households.length === 0) {
      return Promise.reject(new Error('No households found on the SharkNinja account.'))
    }
    this.household_id = households[0]

    const deviceData = await this.request('GET', `/devicesEndUserController/${this.household_id}/users/${this.user_id}`)
    const items: any[] = Array.isArray(deviceData)
      ? deviceData
      : (deviceData?.items ?? [])

    for (const item of items) {
      const deviceId: string | undefined = item?.deviceId ?? item?.snd
      if (!deviceId) {
        continue
      }
      try {
        const device = await this.request('GET', `/devicesEndUserController/${this.household_id}/devices/${deviceId}`)
        // The battery serial number has the format "<Ayla DSN>-<device id>",
        // which links the device on this API to the one Ayla reports
        // Log what the account actually holds - a SharkNinja account can carry
        // non-vacuum appliances, and a vacuum can be present here while Ayla
        // never lists it, which looks identical to "no vacuum found" (#85)
        // A vacuum that Ayla never listed often has no name here either, and
        // "unnamed" then becomes the accessory's name in HomeKit for ever
        // (#91). Fall back to something that at least says what it is, in the
        // same shape the other plugins use for a nameless device.
        const label = device?.registry?.Product_Name
          || device?.name
          || device?.registry?.Model_Number
          || `Shark ${deviceId.slice(-4)}`
        const batterySerial: string = device?.registry?.Battery_Serial_Num ?? ''
        if (batterySerial.includes('-')) {
          const dsn = batterySerial.split('-')[0].trim().toUpperCase()
          this.dsn_to_device_id.set(dsn, deviceId)
          // A vacuum can exist in the new registry without actually being
          // live on it - its shadow then accepts writes that nothing reads
          const connected = device?.connectivityStatus?.connected === true
          // Kept so a vacuum that Ayla no longer lists can still be built
          // into an accessory from what this API knows about it (#91)
          this.mapped_devices.push({
            dsn,
            deviceId,
            name: String(label),
            model: String(device?.registry?.Model_Number ?? ''),
            connected,
          })
          this.log.debug(`Mapped vacuum DSN ${dsn} ("${label}") to new-API device ${deviceId} (connected: ${connected}).`)
        } else {
          this.log.debug(`New-API device ${deviceId} ("${label}") has no battery serial number, cannot map it to a DSN.`)
        }
      } catch (error) {
        this.log.debug(`Unable to read new-API device ${deviceId}: ${error}`)
      }
    }
    return this.dsn_to_device_id.size
  }

  // Every vacuum this API knows about, in the order it listed them
  listDevices(): SkegoxDevice[] {
    return [...this.mapped_devices]
  }

  // Whether commands for this vacuum can be sent through this API
  available(dsn: string): boolean {
    return this.dsn_to_device_id.has(String(dsn).trim().toUpperCase())
  }

  // Set a device property through the desired-state shadow - this is how the
  // SharkClean app sends every command (start, stop, dock, power mode, ...)
  async setProperty(dsn: string, propertyName: string, value: unknown): Promise<void> {
    const deviceId = this.dsn_to_device_id.get(String(dsn).trim().toUpperCase())
    if (!deviceId || !this.household_id) {
      return Promise.reject(new Error(`Vacuum ${dsn} is not mapped on the new SharkNinja API.`))
    }
    const response = await this.request('PATCH', `/devicesEndUserController/${this.household_id}/devices/${deviceId}`, {
      shadow: {
        properties: {
          desired: { [propertyName]: value },
        },
      },
    })
    this.log.debug(`New-API response for setting ${propertyName}: ${JSON.stringify(response)}`)
  }

  // Read the vacuum's live state (telemetry plus reported shadow properties),
  // keyed by the same clean property names the Ayla API uses. A very recent
  // read is reused, since the HAP and Matter platforms can poll in quick
  // succession.
  async getPropertyValues(dsn: string): Promise<Record<string, unknown>> {
    const key = String(dsn).trim().toUpperCase()
    const deviceId = this.dsn_to_device_id.get(key)
    if (!deviceId || !this.household_id) {
      return Promise.reject(new Error(`Vacuum ${dsn} is not mapped on the new SharkNinja API.`))
    }
    const cached = this.state_cache.get(key)
    if (cached && Date.now() - cached.at < 4000) {
      return cached.values
    }
    const device = await this.request('GET', `/devicesEndUserController/${this.household_id}/devices/${deviceId}`)
    const values: Record<string, unknown> = {}
    Object.entries(device?.telemetry ?? {}).forEach(([k, v]) => {
      values[k] = v
    })
    Object.entries(device?.shadow?.properties?.reported ?? {}).forEach(([k, v]) => {
      values[k] = (v && typeof v === 'object' && 'value' in (v as Record<string, unknown>))
        ? (v as Record<string, unknown>).value
        : v
    })
    this.state_cache.set(key, {
      at: Date.now(),
      values,
    })
    return values
  }

  // One-line summary of what the new API currently holds for this vacuum,
  // used after a command to see whether the write landed and was picked up
  async describeState(dsn: string): Promise<string> {
    const deviceId = this.dsn_to_device_id.get(String(dsn).trim().toUpperCase())
    if (!deviceId || !this.household_id) {
      return Promise.reject(new Error(`Vacuum ${dsn} is not mapped on the new SharkNinja API.`))
    }
    const device = await this.request('GET', `/devicesEndUserController/${this.household_id}/devices/${deviceId}`)
    const desired = device?.shadow?.properties?.desired?.Operating_Mode
    const reported = device?.shadow?.properties?.reported?.Operating_Mode
    const connected = device?.connectivityStatus?.connected
    return `desired Operating_Mode=${JSON.stringify(desired)}, reported Operating_Mode=${JSON.stringify(reported)}, connected=${JSON.stringify(connected)}`
  }
}
