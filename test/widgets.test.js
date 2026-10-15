// -----------------------------------------------------------------------------
// The overview widget and the scene action, against the fake controller.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { overviewContent } from '../src/widgets.js';
import { BOSCH, createWorld } from './helpers/world.js';

const items = (content) => content.components.find((c) => c.type === 'status').items;

test('the overview: controller, alarm, open windows, batteries, silent devices', async (t) => {
  const world = await createWorld();
  t.after(() => world.stop());
  const ack = await world.fake.widgetGet('overview', { settings: {}, language: 'en' });
  assert.equal(ack.success, true);
  const content = ack.data.content;
  assert.deepEqual(validateWidgetContent(content), []);
  assert.deepEqual(
    items(content).map((item) => [item.label, item.value, item.color]),
    [
      ['Controller', 'Connected', 'success'],
      ['Intrusion alarm', 'Disarmed', 'neutral'],
      ['Open doors and windows', 1, 'warning'],
      ['Low batteries', 1, 'warning'],
      ['Devices not answering', 0, 'success'],
    ],
  );
  const text = content.components.find((c) => c.type === 'text');
  assert.equal(text.text, 'Open: Fenêtre cuisine\nBattery: Thermostat chambre');
});

test('the overview follows the language of the dashboard', async (t) => {
  const world = await createWorld({ config: { language: 'en' } });
  t.after(() => world.stop());
  for (const language of ['fr', 'de', 'es']) {
    const { content } = (await world.fake.widgetGet('overview', { settings: {}, language })).data;
    assert.deepEqual(validateWidgetContent(content), [], language);
    assert.notEqual(items(content)[2].label, 'Open doors and windows', language);
  }
  const { content } = (await world.fake.widgetGet('overview', { settings: {}, language: 'fr' }))
    .data;
  assert.equal(content.components[1].text, 'Ouvert : Fenêtre cuisine\nPile : Thermostat chambre');
});

test('the overview is nudged when what it shows changes, not for every state', async (t) => {
  const world = await createWorld();
  t.after(() => world.stop());
  world.hub.pollId = await world.hub.client.subscribe();
  const nudges = () => world.fake.widgetRefreshes.length;
  const before = nudges();
  world.controller.updateState(BOSCH.plug, 'PowerMeter', { powerConsumption: 12 });
  await world.hub.pollOnce();
  assert.equal(nudges(), before, 'a power reading changes nothing in the widget');
  world.controller.updateState(BOSCH.door, 'ShutterContact', { value: 'OPEN' });
  await world.hub.pollOnce();
  assert.equal(nudges(), before + 1);
});

test('the overview of an integration not configured, or a controller down', () => {
  const base = {
    state: 'idle',
    error: null,
    paired: false,
    configured: false,
    devices: 0,
    open: [],
    lowBattery: [],
    unreachable: [],
    intrusion: null,
  };
  let content = overviewContent(base, 'en');
  assert.deepEqual(validateWidgetContent(content), []);
  assert.deepEqual(items(content), [
    { label: 'Controller', icon: 'server', value: 'Not configured', color: 'warning' },
  ]);
  content = overviewContent(
    { ...base, configured: true, paired: true, state: 'down', devices: 3 },
    'es',
  );
  assert.equal(items(content)[0].value, 'Inaccesible');
  assert.equal(items(content).length, 4);
  // A long list is cut to what the core keeps.
  const many = Array.from({ length: 40 }, (_, i) => `Fenêtre numéro ${i}`);
  content = overviewContent(
    { ...base, configured: true, paired: true, state: 'connected', open: many },
    'fr',
  );
  assert.deepEqual(validateWidgetContent(content), []);
  assert.ok(content.components[1].text.length <= 300);
});

test('arming from a scene is refused until the user allows it', async (t) => {
  const world = await createWorld();
  t.after(() => world.stop());
  const ack = await world.fake.sceneAction('arm_intrusion', { profile: 'full' });
  assert.equal(ack.success, false);
  assert.match(ack.error, /disabled/);
  assert.ok(!world.controller.requests.some((r) => r.path.includes('/intrusion/actions')));
});

test('arming from a scene, once allowed, with the chosen profile', async (t) => {
  const world = await createWorld({ config: { allow_arming: true } });
  t.after(() => world.stop());
  world.hub.pollId = await world.hub.client.subscribe();
  const ack = await world.fake.sceneAction('arm_intrusion', { profile: 'partial' });
  assert.deepEqual(ack, { success: true, data: { outputs: { armed: true } } });
  const arm = world.controller.requests.find((r) => r.path === '/smarthome/intrusion/actions/arm');
  assert.deepEqual(arm.body, { '@type': 'armRequest', profileId: '1' });
  await world.hub.pollOnce();
  assert.equal(
    world.fake.lastState(
      world.gladys.externalIds('shc', 'intrusionDetectionSystem').feature('status'),
    ),
    'Arming',
  );
});

test('arming a controller without an intrusion system says so', async (t) => {
  const { FakeController } = await import('./helpers/fakeController.js');
  const controller = await new FakeController({ intrusion: false }).start();
  const world = await createWorld({ controller, config: { allow_arming: true, language: 'fr' } });
  t.after(async () => {
    await world.stop();
    await controller.stop();
  });
  const ack = await world.fake.sceneAction('arm_intrusion', { profile: 'full' });
  assert.equal(ack.success, false);
  assert.match(ack.error, /pas de système d'alarme intrusion/);
});
