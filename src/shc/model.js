// -----------------------------------------------------------------------------
// What the controller answers, read into plain values.
//
// The controller describes each device (`GET /devices`: id, model, name, room,
// status) and each service of each device (`GET /services` and the long-poll
// events: `DeviceServiceData` with a `state` and, for batteries, `faults`).
// This module knows which models the integration supports and how to read
// the few states it publishes; it knows nothing about Gladys.
//
// The model list and the meaning of the states follow boschshcpy
// (BSD-3-Clause) and the public local API documentation of Bosch.
// -----------------------------------------------------------------------------

/** The device families the integration supports, by Bosch device model. */
export const KIND_BY_MODEL = Object.freeze({
  ROOM_CLIMATE_CONTROL: 'climate',
  TRV: 'radiator',
  TRV_GEN2: 'radiator',
  TRV_GEN2_DUAL: 'radiator',
  THB: 'room_thermostat',
  BWTH: 'room_thermostat',
  BWTH24: 'room_thermostat',
  RTH2_BAT: 'room_thermostat',
  RTH2_230: 'room_thermostat',
  SWD: 'contact',
  SWD2: 'contact',
  SWD2_PLUS: 'contact',
  SWD2_DUAL: 'contact',
  MD: 'motion',
  MD2: 'motion',
  SD: 'smoke',
  SMOKE_DETECTOR2: 'smoke',
  PSM: 'plug',
  PLUG_COMPACT: 'plug',
  PLUG_COMPACT_DUAL: 'plug',
  BSM: 'switch',
  MICROMODULE_LIGHT_ATTACHED: 'switch',
  MICROMODULE_LIGHT_CONTROL: 'switch',
  MICROMODULE_RELAY: 'switch',
  BBL: 'shutter',
  MICROMODULE_SHUTTER: 'shutter',
  MICROMODULE_AWNING: 'shutter',
  MICROMODULE_BLINDS: 'shutter',
  WLS: 'leak',
  WRC2: 'button',
  SWITCH2: 'button',
});

export const KINDS = Object.freeze([...new Set(Object.values(KIND_BY_MODEL))]);

/** The intrusion detection system is not a device of /devices: its own id. */
export const INTRUSION_ID = 'intrusionDetectionSystem';

/** Device availability (the `status` of a device). */
export const isAvailable = (device) => device.status === undefined || device.status === 'AVAILABLE';

const finite = (value) => {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
};

const round = (value, decimals) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

// --- States ---------------------------------------------------------------------
// Each reader takes the `DeviceServiceData` of the service and returns a plain
// value, or null when the state does not say (a missing or unknown field).

export const read = {
  /** TemperatureLevel → °C */
  temperature(service) {
    const value = finite(service?.state?.temperature);
    return value === null ? null : round(value, 1);
  },
  /** HumidityLevel → % */
  humidity(service) {
    const value = finite(service?.state?.humidity);
    return value === null ? null : round(Math.min(100, Math.max(0, value)), 1);
  },
  /** RoomClimateControl → °C */
  setpoint(service) {
    const value = finite(service?.state?.setpointTemperature);
    return value === null ? null : round(value, 1);
  },
  /** RoomClimateControl → 'off' (summer mode) | 'manual' | 'automatic' */
  heatingMode(service) {
    const state = service?.state;
    if (!state) {
      return null;
    }
    if (state.summerMode === true) {
      return 'off';
    }
    if (state.operationMode === 'AUTOMATIC') {
      return 'automatic';
    }
    if (state.operationMode === 'MANUAL') {
      return 'manual';
    }
    return null;
  },
  /** RoomClimateControl → whether a radiator of the room asks for heat */
  heatDemand(service) {
    const state = service?.state;
    if (!state || typeof state.hasDemand !== 'boolean') {
      return null;
    }
    return state.hasDemand && state.summerMode !== true;
  },
  /** ShutterContact → 'open' | 'closed' */
  contact(service) {
    const value = service?.state?.value;
    return value === 'OPEN' ? 'open' : value === 'CLOSED' ? 'closed' : null;
  },
  /** LatestMotion → ISO date of the last motion, or null */
  latestMotion(service) {
    const value = service?.state?.latestMotionDetected;
    return typeof value === 'string' && value !== '' ? value : null;
  },
  /**
   * Alarm (smoke detectors) → 'idle' | 'smoke' (this detector) | 'relayed'
   * (another detector of the house) | 'intrusion' (sounding for the intrusion
   * alarm). The `*_REQUESTED` values are writes in progress: idle.
   */
  smokeAlarm(service) {
    switch (service?.state?.value) {
      case 'PRIMARY_ALARM':
        return 'smoke';
      case 'SECONDARY_ALARM':
        return 'relayed';
      case 'INTRUSION_ALARM':
        return 'intrusion';
      case undefined:
      case null:
        return null;
      default:
        return 'idle';
    }
  },
  /** PowerSwitch → boolean */
  powerSwitch(service) {
    const value = service?.state?.switchState;
    return value === 'ON' ? true : value === 'OFF' ? false : null;
  },
  /** PowerMeter → W */
  power(service) {
    const value = finite(service?.state?.powerConsumption);
    return value === null ? null : round(Math.max(0, value), 1);
  },
  /** PowerMeter → kWh (the controller counts Wh) */
  energy(service) {
    const value = finite(service?.state?.energyConsumption);
    return value === null ? null : round(Math.max(0, value) / 1000, 3);
  },
  /** ShutterControl → % open (the controller: 0.0 closed … 1.0 open) */
  shutterPosition(service) {
    // Shutter Control I sends the level as a string ("0.590").
    const value = finite(service?.state?.level);
    return value === null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100);
  },
  /** ShutterControl → 'opening' | 'closing' | 'stopped' */
  shutterMovement(service) {
    const state = service?.state;
    if (!state) {
      return null;
    }
    // Shutter Control I reports no operationState at all: stopped.
    switch (state.operationState) {
      case 'OPENING':
        return 'opening';
      case 'CLOSING':
        return 'closing';
      default:
        return 'stopped';
    }
  },
  /** WaterLeakageSensor → boolean */
  leak(service) {
    const value = service?.state?.state;
    return value === 'LEAKAGE_DETECTED' ? true : value === 'NO_LEAKAGE' ? false : null;
  },
  /** BatteryLevel → boolean (the level is a fault entry, not a number) */
  batteryLow(service) {
    if (!service) {
      return null;
    }
    const entries = service.faults?.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
      return false;
    }
    return entries.some((entry) =>
      ['LOW_BATTERY', 'CRITICAL_LOW', 'CRITICALLY_LOW_BATTERY'].includes(entry?.type),
    );
  },
  /**
   * Keypad → the last press: `{ key, press, timestamp }`, press 'short' or
   * 'long'. The release of a long press and the on/off events of the switch
   * mode are not presses.
   */
  keypad(service) {
    const state = service?.state;
    if (!state) {
      return null;
    }
    const press =
      state.eventType === 'PRESS_SHORT'
        ? 'short'
        : state.eventType === 'PRESS_LONG'
          ? 'long'
          : null;
    const key = BUTTON_KEYS[state.keyName] ?? null;
    const timestamp = finite(state.eventTimestamp);
    if (!press || !key || timestamp === null) {
      return null;
    }
    return { key, press, timestamp };
  },
};

/** Keypad key names → the stable keys of the `button_pressed` trigger. */
export const BUTTON_KEYS = Object.freeze({
  UPPER_BUTTON: 'upper',
  LOWER_BUTTON: 'lower',
  UPPER_LEFT_BUTTON: 'upper_left',
  UPPER_RIGHT_BUTTON: 'upper_right',
  LOWER_LEFT_BUTTON: 'lower_left',
  LOWER_RIGHT_BUTTON: 'lower_right',
});

// --- Intrusion detection system --------------------------------------------------

/**
 * The intrusion system state, from `GET /intrusion/states/system` and its
 * partial long-poll updates (`armingState`, `alarmState`…, merged by
 * `mergeIntrusion`).
 * @returns {{ available: boolean, arming: string|null, alarm: string|null, profile: string|null, remaining: number|null }}
 */
export function readIntrusion(system) {
  const arming = system?.armingState?.state;
  const alarm = system?.alarmState?.value;
  return {
    available: system?.systemAvailability?.available === true,
    // 'disarmed' | 'arming' | 'armed'
    arming:
      arming === 'SYSTEM_ARMED'
        ? 'armed'
        : arming === 'SYSTEM_ARMING'
          ? 'arming'
          : arming === 'SYSTEM_DISARMED'
            ? 'disarmed'
            : null,
    // 'off' | 'pre_alarm' | 'alarm' | 'muted'
    alarm:
      alarm === 'ALARM_ON'
        ? 'alarm'
        : alarm === 'PRE_ALARM'
          ? 'pre_alarm'
          : alarm === 'ALARM_MUTED'
            ? 'muted'
            : alarm === 'ALARM_OFF'
              ? 'off'
              : null,
    profile:
      typeof system?.activeConfigurationProfile?.profileId === 'string'
        ? system.activeConfigurationProfile.profileId
        : null,
    remaining: finite(system?.armingState?.remainingTimeUntilArmed),
  };
}

/** Long-poll `@type`s of the intrusion system, and the key they replace. */
const INTRUSION_PARTS = {
  armingState: 'armingState',
  alarmState: 'alarmState',
  activeConfigurationProfile: 'activeConfigurationProfile',
  systemAvailability: 'systemAvailability',
  systemAvailabilityState: 'systemAvailability',
  securityGapState: 'securityGapState',
};

export const isIntrusionEvent = (event) =>
  event?.['@type'] === 'systemState' || Object.hasOwn(INTRUSION_PARTS, event?.['@type']);

/** Apply a long-poll event to the intrusion system state. */
export function mergeIntrusion(system, event) {
  if (event['@type'] === 'systemState') {
    return event;
  }
  return { ...(system ?? {}), [INTRUSION_PARTS[event['@type']]]: event };
}
