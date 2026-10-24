import type { CharacteristicValue, Logger, PlatformAccessory, Service, uuid } from 'homebridge'

import type { SharkIQPlatform } from './platform.js'
import type { SharkIqVacuum } from './sharkiq-js/sharkiq.js'

import { TIMEOUTS, VACUUM_SPEEDS } from './constants.js'
import { createPromiseRejectionHandler } from './errorHandling.js'
import { OperatingModes, PowerModes, Properties } from './sharkiq-js/sharkiq.js'

export class SharkIQAccessory {
  private updateTimer?: ReturnType<typeof setTimeout>
  private service: Service
  private dockedStatusService: Service
  private vacuumPausedService: Service
  private batteryService: Service
  private errorService?: Service
  private waterTankService?: Service
  private mopPlateService?: Service

  constructor(
    private readonly platform: SharkIQPlatform,
    private readonly accessory: PlatformAccessory,
    private device: SharkIqVacuum,
    UUIDGen: typeof uuid,
    private readonly log: Logger,
    private readonly invertDockedStatus: boolean,
    private readonly dockedUpdateInterval: number,
    private readonly showErrorSensor: boolean = false,
    private readonly showWaterTankSensor: boolean = false,
    private readonly showMopPlateSensor: boolean = false,
    private dockedDelay: number = 0,
  ) {
    // Get device serial number
    const serial_number = device._dsn
    const vacuumUUID = UUIDGen.generate(`${serial_number}-vacuum`)
    this.service = this.accessory.getService('Vacuum')
      || this.accessory.addService(this.platform.Service.Fanv2, 'Vacuum', vacuumUUID)

    // Vacuum Name - Default is device name
    this.service.setCharacteristic(this.platform.Characteristic.Name, device._name.toString())

    // // Vacuum Active
    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setVacuumActive.bind(this))
      .onGet(this.getVacuumActive.bind(this))

    // Vacuum Power (Eco, Normal, Max)
    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({
        minStep: VACUUM_SPEEDS.ECO,
        minValue: VACUUM_SPEEDS.OFF,
        maxValue: VACUUM_SPEEDS.MAX,
      })
      .onSet(this.setFanSpeed.bind(this))
      .onGet(this.getFanSpeed.bind(this))

    // Vacuum Docked Status
    this.dockedStatusService = this.accessory.getService('Vacuum Docked')
      || this.accessory.addService(this.platform.Service.ContactSensor, 'Vacuum Docked', 'Docked')
    this.dockedStatusService.setCharacteristic(this.platform.Characteristic.Name, `${device._name.toString()} Docked`)
    this.dockedStatusService.getCharacteristic(this.platform.Characteristic.ContactSensorState)
      .onGet(this.retrieveDockedStatus.bind(this))

    // Vacuum Paused Status
    this.vacuumPausedService = this.accessory.getService('Vacuum Paused')
      || this.accessory.addService(this.platform.Service.Switch, 'Vacuum Paused', 'Paused')
    this.vacuumPausedService.setCharacteristic(this.platform.Characteristic.Name, `${device._name.toString()} Paused`)

    // Vacuum Paused getting and setting state
    this.vacuumPausedService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setPaused.bind(this))
      .onGet(this.getPaused.bind(this))

    // Battery: percentage, charging state and a low-battery warning. The vacuum
    // reports these and nothing surfaced them before (#88).
    this.batteryService = this.accessory.getService('Vacuum Battery')
      || this.accessory.addService(this.platform.Service.Battery, 'Vacuum Battery', 'Battery')
    this.batteryService.setCharacteristic(this.platform.Characteristic.Name, `${device._name.toString()} Battery`)
    this.batteryService.getCharacteristic(this.platform.Characteristic.BatteryLevel)
      .onGet(() => this.device.battery().percent ?? 0)
    this.batteryService.getCharacteristic(this.platform.Characteristic.ChargingState)
      .onGet(() => this.device.battery().charging
        ? this.platform.Characteristic.ChargingState.CHARGING
        : this.platform.Characteristic.ChargingState.NOT_CHARGING)
    this.batteryService.getCharacteristic(this.platform.Characteristic.StatusLowBattery)
      .onGet(() => this.device.battery().low
        ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL)

    // These three are opt-in: each adds a tile to Home, so an existing setup
    // must look exactly as it did until someone asks for them (#88). A fault is
    // logged as a warning either way, so nobody has to enable a sensor to find
    // out why the vacuum stopped.
    //
    // ⚠️ Not StatusFault on the vacuum itself: HAP does not list it as an
    // optional characteristic of Fanv2, so it would only earn a warning.
    if (this.showErrorSensor) {
      this.errorService = this.accessory.getService('Vacuum Error')
        || this.accessory.addService(this.platform.Service.ContactSensor, 'Vacuum Error', 'Error')
      this.errorService.setCharacteristic(this.platform.Characteristic.Name, `${device._name.toString()} Error`)
      this.errorService.getCharacteristic(this.platform.Characteristic.ContactSensorState)
        .onGet(() => this.faultState())
    } else {
      this.removeServiceIfPresent('Vacuum Error')
    }

    if (this.showWaterTankSensor) {
      this.waterTankService = this.accessory.getService('Vacuum Water Tank')
        || this.accessory.addService(this.platform.Service.ContactSensor, 'Vacuum Water Tank', 'WaterTank')
      this.waterTankService.setCharacteristic(this.platform.Characteristic.Name, `${device._name.toString()} Water Tank`)
      this.waterTankService.getCharacteristic(this.platform.Characteristic.ContactSensorState)
        .onGet(() => this.waterTankState())
    } else {
      this.removeServiceIfPresent('Vacuum Water Tank')
    }

    if (this.showMopPlateSensor) {
      this.mopPlateService = this.accessory.getService('Vacuum Mop Plate')
        || this.accessory.addService(this.platform.Service.ContactSensor, 'Vacuum Mop Plate', 'MopPlate')
      this.mopPlateService.setCharacteristic(this.platform.Characteristic.Name, `${device._name.toString()} Mop Plate`)
      this.mopPlateService.getCharacteristic(this.platform.Characteristic.ContactSensorState)
        .onGet(() => this.mopPlateState())
    } else {
      this.removeServiceIfPresent('Vacuum Mop Plate')
    }

    this.updateStates()

    // Retrieve vacuum states
    this.retrieveVacuumStates().then(() => {
      this.retrieveVacuumStateInterval()
    }).catch(() => {
      createPromiseRejectionHandler(this.log, 'first interval update')()
      this.retrieveVacuumStateInterval()
    })
  }

  // Helper method to calculate vacuum docked status based on inversion setting
  private calculateDockedStatus(docked_status: number): boolean {
    if (!this.invertDockedStatus) {
      return docked_status === 1
    } else {
      return docked_status !== 1
    }
  }

  // Retrieve vacuum states interval function.
  //
  // This was a setInterval, which fixes its period when it is created - so the
  // back-off `dockedDelay` picks up after a 429 or an error was written on every
  // poll and read by nothing, and the plugin kept hammering the API at the normal
  // rate while Shark was asking it to slow down. It also could not be cleared, and
  // its async callback could overlap itself on a slow cycle. Rescheduling after
  // each run fixes all three.
  async retrieveVacuumStateInterval(): Promise<void> {
    const runOnce = async () => {
      await this.retrieveVacuumStates()
        .catch(createPromiseRejectionHandler(this.log, 'interval update'))
      this.updateTimer = setTimeout(() => void runOnce(), this.dockedUpdateInterval + this.dockedDelay)
    }

    this.updateTimer = setTimeout(() => void runOnce(), this.dockedUpdateInterval + this.dockedDelay)
  }

  // Stop polling, so the timer does not keep calling the cloud - or hold the
  // process open - after Homebridge has asked the plugin to stop
  public shutdown(): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer)
      this.updateTimer = undefined
    }
  }

  // Retrieve docked status
  async retrieveDockedStatus(): Promise<boolean> {
    this.log.debug('Triggering GET Docked Status')
    await this.device.update(Properties.DOCKED_STATUS)

    const docked_status = this.device.docked_status()
    const vacuumDocked = this.calculateDockedStatus(docked_status)

    return vacuumDocked
  }

  // Retrieve operating mode
  async retrieveOperatingMode(): Promise<void> {
    this.log.debug('Triggering GET Operating Mode')
    await this.device.update(Properties.OPERATING_MODE)
      .then((delay) => {
        this.dockedDelay = delay
      })
  }

  // Retrieve power mode
  async retrievePowerMode(): Promise<void> {
    this.log.debug('Triggering GET Power Mode')
    await this.device.update(Properties.POWER_MODE)
      .then((delay) => {
        this.dockedDelay = delay
      })
  }

  /** Drops a sensor the user has since switched off, so it does not linger. */
  private removeServiceIfPresent(name: string): void {
    const existing = this.accessory.getService(name)
    if (existing) {
      this.accessory.removeService(existing)
    }
  }

  /** Contact "open" while the vacuum is reporting an error code. */
  private faultState(): CharacteristicValue {
    return this.device.fault()
      ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED
  }

  /**
   * Contact "open" when an installed tank has run dry. A vacuum with no tank
   * fitted reads as closed — it is not mopping, so there is nothing to warn about.
   */
  private waterTankState(): CharacteristicValue {
    return this.device.water_tank().needsRefill
      ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED
  }

  /** Contact "closed" while the mop plate is attached. */
  private mopPlateState(): CharacteristicValue {
    return this.device.mop_plate_attached() === false
      ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED
  }

  // Monitor vacuum state function
  async retrieveVacuumStates(): Promise<void> {
    this.log.debug('Triggering GET Vacuum States')
    let vacuumDocked = false

    await this.device.update([
      Properties.DOCKED_STATUS,
      Properties.OPERATING_MODE,
      Properties.POWER_MODE,
      Properties.BATTERY_CAPACITY,
      Properties.CHARGING_STATUS,
      // ⚠️ A characteristic that is never fetched reads as its default forever,
      // so anything surfaced above has to be listed here too (#88).
      Properties.ERROR_CODE,
      Properties.EXTENDED_ERROR_CODE,
      Properties.WATER_TANK_INSTALLED,
      Properties.WATER_TANK_EMPTY,
      Properties.MOP_PLATE_ATTACHED,
    ])
      .then((delay) => {
        this.dockedDelay = delay
      })

    const docked_status = this.device.docked_status()
    vacuumDocked = this.calculateDockedStatus(docked_status)
    const power_mode = this.device.power_mode()
    const mode = this.device.operating_mode()
    const vacuumActive = mode === OperatingModes.START || mode === OperatingModes.STOP
    this.service.updateCharacteristic(this.platform.Characteristic.Active, vacuumActive)
    if (vacuumActive) {
      if (power_mode === PowerModes.MAX) {
        this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, VACUUM_SPEEDS.MAX)
      } else if (power_mode === PowerModes.ECO) {
        this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, VACUUM_SPEEDS.ECO)
      } else {
        this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, VACUUM_SPEEDS.NORMAL)
      }
      if (mode === OperatingModes.STOP) {
        this.vacuumPausedService.updateCharacteristic(this.platform.Characteristic.On, true)
      } else {
        this.vacuumPausedService.updateCharacteristic(this.platform.Characteristic.On, false)
      }
    } else {
      this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, VACUUM_SPEEDS.OFF)
    }
    this.dockedStatusService.updateCharacteristic(this.platform.Characteristic.ContactSensorState, vacuumDocked)

    const battery = this.device.battery()
    if (battery.percent !== undefined) {
      this.batteryService.updateCharacteristic(this.platform.Characteristic.BatteryLevel, battery.percent)
    }
    this.batteryService.updateCharacteristic(
      this.platform.Characteristic.ChargingState,
      battery.charging
        ? this.platform.Characteristic.ChargingState.CHARGING
        : this.platform.Characteristic.ChargingState.NOT_CHARGING,
    )
    this.batteryService.updateCharacteristic(
      this.platform.Characteristic.StatusLowBattery,
      battery.low
        ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    )

    const fault = this.device.fault()
    const waterTank = this.device.water_tank()
    const mopPlateAttached = this.device.mop_plate_attached()
    this.errorService?.updateCharacteristic(this.platform.Characteristic.ContactSensorState, this.faultState())
    this.waterTankService?.updateCharacteristic(this.platform.Characteristic.ContactSensorState, this.waterTankState())
    this.mopPlateService?.updateCharacteristic(this.platform.Characteristic.ContactSensorState, this.mopPlateState())

    // A fault is worth an actual warning - it usually means the vacuum has
    // stopped and is waiting for someone to go and free it.
    if (fault) {
      this.log.warn(`${this.device._name}: ${fault.message}${fault.extendedCode
        ? ` (extended code ${fault.extendedCode})`
        : ''}`)
    }

    this.log.debug('Vacuum Docked:', vacuumDocked, 'Vacuum Active:', vacuumActive, 'Power Mode:', power_mode, 'Battery:', battery.percent ?? 'unknown', battery.charging ? '(charging)' : '')
    this.log.debug(
      'Error code:',
      fault?.code ?? 0,
      '| Water tank installed:',
      waterTank.installed ?? 'not reported',
      'empty:',
      waterTank.empty ?? 'not reported',
      '| Mop plate attached:',
      mopPlateAttached ?? 'not reported',
    )
  }

  // Update paused and active state on switch
  updateStates(): void {
    const mode = this.device.operating_mode()
    if (mode === OperatingModes.START || mode === OperatingModes.STOP) {
      this.service.updateCharacteristic(this.platform.Characteristic.Active, this.platform.Characteristic.Active.ACTIVE)
    } else {
      this.service.updateCharacteristic(this.platform.Characteristic.Active, this.platform.Characteristic.Active.INACTIVE)
    }

    if (mode === OperatingModes.STOP) {
      this.vacuumPausedService.updateCharacteristic(this.platform.Characteristic.On, true)
    } else {
      this.vacuumPausedService.updateCharacteristic(this.platform.Characteristic.On, false)
    }
  }

  // Get paused state
  async getPaused(): Promise<boolean> {
    this.log.debug('Triggering GET Paused')
    await this.retrieveOperatingMode()

    const mode = this.device.operating_mode()
    this.log.debug('State:', mode)
    if (mode === OperatingModes.STOP) {
      return true
    } else {
      return false
    }
  }

  // Set paused state
  async setPaused(value: CharacteristicValue): Promise<void> {
    this.log.debug('Triggering SET Paused. Paused:', value)

    const mode = this.device.operating_mode()
    if (mode === OperatingModes.START || mode === OperatingModes.STOP) {
      if (value) {
        await this.device.set_operating_mode(OperatingModes.STOP)
          .catch(createPromiseRejectionHandler(this.log, 'setting operating mode'))
      } else {
        await this.device.set_operating_mode(OperatingModes.START)
          .catch(createPromiseRejectionHandler(this.log, 'setting operating mode'))
      }
    } else {
      setTimeout(() => {
        this.vacuumPausedService.updateCharacteristic(this.platform.Characteristic.On, false)
      }, TIMEOUTS.PAUSED_UPDATE_DELAY)
    }
  }

  // Check if the vacuum is active for UI
  async getVacuumActive(): Promise<boolean> {
    this.log.debug('Triggering GET Vacuum Active')

    const mode = this.device.operating_mode()
    if (mode === OperatingModes.START || mode === OperatingModes.STOP) {
      return true
    } else {
      return false
    }
  }

  // Set the vacuum state by UI
  async setVacuumActive(value: CharacteristicValue): Promise<void> {
    this.log.debug('Triggering SET Vacuum Active')

    const mode = this.device.operating_mode()
    const running = mode === OperatingModes.START || mode === OperatingModes.STOP

    if (value) {
      // Turning on: start cleaning if it isn't already running. Previously this
      // handler only did anything when turning OFF, so switching the vacuum on
      // sent no command and HomeKit immediately reverted the control to off (#68).
      // Reuse the current fan speed, defaulting to max when none is set.
      if (!running) {
        const currentSpeed = Number(this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed).value)
        const speed = currentSpeed > VACUUM_SPEEDS.OFF
          ? currentSpeed
          : VACUUM_SPEEDS.MAX
        await this.setFanSpeed(speed)
          .catch(createPromiseRejectionHandler(this.log, 'starting the vacuum'))
      }
    } else {
      // Turning off: stop cleaning.
      if (running) {
        await this.setFanSpeed(0)
          .catch(createPromiseRejectionHandler(this.log, 'setting fan speed'))
      }
    }
  }

  // Get vacuum power for UI
  async getFanSpeed(): Promise<number> {
    this.log.debug('Triggering GET Fan Speed')
    await this.retrievePowerMode()

    const mode = this.device.operating_mode()
    const vacuumActive = mode === OperatingModes.START || mode === OperatingModes.STOP
    if (vacuumActive) {
      const power_mode = this.device.power_mode()
      if (power_mode === PowerModes.MAX) {
        return VACUUM_SPEEDS.MAX
      } else if (power_mode === PowerModes.ECO) {
        return VACUUM_SPEEDS.ECO
      } else {
        return VACUUM_SPEEDS.NORMAL
      }
    } else {
      return VACUUM_SPEEDS.OFF
    }
  }

  // Set vacuum power from UI (and start/stop vacuum if needed)
  async setFanSpeed(value: CharacteristicValue): Promise<void> {
    this.log.debug('Triggering SET Fan Speed. Value:', value)

    let power_mode = PowerModes.NORMAL
    if (value === VACUUM_SPEEDS.ECO) {
      power_mode = PowerModes.ECO
    } else if (value === VACUUM_SPEEDS.MAX) {
      power_mode = PowerModes.MAX
    } else if (value === VACUUM_SPEEDS.OFF) {
      await this.device.cancel_clean()
        .catch(createPromiseRejectionHandler(this.log, 'cancel cleaning update'))
      this.service.updateCharacteristic(this.platform.Characteristic.Active, this.platform.Characteristic.Active.INACTIVE)
      this.vacuumPausedService.updateCharacteristic(this.platform.Characteristic.On, false)
      return
    }
    const isPaused = await this.getPaused()
    if (isPaused) {
      await this.device.set_operating_mode(OperatingModes.START)
        .catch(() => {
          this.log.debug('Promise Rejected with setting operating mode.')
        })
      this.vacuumPausedService.updateCharacteristic(this.platform.Characteristic.On, false)
    }
    await this.device.set_property_value(Properties.POWER_MODE, power_mode)
      .catch(createPromiseRejectionHandler(this.log, 'powermode update'))
    const mode = this.device.operating_mode()
    if (mode !== OperatingModes.START && mode !== OperatingModes.STOP) {
      this.service.updateCharacteristic(this.platform.Characteristic.Active, this.platform.Characteristic.Active.ACTIVE)
      await this.device.clean_rooms([])
        .catch(createPromiseRejectionHandler(this.log, 'start cleaning update'))
    }
  }
}
