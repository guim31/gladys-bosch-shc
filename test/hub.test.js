// -----------------------------------------------------------------------------
// End to end, against the fake controller: discovery, states, commands, the
// long-poll events and what they fire, losing and finding the controller.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOSCH,
  createAll,
  createClock,
  createWorld,
  deviceId,
  featureId,
} from './helpers/world.js';
import { COVER_STATE, THERMOSTAT_MODE } from '../src/devices.js';

/** Open the event subscription, as the event loop does first. */
async function subscribe(world) {
  if (!world.hub.pollId) {
    world.hub.pollId = await world.hub.client.subscribe();
  }
}

/** Subscribe once, let `change` act on the controller, then read the events. */
async function step(world, change = () => {}) {
  await subscribe(world);
  await change(world.controller);
  await world.hub.pollOnce();
}

const state = (world, boschId, key) => world.fake.lastState(featureId(world.gladys, boschId, key));

async function setValue(world, boschId, key, value) {
  const device = world.fake.discoveredDevices.find(
    (d) => d.external_id === deviceId(world.gladys, boschId),
  );
  const feature = device.features.find(
    (f) => f.external_id === featureId(world.gladys, boschId, key),
  );
  return world.fake.setValue(device, feature, value);
}

const puts = (world) =>
  world.controller.requests
    .filter((r) => r.method === 'PUT')
    .map((r) => ({ path: r.path, body: r.body }));

test('the states read from the controller, as Gladys expects them', async (t) => {
  const world = await createWorld();
  t.after(() => world.stop());
  assert.deepEqual(world.fake.connectionStatus, { connected: true });

  // Heating: per room.
  assert.equal(state(world, BOSCH.climateLiving, 'temperature'), 20.4);
  assert.equal(state(world, BOSCH.climateLiving, 'setpoint'), 21);
  assert.equal(state(world, BOSCH.climateLiving, 'mode'), THERMOSTAT_MODE.AUTO);
  assert.equal(state(world, BOSCH.climateLiving, 'heating'), 1);
  assert.equal(state(world, BOSCH.climateBedroom, 'mode'), THERMOSTAT_MODE.HEATING);
  assert.equal(state(world, BOSCH.trv, 'temperature'), 20.5);
  assert.equal(state(world, BOSCH.trv2, 'battery_low'), 1);
  assert.equal(state(world, BOSCH.trv, 'battery_low'), 0);
  assert.equal(state(world, BOSCH.wallThermostat, 'humidity'), 47.3);
  // Contacts: 0 = open, 1 = closed (OPENING_SENSOR_STATE of the core).
  assert.equal(state(world, BOSCH.window, 'opening'), 0);
  assert.equal(state(world, BOSCH.door, 'opening'), 1);
  // Plugs: W, and kWh from the Wh of the controller.
  assert.equal(state(world, BOSCH.plug, 'power_switch'), 1);
  assert.equal(state(world, BOSCH.plug, 'power'), 512.3);
  assert.equal(state(world, BOSCH.plug, 'energy'), 123.456);
  assert.equal(state(world, BOSCH.plugCompact, 'power_switch'), 0);
  // Shutters: Shutter Control I sends the level as a string, and no movement.
  assert.equal(state(world, BOSCH.shutter, 'position'), 59);
  assert.equal(state(world, BOSCH.shutter, 'movement'), COVER_STATE.STOP);
  assert.equal(state(world, BOSCH.shutter2, 'position'), 100);
  assert.equal(state(world, BOSCH.leak, 'leak'), 0);
  assert.equal(state(world, BOSCH.smoke, 'smoke'), 0);
  // The last motion is days old: no motion now.
  assert.equal(state(world, BOSCH.motion, 'motion'), 0);
  // The alarm system.
  assert.equal(state(world, 'intrusionDetectionSystem', 'armed'), 0);
  assert.equal(state(world, 'intrusionDetectionSystem', 'alarm'), 0);
  assert.equal(state(world, 'intrusionDetectionSystem', 'status'), 'Disarmed');
});

test('device names follow Bosch, the heating devices are named after their room', async (t) => {
  const world = await createWorld({ config: { language: 'fr' } });
  t.after(() => world.stop());
  const names = world.fake.discoveredDevices.map((device) => device.name);
  assert.ok(names.includes('Chauffage Salon'));
  assert.ok(names.includes('Fenêtre cuisine'));
  assert.ok(names.includes('Alarme intrusion'));
  // Unsupported models are left out.
  assert.ok(!names.includes('Twinguard'));
  assert.ok(!names.includes('Caméra extérieure'));
  const room = world.fake.discoveredDevices
    .find((d) => d.name === 'Fenêtre cuisine')
    .params.find((p) => p.name === 'bosch_room');
  assert.equal(room.value, 'Cuisine');
});

test('the setpoint and the mode of a room are sent to the controller', async (t) => {
  const world = await createWorld();
  t.after(() => world.stop());
  await subscribe(world);

  assert.deepEqual(await setValue(world, BOSCH.climateLiving, 'setpoint', 22.3), {
    success: true,
  });
  // A room in eco refuses a setpoint: eco is left first.
  await setValue(world, BOSCH.climateBedroom, 'setpoint', 19);
  await setValue(world, BOSCH.climateLiving, 'mode', THERMOSTAT_MODE.HEATING);
  await setValue(world, BOSCH.climateLiving, 'mode', THERMOSTAT_MODE.OFF);
  assert.deepEqual(puts(world), [
    {
      path: `/smarthome/devices/${BOSCH.climateLiving}/services/RoomClimateControl/state`,
      body: { '@type': 'climateControlState', setpointTemperature: 22.5 },
    },
    {
      path: `/smarthome/devices/${BOSCH.climateBedroom}/services/RoomClimateControl/state`,
      body: { '@type': 'climateControlState', low: false },
    },
    {
      path: `/smarthome/devices/${BOSCH.climateBedroom}/services/RoomClimateControl/state`,
      body: { '@type': 'climateControlState', setpointTemperature: 19 },
    },
    {
      path: `/smarthome/devices/${BOSCH.climateLiving}/services/RoomClimateControl/state`,
      body: { '@type': 'climateControlState', operationMode: 'MANUAL' },
    },
    {
      path: `/smarthome/devices/${BOSCH.climateLiving}/services/RoomClimateControl/state`,
      body: { '@type': 'climateControlState', summerMode: true },
    },
  ]);

  // The changes come back through the events.
  await step(world);
  assert.equal(state(world, BOSCH.climateLiving, 'setpoint'), 22.5);
  assert.equal(state(world, BOSCH.climateLiving, 'mode'), THERMOSTAT_MODE.OFF);
  assert.equal(state(world, BOSCH.climateLiving, 'heating'), 0);

  // In summer mode, a setpoint is refused with a clear message.
  const refused = await setValue(world, BOSCH.climateLiving, 'setpoint', 21);
  assert.equal(refused.success, false);
  assert.match(refused.error, /summer mode/);

  // Back to the schedule: summer mode is left first.
  world.controller.requests.length = 0;
  await setValue(world, BOSCH.climateLiving, 'mode', THERMOSTAT_MODE.AUTO);
  assert.deepEqual(
    puts(world).map((p) => p.body),
    [
      { '@type': 'climateControlState', summerMode: false },
      { '@type': 'climateControlState', operationMode: 'AUTOMATIC' },
    ],
  );
});

test('plugs, switches and shutters are controlled', async (t) => {
  const world = await createWorld();
  t.after(() => world.stop());
  await subscribe(world);
  await setValue(world, BOSCH.plugCompact, 'power_switch', 1);
  await setValue(world, BOSCH.lightSwitch, 'power_switch', 1);
  await setValue(world, BOSCH.shutter2, 'position', 25);
  await setValue(world, BOSCH.shutter2, 'movement', COVER_STATE.CLOSE);
  await setValue(world, BOSCH.shutter2, 'movement', COVER_STATE.STOP);
  await setValue(world, BOSCH.shutter, 'movement', COVER_STATE.OPEN);
  assert.deepEqual(
    puts(world).map((p) => [p.path.split('/services/')[0].split('/').pop(), p.body]),
    [
      [BOSCH.plugCompact, { '@type': 'powerSwitchState', switchState: 'ON' }],
      [BOSCH.lightSwitch, { '@type': 'powerSwitchState', switchState: 'ON' }],
      [BOSCH.shutter2, { '@type': 'shutterControlState', level: 0.25 }],
      [BOSCH.shutter2, { '@type': 'shutterControlState', level: 0 }],
      [BOSCH.shutter2, { '@type': 'shutterControlState', operationState: 'STOPPED' }],
      [BOSCH.shutter, { '@type': 'shutterControlState', level: 1 }],
    ],
  );
  await step(world);
  assert.equal(state(world, BOSCH.plugCompact, 'power_switch'), 1);
  assert.equal(state(world, BOSCH.shutter2, 'position'), 0);
  assert.equal(state(world, BOSCH.shutter, 'position'), 100);
});

test('a read-only feature cannot be controlled', async (t) => {
  const world = await createWorld();
  t.after(() => world.stop());
  const ack = await setValue(world, BOSCH.plug, 'power', 3);
  assert.equal(ack.success, false);
  assert.match(ack.error, /cannot be controlled/);
  assert.deepEqual(puts(world), []);
});

test('the long-poll events update the states, only the changes are published', async (t) => {
  const world = await createWorld();
  t.after(() => world.stop());
  const before = world.fake.states.length;
  await step(world, (shc) => {
    shc.updateState(BOSCH.door, 'ShutterContact', { value: 'OPEN' });
    shc.updateState(BOSCH.plug, 'PowerMeter', { powerConsumption: 1890.4 });
    shc.updateState(BOSCH.climateLiving, 'TemperatureLevel', { temperature: 20.9 });
    // A battery change re-sends the same contact state: nothing new to publish.
    shc.updateState(BOSCH.window, 'BatteryLevel', {}, { faults: null });
  });
  assert.equal(state(world, BOSCH.door, 'opening'), 0);
  assert.equal(state(world, BOSCH.plug, 'power'), 1890.4);
  assert.equal(state(world, BOSCH.climateLiving, 'temperature'), 20.9);
  assert.equal(world.fake.states.length - before, 3);

  await step(world, (shc) =>
    shc.updateState(BOSCH.leak, 'WaterLeakageSensor', { state: 'LEAKAGE_DETECTED' }, {}),
  );
  assert.equal(state(world, BOSCH.leak, 'leak'), 1);
  await step(world, (shc) =>
    shc.updateState(
      BOSCH.door,
      'BatteryLevel',
      {},
      { faults: { entries: [{ type: 'LOW_BATTERY', category: 'WARNING' }] } },
    ),
  );
  assert.equal(state(world, BOSCH.door, 'battery_low'), 1);
});

test('a smoke alarm fires the trigger once, with where it comes from', async (t) => {
  const world = await createWorld({ config: { language: 'fr' } });
  t.after(() => world.stop());
  await step(world, (shc) => shc.updateState(BOSCH.smoke, 'Alarm', { value: 'PRIMARY_ALARM' }));
  assert.equal(state(world, BOSCH.smoke, 'smoke'), 1);
  // The same alarm sent again (another service of the detector changed).
  await step(world, (shc) => shc.updateState(BOSCH.smoke, 'Alarm', {}));
  await step(world, (shc) => shc.updateState(BOSCH.smoke2, 'Alarm', { value: 'SECONDARY_ALARM' }));
  assert.equal(state(world, BOSCH.smoke2, 'smoke'), 0, 'relayed: no smoke in this room');
  assert.deepEqual(world.fake.sceneEvents, [
    {
      key: 'smoke_alarm',
      data: {
        device: deviceId(world.gladys, BOSCH.smoke),
        device_name: 'Détecteur de fumée couloir',
        room: 'Entrée',
        alarm: 'detected',
      },
    },
    {
      key: 'smoke_alarm',
      data: {
        device: deviceId(world.gladys, BOSCH.smoke2),
        device_name: 'Détecteur de fumée chambre',
        room: 'Chambre',
        alarm: 'relayed',
      },
    },
  ]);
  // Back to idle, then a new alarm: a new event.
  await step(world, (shc) => shc.updateState(BOSCH.smoke, 'Alarm', { value: 'IDLE_OFF' }));
  assert.equal(state(world, BOSCH.smoke, 'smoke'), 0);
  await step(world, (shc) => shc.updateState(BOSCH.smoke, 'Alarm', { value: 'PRIMARY_ALARM' }));
  assert.equal(world.fake.sceneEvents.length, 3);
});

test('a smoke alarm seen by a full read after a gap fires too', async (t) => {
  const world = await createWorld();
  t.after(() => world.stop());
  world.controller.updateState(BOSCH.smoke, 'Alarm', { value: 'PRIMARY_ALARM' }, { silent: true });
  await world.hub.refresh();
  assert.equal(world.fake.sceneEvents.length, 1);
  assert.equal(world.fake.sceneEvents[0].data.alarm, 'detected');
});

test('a universal switch press fires the trigger, a replayed press does not', async (t) => {
  const world = await createWorld();
  t.after(() => world.stop());
  const press = (keyName, eventType, eventTimestamp) => (shc) =>
    shc.updateState(BOSCH.button, 'Keypad', { keyName, eventType, eventTimestamp, keyCode: 2 });
  await step(world, press('UPPER_BUTTON', 'PRESS_SHORT', 1760254900000));
  await step(world, press('UPPER_BUTTON', 'PRESS_LONG', 1760254905000));
  // The release of the long press, then the same press replayed.
  await step(world, press('UPPER_BUTTON', 'PRESS_LONG_RELEASED', 1760254906000));
  await step(world, (shc) => shc.updateState(BOSCH.button, 'Keypad', {}));
  // A never-pressed SWITCH2 reports its first press.
  await step(world, (shc) =>
    shc.updateState(BOSCH.button2, 'Keypad', {
      keyName: 'LOWER_LEFT_BUTTON',
      eventType: 'PRESS_SHORT',
      eventTimestamp: 1760254910000,
    }),
  );
  assert.deepEqual(
    world.fake.sceneEvents.map((e) => [e.key, e.data.device_name, e.data.button, e.data.press]),
    [
      ['button_pressed', 'Interrupteur universel', 'upper', 'short'],
      ['button_pressed', 'Interrupteur universel', 'upper', 'long'],
      ['button_pressed', 'Interrupteur universel II', 'lower_left', 'short'],
    ],
  );
  // The press already in the controller at start-up was never fired.
  assert.ok(world.fake.sceneEvents.every((e) => e.data.press !== undefined));
});

test('a motion detection raises the motion feature for the configured time', async (t) => {
  const clock = createClock();
  const world = await createWorld({ clock, config: { motion_hold_seconds: '30' } });
  t.after(() => world.stop());
  assert.equal(state(world, BOSCH.motion, 'motion'), 0);
  await step(world, (shc) =>
    shc.updateState(BOSCH.motion, 'LatestMotion', {
      latestMotionDetected: new Date(clock.now()).toISOString(),
    }),
  );
  assert.equal(state(world, BOSCH.motion, 'motion'), 1);
  // The battery level changes, the date stays: still the same motion.
  clock.advance(10_000);
  await step(world, (shc) => shc.updateState(BOSCH.motion, 'LatestMotion', {}));
  assert.equal(state(world, BOSCH.motion, 'motion'), 1);
  clock.advance(25_000);
  await world.hub.publishStates([world.hub.records.get(BOSCH.motion)]);
  assert.equal(state(world, BOSCH.motion, 'motion'), 0);
});

test('the intrusion system state follows its events', async (t) => {
  const world = await createWorld({ config: { language: 'de' } });
  t.after(() => world.stop());
  await step(world, (shc) => shc.setIntrusion('armingState', { state: 'SYSTEM_ARMING' }));
  assert.equal(state(world, 'intrusionDetectionSystem', 'status'), 'Wird scharf geschaltet');
  await step(world, (shc) => shc.setIntrusion('armingState', { state: 'SYSTEM_ARMED' }));
  assert.equal(state(world, 'intrusionDetectionSystem', 'armed'), 1);
  await step(world, (shc) => shc.setIntrusion('alarmState', { value: 'ALARM_ON' }));
  assert.equal(state(world, 'intrusionDetectionSystem', 'alarm'), 1);
  assert.equal(state(world, 'intrusionDetectionSystem', 'status'), 'Alarm!');
  // No scene event: the device states carry it (device.new-state).
  assert.deepEqual(world.fake.sceneEvents, []);
});

test('an unavailable device is flagged unreachable, and back', async (t) => {
  const world = await createWorld();
  t.after(() => world.stop());
  const transportOf = (boschId) =>
    world.fake.transports
      .filter((e) => e.device_external_id === deviceId(world.gladys, boschId))
      .at(-1)?.transport;
  assert.equal(transportOf(BOSCH.window), 'local');
  await step(world, (shc) => shc.updateDevice(BOSCH.window, { status: 'UNAVAILABLE' }));
  assert.equal(transportOf(BOSCH.window), 'unreachable');
  assert.equal(transportOf(BOSCH.door), 'local');
  await step(world, (shc) => shc.updateDevice(BOSCH.window, { status: 'AVAILABLE' }));
  assert.equal(transportOf(BOSCH.window), 'local');
});

test('a renamed, a new and a removed device update the discovery', async (t) => {
  const world = await createWorld();
  t.after(() => world.stop());
  await step(world, (shc) => shc.updateDevice(BOSCH.plug, { name: 'Prise sèche-linge' }));
  assert.ok(world.fake.discoveredDevices.some((d) => d.name === 'Prise sèche-linge'));

  // A plug paired on the controller: its events arrive before its device.
  const id = 'hdm:ZigBee:70ac08fffe445566';
  await step(world, (shc) => {
    shc.devices.push({
      ...structuredClone(shc.device(BOSCH.plugCompact)),
      id,
      name: 'Prise bureau',
      serial: '70AC08FFFE445566',
    });
    shc.services.set(`${id}/PowerSwitch`, {
      '@type': 'DeviceServiceData',
      id: 'PowerSwitch',
      deviceId: id,
      state: { '@type': 'powerSwitchState', switchState: 'ON' },
    });
    shc.push(shc.service(id, 'PowerSwitch'));
  });
  await world.hub.runPendingRescan();
  assert.ok(world.fake.discoveredDevices.some((d) => d.name === 'Prise bureau'));
  assert.equal(state(world, id, 'power_switch'), 1);

  await step(world, (shc) => {
    shc.devices = shc.devices.filter((d) => d.id !== id);
    shc.push({ '@type': 'device', id, deleted: true });
  });
  assert.ok(!world.fake.discoveredDevices.some((d) => d.name === 'Prise bureau'));
});

test('adding a device in Gladys re-sends its states', async (t) => {
  const world = await createWorld();
  t.after(() => world.stop());
  const device = world.fake.discoveredDevices.find(
    (d) => d.external_id === deviceId(world.gladys, BOSCH.window),
  );
  const before = world.fake.states.length;
  await world.fake.deviceCreated(device);
  const sent = world.fake.states.slice(before).map((s) => s.device_feature_external_id);
  assert.deepEqual(sent.sort(), device.features.map((f) => f.external_id).sort());
  assert.ok(world.fake.widgetRefreshes.includes('overview'));

  // The alarm system too, its text included.
  const intrusion = world.fake.discoveredDevices.find(
    (d) => d.external_id === deviceId(world.gladys, 'intrusionDetectionSystem'),
  );
  const mark = world.fake.states.length;
  await world.fake.deviceCreated(intrusion);
  assert.equal(world.fake.states.length - mark, 3);
});

test('a lost subscription is renewed, and what the gap hid is read again', async (t) => {
  const world = await createWorld();
  t.after(() => world.stop());
  await step(world);
  world.controller.expireSubscriptions();
  // A change during the gap, which no event will tell.
  world.controller.updateState(BOSCH.door, 'ShutterContact', { value: 'OPEN' }, { silent: true });
  await assert.rejects(world.hub.pollOnce(), (err) => err.rpcCode === -32001);
  world.hub.pollId = null;
  world.hub.needsRefresh = true;
  world.controller.push();
  setTimeout(() => world.controller.push({ '@type': 'unknownEvent' }), 50);
  await world.hub.pollOnce();
  assert.equal(state(world, BOSCH.door, 'opening'), 0);
});

test('the controller lost and found: one status change each way', async (t) => {
  const world = await createWorld();
  t.after(() => world.stop());
  world.controller.online = false;
  await assert.rejects(world.hub.refresh(), (err) => err.kind === 'unreachable');
  await world.hub.onFailure({ kind: 'unreachable', message: 'ECONNRESET' });
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.en, /does not answer/);
  const unreachable = world.fake.transports.filter((e) => e.transport === 'unreachable');
  assert.equal(unreachable.length, world.fake.discoveredDevices.length);

  world.controller.online = true;
  await world.hub.pollOnce().catch(() => {});
  world.hub.pollId = null;
  world.controller.push();
  setTimeout(() => world.controller.push({ '@type': 'unknownEvent' }), 50);
  await world.hub.pollOnce();
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
  assert.equal(world.hub.state, 'connected');
});

test('a pairing removed in the Bosch app asks for a new pairing', async (t) => {
  const world = await createWorld();
  t.after(() => world.stop());
  world.controller.revokeClients();
  const ack = await world.fake.action('test_connection', {});
  assert.match(ack.data.message.en, /refuses Gladys \(pair it again\)/);
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.fr, /appairez-le de nouveau/);
});

test('a controller with a certificate of another authority is refused', async (t) => {
  const { FakeController } = await import('./helpers/fakeController.js');
  const controller = await new FakeController({ untrusted: true }).start();
  const world = await createWorld({ controller });
  t.after(async () => {
    await world.stop();
    await controller.stop();
  });
  assert.equal(world.hub.error, 'certificate');
  assert.match(world.fake.connectionStatus.message.en, /not a valid Bosch certificate/);
  assert.deepEqual(world.controller.requests, [], 'nothing was sent to it');

  // The opt-out, for a controller whose certificate expired.
  await world.fake.configUpdated({ host: controller.host, skip_certificate_check: true });
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
});

test('onPoll is only a fallback: skipped right after a full read, else one device', async (t) => {
  const clock = createClock();
  const world = await createWorld({ clock });
  t.after(() => world.stop());
  await createAll(world);
  const device = world.fake.discoveredDevices.find(
    (d) => d.external_id === deviceId(world.gladys, BOSCH.plug),
  );
  world.controller.requests.length = 0;
  assert.deepEqual(await world.fake.poll(device), { success: true });
  assert.deepEqual(world.controller.requests, []);

  clock.advance(10 * 60_000);
  world.controller.updateState(
    BOSCH.plug,
    'PowerMeter',
    { powerConsumption: 3.2 },
    { silent: true },
  );
  assert.deepEqual(await world.fake.poll(device), { success: true });
  assert.deepEqual(
    world.controller.requests.map((r) => r.path),
    [`/smarthome/devices/${BOSCH.plug}/services`],
  );
  assert.equal(state(world, BOSCH.plug, 'power'), 3.2);
});

test('the states refresh on their own, without onPoll: long polling and timer', async (t) => {
  const world = await createWorld({
    timers: true,
    timings: { refreshMs: 300, pollSeconds: 1, retryMs: [50] },
  });
  t.after(() => world.stop());
  const wait = async (check) => {
    for (let i = 0; i < 100 && !check(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(check());
  };
  await wait(() => world.controller.subscriptions.size === 1);
  // Real time: an event.
  world.controller.updateState(BOSCH.plug, 'PowerMeter', { powerConsumption: 42 });
  await wait(() => state(world, BOSCH.plug, 'power') === 42);
  // Safety net: a change without any event, caught by the timer.
  world.controller.updateState(
    BOSCH.window,
    'ShutterContact',
    { value: 'CLOSED' },
    { silent: true },
  );
  await wait(() => state(world, BOSCH.window, 'opening') === 1);
  // No onPoll was ever needed.
  assert.ok(!world.fake.wsMessages.some((m) => m.type === 'device.poll'));
});
