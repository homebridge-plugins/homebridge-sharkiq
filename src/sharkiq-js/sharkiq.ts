import type { Logger } from 'homebridge'

import type { AylaApi } from './ayla_api.js'
import type { SkegoxApi } from './skegox_api.js'

import { Buffer, transcode } from 'node:buffer'

import { safeJsonParse } from '../utils.js'
import { global_vars } from './const.js'
import { ERROR_MESSAGES, OperatingModes, PowerModes, Properties } from './properties.js'

// Strip text from property name
function _clean_property_name(raw_property_name: string): string {
  const check_for = ['SET_', 'GET_']
  if (check_for.some(v => raw_property_name.slice(0, 4).toUpperCase().includes(v))) {
    return raw_property_name.slice(4)
  } else {
    return raw_property_name
  }
}

const ERROR_DELAY = 10000
const TIMEOUT_DELAY = 30000
/**
 * Describe whether a vacuum reports a room list, for the debug log.
 *
 * Room-specific cleaning (#41) depends entirely on the vacuum publishing
 * `Robot_Room_List`, and that varies by model and by which API the vacuum is
 * live on. This states it directly rather than leaving a reporter to infer it.
 *
 * ⚠️ It exists because the plugin used to log only a property *count* ("Read 77
 * properties"). Asked to look for a room list, a reporter on #41 could not have
 * found one either way — an absent list and an unlogged one looked identical,
 * and a whole round trip was spent finding that out.
 *
 * The raw value is `mapIdentifier:room1:room2:...`.
 */
export function describeRoomList(raw: unknown): string {
  const label = `Room list (${Properties.ROBOT_ROOM_LIST})`
  if (typeof raw !== 'string' || raw === '') {
    return `${label}: not reported by this vacuum, so room-specific cleaning is not available on it.`
  }
  const [identifier, ...rooms] = raw.split(':')
  if (rooms.length === 0) {
    return `${label}: map "${identifier}" reported, but no rooms in it.`
  }
  return `${label}: map "${identifier}" with ${rooms.length} room(s): ${rooms.join(', ')}`
}

/**
 * The three generations of the "which areas to clean" property, oldest first.
 *
 * A vacuum can report all three (#41). The plugin writes
 * {@link Properties.AREAS_TO_CLEAN}, which is V2, but that was chosen before V3
 * existed, and a property *list* cannot tell us which one a given firmware acts
 * on. Logging all three lets a reporter start a single-room clean from the
 * SharkClean app and show us which one the app populates.
 */
export const AREA_FILTER_PROPERTIES = ['Areas_To_Clean', 'AreasToClean_V2', 'AreasToClean_V3'] as const

/**
 * Render one area-filter value for the debug log.
 *
 * The encoded form is a length-prefixed room list carrying control bytes, so it
 * is shown as hex with a printable rendering beside it rather than dumped raw
 * into the log.
 */
export function describeAreaFilter(name: string, raw: unknown): string {
  if (raw === undefined) {
    return `${name}: not reported`
  }
  if (raw === null || raw === '') {
    return `${name}: empty`
  }
  const text = String(raw)
  const hex = Buffer.from(text, 'latin1').toString('hex')
  const printable = text.replace(/[^\x20-\x7E]/g, '.')
  return `${name}: ${text.length} byte(s) hex=${hex} printable="${printable}"`
}

/**
 * Options for a V3 room clean, with the defaults observed on a real vacuum.
 *
 * ⚠️ Every value here came from ONE device (RV2800AF-UK, #41) doing one clean.
 * They are what the SharkClean app sent, not a documented default, so they are
 * settings rather than constants.
 */
export interface RoomCleanOptions {
  /**
   * Key inside `areas_to_clean`. The observed value was `UltraClean`, which is
   * what that app calls "Matrix Clean". Other models may name it differently.
   */
  mode?: string
  /** Number of passes. Observed: 2. */
  cleanCount?: number
  /** `dry` to vacuum, and presumably `wet`/`mop` on models that mop. Observed: `dry`. */
  cleanType?: string
}

/**
 * The two room-clean presets the SharkClean app offers, captured from a real
 * vacuum (#41). Selecting a room in the app gives "Clean" and "Matrix Clean",
 * and they differ in the mode key AND the pass count:
 *
 * ```
 * Clean         {"areas_to_clean":{"UserRoom":["Kitchen"]},"clean_count":1,...}
 * Matrix Clean  {"areas_to_clean":{"UltraClean":["Kitchen"]},"clean_count":2,...}
 * ```
 *
 * ⚠️ `UltraClean` was the first value seen, and was briefly the default — which
 * silently made every HomeKit room clean a two-pass Matrix Clean. A plain clean
 * is `UserRoom` with one pass.
 */
export const ROOM_CLEAN_PRESETS = {
  standard: { mode: 'UserRoom', cleanCount: 1, cleanType: 'dry' },
  matrix: { mode: 'UltraClean', cleanCount: 2, cleanType: 'dry' },
} as const satisfies Record<string, Required<RoomCleanOptions>>

/** A plain clean, matching the app's "Clean" button rather than "Matrix Clean". */
export const ROOM_CLEAN_DEFAULTS: Required<RoomCleanOptions> = ROOM_CLEAN_PRESETS.standard

/**
 * Build the V3 area filter: plain JSON, unlike V2's length-prefixed binary blob.
 *
 * Reproduced from a capture in #41 — a Kitchen clean started from the app sent:
 *
 * ```json
 * {"areas_to_clean":{"UltraClean":["Kitchen"]},"clean_count":2,"floor_id":"6ABE3ECC","cleantype":"dry"}
 * ```
 *
 * Key order matches that payload. It should not matter to a JSON parser, but
 * this is reverse-engineered from one sample and there is no upside to differing.
 *
 * `floorId` is the map identifier from `Robot_Room_List`, so no extra lookup is
 * needed — the room list already carries it.
 */
export function encodeRoomListV3(rooms: string[], floorId: string, options: RoomCleanOptions = {}): string {
  const { mode, cleanCount, cleanType } = {
    ...ROOM_CLEAN_DEFAULTS,
    ...options,
  }
  return JSON.stringify({
    areas_to_clean: { [mode]: rooms },
    clean_count: cleanCount,
    floor_id: floorId,
    cleantype: cleanType,
  })
}

/**
 * Which area-filter property to write for this vacuum.
 *
 * A vacuum that reports V3 is on the newer scheme and ignores V2 — confirmed in
 * #41, where V2 stayed at `*` for the whole of a room clean while V3 carried the
 * request. Older vacuums never report V3, so they keep the V2 binary path.
 */
export function chooseAreaFilterProperty(propertyValues: Record<string, unknown> | undefined): 'AreasToClean_V2' | 'AreasToClean_V3' {
  return propertyValues?.AreasToClean_V3 === undefined
    ? 'AreasToClean_V2'
    : 'AreasToClean_V3'
}

/** One entry of the Matter ServiceArea cluster's `supportedAreas`. */
export interface MatterSupportedArea {
  areaId: number
  mapId: number | null
  areaInfo: {
    locationInfo: { locationName: string, floorNumber: number | null, areaType: number | null }
    landmarkInfo: null
  }
}

/**
 * Turn the vacuum's room list into Matter `supportedAreas`.
 *
 * ⚠️ Area ids are the room's 1-based position in the list, so they are only as
 * stable as the order the vacuum reports. If a user renames or reorders rooms in
 * the SharkClean app, a controller's saved selection can point at a different
 * room. Ids start at 1 because 0 is a reserved-looking value that some
 * controllers treat as "unset".
 */
export function buildSupportedAreas(rooms: string[]): MatterSupportedArea[] {
  return rooms.map((locationName, index) => ({
    areaId: index + 1,
    mapId: null,
    areaInfo: {
      locationInfo: { locationName, floorNumber: null, areaType: null },
      landmarkInfo: null,
    },
  }))
}

/** The full ServiceArea cluster state, as matter.js requires it. */
export interface MatterServiceAreaCluster {
  supportedAreas: MatterSupportedArea[]
  /**
   * ⚠️ MUST be present, even when empty. matter.js's `ServiceAreaServer` calls
   * `maps.length` on it unguarded during initialize, so leaving it out throws
   * "Cannot read properties of undefined (reading 'length')", the behaviour
   * fails to initialise, and the WHOLE endpoint is rolled back - the vacuum
   * shows as No Response in Home. Shipped exactly that in 1.6.2-beta.4 (#41).
   */
  supportedMaps: never[]
  selectedAreas: number[]
}

/**
 * Build the ServiceArea cluster state for a vacuum's rooms.
 *
 * One function, so what the tests check is the same object the platform hands to
 * Matter. Testing only the pieces is what let the missing `supportedMaps`
 * through: `buildSupportedAreas` was well covered, and the bug was in the object
 * around it.
 *
 * An empty `supportedMaps` obliges every area to carry `mapId: null`, which
 * matter.js enforces too, so the two must change together.
 */
export function buildServiceAreaCluster(rooms: string[]): MatterServiceAreaCluster {
  return {
    supportedAreas: buildSupportedAreas(rooms),
    supportedMaps: [],
    selectedAreas: [],
  }
}

/**
 * Map the area ids a controller selected back to the room names the vacuum wants.
 *
 * Unknown ids are dropped rather than throwing: a stale selection left over from
 * a renamed map should clean the rooms it still recognises, not fail outright.
 * An empty result means "no recognised rooms", which callers must treat as a
 * whole-house clean rather than an empty area filter — writing an empty filter is
 * what stopped the vacuum leaving the dock in #68.
 */
export function areaIdsToRoomNames(areaIds: number[], rooms: string[]): string[] {
  return areaIds
    .map(id => rooms[id - 1])
    .filter((name): name is string => typeof name === 'string')
}

/**
 * Battery and charging state, normalised from what the vacuum reports (#88).
 *
 * The vacuum publishes `Battery_Capacity` as a plain percentage and
 * `Charging_Status` as a flag. Neither reached HomeKit on either protocol
 * before this.
 */
export interface VacuumBattery {
  /** 0-100, or undefined when the vacuum has not reported one */
  percent?: number
  charging: boolean
  /** Matter's batChargeLevel: 0 Ok, 1 Warning, 2 Critical */
  chargeLevel: 0 | 1 | 2
  low: boolean
}

/** Below this the battery is reported as low on HAP and Warning on Matter. */
export const BATTERY_LOW_THRESHOLD = 20
/** Below this Matter reports Critical. */
export const BATTERY_CRITICAL_THRESHOLD = 10

export function readVacuumBattery(rawPercent: unknown, rawCharging: unknown): VacuumBattery {
  const parsed = typeof rawPercent === 'number'
    ? rawPercent
    : Number.parseInt(String(rawPercent ?? ''), 10)
  const percent = Number.isFinite(parsed)
    ? Math.max(0, Math.min(100, Math.round(parsed)))
    : undefined
  // Charging_Status is 1/0 on this API, but a boolean is cheap to tolerate.
  const charging = rawCharging === true || rawCharging === 1 || String(rawCharging) === '1'

  let chargeLevel: 0 | 1 | 2 = 0
  if (percent !== undefined) {
    if (percent < BATTERY_CRITICAL_THRESHOLD) {
      chargeLevel = 2
    } else if (percent < BATTERY_LOW_THRESHOLD) {
      chargeLevel = 1
    }
  }

  return {
    percent,
    charging,
    chargeLevel,
    low: percent !== undefined && percent < BATTERY_LOW_THRESHOLD,
  }
}

/**
 * The Matter PowerSource cluster state for a battery reading.
 *
 * ⚠️ `batPercentRemaining` is DOUBLE the percentage - 100% is 200, not 100.
 * Homebridge's own note says so (`clusterTypes.ts:337`). Sending the plain
 * percentage would report every battery at half its real charge.
 */
export function matterPowerSourceState(battery: VacuumBattery): Record<string, unknown> {
  return {
    status: 1, // Active
    order: 0,
    description: 'Battery',
    batPresent: true,
    batPercentRemaining: battery.percent === undefined
      ? null
      : battery.percent * 2,
    batChargeLevel: battery.chargeLevel,
    batReplacementNeeded: false,
    batReplaceability: 0, // NotReplaceable
    // 0 Unknown, 1 IsCharging, 2 IsAtFullCharge, 3 IsNotCharging
    batChargeState: battery.charging
      ? 1
      : (battery.percent === 100
          ? 2
          : 3),
    // ⚠️ Mandatory for a rechargeable power source, and matter.js defaults it to
    // FALSE if you leave it out - which claims the vacuum stops working the
    // moment it is on the dock. A Shark runs perfectly well from a part charge,
    // and Home showed no battery at all while it was docked and charging (#88).
    batFunctionalWhileCharging: true,
  }
}

/**
 * Matter mode tag numbers used by the clean modes below.
 *
 * ⚠️ These are spec values, not guesses. `@matter` is not a runtime dependency
 * of this plugin, so they cannot be imported here — instead every one of them is
 * asserted against `@matter/types`' own enums in `battery.test.ts`, which fails
 * if a number here drifts from the spec.
 */
export const MODE_TAG = {
  auto: 0, // ModeBase.ModeTag.Auto
  lowEnergy: 4, // ModeBase.ModeTag.LowEnergy
  max: 7, // ModeBase.ModeTag.Max
  vacuum: 16385, // RvcCleanMode.ModeTag.Vacuum
} as const

/**
 * The vacuum's suction levels, as Matter clean modes (#88).
 *
 * Mode numbers are the vacuum's own `PowerModes` values so the two cannot drift.
 *
 * ⚠️ **At least one mode must carry the `vacuum` tag** (or `mop`). Without it
 * matter.js throws "Provided supportedModes need to include at least Vacuum or
 * Mop mode tag", the behaviour fails to initialise, and the *whole endpoint*
 * rolls back — the vacuum shows as No Response in Home. Every mode carries it
 * here, and the tests restate the rule.
 *
 * ⚠️ **Every mode needs a descriptive tag as well as `vacuum`.** `Normal` first
 * shipped with only the `vacuum` tag, on the reasoning that `auto` means "the
 * device chooses" and this is a fixed suction level. Home then listed only
 * "Max" and "Energy Saving" — it names modes from the standard tags, so a mode
 * carrying nothing but `vacuum` has nothing to be called and drops out of the
 * picker. Spec purity lost to being usable.
 */
export const MATTER_CLEAN_MODES = [
  {
    label: 'Eco',
    mode: 1,
    modeTags: [
      { value: MODE_TAG.vacuum },
      { value: MODE_TAG.lowEnergy },
    ],
  }, // PowerModes.ECO
  {
    label: 'Normal',
    mode: 0,
    modeTags: [
      { value: MODE_TAG.vacuum },
      { value: MODE_TAG.auto },
    ],
  }, // PowerModes.NORMAL
  {
    label: 'Max',
    mode: 2,
    modeTags: [
      { value: MODE_TAG.vacuum },
      { value: MODE_TAG.max },
    ],
  }, // PowerModes.MAX
] as const

/** Whether a mode number a controller sent is one this vacuum actually has. */
export function isKnownCleanMode(mode: number): boolean {
  return MATTER_CLEAN_MODES.some(m => m.mode === mode)
}

/**
 * The operating mode this vacuum actually uses for "paused" (#88).
 *
 * ⚠️ **It is `STOP`, not `PAUSE`.** Despite the name, `OperatingModes.PAUSE` (1)
 * is a value this vacuum uses in neither direction: a paused Shark *reports*
 * `STOP`, and writing `PAUSE` to it does nothing at all. The HAP path has always
 * paused with `STOP`, and the Matter polling loop already reads `STOP` as
 * Matter's Paused state — only the Matter pause/resume handlers disagreed, so
 * Home showed "Paused" while the vacuum carried on cleaning.
 *
 * Everything that pauses, resumes, or tests for paused uses this, so the read
 * and write sides cannot drift apart again.
 */
export const PAUSED_OPERATING_MODE = OperatingModes.STOP

/**
 * Matter `RvcOperationalState` error state IDs, from the spec (#88).
 *
 * As with `MODE_TAG`, `@matter` is not a runtime dependency so these cannot be
 * imported; every one is asserted against matter's own enum in `status.test.ts`.
 */
export const MATTER_ERROR_STATE = {
  noError: 0,
  unableToStartOrResume: 1,
  unableToCompleteOperation: 2,
  stuck: 65,
  dustBinMissing: 66,
  waterTankEmpty: 68,
  lowBattery: 72,
  wheelsJammed: 76,
  brushJammed: 77,
  navigationSensorObscured: 78,
} as const

/**
 * The vacuum's own error codes, mapped onto Matter's error states.
 *
 * Matter has a specific state for most of what this vacuum reports, so a
 * controller can say "brush jammed" rather than just "error". Anything without a
 * good match falls back to `unableToCompleteOperation`, with the real wording
 * carried in `errorStateDetails`.
 */
const MATTER_ERROR_STATE_BY_CODE: Record<number, number> = {
  1: MATTER_ERROR_STATE.wheelsJammed, // Side wheel is stuck
  2: MATTER_ERROR_STATE.brushJammed, // Side brush is stuck
  3: MATTER_ERROR_STATE.unableToCompleteOperation, // Suction motor failed
  4: MATTER_ERROR_STATE.brushJammed, // Brushroll stuck
  5: MATTER_ERROR_STATE.wheelsJammed, // Side wheel is stuck (2)
  6: MATTER_ERROR_STATE.stuck, // Bumper is stuck
  7: MATTER_ERROR_STATE.navigationSensorObscured, // Cliff sensor is blocked
  8: MATTER_ERROR_STATE.lowBattery, // Battery power is low
  9: MATTER_ERROR_STATE.dustBinMissing, // No Dustbin
  10: MATTER_ERROR_STATE.navigationSensorObscured, // Fall sensor is blocked
  11: MATTER_ERROR_STATE.wheelsJammed, // Front wheel is stuck
  13: MATTER_ERROR_STATE.unableToStartOrResume, // Switched off
  14: MATTER_ERROR_STATE.unableToCompleteOperation, // Magnetic strip error
  16: MATTER_ERROR_STATE.stuck, // Top bumper is stuck
  18: MATTER_ERROR_STATE.wheelsJammed, // Wheel encoder error
}

/** A fault the vacuum is reporting. Absent when there is nothing wrong. */
export interface VacuumFault {
  code: number
  /** `Extended_Error_Code`, when the vacuum gives one. Meaning not yet known. */
  extendedCode?: number
  /** Human wording, for logs and for Matter's `errorStateDetails`. */
  message: string
  matterErrorStateId: number
}

/** Reads a number the API may report as a number or a string. */
function readNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    return Number.isFinite(raw)
      ? raw
      : undefined
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed)
      ? parsed
      : undefined
  }
  return undefined
}

/**
 * Reads a flag the API may report as a boolean, a 0/1 number, or those as
 * strings. Returns undefined when the vacuum has not reported the property at
 * all, which is different from reporting false.
 */
export function readFlag(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined
  }
  if (typeof raw === 'boolean') {
    return raw
  }
  return raw === 1 || raw === '1' || String(raw).toLowerCase() === 'true'
}

/**
 * The fault the vacuum is reporting, if any (#88).
 *
 * Code 0 (and no code at all) means no fault. Unknown codes are still reported —
 * an unrecognised fault is better surfaced than swallowed — with the number in
 * the message so it can be identified from a log.
 */
export function readVacuumFault(rawCode: unknown, rawExtendedCode?: unknown): VacuumFault | undefined {
  const code = readNumber(rawCode)
  if (code === undefined || code === 0) {
    return undefined
  }
  const extendedCode = readNumber(rawExtendedCode)
  const known = ERROR_MESSAGES[code as keyof typeof ERROR_MESSAGES]
  const message = known ?? `Unknown error (code ${code}${extendedCode
    ? `, extended ${extendedCode}`
    : ''})`
  return {
    code,
    ...(extendedCode === undefined || extendedCode === 0
      ? {}
      : { extendedCode }),
    message,
    matterErrorStateId: MATTER_ERROR_STATE_BY_CODE[code] ?? MATTER_ERROR_STATE.unableToCompleteOperation,
  }
}

/** Water tank state. Each flag is undefined when the vacuum does not report it. */
export interface WaterTank {
  installed?: boolean
  empty?: boolean
  /** Installed but out of water — the only combination worth warning about. */
  needsRefill: boolean
}

export function readWaterTank(rawInstalled: unknown, rawEmpty: unknown): WaterTank {
  const installed = readFlag(rawInstalled)
  const empty = readFlag(rawEmpty)
  // A missing tank is not a problem: this vacuum runs perfectly well without one
  // when it is not mopping. Only an installed tank that has run dry is.
  return { installed, empty, needsRefill: installed === true && empty === true }
}

/**
 * The Matter `operationalError` for the current state (#88).
 *
 * ⚠️ **Setting this to anything but `noError` forces the whole device into the
 * Error state.** matter.js does it for you in `OperationalStateServer`'s
 * `#handleOperationalError`, so a value here is not a passive status — it is
 * what Home shows instead of "Docked" or "Charging". That is why an empty water
 * tank only counts while the vacuum is actually running: reporting it on a
 * docked vacuum would leave every mop-less user permanently in Error.
 *
 * ⚠️ `errorStateLabel` is deliberately never set. The spec only permits it on
 * manufacturer-specific IDs (0x80-0xBF), and matter.js rejects it on the
 * standard IDs used here as a conformance error, rolling back the whole
 * registration — the same trap as the operational state labels in #83.
 * `errorStateDetails` is the free-text field, and carries the real wording.
 */
export function matterOperationalError(
  fault: VacuumFault | undefined,
  waterTank: WaterTank,
  running: boolean,
): { errorStateId: number, errorStateDetails?: string } {
  if (fault) {
    return { errorStateId: fault.matterErrorStateId, errorStateDetails: fault.message }
  }
  if (running && waterTank.needsRefill) {
    return { errorStateId: MATTER_ERROR_STATE.waterTankEmpty, errorStateDetails: 'Water tank is empty' }
  }
  return { errorStateId: MATTER_ERROR_STATE.noError }
}

export interface DeviceDct {
  dsn: string
  key: string
  oem_model: string
  product_name: string
}

interface Log extends Logger {
  warn: (message: string, ...args: any[]) => void
  debug: (message: string, ...args: any[]) => void
  info: (message: string, ...args: any[]) => void
  success: (message: string, ...args: any[]) => void
  error: (message: string, ...args: any[]) => void
}

class SharkIqVacuum {
  ayla_api: AylaApi
  _dsn: string
  _key: string
  _oem_model_number: string
  _vac_model_number: string
  _vac_serial_number: string
  properties_full
  property_values
  _settable_properties
  europe: boolean
  _name: string
  _firmware_version: string
  log: Logger
  _error: string | null
  skegox: SkegoxApi | null
  /**
   * Whether this vacuum exists only on the newer SharkNinja API. The Ayla
   * account has no record of it, so there is nothing there to read or write
   * and every request must go to the newer API instead (#91).
   */
  newApiOnly: boolean
  /** Per-vacuum overrides for the V3 room-clean payload (#41) */
  roomCleanOptions: RoomCleanOptions

  // Shark IQ vacuum entity
  constructor(ayla_api: AylaApi, device_dct: DeviceDct, log: Log, europe = false) {
    this.ayla_api = ayla_api
    this._dsn = device_dct.dsn
    this._key = device_dct.key
    this._oem_model_number = device_dct.oem_model
    this._vac_model_number = ''
    this._vac_serial_number = ''
    this.properties_full = {}
    this.property_values = {}
    this._settable_properties = null
    this.europe = europe
    this._name = device_dct.product_name
    this._firmware_version = ''
    this.log = log
    this._error = null
    this.skegox = null
    this.newApiOnly = false
    this.roomCleanOptions = {}
  }

  // Get oem model number
  get oem_model_number(): string {
    return this._oem_model_number
  }

  // Get vacuum model number
  get vac_model_number(): string {
    return this._vac_model_number
  }

  // Get vacuum serial number
  get vac_serial_number(): string {
    return this._vac_serial_number
  }

  // Get vacuum name
  get name(): string {
    return this._name
  }

  // Get device serial number
  get serial_number(): string {
    return this._dsn
  }

  // Get current operating mode
  operating_mode(): number {
    return this.get_property_value(Properties.OPERATING_MODE)
  }

  // Get current docked status
  docked_status(): number {
    return this.get_property_value(Properties.DOCKED_STATUS)
  }

  // Get current power mode
  power_mode(): number {
    return this.get_property_value(Properties.POWER_MODE)
  }

  /** Battery percentage and charging state, normalised (#88). */
  battery(): VacuumBattery {
    return readVacuumBattery(
      this.get_property_value(Properties.BATTERY_CAPACITY),
      this.get_property_value(Properties.CHARGING_STATUS),
    )
  }

  /** The fault the vacuum is reporting, or undefined when all is well (#88). */
  fault(): VacuumFault | undefined {
    return readVacuumFault(
      this.get_property_value(Properties.ERROR_CODE),
      this.get_property_value(Properties.EXTENDED_ERROR_CODE),
    )
  }

  /** Water tank state (#88). */
  water_tank(): WaterTank {
    return readWaterTank(
      this.get_property_value(Properties.WATER_TANK_INSTALLED),
      this.get_property_value(Properties.WATER_TANK_EMPTY),
    )
  }

  /**
   * Whether the mop plate is attached (#88). Undefined when the vacuum does not
   * report it, which is different from reporting that it is off.
   */
  mop_plate_attached(): boolean | undefined {
    return readFlag(this.get_property_value(Properties.MOP_PLATE_ATTACHED))
  }

  /** Whether the vacuum is currently running a job. */
  is_running(): boolean {
    return this.operating_mode() === OperatingModes.START
  }

  /** Whether a clean is paused. See {@link PAUSED_OPERATING_MODE}. */
  is_paused(): boolean {
    return this.operating_mode() === PAUSED_OPERATING_MODE
  }

  /**
   * Make the vacuum play a sound so it can be found (#88).
   *
   * ⚠️ Untested against real hardware — `Find_Device` is in the property list
   * every vacuum reports, and 1 is the obvious trigger, but nobody has confirmed
   * the vacuum acts on it.
   */
  async find_device(): Promise<void> {
    await this.set_property_value(Properties.FIND_DEVICE, 1)
  }

  // Update vacuum details such as the model and serial number. These come
  // from optional properties, so a vacuum that does not report them must not
  // take the whole plugin down with it (#85).
  _update_metadata(): void {
    const model_and_serial = this.get_property_value(Properties.DEVICE_SERIAL_NUMBER)
    if (typeof model_and_serial === 'string' && model_and_serial.trim() !== '') {
      const model_serial_split = model_and_serial.split(/(\s+)/).filter((e) => {
        return e.trim().length > 0
      })
      this._vac_model_number = model_serial_split[0] ?? ''
      this._vac_serial_number = model_serial_split[1] ?? ''
    } else {
      this.log.debug(`No model or serial number reported for ${this._dsn}.`)
    }
    this._firmware_version = this.get_property_value(Properties.ROBOT_FIRMWARE_VERSION) ?? ''
  }

  // Get url for the endpoint of the setting a property API
  set_property_endpoint(property_name): string {
    return `${this.europe ? global_vars.EU_DEVICE_URL : global_vars.DEVICE_URL}`
      + `/apiv1/dsns/${this._dsn}/properties/${property_name}/datapoints.json`
  }

  // Get a device property value
  get_property_value(property_name) {
    if (property_name.value) {
      property_name = property_name.value
    }
    return this.property_values[property_name]
  }

  // Set a device property value
  async set_property_value(property_name, value, attempt = 0): Promise<void> {
    if (property_name.value) {
      property_name = property_name.value
    }
    if (value.value) {
      value = value.value
    }

    // Newer vacuums only act on commands sent through the newer SharkNinja
    // API - the Ayla request below succeeds but the vacuum ignores it (#68).
    // Try the new API first when this vacuum is known to it, and fall back
    // to Ayla on any error so older setups keep working.
    if (this.skegox?.available(this._dsn)) {
      try {
        await this.skegox.setProperty(this._dsn, property_name, value)
        this.log.debug(`Set property ${property_name} to ${value} via the new SharkNinja API.`)
        this.properties_full[property_name] = value
        // Read the state back shortly after a mode command, to show in the
        // debug log whether the vacuum actually picked the command up
        if (property_name === Properties.OPERATING_MODE) {
          setTimeout(async () => {
            try {
              this.log.debug(`New-API state check for ${this._dsn}: ${await this.skegox!.describeState(this._dsn)}`)
            } catch (error) {
              this.log.debug(`New-API state check failed for ${this._dsn}: ${error}`)
            }
          }, 4000)
        }
        return
      } catch (error) {
        if (this.newApiOnly) {
          this.log.warn(`Unable to set ${property_name} on ${this._dsn} (${error}).`)
          return
        }
        this.log.debug(`New SharkNinja API could not set ${property_name} (${error}), falling back to the Ayla API.`)
      }
    }

    const end_point = this.set_property_endpoint(`SET_${property_name}`)
    const data = {
      datapoint: { value },
    }
    try {
      const auth_header = await this.ayla_api.auth_header()
      const resp = await this.ayla_api.makeRequest('POST', end_point, data, auth_header)
      if (resp.ok !== true) {
        // Check if this is an authentication error (401) that requires token refresh
        if (resp.status === 401) {
          this.log.debug(`Authentication error setting property ${property_name}, attempting token refresh`)
          const status = await this.ayla_api.attempt_refresh(attempt, false)
          if (!status && attempt === 1) {
            this.log.warn(`Failed to set property ${property_name} after authentication retry`)
            return
          } else {
            await this.set_property_value(property_name, value, attempt + 1)
            return
          }
        } else {
          // For non-authentication errors, log as debug since vacuum may still function
          this.log.debug(`Unable to set property ${property_name} to ${value} (Status: ${resp.status}). This may be normal depending on device state.`)
          this.log.debug(`API Response: ${resp.response}`)
          return
        }
      }
      // Log the successful outcome too, so a start/stop command that the API
      // accepts (but the vacuum then ignores) can be told apart from one the
      // API rejects (#68).
      this.log.debug(`Set property ${property_name} to ${value} accepted by Shark (Status: ${resp.status}).`)
      this.properties_full[property_name] = value
    } catch {
      this.log.debug('Promise Rejected with setting property value.')
    }
  }

  // Get the url for the endpoint that gets property values
  get update_url(): string {
    return `${this.europe ? global_vars.EU_DEVICE_URL : global_vars.DEVICE_URL}/apiv1/dsns/${this.serial_number}/properties.json`
  }

  // Get properties
  async update(property_list, attempt = 0): Promise<number> {
    if (property_list) {
      if (!Array.isArray(property_list)) {
        property_list = [property_list]
      }
    }
    const full_update = !property_list
    const url = this.update_url
    try {
      // A vacuum the Ayla account has never heard of has no properties there
      // to read, and asking anyway returns an error for every poll. The newer
      // API is the only source of state for it, full updates included (#91).
      if (this.newApiOnly) {
        return await this._apply_skegox_state()
          ? 0
          : ERROR_DELAY
      }
      // Newer vacuums no longer report fresh state to the Ayla API, so read
      // the live state from the newer SharkNinja API when this vacuum is on
      // it (#68). Full updates still go to Ayla afterwards for the device
      // metadata, with the live state overlaid on top at the end.
      if (!full_update && property_list.length !== 0 && await this._apply_skegox_state()) {
        return 0
      }
      if (!full_update && property_list.length !== 0) {
        const params = new URLSearchParams()
        property_list.forEach((property) => {
          params.append('names[]', `GET_${property}`)
        })
        const auth_header = await this.ayla_api.auth_header()
        const resp = await this.ayla_api.makeRequest('GET', `${url}?${params.toString()}`, null, auth_header)
        try {
          // Use safe JSON parsing utility
          const parseResult = safeJsonParse(resp.response)
          if (!parseResult.success) {
            this.log.warn(`Error parsing JSON response for properties: ${property_list.join(', ')}`)
            this.log.debug(`Parse Error: ${parseResult.error}`)
            this.log.debug(`Raw API Response: ${resp.response}`)
            this.log.debug(`Response Status: ${resp.status}`)
            this.log.debug(`Response OK: ${resp.ok}`)
            return ERROR_DELAY
          }

          const properties = parseResult.data
          if (resp.status === 429) {
            this.log.debug('API Error: Too many requests')
            this.log.debug('Waiting an extra 30 seconds before retrying...')
            return TIMEOUT_DELAY
          } else if (resp.status === 500) {
            // Handle 500 server errors gracefully
            this.log.error(`Server error (500) - API temporarily unavailable. Status: ${resp.status}, Error: ${properties.error
              ? JSON.stringify(properties.error)
              : 'Internal server error'}`)
            return ERROR_DELAY
          } else if (resp.ok !== true) {
            this.log.warn('Error getting property values', property_list.join(', '))
            this.log.debug(`Raw API Response: ${resp.response}`)
            this.log.error(`API Error - Status: ${resp.status}, Error: ${properties.error
              ? JSON.stringify(properties.error)
              : 'Unknown error'}`)
            const status = await this.ayla_api.attempt_refresh(attempt)
            if (!status && attempt === 1) {
              return ERROR_DELAY
            } else {
              return await this.update(property_list, attempt + 1)
            }
          } else {
            this._do_update(full_update, properties)
            return 0
          }
        } catch (e) {
          this.log.warn(`Error processing API response for properties: ${property_list.join(', ')}`)
          this.log.debug(`Error Message: ${e}`)
          this.log.debug(`Raw Response: ${resp.response}`)
          return ERROR_DELAY
        }
      } else {
        const auth_header = await this.ayla_api.auth_header()
        const resp = await this.ayla_api.makeRequest('GET', url, null, auth_header)
        try {
          // Use safe JSON parsing utility
          const parseResult = safeJsonParse(resp.response)
          if (!parseResult.success) {
            this.log.warn('Error parsing JSON response for full property update')
            this.log.debug(`Parse Error: ${parseResult.error}`)
            this.log.debug(`Raw API Response (full update): ${resp.response}`)
            this.log.debug(`Response Status: ${resp.status}`)
            this.log.debug(`Response OK: ${resp.ok}`)
            return ERROR_DELAY
          }

          const properties = parseResult.data
          if (resp.status === 429) {
            this.log.debug('API Error: Too many requests')
            this.log.debug('Waiting an extra 30 seconds before retrying...')
            return TIMEOUT_DELAY
          } else if (resp.status === 500) {
            // Handle 500 server errors gracefully
            this.log.error(`Server error (500) - API temporarily unavailable. Status: ${resp.status}, Error: ${properties.error
              ? JSON.stringify(properties.error)
              : 'Internal server error'}`)
            return ERROR_DELAY
          } else if (resp.ok !== true) {
            this.log.warn('Error getting property values.')
            this.log.debug(`Raw API Response (full update): ${resp.response}`)
            this.log.error(`API Error - Status: ${resp.status}, Error: ${properties.error
              ? JSON.stringify(properties.error)
              : 'Unknown error'}`)
            const status = await this.ayla_api.attempt_refresh(attempt)
            if (!status && attempt === 1) {
              return ERROR_DELAY
            } else {
              return await this.update(property_list, attempt + 1)
            }
          } else {
            this._do_update(full_update, properties)
            await this._apply_skegox_state()
            return 0
          }
        } catch (e) {
          this.log.warn('Error processing API response for properties.')
          this.log.debug(`Error Message: ${e}`)
          this.log.debug(`Raw Response: ${resp.response}`)
          return ERROR_DELAY
        }
      }
    } catch (e) {
      this.log.debug('Promise Rejected with updating properties.')
      return ERROR_DELAY
    }
  }

  // Overlay the live state from the newer SharkNinja API onto the local
  // property values, for vacuums that are live on it. Returns whether the
  // overlay happened, so callers know if the Ayla read can be skipped.
  async _apply_skegox_state(): Promise<boolean> {
    if (!this.skegox?.available(this._dsn)) {
      return false
    }
    try {
      const values = await this.skegox.getPropertyValues(this._dsn)
      this.property_values = {
        ...this.property_values,
        ...values,
      }
      const names = Object.keys(values)
      this.log.debug(`Read ${names.length} properties via the new SharkNinja API.`)
      // The names, not just the count. Asking a reporter to look for a property
      // in a log that only ever printed a number wasted a round trip on #41 -
      // "I can't see any mention of a room list" could not have been anything
      // else, because the list of names was never printed.
      this.log.debug(`New-API properties: ${names.sort().join(', ')}`)
      this.log.debug(this.describeRoomList())
      // Values, not just names. Which of the three area-filter generations the
      // vacuum actually acts on can only be found by watching which one changes
      // when a single-room clean is started from the SharkClean app (#41).
      this.log.debug(`Area filters: ${AREA_FILTER_PROPERTIES.map(name => describeAreaFilter(name, values[name])).join(' | ')}`)
      return true
    } catch (error) {
      this.log.debug(`New SharkNinja API state read failed (${error}), falling back to the Ayla API.`)
      return false
    }
  }

  // Update or set properties locally from update function
  _do_update(full_update, properties): void {
    const property_names = properties.map((property) => {
      return property.property.name
    })
    let settable_properties = property_names.map((property_name) => {
      if (property_name.toUpperCase().substring(0, 3) === 'SET') {
        return _clean_property_name(property_name)
      }
      return null
    })
    settable_properties = settable_properties.filter((el) => {
      return el !== null
    })
    const readable_properties = {}
    for (let i = 0; i < properties.length; i++) {
      if (properties[i].property.name.toUpperCase() !== 'SET') {
        const property_name = _clean_property_name(properties[i].property.name)
        readable_properties[property_name] = properties[i]
      }
    }

    if (full_update || this._settable_properties === null) {
      this._settable_properties = settable_properties
    } else {
      const combined_settable_properties = this._settable_properties.concat(settable_properties)
      const result = combined_settable_properties.filter((item, pos) => {
        return combined_settable_properties.indexOf(item) === pos
      })
      this._settable_properties = result
    }

    if (full_update) {
      this.properties_full = {}
    }
    this.properties_full = {
      ...this.properties_full,
      ...readable_properties,
    }

    for (const [key, value] of Object.entries(readable_properties) as [string, any][]) {
      this.property_values[key] = value.property.value
    }
  }

  // Set vacuum operating mode
  async set_operating_mode(mode: number): Promise<void> {
    try {
      const modeName = Object.keys(OperatingModes).find(k => OperatingModes[k] === mode) ?? mode
      this.log.debug(`Setting operating mode to ${modeName} (${mode}).`)
      await this.set_property_value(Properties.OPERATING_MODE, mode)
    } catch {
      this.log.debug('Promise Rejected with setting opertating mode.')
    }
  }

  // Encode room list for specifying multiple rooms
  _encode_room_list(rooms): string {
    if (!rooms) {
      return '*'
    } else if (rooms.length === 0) {
      return '*'
    }

    const room_list = this._get_device_room_list()

    let header = '\x80\x01\x0B\xCA\x02'

    let rooms_enc = ''
    rooms.forEach((room) => {
      rooms_enc += `${String.fromCharCode(room.length) + room}\n`
    })
    rooms_enc = rooms_enc.replace(/\n$/, '')

    const footer = `\x1A${String.fromCharCode(room_list.identifier.length)}${room_list.identifier}`

    const header_byte = String.fromCharCode(0 + 1 + rooms_enc.length + footer.length)
    header += header_byte
    header += '\n'

    const latin1Buffer = transcode(Buffer.from(header + rooms_enc + footer), 'utf8', 'latin1')
    const encoded = Buffer.from(latin1Buffer).toString('base64')
    return encoded
  }

  /**
   * A plain-English line about whether this vacuum reports a room list, for the
   * debug log.
   *
   * Room-specific cleaning (#41) depends entirely on the vacuum publishing
   * `Robot_Room_List`, and that varies by model and by which API the vacuum is
   * live on. This says so directly rather than leaving a reporter to infer it
   * from a property dump.
   */
  describeRoomList(): string {
    return describeRoomList(this.property_values?.[Properties.ROBOT_ROOM_LIST])
  }

  // Get object of the device room list for starting a clean
  _get_device_room_list(): { identifier: string, rooms: string[] } {
    // Many models never report Robot_Room_List at all. This used to call .split()
    // on undefined and throw, which aborted Matter registration entirely and left
    // the owner with no accessories - after the cached HAP ones had already been
    // removed.
    const room_list = this.get_property_value(Properties.ROBOT_ROOM_LIST)
    if (typeof room_list !== 'string' || room_list === '') {
      return { identifier: '', rooms: [] }
    }
    const split = room_list.split(':')
    return {
      identifier: split[0],
      rooms: split.slice(1),
    }
  }

  // Get device room list (will output * for all)
  get_room_list() {
    return this._get_device_room_list().rooms
  }

  // Start the vacuum cleaning
  async clean_rooms(rooms): Promise<void> {
    try {
      // Only write an area filter for a genuine room-specific clean. For a
      // whole-house clean (no rooms) we send START on its own, the same as the
      // physical button and the Shark app. Writing the placeholder '*' area
      // filter first told the vacuum to clean an empty set of areas, so it
      // accepted START but never left the dock (#68).
      if (rooms && rooms.length > 0) {
        // Which generation of the area filter this vacuum listens to decides
        // both the property AND the encoding - V3 is JSON, V2 a binary blob, so
        // the two are not interchangeable (#41).
        const property = chooseAreaFilterProperty(this.property_values)
        const payload = property === 'AreasToClean_V3'
          ? encodeRoomListV3(rooms, this._get_device_room_list().identifier, this.roomCleanOptions)
          : this._encode_room_list(rooms)
        this.log.debug(`Starting a clean of ${rooms.length} room(s) via ${property}: ${payload}`)
        await this.set_property_value(property, payload)
      } else {
        this.log.debug('Starting a whole-house clean.')
      }
      await this.set_operating_mode(OperatingModes.START)
    } catch {
      this.log.debug('Promise Rejected with starting clean.')
    }
  }

  // Stop or cancel a vacuum cleaning
  async cancel_clean(): Promise<void> {
    try {
      await this.set_operating_mode(OperatingModes.RETURN)
    } catch {
      this.log.debug('Promise Rejected with canceling clean.')
    }
  }
}

export { OperatingModes, PowerModes, Properties, SharkIqVacuum }
