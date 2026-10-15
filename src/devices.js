// -----------------------------------------------------------------------------
// Bosch devices → Gladys devices.
//
// One Gladys device per supported Bosch device, keyed on the Bosch device id
// (`hdm:HomeMaticIP:3014F7…`, `hdm:ZigBee:…`, `roomClimateControl_hz_1`): the
// controller keeps it for the life of the pairing of the device, and it
// survives a renaming or a move to another room. One more device for the
// intrusion detection system when the controller has one.
//
// The heating follows the Bosch model: the setpoint and the mode belong to
// the room ("room climate control" of the controller, one per room with
// radiator thermostats), the thermostats themselves carry their measured
// temperature and their battery.
//
// The features are declared from the services the device really has, so a
// first-generation model without a sensor never shows an empty feature.
// External ids are permanent: `ext:<selector>:shc:<bosch id>[:<feature key>]`.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CATEGORY,
  DEVICE_FEATURE_TYPES as TYPE,
  DEVICE_FEATURE_UNITS as UNIT,
} from '@gladysassistant/integration-sdk';
import { INTRUSION_ID, KIND_BY_MODEL, read } from './shc/model.js';

export const DEVICE_TYPE = 'shc';

/** Gladys values of the thermostat mode (THERMOSTAT_MODE of the core). */
export const THERMOSTAT_MODE = Object.freeze({ OFF: 0, HEATING: 1, AUTO: 3 });
/** Gladys values of the shutter state (COVER_STATE of the core). */
export const COVER_STATE = Object.freeze({ STOP: 0, OPEN: 1, CLOSE: -1 });

// Feature names, frozen at the creation of the device in Gladys (they follow
// the `language` of the configuration). Keys are permanent: they end the
// external id of the feature.
export const NAMES = {
  en: {
    temperature: 'Temperature',
    setpoint: 'Setpoint',
    mode: 'Heating mode',
    heating: 'Heating demand',
    humidity: 'Humidity',
    opening: 'Opening',
    motion: 'Motion',
    smoke: 'Smoke',
    power_switch: 'On/Off',
    power: 'Power',
    energy: 'Energy',
    position: 'Position',
    movement: 'Open/Close',
    leak: 'Water leak',
    battery_low: 'Low battery',
    armed: 'Armed',
    alarm: 'Alarm triggered',
    status: 'Alarm status',
  },
  fr: {
    temperature: 'Température',
    setpoint: 'Consigne',
    mode: 'Mode de chauffage',
    heating: 'Demande de chauffe',
    humidity: 'Humidité',
    opening: 'Ouverture',
    motion: 'Mouvement',
    smoke: 'Fumée',
    power_switch: 'Marche/Arrêt',
    power: 'Puissance',
    energy: 'Énergie',
    position: 'Position',
    movement: 'Ouvrir/Fermer',
    leak: "Fuite d'eau",
    battery_low: 'Batterie faible',
    armed: 'Armée',
    alarm: 'Alarme déclenchée',
    status: "État de l'alarme",
  },
  de: {
    temperature: 'Temperatur',
    setpoint: 'Solltemperatur',
    mode: 'Heizmodus',
    heating: 'Heizbedarf',
    humidity: 'Luftfeuchtigkeit',
    opening: 'Öffnung',
    motion: 'Bewegung',
    smoke: 'Rauch',
    power_switch: 'Ein/Aus',
    power: 'Leistung',
    energy: 'Energie',
    position: 'Position',
    movement: 'Öffnen/Schließen',
    leak: 'Wasserleck',
    battery_low: 'Niedriger Batteriestand',
    armed: 'Scharf geschaltet',
    alarm: 'Alarm ausgelöst',
    status: 'Alarmstatus',
  },
  es: {
    temperature: 'Temperatura',
    setpoint: 'Consigna',
    mode: 'Modo de calefacción',
    heating: 'Demanda de calefacción',
    humidity: 'Humedad',
    opening: 'Apertura',
    motion: 'Movimiento',
    smoke: 'Humo',
    power_switch: 'Encendido/Apagado',
    power: 'Potencia',
    energy: 'Energía',
    position: 'Posición',
    movement: 'Abrir/Cerrar',
    leak: 'Fuga de agua',
    battery_low: 'Batería baja',
    armed: 'Armada',
    alarm: 'Alarma activada',
    status: 'Estado de la alarma',
  },
};

// Names of the devices the integration names itself.
export const DEVICE_NAMES = {
  en: { climate: (room) => `Heating ${room}`, intrusion: 'Intrusion alarm', room: 'No room' },
  fr: { climate: (room) => `Chauffage ${room}`, intrusion: 'Alarme intrusion', room: 'Sans pièce' },
  de: {
    climate: (room) => `Heizung ${room}`,
    intrusion: 'Einbruchalarm',
    room: 'Ohne Raum',
  },
  es: {
    climate: (room) => `Calefacción ${room}`,
    intrusion: 'Alarma de intrusión',
    room: 'Sin habitación',
  },
};

// Labels of the heating modes offered by the mode feature.
export const MODE_LABELS = {
  en: { off: 'Off (summer)', manual: 'Manual', automatic: 'Schedule' },
  fr: { off: 'Arrêt (été)', manual: 'Manuel', automatic: 'Programme' },
  de: { off: 'Aus (Sommer)', manual: 'Manuell', automatic: 'Zeitplan' },
  es: { off: 'Apagado (verano)', manual: 'Manual', automatic: 'Programa' },
};

// The status text of the intrusion system.
export const INTRUSION_TEXT = {
  en: {
    disarmed: 'Disarmed',
    arming: 'Arming',
    armed: 'Armed',
    pre_alarm: 'Pre-alarm',
    alarm: 'Alarm!',
    muted: 'Alarm muted',
    unknown: 'Unknown',
  },
  fr: {
    disarmed: 'Désarmée',
    arming: 'Armement en cours',
    armed: 'Armée',
    pre_alarm: 'Pré-alarme',
    alarm: 'Alarme !',
    muted: 'Alarme coupée',
    unknown: 'Inconnu',
  },
  de: {
    disarmed: 'Unscharf',
    arming: 'Wird scharf geschaltet',
    armed: 'Scharf',
    pre_alarm: 'Voralarm',
    alarm: 'Alarm!',
    muted: 'Alarm stumm',
    unknown: 'Unbekannt',
  },
  es: {
    disarmed: 'Desarmada',
    arming: 'Armándose',
    armed: 'Armada',
    pre_alarm: 'Prealarma',
    alarm: '¡Alarma!',
    muted: 'Alarma silenciada',
    unknown: 'Desconocido',
  },
};

const binary = (value) => (value === null ? null : value ? 1 : 0);

const MODE_VALUE = {
  off: THERMOSTAT_MODE.OFF,
  manual: THERMOSTAT_MODE.HEATING,
  automatic: THERMOSTAT_MODE.AUTO,
};

// --- Feature definitions ------------------------------------------------------------
// `service`: the Bosch service the feature reads (and writes); `value`: the
// Gladys state from that service, null when unknown. A feature is declared
// only when its device has the service.

const FEATURES = {
  temperature: {
    service: 'TemperatureLevel',
    category: CATEGORY.TEMPERATURE_SENSOR,
    type: TYPE.SENSOR.DECIMAL,
    unit: UNIT.CELSIUS,
    min: -20,
    max: 60,
    value: (service) => read.temperature(service),
  },
  setpoint: {
    service: 'RoomClimateControl',
    category: CATEGORY.THERMOSTAT,
    type: TYPE.THERMOSTAT.TARGET_TEMPERATURE,
    unit: UNIT.CELSIUS,
    // What the controller accepts, by half degrees.
    min: 5,
    max: 30,
    step: 0.5,
    writable: true,
    value: (service) => read.setpoint(service),
  },
  mode: {
    service: 'RoomClimateControl',
    category: CATEGORY.THERMOSTAT,
    type: TYPE.THERMOSTAT.MODE,
    min: THERMOSTAT_MODE.OFF,
    max: THERMOSTAT_MODE.AUTO,
    writable: true,
    options: (language) => [
      { value: THERMOSTAT_MODE.OFF, label: MODE_LABELS[language].off, sort_order: 0 },
      { value: THERMOSTAT_MODE.HEATING, label: MODE_LABELS[language].manual, sort_order: 1 },
      { value: THERMOSTAT_MODE.AUTO, label: MODE_LABELS[language].automatic, sort_order: 2 },
    ],
    value: (service) => {
      const mode = read.heatingMode(service);
      return mode === null ? null : MODE_VALUE[mode];
    },
  },
  heating: {
    service: 'RoomClimateControl',
    // Only where the controller reports the demand of the radiators.
    when: (service) => typeof service.state?.hasDemand === 'boolean',
    category: CATEGORY.THERMOSTAT,
    type: TYPE.THERMOSTAT.OPERATING_STATE,
    min: 0,
    max: 1,
    value: (service) => binary(read.heatDemand(service)),
  },
  humidity: {
    service: 'HumidityLevel',
    category: CATEGORY.HUMIDITY_SENSOR,
    type: TYPE.SENSOR.DECIMAL,
    unit: UNIT.PERCENT,
    min: 0,
    max: 100,
    value: (service) => read.humidity(service),
  },
  opening: {
    service: 'ShutterContact',
    category: CATEGORY.OPENING_SENSOR,
    type: TYPE.SENSOR.BINARY,
    min: 0,
    max: 1,
    // OPENING_SENSOR_STATE of the core: 0 = open, 1 = closed.
    value: (service) => {
      const contact = read.contact(service);
      return contact === null ? null : contact === 'open' ? 0 : 1;
    },
  },
  motion: {
    service: 'LatestMotion',
    category: CATEGORY.MOTION_SENSOR,
    type: TYPE.SENSOR.BINARY,
    min: 0,
    max: 1,
    // A motion is an event (the date of the last one): the hub raises the
    // feature for a while after each new date, see Hub.motionValue.
    value: () => null,
  },
  smoke: {
    service: 'Alarm',
    category: CATEGORY.SMOKE_SENSOR,
    type: TYPE.SENSOR.BINARY,
    min: 0,
    max: 1,
    // Smoke seen by this detector only: a relayed alarm (another detector)
    // and the siren of the intrusion alarm are not smoke here.
    value: (service) => {
      const alarm = read.smokeAlarm(service);
      return alarm === null ? null : alarm === 'smoke' ? 1 : 0;
    },
  },
  power_switch: {
    service: 'PowerSwitch',
    category: CATEGORY.SWITCH,
    type: TYPE.SWITCH.BINARY,
    min: 0,
    max: 1,
    writable: true,
    value: (service) => binary(read.powerSwitch(service)),
  },
  power: {
    service: 'PowerMeter',
    category: CATEGORY.SWITCH,
    type: TYPE.SWITCH.POWER,
    unit: UNIT.WATT,
    min: 0,
    max: 4000,
    value: (service) => read.power(service),
  },
  energy: {
    service: 'PowerMeter',
    category: CATEGORY.SWITCH,
    type: TYPE.SWITCH.ENERGY,
    unit: UNIT.KILOWATT_HOUR,
    min: 0,
    max: 1_000_000,
    value: (service) => read.energy(service),
  },
  position: {
    service: 'ShutterControl',
    category: CATEGORY.SHUTTER,
    type: TYPE.SHUTTER.POSITION,
    unit: UNIT.PERCENT,
    min: 0,
    max: 100,
    writable: true,
    value: (service) => read.shutterPosition(service),
  },
  movement: {
    service: 'ShutterControl',
    category: CATEGORY.SHUTTER,
    type: TYPE.SHUTTER.STATE,
    min: COVER_STATE.CLOSE,
    max: COVER_STATE.OPEN,
    writable: true,
    value: (service) => {
      const movement = read.shutterMovement(service);
      return movement === null
        ? null
        : movement === 'opening'
          ? COVER_STATE.OPEN
          : movement === 'closing'
            ? COVER_STATE.CLOSE
            : COVER_STATE.STOP;
    },
  },
  leak: {
    service: 'WaterLeakageSensor',
    category: CATEGORY.LEAK_SENSOR,
    type: TYPE.SENSOR.BINARY,
    min: 0,
    max: 1,
    value: (service) => binary(read.leak(service)),
  },
  battery_low: {
    service: 'BatteryLevel',
    category: CATEGORY.BATTERY_LOW,
    type: TYPE.BATTERY_LOW.BINARY,
    min: 0,
    max: 1,
    value: (service) => binary(read.batteryLow(service)),
  },
};

/** The features of each device family, in display order. */
const FEATURES_BY_KIND = {
  climate: ['temperature', 'setpoint', 'mode', 'heating'],
  radiator: ['temperature', 'battery_low'],
  room_thermostat: ['temperature', 'humidity', 'battery_low'],
  contact: ['opening', 'battery_low'],
  motion: ['motion', 'battery_low'],
  smoke: ['smoke', 'battery_low'],
  plug: ['power_switch', 'power', 'energy'],
  switch: ['power_switch', 'power', 'energy'],
  shutter: ['position', 'movement'],
  leak: ['leak', 'battery_low'],
  button: ['battery_low'],
};

// The few that change constantly (power) or carry no history worth keeping.
const NO_HISTORY = new Set(['movement']);

/** The ids of one Bosch device. */
export const idsOf = (gladys, boschId) => gladys.externalIds(DEVICE_TYPE, boschId);

/**
 * The family of a device, or null when the integration does not support it.
 * @param {{ deviceModel?: string }} device a device of `GET /devices`
 */
export const kindOf = (device) => KIND_BY_MODEL[device?.deviceModel] ?? null;

/**
 * The features a device gets: those of its family whose service it has.
 * @param {object} record `{ device, services: Map<serviceId, DeviceServiceData> }`
 */
export function featureKeys(record) {
  const kind = kindOf(record.device);
  return (FEATURES_BY_KIND[kind] ?? []).filter((key) => {
    const definition = FEATURES[key];
    const service = record.services.get(definition.service);
    return service !== undefined && (definition.when ? definition.when(service) : true);
  });
}

/** The service a feature reads and writes. */
export const serviceOf = (featureKey) => FEATURES[featureKey]?.service ?? null;

/**
 * The name Gladys shows for a device (the user can rename it once created).
 * @param {object} record
 * @param {string|null} roomName
 * @param {string} language
 */
export function deviceName(record, roomName, language) {
  if (kindOf(record.device) === 'climate') {
    return DEVICE_NAMES[language].climate(roomName ?? DEVICE_NAMES[language].room);
  }
  const name = typeof record.device.name === 'string' ? record.device.name.trim() : '';
  return (name || record.device.deviceModel || record.device.id).slice(0, 100);
}

/**
 * The discovery payload of a Bosch device, or null when it has no feature.
 * @param {object} gladys
 * @param {object} record `{ device, services }`
 * @param {{ language: string, roomName: string|null }} options
 */
export function buildDevice(gladys, record, { language, roomName }) {
  const keys = featureKeys(record);
  if (keys.length === 0) {
    return null;
  }
  const ids = idsOf(gladys, record.device.id);
  return {
    name: deviceName(record, roomName, language),
    external_id: ids.device,
    // The container keeps the states up to date itself (long polling and its
    // own refresh): the core scheduler is not needed (Gladys#3198).
    should_poll: false,
    params: [
      { name: 'bosch_model', value: String(record.device.deviceModel) },
      ...(roomName ? [{ name: 'bosch_room', value: roomName }] : []),
    ],
    features: keys.map((key) => {
      const definition = FEATURES[key];
      const feature = {
        name: NAMES[language][key],
        external_id: ids.feature(key),
        category: definition.category,
        type: definition.type,
        read_only: !definition.writable,
        has_feedback: Boolean(definition.writable),
        keep_history: !NO_HISTORY.has(key),
        min: definition.min,
        max: definition.max,
      };
      if (definition.unit) {
        feature.unit = definition.unit;
      }
      if (definition.step) {
        feature.step = definition.step;
      }
      if (definition.options) {
        feature.supported_options = definition.options(language);
      }
      return feature;
    }),
  };
}

/**
 * The current Gladys state of each feature of a device: `{ externalId, key,
 * value }`, value a number or null when the controller does not say.
 */
export function featureStates(gladys, record) {
  const ids = idsOf(gladys, record.device.id);
  return featureKeys(record).map((key) => ({
    key,
    externalId: ids.feature(key),
    value: FEATURES[key].value(record.services.get(FEATURES[key].service)),
  }));
}

// --- Intrusion detection system ---------------------------------------------------------

const INTRUSION_FEATURES = ['armed', 'alarm', 'status'];

/** The device of the intrusion system. */
export function buildIntrusionDevice(gladys, language) {
  const ids = idsOf(gladys, INTRUSION_ID);
  const base = { read_only: true, has_feedback: false, keep_history: true };
  return {
    name: DEVICE_NAMES[language].intrusion,
    external_id: ids.device,
    should_poll: false,
    params: [{ name: 'bosch_model', value: 'IDS' }],
    features: [
      {
        ...base,
        name: NAMES[language].armed,
        external_id: ids.feature('armed'),
        category: CATEGORY.INPUT,
        type: TYPE.INPUT.BINARY,
        min: 0,
        max: 1,
      },
      {
        ...base,
        name: NAMES[language].alarm,
        external_id: ids.feature('alarm'),
        category: CATEGORY.INPUT,
        type: TYPE.INPUT.BINARY,
        min: 0,
        max: 1,
      },
      {
        ...base,
        name: NAMES[language].status,
        external_id: ids.feature('status'),
        category: CATEGORY.TEXT,
        type: TYPE.TEXT.TEXT,
        // NOT NULL in the core, even for a text.
        min: 0,
        max: 0,
        keep_history: false,
      },
    ],
  };
}

/** The key of INTRUSION_TEXT describing the system right now. */
export function intrusionStatus(state) {
  if (state.alarm === 'alarm' || state.alarm === 'pre_alarm' || state.alarm === 'muted') {
    return state.alarm;
  }
  return state.arming ?? 'unknown';
}

/** States of the intrusion system device (`value` a number or `{ text }`). */
export function intrusionStates(gladys, state, language) {
  const ids = idsOf(gladys, INTRUSION_ID);
  return [
    {
      key: 'armed',
      externalId: ids.feature('armed'),
      value: state.arming === null ? null : state.arming === 'armed' ? 1 : 0,
    },
    {
      key: 'alarm',
      externalId: ids.feature('alarm'),
      value:
        state.alarm === null
          ? null
          : state.alarm === 'alarm' || state.alarm === 'pre_alarm'
            ? 1
            : 0,
    },
    {
      key: 'status',
      externalId: ids.feature('status'),
      value: { text: INTRUSION_TEXT[language][intrusionStatus(state)] },
    },
  ];
}

export { INTRUSION_FEATURES };
