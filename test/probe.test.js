// -----------------------------------------------------------------------------
// scripts/probe.mjs runs against the fake controller, so the run on a real
// controller does not fail on a mistake of the script itself; and it prints
// no name, id, address, key nor password.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { testPki } from './helpers/fakeController.js';
import { BOSCH, createWorld } from './helpers/world.js';

const run = promisify(execFile);

test('the probe reads the controller, read-only, and prints nothing personal', async (t) => {
  const world = await createWorld();
  t.after(() => world.stop());
  const { controller, dataDir } = world;
  const caFile = join(dataDir, 'test-ca.pem');
  await writeFile(caFile, testPki().ca);
  const script = new URL('../scripts/probe.mjs', import.meta.url).pathname;
  const ports = `${controller.ports.pairing},${controller.ports.api},${controller.ports.public}`;
  const common = [script, controller.host, '--ports', ports, '--ca', caFile];

  let { stdout } = await run(process.execPath, common);
  assert.match(stdout, /TLS api \(\d+\)\s+OK/);
  assert.match(stdout, /Public information\s+generation SHC_2/);
  assert.match(stdout, /API without client certificate\s+refused as refused/);
  // Outside pairing mode, the pairing port refuses the session.
  assert.match(stdout, /TLS pairing \(\d+\), verified\s+refused/);

  const writes = controller.requests.length;
  // An event once the probe has subscribed (the test's own subscription aside).
  const known = new Set(controller.subscriptions.keys());
  const waitForProbe = setInterval(() => {
    if ([...controller.subscriptions.keys()].some((id) => !known.has(id))) {
      clearInterval(waitForProbe);
      controller.updateState(BOSCH.plug, 'PowerMeter', { powerConsumption: 7 });
    }
  }, 20);
  t.after(() => clearInterval(waitForProbe));
  ({ stdout } = await run(process.execPath, [
    ...common,
    '--cert',
    world.store.path('cert'),
    '--key',
    world.store.path('key'),
  ]));
  assert.match(stdout, /Devices, services, rooms\s+23, 55, 5/);
  assert.match(stdout, /ROOM_CLIMATE_CONTROL → climate\s+2 device\(s\)/);
  assert.match(stdout, /TWINGUARD \(ignored\)/);
  assert.match(stdout, /RoomClimateControl: @type\|boostMode/);
  assert.match(stdout, /BatteryLevel\+faults/);
  assert.match(stdout, /Events in 10 s\s+DeviceServiceData:PowerMeter/);
  assert.ok(
    controller.requests
      .slice(writes)
      .every((r) => r.method === 'GET' || r.path === '/remote/json-rpc'),
    'read-only',
  );

  for (const secret of [
    controller.host,
    'Prise lave-linge',
    'Salon',
    BOSCH.plug,
    '3014F711',
    'PRIVATE KEY',
    'CERTIFICATE',
  ]) {
    assert.ok(!stdout.includes(secret), `"${secret}" is not printed`);
  }
});
