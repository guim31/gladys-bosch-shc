// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, a fake controller on
// localhost (real HTTPS, real client certificates), a temporary /data and a
// manual clock, with the integration wired on top through registerHandlers.
//
// No timer runs unless `timers: true`: the tests drive the event loop with
// `world.hub.pollOnce()` and the full reads with `world.hub.refresh()`.
// -----------------------------------------------------------------------------

import { X509Certificate } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { idsOf } from '../../src/devices.js';
import { Store } from '../../src/store.js';
import { generateClientIdentity } from '../../src/shc/x509.js';
import { FakeController, testPki } from './fakeController.js';

// The integration logs its lifecycle; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

export const PASSWORD = 'Secret-System-Pw1';

/** A manual clock. */
export function createClock(start = Date.UTC(2026, 9, 12, 10, 0, 0)) {
  const clock = {
    time: start,
    now: () => clock.time,
    advance(ms) {
      clock.time += ms;
    },
  };
  return clock;
}

let identity;
/** One client identity for the whole run (RSA key generation takes time). */
async function testIdentity() {
  identity ??= await generateClientIdentity({
    clientId: 'oss_gladys_0123456789ab',
    organization: 'oss_Gladys_Assistant',
  });
  return identity;
}

/**
 * @param {object} [options]
 * @param {FakeController} [options.controller]
 * @param {object} [options.config] raw integration config (host added when absent)
 * @param {boolean} [options.paired] start with a saved pairing the controller knows
 * @param {Array} [options.devices] devices already created in Gladys
 * @param {boolean} [options.connect]
 * @param {boolean} [options.timers]
 * @param {object} [options.timings]
 */
export async function createWorld({
  clock = createClock(),
  controller,
  config,
  paired = true,
  devices = [],
  connect = true,
  timers = false,
  timings = {},
  dataDir = mkdtempSync(join(tmpdir(), 'gladys-bosch-shc-')),
} = {}) {
  const shc = controller ?? (await new FakeController().start());
  const store = new Store(dataDir);
  if (paired) {
    const { keyPem, certPem } = await testIdentity();
    await store.savePairing({
      key: keyPem,
      cert: certPem,
      clientId: 'oss_gladys_0123456789ab',
      host: shc.host,
      pairedAt: '2026-10-01T10:00:00.000Z',
    });
    shc.clients.set(new X509Certificate(certPem).fingerprint256, {
      id: 'oss_gladys_0123456789ab',
      name: 'oss_Gladys_Assistant',
    });
  }
  const gladys = createFakeGladys({
    config: { host: shc.host, language: 'en', ...config },
    devices,
  });
  const app = registerHandlers(gladys, {
    store,
    timers,
    timings,
    now: clock.now,
    ca: testPki().ca,
    ports: shc.ports,
  });
  if (connect) {
    await gladys.connect();
    await app.ready;
  }
  const world = {
    gladys,
    fake: gladys.fake,
    controller: shc,
    app,
    hub: app.hub,
    clock,
    store,
    dataDir,
    async stop() {
      await app.stop();
      if (!controller) {
        await shc.stop();
      }
    },
  };
  return world;
}

/** External ids of a Bosch device. */
export const deviceId = (gladys, boschId) => idsOf(gladys, boschId).device;
export const featureId = (gladys, boschId, key) => idsOf(gladys, boschId).feature(key);

/** Add every discovered device in Gladys, as the user would. */
export async function createAll(world) {
  for (const device of world.fake.discoveredDevices) {
    await world.fake.deviceCreated(device);
  }
}

/** Ids of the fixture devices. */
export const BOSCH = {
  climateLiving: 'roomClimateControl_hz_1',
  climateBedroom: 'roomClimateControl_hz_2',
  trv: 'hdm:HomeMaticIP:3014F711A0000496D858A9B2',
  trv2: 'hdm:ZigBee:70ac08fffe5a1b2c',
  wallThermostat: 'hdm:HomeMaticIP:3014F711A0000A1B2C3D4E5F',
  roomThermostat: 'hdm:ZigBee:70ac08fffe7d6e5f',
  window: 'hdm:HomeMaticIP:3014F711A00004953859F31B',
  door: 'hdm:ZigBee:00158d0001a2b3c4',
  motion: 'hdm:HomeMaticIP:3014F711A00000953859A1B2',
  smoke: 'hdm:HomeMaticIP:3014F711A0001916D859C3D4',
  smoke2: 'hdm:ZigBee:000d6f0012abcd34',
  plug: 'hdm:ZigBee:000d6f0011223344',
  plugCompact: 'hdm:ZigBee:70ac08fffe112233',
  lightSwitch: 'hdm:HomeMaticIP:3014F711A0000B7A5D6E8F90',
  micromodule: 'hdm:ZigBee:5c0272fffe462481',
  shutter: 'hdm:HomeMaticIP:3014F711A0000C8B6E7F9A01',
  shutter2: 'hdm:ZigBee:5c0272fffe9a8b7c',
  leak: 'hdm:ZigBee:00158d00a1b2c3d4',
  button: 'hdm:HomeMaticIP:3014F711A0000E1D2C3B4A59',
  button2: 'hdm:ZigBee:000d6f0012ef5678',
};

export { FakeController };
