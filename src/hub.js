// -----------------------------------------------------------------------------
// The Bosch Smart Home hub: one paired controller, its devices and their
// states, kept in sync with Gladys.
//
//   - real time: an event subscription on the controller, read by long
//     polling (`RE/longPoll`, 30 s per request), as Bosch recommends instead
//     of polling the states;
//   - safety net: a full read of the devices and their services every
//     15 minutes, and after every reconnection or lost subscription (the
//     events of a gap are lost). It also re-sends the values that did not
//     change at least every 6 hours (heartbeat), so Gladys keeps them dated;
//   - the core scheduler is not used (`should_poll: false`, Gladys#3198):
//     `onPoll` stays as a fallback that re-reads one device.
//
// Only the changes are published (the SDK deduplicates), and the scene
// events fire on transitions: a smoke detector going into alarm, a press on
// a universal switch.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { randomBytes } from 'node:crypto';
import {
  buildDevice,
  buildIntrusionDevice,
  COVER_STATE,
  featureStates,
  idsOf,
  intrusionStates,
  kindOf,
  THERMOSTAT_MODE,
} from './devices.js';
import { createIssueLog } from './issues.js';
import { BOSCH_ROOT_CA, LONG_POLL_SECONDS, ShcClient } from './shc/client.js';
import { ERROR_KINDS } from './shc/http.js';
import {
  INTRUSION_ID,
  isAvailable,
  isIntrusionEvent,
  mergeIntrusion,
  read,
  readIntrusion,
} from './shc/model.js';
import { generateClientIdentity, pairingCertificate } from './shc/x509.js';
import {
  CONNECTION_TEXT,
  ERROR_TEXT,
  actionMessage,
  errorStatus,
  localizedError,
  pick,
} from './texts.js';

const logger = createLogger({ name: 'bosch-hub' });

export const WIDGET_KEY = 'overview';

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
export const TRIGGERS = Object.freeze({
  SMOKE: 'smoke_alarm',
  BUTTON: 'button_pressed',
});

// Intrusion profiles of the controller (`armRequest.profileId`).
export const ARM_PROFILES = Object.freeze({ full: '0', partial: '1', custom: '2' });

export const HUB_TIMINGS = {
  // Full read of the devices and services, the safety net of the long polling.
  refreshMs: 15 * 60_000,
  // Unchanged values are re-sent this often (Gladys flags a value older than
  // 48 h as not recent).
  heartbeatMs: 6 * 3600_000,
  // Waits after a failure, then the last one again and again.
  retryMs: [5_000, 15_000, 30_000, 60_000],
  // Wait of one long-poll request on the controller.
  pollSeconds: LONG_POLL_SECONDS,
  // A device the events mention but the hub does not know yet: read
  // everything again, once the burst of events of a new pairing is over.
  rescanDelayMs: 3_000,
};

// What identifies the pairing in the Bosch app ("oss_" is required by the
// terms of the local API).
const CLIENT_NAME = 'oss_Gladys_Assistant';
const newClientId = () => `oss_gladys_${randomBytes(6).toString('hex')}`;

const STATES_PER_LOG = 100;

const delay = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

export class Hub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {object} options.store persistence of the pairing (src/store.js)
   * @param {boolean} [options.timers] long polling and periodic timers (off in most tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {() => number} [options.now]
   * @param {string} [options.ca] trusted authorities (tests: the fake controller's)
   * @param {object} [options.ports] controller ports (tests)
   */
  constructor({ gladys, store, timers = true, timings, now, ca, ports }) {
    this.gladys = gladys;
    this.store = store;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.now = now ?? (() => Date.now());
    this.ca = ca ?? BOSCH_ROOT_CA;
    this.ports = ports;
    this.issues = createIssueLog(logger);

    this.config = null;
    this.pairing = null;
    this.client = null;
    /** @type {Map<string, { device: object, services: Map<string, object> }>} by Bosch id */
    this.records = new Map();
    /** @type {Map<string, string>} room names by room id */
    this.rooms = new Map();
    this.intrusion = null;
    this.information = null;
    /** 'idle' (not configured) | 'connecting' | 'connected' | 'down' */
    this.state = 'idle';
    this.error = null;
    this.failures = 0;
    this.lastRefreshAt = 0;
    this.published = { devices: null, connection: null, widget: null };
    this.transports = new Map();
    /** Motion: the date of the last detection and until when it counts, by Bosch id. */
    this.motion = new Map();
    /** Last press seen on each universal switch (its event timestamp). */
    this.keypad = new Map();
    this.ignoredModels = new Set();

    this.generation = 0;
    this.abort = null;
    this.pollId = null;
    this.loopRunning = null;
    this.refreshTimer = null;
    this.rescanTimer = null;
    this.motionTimers = new Map();
    this.stopped = false;
  }

  // --- Lifecycle ------------------------------------------------------------------

  async start(config) {
    this.pairing = await this.store.loadPairing();
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it restarted): send everything again. */
  async resync(config) {
    this.published = { devices: null, connection: null, widget: null };
    this.transports.clear();
    this.gladys.forgetPublishedStates?.();
    await this.reconfigure(config);
  }

  /**
   * A new configuration: reconnect when the controller, the certificate
   * check or the pairing changed; otherwise only re-publish (language).
   */
  async reconfigure(config) {
    const previous = this.config;
    this.config = config;
    const same =
      previous &&
      this.client &&
      previous.host === config.host &&
      previous.insecure === config.insecure &&
      this.client.cert === this.pairing?.cert;
    if (same) {
      await this.publishDevices();
      await this.publishAllStates({ force: true });
      this.refreshWidget(true);
      return;
    }
    await this.connect();
  }

  /** (Re)open the connection with the current configuration and pairing. */
  async connect() {
    this.stopLoop();
    this.client = null;
    this.records.clear();
    this.intrusion = null;
    this.information = null;
    this.error = null;
    this.failures = 0;
    if (!this.config.host || !this.pairing) {
      this.state = 'idle';
      await this.publishDevices();
      await this.publishConnectionStatus();
      this.refreshWidget(true);
      return;
    }
    this.client = new ShcClient({
      host: this.config.host,
      key: this.pairing.key,
      cert: this.pairing.cert,
      ca: this.ca,
      insecure: this.config.insecure,
      ports: this.ports,
    });
    this.state = 'connecting';
    const generation = ++this.generation;
    this.abort = new AbortController();
    try {
      await this.refresh();
      this.onSuccess();
    } catch (err) {
      if (!err.kind) {
        throw err;
      }
      await this.onFailure(err);
    }
    await this.afterChange();
    this.scheduleRefresh();
    if (this.timersEnabled) {
      this.loopRunning = this.loop(generation);
    }
  }

  stopLoop() {
    this.generation += 1;
    this.abort?.abort();
    this.abort = null;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.rescanTimer);
    for (const timer of this.motionTimers.values()) {
      clearTimeout(timer);
    }
    this.motionTimers.clear();
    const { client, pollId } = this;
    this.pollId = null;
    if (client && pollId) {
      // Free the subscription on the controller; it expires by itself anyway.
      this.unsubscribing = client.unsubscribe(pollId).catch(() => {});
    }
  }

  async stop() {
    this.stopped = true;
    this.stopLoop();
    await Promise.all([this.loopRunning?.catch(() => {}), this.unsubscribing]);
  }

  // --- Connection state -------------------------------------------------------------

  onSuccess() {
    const was = this.state;
    this.failures = 0;
    this.error = null;
    this.state = 'connected';
    if (was === 'down') {
      this.issues.ok('controller', `Controller ${this.config.host}: connection restored`);
    } else if (was === 'connecting') {
      this.issues.ok('controller');
      logger.info(`Connected to the controller ${this.config.host} (${this.records.size} devices)`);
    }
  }

  async onFailure(err) {
    this.failures += 1;
    this.error = err.kind;
    this.state = 'down';
    this.pollId = null;
    this.issues.fail('controller', `Controller ${this.config.host}: ${err.message}`);
    await this.afterChange();
  }

  retryDelay() {
    const list = this.timings.retryMs;
    return list[Math.min(this.failures - 1, list.length - 1)] ?? list[list.length - 1];
  }

  // --- Long polling -----------------------------------------------------------------

  /** The event loop: subscribe, wait for events, apply them, again. */
  async loop(generation) {
    let rpcErrors = 0;
    while (generation === this.generation && !this.stopped) {
      try {
        await this.pollOnce();
        rpcErrors = 0;
      } catch (err) {
        if (generation !== this.generation || err.name === 'AbortError') {
          return;
        }
        if (!err.kind) {
          this.issues.fail('loop', `Event loop error: ${err.message}`);
          await delay(this.timings.retryMs[0], this.abort?.signal);
          continue;
        }
        if (err.rpcCode !== undefined && rpcErrors === 0) {
          // The subscription expired (24 h at most, 5 min without a request):
          // subscribe again at once, and read what the gap may have hidden.
          rpcErrors += 1;
          logger.debug(`Subscription lost (${err.message}), subscribing again`);
          this.pollId = null;
          this.needsRefresh = true;
          continue;
        }
        rpcErrors = 0;
        await this.onFailure(err);
        this.needsRefresh = true;
        await delay(this.retryDelay(), this.abort?.signal);
      }
    }
  }

  /**
   * One step of the loop: subscribe when needed (and read everything after a
   * gap), then one long-poll request and its events.
   */
  async pollOnce() {
    const { client } = this;
    if (!client) {
      return;
    }
    if (!this.pollId) {
      this.pollId = await client.subscribe();
      logger.debug('Subscribed to the controller events');
      if (this.needsRefresh || this.state !== 'connected') {
        this.needsRefresh = false;
        await this.refresh();
      }
      this.onSuccess();
      await this.afterChange();
    }
    const events = await client.longPoll(this.pollId, {
      seconds: this.timings.pollSeconds,
      signal: this.abort?.signal,
    });
    if (client !== this.client) {
      return;
    }
    if (this.state !== 'connected') {
      this.onSuccess();
    }
    await this.applyEvents(events);
  }

  // --- Full read ----------------------------------------------------------------------

  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    if (!this.timersEnabled || this.stopped || !this.client) {
      return;
    }
    this.refreshTimer = setTimeout(async () => {
      try {
        if (this.state === 'connected') {
          await this.refresh();
          await this.afterChange();
        }
        this.issues.ok('refresh');
      } catch (err) {
        if (err.kind) {
          await this.onFailure(err);
        } else {
          this.issues.fail('refresh', `Refresh failed: ${err.message}`);
        }
      }
      this.scheduleRefresh();
    }, this.timings.refreshMs);
    this.refreshTimer.unref?.();
  }

  /** Read every device, service, room and the intrusion system, then publish. */
  async refresh() {
    const { client } = this;
    const [devices, services, rooms, intrusion] = await Promise.all([
      client.devices(),
      client.services(),
      client.rooms(),
      client.intrusionState(),
    ]);
    if (client !== this.client) {
      return;
    }
    this.lastRefreshAt = this.now();
    this.rooms = new Map(
      rooms.filter((room) => room?.id).map((room) => [room.id, String(room.name ?? '')]),
    );
    const servicesByDevice = new Map();
    for (const service of services) {
      if (!service?.deviceId || !service.id) {
        continue;
      }
      if (!servicesByDevice.has(service.deviceId)) {
        servicesByDevice.set(service.deviceId, new Map());
      }
      servicesByDevice.get(service.deviceId).set(service.id, service);
    }
    const previous = this.records;
    this.records = new Map();
    for (const device of devices) {
      if (!device?.id || device.deleted === true) {
        continue;
      }
      if (!kindOf(device)) {
        this.noteIgnored(device.deviceModel);
        continue;
      }
      const record = { device, services: servicesByDevice.get(device.id) ?? new Map() };
      this.records.set(device.id, record);
      await this.track(record, previous.get(device.id) ?? null, { live: false });
    }
    this.intrusion = intrusion;
    await this.publishDevices();
    await this.publishAllStates();
  }

  noteIgnored(model) {
    if (model && !this.ignoredModels.has(model)) {
      this.ignoredModels.add(model);
      logger.debug(`Bosch model ${model} is not supported: ignored`);
    }
  }

  /** Read everything again shortly (an unknown device in the events). */
  scheduleRescan() {
    if (this.rescanTimer || !this.client) {
      return;
    }
    const run = async () => {
      this.rescanTimer = null;
      try {
        await this.refresh();
        await this.afterChange();
      } catch (err) {
        logger.debug(`Rescan failed: ${err.message}`);
      }
    };
    if (!this.timersEnabled) {
      this.pendingRescan = run;
      return;
    }
    this.rescanTimer = setTimeout(run, this.timings.rescanDelayMs);
    this.rescanTimer.unref?.();
  }

  /** onPoll fallback: re-read one device, unless the hub read everything recently. */
  async pollDevice(externalId) {
    const record = this.recordOf(externalId);
    if (!record || !this.client || this.state !== 'connected') {
      return;
    }
    if (this.now() - this.lastRefreshAt < this.timings.refreshMs / 2) {
      return;
    }
    const services = await this.client.deviceServices(record.device.id);
    for (const service of services) {
      if (service?.id) {
        await this.applyService(service, { live: false });
      }
    }
    await this.publishStates([record]);
  }

  // --- Events -------------------------------------------------------------------------

  async applyEvents(events) {
    const touched = new Set();
    let structure = false;
    let intrusion = false;
    for (const event of events) {
      try {
        const type = event?.['@type'];
        if (type === 'DeviceServiceData') {
          const record = await this.applyService(event, { live: true });
          if (record) {
            touched.add(record);
          }
        } else if (type === 'device') {
          structure = this.applyDevice(event) || structure;
        } else if (type === 'room') {
          if (event.id) {
            this.rooms.set(event.id, String(event.name ?? ''));
            structure = true;
          }
        } else if (type === 'message') {
          // Some changes come as a message wrapping the service data.
          const embedded = event.arguments?.deviceServiceDataModel;
          if (typeof embedded === 'string') {
            const record = await this.applyService(JSON.parse(embedded), { live: true });
            if (record) {
              touched.add(record);
            }
          }
        } else if (isIntrusionEvent(event)) {
          this.intrusion = mergeIntrusion(this.intrusion, event);
          intrusion = true;
        }
      } catch (err) {
        logger.debug(`Event ignored (${err.message})`);
      }
    }
    if (structure) {
      await this.publishDevices();
    }
    await this.publishStates([...touched], { intrusion });
    await this.afterChange();
  }

  /** A service changed: keep it, fire what its change means. */
  async applyService(service, { live }) {
    const record = this.records.get(service.deviceId);
    if (!record) {
      if (live) {
        // A device the hub has not read yet (just paired): read it.
        this.scheduleRescan();
      }
      return null;
    }
    const before = record.services.get(service.id);
    // The controller sends the whole service; a missing `faults` means none.
    record.services.set(service.id, {
      ...service,
      state: service.state ?? before?.state,
    });
    if (!before && live) {
      // A service the device did not have: its features may be new.
      await this.publishDevices();
    }
    await this.track(record, null, { live, service: service.id, before });
    return record;
  }

  /**
   * The transitions of a device: motion, smoke alarm, button press.
   * @param {object} record
   * @param {object|null} previous the record of the previous full read
   * @param {object} options `live` (an event of the long polling), `service`, `before`
   */
  track(record, previous, { live, service, before }) {
    const id = record.device.id;
    const kind = kindOf(record.device);
    const services = record.services;
    const prior = (serviceId) =>
      service === serviceId ? before : (previous?.services.get(serviceId) ?? null);
    const work = [];

    if (kind === 'motion' && (!service || service === 'LatestMotion')) {
      const last = read.latestMotion(services.get('LatestMotion'));
      const known = this.motion.get(id);
      if (last && (!known || known.last !== last)) {
        // A new date: a new motion. On a full read, only if recent enough.
        const at = Date.parse(last);
        const fresh = live ? this.now() : Number.isFinite(at) ? at : 0;
        this.setMotion(id, last, fresh + this.config.motionHoldMs);
      }
    }

    if (kind === 'smoke' && (!service || service === 'Alarm')) {
      const next = read.smokeAlarm(services.get('Alarm'));
      const hadState = Boolean(prior('Alarm')) || (!service && Boolean(previous));
      const was = read.smokeAlarm(prior('Alarm'));
      if (hadState && (next === 'smoke' || next === 'relayed') && next !== was) {
        logger.info(`Smoke alarm: ${record.device.name} (${next})`);
        work.push(
          this.fire(TRIGGERS.SMOKE, record, {
            alarm: next === 'smoke' ? 'detected' : 'relayed',
          }),
        );
      }
    }

    if (kind === 'button' && (!service || service === 'Keypad')) {
      const press = read.keypad(services.get('Keypad'));
      const seen = this.keypad.get(id);
      if (press && seen !== undefined && press.timestamp > seen && live) {
        work.push(this.fire(TRIGGERS.BUTTON, record, { button: press.key, press: press.press }));
      }
      if (press && (seen === undefined || press.timestamp > seen)) {
        this.keypad.set(id, press.timestamp);
      } else if (seen === undefined) {
        this.keypad.set(id, 0);
      }
    }

    return Promise.all(work);
  }

  setMotion(id, last, until) {
    this.motion.set(id, { last, until });
    clearTimeout(this.motionTimers.get(id));
    this.motionTimers.delete(id);
    const wait = until - this.now();
    if (this.timersEnabled && wait > 0) {
      const timer = setTimeout(() => {
        this.motionTimers.delete(id);
        const record = this.records.get(id);
        if (record) {
          this.publishStates([record]).catch(() => {});
        }
      }, wait + 50);
      timer.unref?.();
      this.motionTimers.set(id, timer);
    }
  }

  /** 1 while the last detection of a motion detector is recent, else 0. */
  motionValue(id) {
    const motion = this.motion.get(id);
    return motion && this.now() < motion.until ? 1 : 0;
  }

  /** A device changed (name, room, availability), appeared or was removed. */
  applyDevice(device) {
    if (!device.id) {
      return false;
    }
    const record = this.records.get(device.id);
    if (device.deleted === true) {
      if (record) {
        this.records.delete(device.id);
        logger.info(`Device removed from the controller: ${record.device.name}`);
        return true;
      }
      return false;
    }
    if (!record) {
      if (kindOf(device)) {
        this.scheduleRescan();
      } else {
        this.noteIgnored(device.deviceModel);
      }
      return false;
    }
    const before = record.device;
    record.device = { ...before, ...device };
    return before.name !== record.device.name || before.roomId !== record.device.roomId;
  }

  async fire(key, record, data) {
    try {
      await this.gladys.publishSceneEvent(key, {
        device: idsOf(this.gladys, record.device.id).device,
        device_name: String(record.device.name ?? ''),
        room: this.rooms.get(record.device.roomId) ?? '',
        ...data,
      });
      this.issues.ok('scene-event');
    } catch (err) {
      this.issues.fail('scene-event', `Scene event ${key} refused: ${err.message}`);
    }
  }

  // --- Publishing to Gladys -------------------------------------------------------------------

  roomName(record) {
    const name = this.rooms.get(record.device.roomId);
    return name && name.trim() ? name.trim() : null;
  }

  intrusionState() {
    if (!this.intrusion) {
      return null;
    }
    const state = readIntrusion(this.intrusion);
    return state.available || state.arming ? state : null;
  }

  /** The discovery payload: every supported device with features. */
  buildDevices() {
    const language = this.config?.language ?? 'fr';
    const devices = [];
    for (const record of this.records.values()) {
      const device = buildDevice(this.gladys, record, {
        language,
        roomName: this.roomName(record),
      });
      if (device) {
        devices.push(device);
      }
    }
    if (this.intrusionState()) {
      devices.push(buildIntrusionDevice(this.gladys, language));
    }
    return devices;
  }

  async publishDevices() {
    const devices = this.buildDevices();
    const signature = JSON.stringify(devices);
    if (signature === this.published.devices) {
      return;
    }
    try {
      // Even an empty list: the Discovery tab then shows no stale device.
      await this.gladys.publishDiscoveredDevices(devices);
      this.published.devices = signature;
      this.issues.ok('discovery');
    } catch (err) {
      this.issues.fail('discovery', `Devices refused by Gladys: ${err.message}`);
    }
  }

  /** States of a device, as `publishStates` takes them. */
  statesOf(record) {
    return featureStates(this.gladys, record)
      .map(({ key, externalId, value }) => ({
        externalId,
        value: key === 'motion' ? this.motionValue(record.device.id) : value,
      }))
      .filter(({ value }) => value !== null)
      .map(({ externalId, value }) => ({ device_feature_external_id: externalId, state: value }));
  }

  intrusionStatesList() {
    const state = this.intrusionState();
    if (!state) {
      return [];
    }
    return intrusionStates(this.gladys, state, this.config.language)
      .filter(({ value }) => value !== null)
      .map(({ externalId, value }) =>
        typeof value === 'object'
          ? { device_feature_external_id: externalId, text: value.text }
          : { device_feature_external_id: externalId, state: value },
      );
  }

  async publishStates(records, { intrusion = false, force = false } = {}) {
    const states = records.flatMap((record) => this.statesOf(record));
    if (intrusion) {
      states.push(...this.intrusionStatesList());
    }
    if (states.length === 0) {
      return;
    }
    if (force) {
      for (const state of states) {
        this.gladys.forgetPublishedStates?.(state.device_feature_external_id);
      }
    }
    try {
      const { count } = await this.gladys.publishChangedStates(states, {
        heartbeat: this.timings.heartbeatMs,
      });
      if (count > 0) {
        logger.debug(`${count} state(s) published`);
      }
      this.issues.ok('states', 'Gladys accepts the states again');
    } catch (err) {
      this.issues.fail(
        'states',
        `States refused by Gladys (${Math.min(states.length, STATES_PER_LOG)}): ${err.message}`,
      );
    }
  }

  publishAllStates(options = {}) {
    return this.publishStates([...this.records.values()], { intrusion: true, ...options });
  }

  /** The user added a device: the states sent before were dropped by Gladys. */
  async onDeviceCreated(device) {
    if (device.external_id === idsOf(this.gladys, INTRUSION_ID).device) {
      await this.publishStates([], { intrusion: true, force: true });
    } else {
      const record = this.recordOf(device.external_id);
      if (record) {
        await this.publishStates([record], { force: true });
      }
    }
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  async afterChange() {
    await this.publishTransports();
    await this.publishConnectionStatus();
    this.refreshWidget();
  }

  async publishTransports() {
    const entries = [];
    const reachable = this.state === 'connected';
    for (const record of this.records.values()) {
      const externalId = idsOf(this.gladys, record.device.id).device;
      const available = reachable && isAvailable(record.device);
      const transport = available ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE;
      const before = this.transports.get(externalId);
      if (before !== transport) {
        entries.push({ external_id: externalId, transport });
        // Lost and back, for the devices themselves (not the whole controller).
        if (reachable && before === DEVICE_TRANSPORTS.LOCAL && !available) {
          logger.info(`Device unreachable: ${record.device.name} (${record.device.status})`);
        } else if (reachable && before === DEVICE_TRANSPORTS.UNREACHABLE && available) {
          logger.info(`Device reachable again: ${record.device.name}`);
        }
      }
    }
    if (this.intrusionState()) {
      const externalId = idsOf(this.gladys, INTRUSION_ID).device;
      const transport = reachable ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE;
      if (this.transports.get(externalId) !== transport) {
        entries.push({ external_id: externalId, transport });
      }
    }
    for (let at = 0; at < entries.length; at += 100) {
      const batch = entries.slice(at, at + 100);
      try {
        await this.gladys.publishTransports(batch);
        for (const entry of batch) {
          this.transports.set(entry.external_id, entry.transport);
        }
        this.issues.ok('transports');
      } catch (err) {
        this.issues.fail('transports', `Transports refused by Gladys: ${err.message}`);
      }
    }
  }

  /** The status under the integration name. */
  connectionStatus() {
    const config = this.config;
    if (!config.host) {
      return {
        connected: false,
        message: config.hostTyped ? CONNECTION_TEXT.invalidHost : CONNECTION_TEXT.noHost,
      };
    }
    if (!this.pairing) {
      return { connected: false, message: CONNECTION_TEXT.notPaired };
    }
    if (this.state === 'connected') {
      return { connected: true };
    }
    if (this.error) {
      return { connected: false, message: errorStatus(this.error) };
    }
    return { connected: false };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    const key = JSON.stringify(status);
    if (key === this.published.connection) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.published.connection = key;
      this.issues.ok('connection-status');
    } catch (err) {
      this.issues.fail('connection-status', `Connection status refused: ${err.message}`);
    }
  }

  /** Nudge the widget when what it shows changed (or always, `force`). */
  refreshWidget(force = false) {
    const signature = JSON.stringify(this.summary());
    if (!force && signature === this.published.widget) {
      return;
    }
    this.published.widget = signature;
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  // --- Reading for the widget and the actions ------------------------------------------------

  recordOf(externalId) {
    for (const record of this.records.values()) {
      if (idsOf(this.gladys, record.device.id).device === externalId) {
        return record;
      }
    }
    return null;
  }

  /** What the overview widget shows. */
  summary() {
    const open = [];
    const lowBattery = [];
    const unreachable = [];
    for (const record of this.records.values()) {
      const name = String(record.device.name ?? record.device.id);
      if (read.contact(record.services.get('ShutterContact')) === 'open') {
        open.push(name);
      }
      if (read.batteryLow(record.services.get('BatteryLevel'))) {
        lowBattery.push(name);
      }
      if (!isAvailable(record.device)) {
        unreachable.push(name);
      }
    }
    const sort = (list) => list.sort((a, b) => a.localeCompare(b));
    return {
      state: this.state,
      error: this.error,
      paired: Boolean(this.pairing),
      configured: Boolean(this.config?.host),
      devices: this.records.size,
      open: sort(open),
      lowBattery: sort(lowBattery),
      unreachable: sort(unreachable),
      intrusion: this.intrusionState(),
    };
  }

  // --- Commands ------------------------------------------------------------------------

  requireClient() {
    if (!this.client) {
      throw new Error(
        pick(
          this.config?.host ? CONNECTION_TEXT.notPaired : CONNECTION_TEXT.noHost,
          this.config?.language,
        ),
      );
    }
    return this.client;
  }

  /** A command on a feature of a Bosch device. */
  async setValue(device, feature, value) {
    const language = this.config.language;
    const record = this.recordOf(device.external_id);
    if (!record) {
      throw localizedError('unknownDevice', language);
    }
    const ids = idsOf(this.gladys, record.device.id);
    const key = feature.external_id.startsWith(`${ids.device}:`)
      ? feature.external_id.slice(ids.device.length + 1)
      : null;
    const client = this.requireClient();
    const put = (serviceId, state, type) => {
      const current = record.services.get(serviceId);
      return client.putState(record.device.id, serviceId, {
        '@type': current?.state?.['@type'] ?? type,
        ...state,
      });
    };
    const number = Number(value);
    const label = `${record.device.name} ${key}=${value}`;
    try {
      switch (key) {
        case 'power_switch':
          await put(
            'PowerSwitch',
            { switchState: number === 1 ? 'ON' : 'OFF' },
            'powerSwitchState',
          );
          break;
        case 'position': {
          const level = Math.min(100, Math.max(0, Math.round(number))) / 100;
          await put('ShutterControl', { level }, 'shutterControlState');
          break;
        }
        case 'movement':
          if (number === COVER_STATE.OPEN) {
            await put('ShutterControl', { level: 1 }, 'shutterControlState');
          } else if (number === COVER_STATE.CLOSE) {
            await put('ShutterControl', { level: 0 }, 'shutterControlState');
          } else {
            await put('ShutterControl', { operationState: 'STOPPED' }, 'shutterControlState');
          }
          break;
        case 'setpoint': {
          const climate = record.services.get('RoomClimateControl')?.state ?? {};
          if (climate.summerMode === true) {
            throw localizedError('heatingOff', language);
          }
          // The controller refuses a setpoint while the room is in eco.
          if (climate.low === true) {
            await put('RoomClimateControl', { low: false }, 'climateControlState');
          }
          const setpoint = Math.min(30, Math.max(5, Math.round(number * 2) / 2));
          await put('RoomClimateControl', { setpointTemperature: setpoint }, 'climateControlState');
          break;
        }
        case 'mode': {
          const climate = record.services.get('RoomClimateControl')?.state ?? {};
          if (number === THERMOSTAT_MODE.OFF) {
            await put('RoomClimateControl', { summerMode: true }, 'climateControlState');
            break;
          }
          if (climate.summerMode === true) {
            await put('RoomClimateControl', { summerMode: false }, 'climateControlState');
          }
          await put(
            'RoomClimateControl',
            { operationMode: number === THERMOSTAT_MODE.AUTO ? 'AUTOMATIC' : 'MANUAL' },
            'climateControlState',
          );
          break;
        }
        default:
          throw localizedError('readOnly', language);
      }
    } catch (err) {
      if (err.kind) {
        logger.warn(`Command failed: ${label}: ${err.message}`);
        throw new Error(pick(ERROR_TEXT[err.kind] ?? ERROR_TEXT[ERROR_KINDS.PROTOCOL], language), {
          cause: err,
        });
      }
      throw err;
    }
    logger.info(`Command: ${label}`);
    // The new state comes back through the events (has_feedback).
  }

  /** Scene action: arm the intrusion detection system (opt-in in the configuration). */
  async arm(profile) {
    const language = this.config.language;
    if (!this.config.allowArming) {
      throw localizedError('armingDisabled', language);
    }
    const client = this.requireClient();
    if (!this.intrusionState()) {
      throw localizedError('noIntrusion', language);
    }
    const profileId = ARM_PROFILES[profile] ?? ARM_PROFILES.full;
    try {
      await client.arm(profileId);
    } catch (err) {
      if (err.kind) {
        logger.warn(`Arming failed: ${err.message}`);
        throw new Error(pick(ERROR_TEXT[err.kind] ?? ERROR_TEXT[ERROR_KINDS.PROTOCOL], language), {
          cause: err,
        });
      }
      throw err;
    }
    logger.info(`Intrusion alarm arming (profile ${profileId})`);
    return pick(actionMessage('armed'), language);
  }

  // --- Configuration actions -------------------------------------------------------------

  /**
   * "Pair": a new client certificate registered on the controller, which must
   * be in pairing mode. The system password is only sent there.
   */
  async pair() {
    const config = this.config;
    if (!config.host) {
      return config.hostTyped ? CONNECTION_TEXT.invalidHost : CONNECTION_TEXT.noHost;
    }
    if (!config.password) {
      return actionMessage('missingPassword');
    }
    const clientId = newClientId();
    const identity = await generateClientIdentity({ clientId, organization: CLIENT_NAME });
    const pairingClient = new ShcClient({
      host: config.host,
      ca: this.ca,
      insecure: config.insecure,
      ports: this.ports,
      timeoutMs: 30_000,
    });
    try {
      await pairingClient.pair({
        password: config.password,
        clientId,
        name: CLIENT_NAME,
        certificate: pairingCertificate(identity.certPem),
      });
    } catch (err) {
      if (!err.kind) {
        throw err;
      }
      logger.warn(`Pairing with ${config.host} failed: ${err.message}`);
      return actionMessage('pairingFailed', ERROR_TEXT[err.kind]);
    }
    this.pairing = {
      key: identity.keyPem,
      cert: identity.certPem,
      clientId,
      host: config.host,
      pairedAt: new Date(this.now()).toISOString(),
    };
    await this.store.savePairing(this.pairing);
    logger.info(`Paired with the controller ${config.host} as ${clientId}`);
    // The system password is not needed any more: do not keep it in Gladys.
    await this.gladys
      .setConfig({ system_password: '' })
      .catch((err) => logger.debug(`System password not cleared: ${err.message}`));
    this.config = { ...this.config, password: '' };
    await this.connect();
    if (this.state !== 'connected') {
      return actionMessage('connectionFailed', ERROR_TEXT[this.error ?? ERROR_KINDS.PROTOCOL]);
    }
    return actionMessage('paired', this.buildDevices().length);
  }

  /** "Test the connection": read the controller now. */
  async testConnection() {
    const config = this.config;
    if (!config.host) {
      return config.hostTyped ? CONNECTION_TEXT.invalidHost : CONNECTION_TEXT.noHost;
    }
    if (!this.pairing || !this.client) {
      return CONNECTION_TEXT.notPaired;
    }
    try {
      const [information] = await Promise.all([this.client.information(), this.refresh()]);
      this.information = information;
      this.onSuccess();
    } catch (err) {
      if (!err.kind) {
        throw err;
      }
      await this.onFailure(err);
      return actionMessage('connectionFailed', ERROR_TEXT[err.kind]);
    }
    await this.afterChange();
    const version =
      this.information?.version ?? this.information?.softwareUpdateState?.swInstalledVersion ?? '?';
    logger.info(`Connection test: ${this.records.size} devices`);
    return actionMessage('connected', version, this.buildDevices().length);
  }

  /** Tests without timers: run the read a new device asked for. */
  async runPendingRescan() {
    const run = this.pendingRescan;
    this.pendingRescan = null;
    await run?.();
  }
}
