# Changelog

All notable changes to this project will be documented in this file. This project uses [Semantic Versioning](https://semver.org/)

## v1.6.6 (2026-10-18)

### Changed

- chore(deps): dependency updates

## v1.6.5 (2026-08-21)

### Changed

- fix: add vacuums that only appear on the newer sharkninja api, instead of finding none at all
- fix: give a vacuum the newer api has no name for a real name, instead of calling it unnamed
- chore(deps): dependency updates

## v1.6.4 (2026-08-09)

### Changed

- chore: remove personal funding links
- docs: add node 26 to the supported node versions
- chore: exclude test files and the test config from the published package
- fix: remove every stale accessory, instead of skipping every other one
- fix: keep the vacuums when the account list comes back empty
- fix: stop writing login tokens into the debug log
- fix: register a vacuum that does not report a room list, instead of failing outright
- fix: stop claiming an email and password login the plugin does not have
- fix: back off when shark asks the plugin to slow down, and stop polling on shutdown
- fix: drop the unreachable email and password login path, which could never run
- fix: clamp the docked update interval, so a very large value cannot make it poll every millisecond
- chore(deps): dependency updates

## v1.6.3 (2026-07-31)

### Changed

- feat: report battery level and charging state, and expose the eco, normal and max suction levels over matter (#88)
- fix(matter): tag the suction levels as vacuum modes, so the accessory registers instead of showing as no response (#88)
- feat: report errors, water tank and mop plate state over both hap and matter (#88)
- fix(matter): refresh the vacuum state shortly after a command, so home reflects it straight away instead of up to a poll later (#88)
- fix(matter): show the battery while the vacuum is charging, and put the normal suction level back in the home mode list (#88)
- fix(matter): actually pause the vacuum when home asks, and make play sound to locate work (#88)

## v1.6.2 (2026-07-30)

### Changed

- chore: keep test files out of the published package
- chore(github): run the build and tests in ci, on node 22, 24 and 26
- chore: use the same lint setup across every plugin
- chore: add a changelog:sync script to populate the pending section from the commits
- chore: count a repeated commit subject once when syncing the changelog
- chore(github): check the changelog against the commits in ci
- chore(deps): dependency updates
- fix: explain that a failed code exchange usually means the login code was already used or has expired, instead of reporting a bare http error (#84)
- chore: log which properties the new api returns, and whether the vacuum reports a room list (#41)
- chore: log the value of all three area filter properties, to find which one the vacuum acts on (#41)
- feat: clean individual rooms, selectable from the matter service area, using the newer json area filter the vacuum expects (#41)
- fix(matter): declare supportedMaps on the service area cluster, so a vacuum with rooms registers instead of showing as no response (#41)
- fix: use the app's plain room clean by default instead of matrix clean, with a config option for matrix clean (#41)

## v1.6.1 (2026-07-28)

### Changed

- fix: use the european callback address when the eu region is selected, so the login page no longer rejects it as an allowed callback url (#85)
- docs(github): name this plugin's devices in the issue forms instead of meater
- fix: do not crash the whole plugin when a vacuum does not report a model or serial number (#85)
- fix(schema): declare required fields the standard way so the homebridge ui stops reporting a config validation failure
- chore: declare the supports-hap transport keyword for the homebridge ui
- fix: ignore non-vacuum appliances on your sharkninja account, instead of adding them to homekit as vacuums (#85)
- chore(deps): dependency updates

## v1.6.0 (2026-07-25)

### Changed

- fix: actually start the vacuum when its control is switched on, instead of the switch doing nothing and reverting to off (#68)
- fix(matter): handle the home app's play, pause and dock buttons, so the vacuum responds instead of rejecting the command (#68)
- fix: start a whole-house clean with just the start command, so the vacuum actually leaves the dock instead of being told to clean no areas (#68)
- chore: log the start command and whether shark accepts it in debug mode, to diagnose a vacuum that will not leave the dock from homekit (#68)
- style(ui): standardise the custom ui layout and sync the support tab with the readme
- fix(ui): fall back to the older copy command when the clipboard api is unavailable, so the oauth url copy button works over plain http (#84)
- feat: send vacuum commands through the newer sharkninja api that the current sharkclean app uses, so newer vacuums actually respond, keeping ayla as the fallback (#68)
- chore: log whether each vacuum is live on the new api and read the state back after a mode command, to diagnose a start command that the api accepts but the vacuum ignores (#68)
- feat: read the vacuum state from the newer sharkninja api too, so homekit shows the true cleaning status for vacuums that no longer report to ayla (#68)
- chore(deps): dependency updates

## v1.5.2 (2026-07-22)

### Changed

- chore(github): release on a published github release, not every push to latest
- chore(github): align workflows, funding and issue templates with the other org plugins
- chore: standardise the eslint setup and apply the org lint rules
- chore: align the npm publishing files with the other org plugins
- chore: standardise the package manifest with the other org plugins
- docs: add claude and copilot instructions files
- docs: use the standard org readme banner
- chore(deps): dependency updates
- fix(matter): include the required error state so the robot vacuum registers over matter (#79)
- fix: match configured vacuum DSNs ignoring case and spaces, and log the discovered DSNs to make configuration easier (#64, #70)
- fix: add every vacuum on the account when no DSNs are configured, instead of erroring out (the documented single-vacuum workaround) (#64, #68)
- fix(ui): register the OAuth login handlers with the leading slash the UI calls, so "Generate Login URL" no longer fails with "No Registered Handler" (#18)
- fix(matter): drop the operational state labels that newer Matter rejects, so the robot vacuum registers over Matter again (#83)

## [1.5.0](https://github.com/homebridge-plugins/homebridge-sharkiq/compare/tag/v1.5.0) (2026-05-04)

### Enhancements
- Add and document Matter and HomeKit integration guidance.
- Add implementation reference for Home Assistant SharkIQ integration.
- Add Homebridge UI OAuth Assistant to generate login URL and exchange callback code.

### Bug Fixes
- Replace `undici` usage with native Node.js fetch APIs.

### Maintenance
- Remove unused dependencies and type packages.
- Refresh dependency versions and lockfile metadata.
- Remove Puppeteer-based login automation dependencies.

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-sharkiq/compare/v1.4.1...v1.5.0

## [1.4.1](https://github.com/homebridge-plugins/homebridge-sharkiq/compare/tag/v1.4.1) (2025-07-24)

### Bug Fixes
- Improve login and API request stability.

### Documentation
- Clarify OAuth manual login instructions and update setup references.

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-sharkiq/compare/v1.4.0...v1.4.1

## [1.4.0](https://github.com/homebridge-plugins/homebridge-sharkiq/releases/tag/v1.4.0) (2025-07-17)

### What's Changes
- Convert to ESModule
- Fix JSON parsing errors in SharkIQ API responses [#44](https://github.com/homebridge-plugins/homebridge-sharkiq/pull/44) [@mmenanno](https://github.com/mmenanno)
- Housekeeping and updated dependencies.

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-sharkiq/compare/v1.3.2...v1.4.0

# ## [1.3.2](https://github.com/homebridge-plugins/homebridge-sharkiq/releases/tag/v1.3.2) (2024-10-29)

### What's Changed
- Show warning messages if manual login is required

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-sharkiq/compare/v1.3.1...v1.3.2

# ## [1.3.1](https://github.com/homebridge-plugins/homebridge-sharkiq/releases/tag/v1.3.1) (2024-09-29)

### What's Changed
- Development by [@Bubba8291](https://github.com/Bubba8291) in [#21](https://github.com/homebridge-plugins/homebridge-sharkiq/pull/21)
- Email and password login working again [#18](https://github.com/homebridge-plugins/homebridge-sharkiq/issues/18)
- Manual login still works as well
- Homebridge 2.0 support [#22](https://github.com/homebridge-plugins/homebridge-sharkiq/issues/22)

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-sharkiq/compare/v1.2.3...v1.3.1

# ## [1.2.3](https://github.com/homebridge-plugins/homebridge-sharkiq/releases/tag/v1.2.3) (2024-08-28)

### What's Changed
- Fixed the small chance of get fan speed generating errors
- Stores the date of the expiration rather than the amount of seconds until the auth token expiration ([#18](https://github.com/homebridge-plugins/homebridge-sharkiq/issues/18))

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-sharkiq/compare/v1.2.2...v1.2.3

# ## [1.2.2](https://github.com/homebridge-plugins/homebridge-sharkiq/releases/tag/v1.2.2) (2024-08-24)

### What's Changed
- Log location of auth file to user if errors relating to refresh continue

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-sharkiq/compare/v1.2.1...v1.2.2

# ## [1.2.1](https://github.com/homebridge-plugins/homebridge-sharkiq/releases/tag/v1.2.1) (2024-08-24)

### What's Changed
- Added specific debug error messages from API

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-sharkiq/compare/v1.2.0...v1.2.1

# ## [1.2.0](https://github.com/homebridge-plugins/homebridge-sharkiq/releases/tag/v1.2.0) (2024-08-19)

### What's Changed
- Switched to new Shark login method [#17](https://github.com/homebridge-plugins/homebridge-sharkiq/issues/17)

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-sharkiq/compare/v1.1.3...v1.2.0

# ## [1.1.3](https://github.com/homebridge-plugins/homebridge-sharkiq/releases/tag/v1.1.3) (2024-08-10)

### What's Changed
- Make API errors more descriptive

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-sharkiq/compare/v1.1.2...v1.1.3

# ## [1.1.2](https://github.com/homebridge-plugins/homebridge-sharkiq/releases/tag/v1.1.2) (2023-10-27)

### What's Changed
- Vacuums are now obtained from their device serial numbers (DSN)

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-sharkiq/compare/v1.1.1...v1.1.2

# ## [1.1.1](https://github.com/homebridge-plugins/homebridge-sharkiq/releases/tag/v1.1.1) (2023-10-25)

### What's Changed
- Added support for the SharkClean European server

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-sharkiq/compare/v1.1.0...v1.1.1

# ## [1.1.0](https://github.com/homebridge-plugins/homebridge-sharkiq/releases/tag/v1.1.0) (2023-10-09)

### What's Changed
- Fixed an issue where the plugin would slow down Homebridge [#8](https://github.com/homebridge-plugins/homebridge-sharkiq/issues/8)
- Changed the http client to `node-fetch`
- Fixed an issue where the vacuum states would not consistently update in Homebridge if controlled from the SharkClean mobile app
- Heavily optimized the plugin code
- Added a config option to change the interval on how often the docked status updates
- Changed the minimum Homebridge version to `1.6.1` [#9](https://github.com/homebridge-plugins/homebridge-sharkiq/pull/9)
- Updated the plugin to work on both Node versions 18 and 20 [#9](https://github.com/homebridge-plugins/homebridge-sharkiq/pull/9)

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-sharkiq/compare/v1.0.9...v1.1.0

# ## [1.0.9](https://github.com/homebridge-plugins/homebridge-sharkiq/releases/tag/v1.0.9) (2023-09-01)

### What's Changed
- Optimized code for parsing config

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-sharkiq/compare/v1.0.8...v1.0.9

# ## [1.0.8](https://github.com/homebridge-plugins/homebridge-sharkiq/releases/tag/v1.0.8) (2023-09-01)

### What's Changed
- Updated README to include badge
- Added donation link

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-sharkiq/compare/v1.0.7...v1.0.8

# ## [1.0.7](https://github.com/homebridge-plugins/homebridge-sharkiq/releases/tag/v1.0.7) (2023-09-01)

### What's Changed
- Updated `README`

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-sharkiq/compare/v1.0.6...v1.0.7

# ## [1.0.6](https://github.com/homebridge-plugins/homebridge-sharkiq/releases/tag/v1.0.6) (2023-09-01)

### What's Changed
- Updated the README to make the json config easier to understand
- Updated the `config.schema.json` to fix a bug in the Homebridge config UI
- Updated `package.json` and removed a dev dependency that is no longer needed

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-sharkiq/compare/v1.0.5...v1.0.6

# ## [1.0.5](https://github.com/homebridge-plugins/homebridge-sharkiq/releases/tag/v1.0.5) (2023-08-31)

### What's Changed
- Minor fixes and improvements to config and documentation

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-sharkiq/compare/v1.0.4...v1.0.5

# ## [1.0.4](https://github.com/homebridge-plugins/homebridge-sharkiq/releases/tag/v1.0.4) (2023-08-30)

### What's Changed
- Added invert docked status option
- Bug fixes for auth token

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-sharkiq/compare/v1.0.3...v1.0.4

# ## [1.0.3](https://github.com/homebridge-plugins/homebridge-sharkiq/releases/tag/v1.0.3) (2023-08-29)

### What's Changed
- Various bug fixes and documentation updates

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-sharkiq/compare/v1.0.2...v1.0.3

# ## [1.0.2](https://github.com/homebridge-plugins/homebridge-sharkiq/releases/tag/v1.0.2) (2023-08-28)

### What's Changed
- Minor updates to config and formatting

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-sharkiq/compare/v1.0.1...v1.0.2

# ## [1.0.1](https://github.com/homebridge-plugins/homebridge-sharkiq/releases/tag/v1.0.1) (2023-08-27)

### What's Changed
- Initial public release

**Full Changelog**: https://github.com/homebridge-plugins/homebridge-sharkiq/compare/df61287...v1.0.1
