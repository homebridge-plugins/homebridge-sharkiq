import fs from 'node:fs'
import { join } from 'node:path'

/* Copyright(C) 2021-2024, donavanbecker (https://github.com/donavanbecker). All rights reserved.
 *
 * server.ts: homebridge-sharkiq.
 */
import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils'

import { generateURL } from '../config.js'
import { exchangeOAuthCodeForAuthTokens } from '../login.js'
import { global_vars } from '../sharkiq-js/const.js'

function extractOAuthCode(callbackOrCode: string): string {
  const trimmed = callbackOrCode.trim()
  if (trimmed === '') {
    throw new Error('OAuth callback URL or code is required.')
  }

  if (!trimmed.includes('code=')) {
    return trimmed
  }

  try {
    const parsed = new URL(trimmed)
    const code = parsed.searchParams.get('code')
    if (!code) {
      throw new Error('OAuth code was not found in the callback URL.')
    }
    return code
  } catch {
    const match = trimmed.match(/[?&]code=([^&]+)/)
    if (!match || !match[1]) {
      throw new Error('OAuth code was not found in the callback URL.')
    }
    return decodeURIComponent(match[1])
  }
}

class PluginUiServer extends HomebridgePluginUiServer {
  constructor() {
    super()
    const storagePath = this.homebridgeStoragePath
    if (!storagePath) {
      throw new Error('Homebridge storage path is unavailable.')
    }
    /*
      A native method getCachedAccessories() was introduced in config-ui-x v4.37.0
      The following is for users who have a lower version of config-ui-x
    */
    this.onRequest('/getCachedAccessories', () => {
      try {
        const plugin = '@homebridge-plugins/homebridge-sharkiq'
        const devicesToReturn = []

        // The path and file of the cached accessories
        const accFile = `${this.homebridgeStoragePath}/accessories/cachedAccessories`

        // Check the file exists
        if (fs.existsSync(accFile)) {
          // read the cached accessories file
          const cachedAccessories: any[] = JSON.parse(fs.readFileSync(accFile, 'utf8'))

          cachedAccessories.forEach((accessory: any) => {
            // Check the accessory is from this plugin
            if (accessory.plugin === plugin) {
              // Add the cached accessory to the array
              devicesToReturn.push(accessory.accessory as never)
            }
          })
        }
        // Return the array
        return devicesToReturn
      } catch {
        // Just return an empty accessory list in case of any errors
        return []
      }
    })

    this.onRequest('/generateOAuthUrl', async ({ europe }: { europe?: boolean } = {}) => {
      const oauthFile = join(storagePath, global_vars.OAUTH.FILE)
      const url = await generateURL(oauthFile, europe === true)
      return { url }
    })

    this.onRequest('/exchangeOAuthCode', async ({ callbackOrCode, europe }: { callbackOrCode: string, europe?: boolean }) => {
      const code = extractOAuthCode(callbackOrCode)
      const authFile = join(storagePath, global_vars.FILE)
      const oauthFile = join(storagePath, global_vars.OAUTH.FILE)
      await exchangeOAuthCodeForAuthTokens(authFile, oauthFile, code, europe === true)
      return { success: true }
    })

    this.onRequest('/getAuthStatus', () => {
      try {
        const authFile = join(storagePath, global_vars.FILE)
        if (!fs.existsSync(authFile)) {
          return { loggedIn: false, message: 'Not logged in' }
        }

        const raw = fs.readFileSync(authFile, 'utf8')
        const authData = JSON.parse(raw) as { access_token?: string, refresh_token?: string }
        const loggedIn = !!authData.access_token && !!authData.refresh_token
        return {
          loggedIn,
          message: loggedIn ? 'Logged in' : 'Not logged in',
        }
      } catch {
        return { loggedIn: false, message: 'Not logged in' }
      }
    })

    this.ready()
  }
}

function startPluginUiServer(): PluginUiServer {
  return new PluginUiServer()
}

startPluginUiServer()
