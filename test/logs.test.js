// -----------------------------------------------------------------------------
// What the integration writes at the default level (info): the lifecycle
// only. A normal cycle writes nothing, a failure that repeats is logged once,
// and its end once. Never the system password, the private key, the client
// certificate nor the subscription id — not even at debug.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOSCH, FakeController, PASSWORD, createWorld } from './helpers/world.js';

/** Capture the lines of the SDK logger at a level. */
function captureLogs(t, level = 'info') {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  t.after(() => {
    process.env.LOG_LEVEL = previous;
  });
  const lines = [];
  const record =
    (stream) =>
    (...args) =>
      lines.push({
        stream,
        text: args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(' '),
      });
  t.mock.method(console, 'log', record('out'));
  t.mock.method(console, 'error', record('err'));
  t.mock.method(console, 'warn', record('err'));
  t.mock.method(console, 'info', record('out'));
  t.mock.method(console, 'debug', record('out'));
  return {
    lines,
    clear: () => lines.splice(0),
    texts: () => lines.map((line) => line.text),
  };
}

async function step(world, change) {
  if (!world.hub.pollId) {
    world.hub.pollId = await world.hub.client.subscribe();
  }
  change(world.controller);
  await world.hub.pollOnce();
}

test('a normal cycle writes nothing at info: events, full reads, states', async (t) => {
  const logs = captureLogs(t);
  const world = await createWorld();
  t.after(() => world.stop());
  assert.ok(
    logs.texts().some((text) => text.includes('Connected to the controller')),
    'the start is logged',
  );
  logs.clear();
  for (let i = 0; i < 5; i += 1) {
    await step(world, (shc) => {
      shc.updateState(BOSCH.plug, 'PowerMeter', { powerConsumption: 100 + i });
      shc.updateState(BOSCH.climateLiving, 'TemperatureLevel', { temperature: 20 + i / 10 });
      shc.updateState(BOSCH.door, 'ShutterContact', { value: i % 2 ? 'OPEN' : 'CLOSED' });
    });
    await world.hub.refresh();
  }
  assert.deepEqual(logs.texts(), []);
});

test('a user command is one info line', async (t) => {
  const logs = captureLogs(t);
  const world = await createWorld();
  t.after(() => world.stop());
  logs.clear();
  const device = world.fake.discoveredDevices.find((d) => d.name === 'Prise lampe');
  await world.fake.setValue(device, device.features[0], 1);
  assert.equal(logs.lines.length, 1, logs.texts().join('\n'));
  assert.match(logs.lines[0].text, /Command: Prise lampe power_switch=1/);
});

test('a controller that stays down is logged once, and once when it is back', async (t) => {
  const logs = captureLogs(t);
  const world = await createWorld();
  t.after(() => world.stop());
  logs.clear();
  world.controller.online = false;
  for (let i = 0; i < 5; i += 1) {
    await world.hub.refresh().catch((err) => world.hub.onFailure(err));
  }
  const down = logs.lines.filter((line) => line.stream === 'err');
  assert.equal(down.length, 1, logs.texts().join('\n'));
  assert.equal(logs.lines.length, 1);

  logs.clear();
  world.controller.online = true;
  await world.hub.refresh();
  world.hub.onSuccess();
  world.hub.onSuccess();
  assert.equal(logs.lines.length, 1, logs.texts().join('\n'));
  assert.match(logs.lines[0].text, /connection restored/);
});

test('Gladys refusing the states is logged once', async (t) => {
  const logs = captureLogs(t);
  const world = await createWorld();
  t.after(() => world.stop());
  logs.clear();
  t.mock.method(world.gladys, 'publishChangedStates', async () => {
    throw new Error('HTTP 429');
  });
  for (let i = 0; i < 4; i += 1) {
    await step(world, (shc) => shc.updateState(BOSCH.plug, 'PowerMeter', { powerConsumption: i }));
  }
  assert.equal(logs.lines.length, 1, logs.texts().join('\n'));
  assert.match(logs.lines[0].text, /States refused by Gladys/);
});

test('no secret in the logs, even at debug: password, key, certificate, subscription', async (t) => {
  const logs = captureLogs(t, 'debug');
  const controller = await new FakeController().start();
  const world = await createWorld({
    controller,
    paired: false,
    config: { system_password: PASSWORD },
  });
  t.after(async () => {
    await world.stop();
    await controller.stop();
  });
  // A failed pairing, a good one, events, a lost controller.
  await world.fake.action('pair', {});
  controller.pairingMode = true;
  await world.fake.action('pair', {});
  await step(world, (shc) => shc.updateState(BOSCH.plug, 'PowerSwitch', { switchState: 'OFF' }));
  controller.online = false;
  await world.hub.refresh().catch((err) => world.hub.onFailure(err));

  const text = logs.texts().join('\n');
  assert.ok(text.includes('Paired with the controller'), 'the pairing is logged');
  assert.ok(!text.includes(PASSWORD), 'never the system password');
  assert.ok(!text.includes(Buffer.from(PASSWORD).toString('base64')), 'not even encoded');
  const { key, cert } = world.hub.pairing;
  const body = (pem) => pem.split('\n').slice(1, 3).join('');
  assert.ok(!text.includes(body(key)), 'never the private key');
  assert.ok(!text.includes(body(cert)), 'never the certificate');
  assert.ok(!/PRIVATE KEY/.test(text));
  for (const id of controller.subscriptions.keys()) {
    assert.ok(!text.includes(id), 'never the subscription id');
  }
});
