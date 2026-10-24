import { describe, expect, it } from 'vitest'

import { Properties } from './properties.js'
import { AREA_FILTER_PROPERTIES, areaIdsToRoomNames, buildServiceAreaCluster, buildSupportedAreas, chooseAreaFilterProperty, describeAreaFilter, describeRoomList, encodeRoomListV3, ROOM_CLEAN_DEFAULTS, ROOM_CLEAN_PRESETS } from './sharkiq.js'

/**
 * Room-specific cleaning (#41) depends on the vacuum publishing
 * `Robot_Room_List`, which varies by model and by which API it is live on.
 *
 * These cover the log line that reports it. It exists because the plugin used
 * to log only a property *count* ("Read 77 properties"), so when a reporter was
 * asked to look for a room list there was nothing to find either way — an
 * absent list and an unlogged one looked identical.
 */
describe('describeRoomList', () => {
  it('says plainly when the vacuum does not report a room list', () => {
    const line = describeRoomList(undefined)
    expect(line).toContain('not reported by this vacuum')
    expect(line).toContain('room-specific cleaning is not available')
  })

  it('treats an empty string as not reported, not as zero rooms', () => {
    expect(describeRoomList('')).toContain('not reported by this vacuum')
  })

  it('treats null and a non-string as not reported', () => {
    expect(describeRoomList(null)).toContain('not reported by this vacuum')
    expect(describeRoomList(42)).toContain('not reported by this vacuum')
  })

  it('lists the map identifier and the room names when they are there', () => {
    const line = describeRoomList('map1:Kitchen:Hallway:Lounge')
    expect(line).toContain('map "map1"')
    expect(line).toContain('3 room(s)')
    expect(line).toContain('Kitchen, Hallway, Lounge')
  })

  it('distinguishes a map with no rooms from no map at all', () => {
    expect(describeRoomList('map1')).toContain('no rooms in it')
    expect(describeRoomList('map1')).not.toContain('not reported')
  })

  it('names the property so it can be searched for in a log', () => {
    expect(describeRoomList(undefined)).toContain(Properties.ROBOT_ROOM_LIST)
    expect(describeRoomList('map1:Kitchen')).toContain(Properties.ROBOT_ROOM_LIST)
  })
})

/**
 * The area filter (#41). A vacuum can report three generations of the same
 * property; the plugin writes V2, and only a live test can show which one the
 * firmware honours. These cover the log rendering used to find that out.
 */
describe('describeAreaFilter', () => {
  it('lists the three generations oldest first', () => {
    expect([...AREA_FILTER_PROPERTIES]).toEqual(['Areas_To_Clean', 'AreasToClean_V2', 'AreasToClean_V3'])
  })

  it('includes the property the plugin actually writes', () => {
    expect(AREA_FILTER_PROPERTIES).toContain(Properties.AREAS_TO_CLEAN)
  })

  it('distinguishes not reported from empty', () => {
    expect(describeAreaFilter('AreasToClean_V2', undefined)).toBe('AreasToClean_V2: not reported')
    expect(describeAreaFilter('AreasToClean_V2', '')).toBe('AreasToClean_V2: empty')
    expect(describeAreaFilter('AreasToClean_V2', null)).toBe('AreasToClean_V2: empty')
  })

  it('renders control bytes as hex rather than dumping them into the log', () => {
    // the encoded room list is length-prefixed and carries control characters
    const encoded = '\x0A\x07Kitchen\x1A\x086ABE3ECC'
    const line = describeAreaFilter('AreasToClean_V3', encoded)
    expect(line).toContain('hex=0a074b69746368656e1a083641424533454343')
    // the printable rendering keeps the room name readable without breaking the log
    expect(line).toContain('printable="..Kitchen..6ABE3ECC"')
    expect(line).toContain(`${encoded.length} byte(s)`)
  })

  it('keeps a plain value readable', () => {
    expect(describeAreaFilter('Areas_To_Clean', '*')).toContain('printable="*"')
  })
})

/**
 * The V3 area filter (#41).
 *
 * Reverse-engineered from one capture, so the observed payload is pinned
 * byte-for-byte: a Kitchen clean started from the SharkClean app on an
 * RV2800AF-UK sent exactly the string asserted below.
 */
describe('encodeRoomListV3', () => {
  // Both payloads are pinned in the presets block below; this block covers the
  // encoder's own behaviour with whatever preset it is given.

  it('uses the key order the app sends', () => {
    expect(Object.keys(JSON.parse(encodeRoomListV3(['Kitchen'], '6ABE3ECC'))))
      .toEqual([
        'areas_to_clean',
        'clean_count',
        'floor_id',
        'cleantype',
      ])
  })

  it('carries several rooms in one request', () => {
    const parsed = JSON.parse(encodeRoomListV3(['Kitchen', 'Hallway'], '6ABE3ECC'))
    expect(parsed.areas_to_clean.UserRoom).toEqual(['Kitchen', 'Hallway'])
  })

  it('keeps room names verbatim, including spaces', () => {
    // "Dining Room" and "Downstairs Toilet" are real names off his map - escaping
    // or slugifying them would not match what the app sends
    const parsed = JSON.parse(encodeRoomListV3(['Dining Room', 'Downstairs Toilet'], '6ABE3ECC'))
    expect(parsed.areas_to_clean.UserRoom).toEqual(['Dining Room', 'Downstairs Toilet'])
  })

  it('takes the floor id from the caller, which is the room list map identifier', () => {
    expect(JSON.parse(encodeRoomListV3(['Kitchen'], 'DEADBEEF')).floor_id).toBe('DEADBEEF')
  })

  it('allows the mode, pass count and clean type to be overridden', () => {
    const parsed = JSON.parse(encodeRoomListV3(['Kitchen'], 'F1', { mode: 'Eco', cleanCount: 1, cleanType: 'wet' }))
    expect(parsed.areas_to_clean).toEqual({
      Eco: ['Kitchen'],
    })
    expect(parsed.clean_count).toBe(1)
    expect(parsed.cleantype).toBe('wet')
  })

  it('produces valid JSON with no control bytes, unlike the V2 encoder', () => {
    const payload = encodeRoomListV3(['Kitchen'], '6ABE3ECC')
    expect(() => JSON.parse(payload)).not.toThrow()
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x1F]/.test(payload)).toBe(false)
  })
})

describe('chooseAreaFilterProperty', () => {
  it('uses V3 when the vacuum reports it', () => {
    // his vacuum reports both, and V2 stayed at "*" for the whole clean
    expect(chooseAreaFilterProperty({ AreasToClean_V2: '*', AreasToClean_V3: '*' })).toBe('AreasToClean_V3')
  })

  it('falls back to V2 for a vacuum that never reports V3', () => {
    expect(chooseAreaFilterProperty({ AreasToClean_V2: '*' })).toBe('AreasToClean_V2')
  })

  it('treats an empty V3 value as still being on V3', () => {
    // reporting the property at all is the signal - its value is irrelevant
    expect(chooseAreaFilterProperty({ AreasToClean_V3: '' })).toBe('AreasToClean_V3')
  })

  it('falls back to V2 when nothing is known yet', () => {
    expect(chooseAreaFilterProperty(undefined)).toBe('AreasToClean_V2')
    expect(chooseAreaFilterProperty({})).toBe('AreasToClean_V2')
  })
})

/**
 * Mapping the vacuum's rooms onto Matter's ServiceArea cluster (#41).
 */
const HIS_ROOMS = [
  'Kitchen',
  'Dining Room',
  'Living Room',
  'Hallway',
  'Downstairs Toilet',
]

describe('buildSupportedAreas', () => {
  it('turns the room list into one area each, ids starting at 1', () => {
    const areas = buildSupportedAreas(HIS_ROOMS)
    expect(areas).toHaveLength(5)
    expect(areas.map(a => a.areaId)).toEqual([1, 2, 3, 4, 5])
    expect(areas[0].areaInfo.locationInfo.locationName).toBe('Kitchen')
    expect(areas[4].areaInfo.locationInfo.locationName).toBe('Downstairs Toilet')
  })

  it('never uses area id 0, which some controllers read as unset', () => {
    expect(buildSupportedAreas(HIS_ROOMS).some(a => a.areaId === 0)).toBe(false)
  })

  it('gives every area the shape the cluster requires', () => {
    const [area] = buildSupportedAreas(['Kitchen'])
    expect(area.mapId).toBeNull()
    expect(area.areaInfo.landmarkInfo).toBeNull()
    expect(area.areaInfo.locationInfo.floorNumber).toBeNull()
    expect(area.areaInfo.locationInfo.areaType).toBeNull()
  })

  it('produces nothing for a vacuum with no rooms', () => {
    expect(buildSupportedAreas([])).toEqual([])
  })
})

describe('areaIdsToRoomNames', () => {
  it('maps a selection back to the names the vacuum expects', () => {
    expect(areaIdsToRoomNames([1, 4], HIS_ROOMS)).toEqual(['Kitchen', 'Hallway'])
  })

  it('round trips through buildSupportedAreas', () => {
    const areas = buildSupportedAreas(HIS_ROOMS)
    const ids = areas.map(a => a.areaId)
    expect(areaIdsToRoomNames(ids, HIS_ROOMS)).toEqual(HIS_ROOMS)
  })

  it('keeps the order the controller asked for, not the map order', () => {
    expect(areaIdsToRoomNames([4, 1], HIS_ROOMS)).toEqual(['Hallway', 'Kitchen'])
  })

  it('drops ids that are not on the map rather than throwing', () => {
    // a stale selection after a map was renamed should still clean what it can
    expect(areaIdsToRoomNames([1, 99], HIS_ROOMS)).toEqual(['Kitchen'])
  })

  it('returns nothing for an all-stale selection, which callers treat as whole-house', () => {
    expect(areaIdsToRoomNames([98, 99], HIS_ROOMS)).toEqual([])
  })

  it('ignores id 0 and negatives', () => {
    expect(areaIdsToRoomNames([0, -1, 2], HIS_ROOMS)).toEqual(['Dining Room'])
  })

  it('handles an empty selection', () => {
    expect(areaIdsToRoomNames([], HIS_ROOMS)).toEqual([])
  })
})

/**
 * The cluster object handed to Matter (#41).
 *
 * ⚠️ These exist because `1.6.2-beta.4` shipped a ServiceArea cluster with no
 * `supportedMaps`. matter.js calls `maps.length` on it unguarded, so the
 * behaviour threw "Cannot read properties of undefined (reading 'length')", the
 * whole endpoint rolled back, and the vacuum went to No Response in Home.
 *
 * `buildSupportedAreas` was well covered at the time. The bug was in the object
 * around it, which nothing tested — so these assert the shape actually passed to
 * Matter, and restate matter.js's own validation rules so they fail here rather
 * than on a user's bridge.
 */
describe('buildServiceAreaCluster', () => {
  it('always includes supportedMaps, which matter.js reads unguarded', () => {
    const cluster = buildServiceAreaCluster(HIS_ROOMS)
    expect(cluster.supportedMaps).toBeDefined()
    expect(Array.isArray(cluster.supportedMaps)).toBe(true)
  })

  it('includes supportedMaps even with no rooms', () => {
    expect(buildServiceAreaCluster([]).supportedMaps).toEqual([])
  })

  it('declares every attribute the cluster needs, none undefined', () => {
    const cluster = buildServiceAreaCluster(HIS_ROOMS)
    for (const key of ['supportedAreas', 'supportedMaps', 'selectedAreas'] as const) {
      expect(cluster[key], key).toBeDefined()
    }
  })

  it('starts with nothing selected', () => {
    expect(buildServiceAreaCluster(HIS_ROOMS).selectedAreas).toEqual([])
  })

  // matter.js: "Areas must not have a null mapId when supportedMaps is defined",
  // and conversely with no maps every mapId must be null and all the same.
  it('leaves every mapId null, as an empty supportedMaps requires', () => {
    const cluster = buildServiceAreaCluster(HIS_ROOMS)
    expect(cluster.supportedMaps).toHaveLength(0)
    expect(cluster.supportedAreas.every(a => a.mapId === null)).toBe(true)
    expect(new Set(cluster.supportedAreas.map(a => a.mapId)).size).toBe(1)
  })

  // matter.js: "AreaID <n> is not unique"
  it('gives every area a unique id', () => {
    const ids = buildServiceAreaCluster(HIS_ROOMS).supportedAreas.map(a => a.areaId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  // matter.js: "Areas must have a unique AreaInfo field"
  it('gives every area a distinct areaInfo', () => {
    const infos = buildServiceAreaCluster(HIS_ROOMS).supportedAreas.map(a => JSON.stringify(a.areaInfo))
    expect(new Set(infos).size).toBe(infos.length)
  })

  // matter.js: "Area <n> has no location info"
  it('gives every area a usable location name', () => {
    for (const area of buildServiceAreaCluster(HIS_ROOMS).supportedAreas) {
      expect(area.areaInfo.locationInfo).not.toBeNull()
      expect(area.areaInfo.locationInfo.locationName).not.toBe('')
    }
  })
})

/**
 * The two room-clean presets (#41).
 *
 * Both payloads were captured from the same vacuum: selecting a room in the
 * SharkClean app offers "Clean" and "Matrix Clean", and they differ in more than
 * a label. `UltraClean` was the first one seen and was briefly the default,
 * which quietly turned every HomeKit room clean into a two-pass Matrix Clean.
 */
describe('room clean presets', () => {
  const STANDARD = '{"areas_to_clean":{"UserRoom":["Kitchen"]},"clean_count":1,"floor_id":"6ABE3ECC","cleantype":"dry"}'
  const MATRIX = '{"areas_to_clean":{"UltraClean":["Kitchen"]},"clean_count":2,"floor_id":"6ABE3ECC","cleantype":"dry"}'

  it('defaults to a plain clean, not Matrix Clean', () => {
    expect(ROOM_CLEAN_DEFAULTS).toEqual(ROOM_CLEAN_PRESETS.standard)
    expect(ROOM_CLEAN_DEFAULTS.mode).toBe('UserRoom')
    expect(ROOM_CLEAN_DEFAULTS.cleanCount).toBe(1)
  })

  it('reproduces the app\'s plain "Clean" payload byte for byte', () => {
    expect(encodeRoomListV3(['Kitchen'], '6ABE3ECC')).toBe(STANDARD)
    expect(encodeRoomListV3(['Kitchen'], '6ABE3ECC').length).toBe(99)
  })

  it('reproduces the app\'s "Matrix Clean" payload byte for byte', () => {
    expect(encodeRoomListV3(['Kitchen'], '6ABE3ECC', ROOM_CLEAN_PRESETS.matrix)).toBe(MATRIX)
    expect(encodeRoomListV3(['Kitchen'], '6ABE3ECC', ROOM_CLEAN_PRESETS.matrix).length).toBe(101)
  })

  it('keeps the two presets genuinely different', () => {
    // if these ever converge, one of the app's two buttons is not being honoured
    expect(ROOM_CLEAN_PRESETS.standard.mode).not.toBe(ROOM_CLEAN_PRESETS.matrix.mode)
    expect(ROOM_CLEAN_PRESETS.standard.cleanCount).not.toBe(ROOM_CLEAN_PRESETS.matrix.cleanCount)
  })
})
