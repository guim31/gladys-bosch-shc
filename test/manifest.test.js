// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG, LANGUAGES, MOTION_HOLD_SECONDS } from '../src/config.js';
import { ARM_PROFILES, TRIGGERS, WIDGET_KEY } from '../src/hub.js';
import { BUTTON_KEYS } from '../src/shc/model.js';
import { SCENE_ACTIONS } from '../src/scenes.js';
import { WIDGETS } from '../src/widgets.js';
import { BOSCH, createWorld } from './helpers/world.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

// Every list of form fields the manifest can declare (same field grammar).
const allFields = [
  ...(manifest.config_schema ?? []),
  ...[
    ...(manifest.actions ?? []),
    ...(manifest.scene_triggers ?? []),
    ...(manifest.scene_actions ?? []),
  ].flatMap((item) => item.fields ?? []),
  ...(manifest.widgets ?? []).flatMap((widget) => widget.settings ?? []),
];

const CAPABILITY_FIELDS = ['scene_triggers', 'scene_actions', 'widgets'];
const keysOf = (list) => (list ?? []).map((entry) => entry.key);

function minGladysVersion() {
  const match = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, 'gladys_version must declare a minimum version');
  return match.slice(1).map(Number);
}

function isAtLeast(version, required) {
  for (let i = 0; i < required.length; i += 1) {
    if (version[i] !== required[i]) {
      return version[i] > required[i];
    }
  }
  return true;
}

test('identity: name, image, cover, local transport, categories', () => {
  assert.equal(manifest.name, 'Bosch Smart Home');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.docker_image, `ghcr.io/guim31/gladys-bosch-shc:${manifest.version}`);
  assert.equal(
    manifest.cover_image,
    'https://raw.githubusercontent.com/guim31/gladys-bosch-shc/main/cover.png',
  );
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['climate', 'protocols', 'security']);
  // The controller is reached by its IP address: no mediated discovery.
  assert.equal(manifest.network_discovery, undefined);
});

test('the versions of package.json, the manifest and the image agree', () => {
  assert.equal(manifest.version, pkg.version);
  assert.ok(manifest.docker_image.endsWith(`:${pkg.version}`));
});

test('every manifest action has a handler', async (t) => {
  const world = await createWorld();
  t.after(() => world.stop());
  assert.deepEqual(keysOf(manifest.actions), ['pair', 'test_connection']);
  for (const action of manifest.actions) {
    const ack = await world.fake.action(action.key, {});
    assert.equal(ack.success, true, `${action.key}: ${ack.error}`);
    assert.ok(ack.data.message.en, `${action.key} reports something`);
  }
});

test('no action field is a secret (the core cannot fill them, Gladys#3154)', () => {
  for (const action of manifest.actions) {
    for (const field of action.fields ?? []) {
      assert.notEqual(field.type, 'secret', `${action.key}.${field.key}`);
    }
  }
});

test('capabilities and categories require the right Gladys version', () => {
  const declared = CAPABILITY_FIELDS.filter((field) => manifest[field] !== undefined);
  assert.deepEqual(declared, CAPABILITY_FIELDS);
  assert.ok(isAtLeast(minGladysVersion(), [5, 1, 0]));
  // No widget button opens a form (#3168): 5.1.0 is enough.
  assert.deepEqual(minGladysVersion(), [5, 1, 0]);
});

test('the defaults of the config_schema are those of the code', () => {
  for (const field of manifest.config_schema) {
    if (field.type === 'section') {
      continue;
    }
    assert.ok(Object.hasOwn(DEFAULT_CONFIG, field.key), `${field.key} is known to the code`);
    if (field.type === 'secret') {
      // A secret has no default in a manifest (it would be published).
      assert.equal(field.default, undefined, field.key);
      continue;
    }
    assert.deepEqual(field.default, DEFAULT_CONFIG[field.key], `default of ${field.key}`);
  }
  const fields = manifest.config_schema.filter((field) => field.type !== 'section');
  assert.deepEqual(keysOf(fields).sort(), Object.keys(DEFAULT_CONFIG).sort());
  const options = (key) =>
    manifest.config_schema.find((field) => field.key === key).options.map((o) => o.value);
  assert.deepEqual(options('language'), LANGUAGES);
  assert.deepEqual(options('motion_hold_seconds'), MOTION_HOLD_SECONDS);
});

test('the intrusion alarm is read-only by default, and never disarmed', () => {
  const arming = manifest.config_schema.find((field) => field.key === 'allow_arming');
  assert.equal(arming.default, false);
  assert.equal(DEFAULT_CONFIG.allow_arming, false);
  const everything = JSON.stringify([manifest.actions, manifest.scene_actions, manifest.widgets]);
  assert.doesNotMatch(everything, /disarm|mute/i);
  assert.deepEqual(keysOf(manifest.scene_actions), ['arm_intrusion']);
});

test('every scene_actions key has a handler', () => {
  assert.deepEqual(keysOf(manifest.scene_actions).sort(), Object.keys(SCENE_ACTIONS).sort());
  const profile = manifest.scene_actions[0].fields.find((field) => field.key === 'profile');
  assert.deepEqual(
    profile.options.map((option) => option.value),
    Object.keys(ARM_PROFILES),
  );
});

test('the scene triggers are the ones the hub fires, with their filters and variables', async (t) => {
  assert.deepEqual(keysOf(manifest.scene_triggers).sort(), Object.values(TRIGGERS).sort());
  const world = await createWorld();
  t.after(() => world.stop());
  world.hub.pollId = await world.hub.client.subscribe();
  world.controller.updateState(BOSCH.smoke, 'Alarm', { value: 'PRIMARY_ALARM' });
  world.controller.updateState(BOSCH.button, 'Keypad', {
    keyName: 'UPPER_BUTTON',
    eventType: 'PRESS_LONG',
    eventTimestamp: 1760254999000,
  });
  await world.hub.pollOnce();
  const fired = new Map(world.fake.sceneEvents.map((event) => [event.key, event.data]));
  for (const trigger of manifest.scene_triggers) {
    const data = fired.get(trigger.key);
    assert.ok(data, `${trigger.key} was fired`);
    for (const key of [...keysOf(trigger.fields), ...keysOf(trigger.variables)]) {
      assert.ok(key in data, `${trigger.key}: "${key}" is in the event data`);
    }
    for (const key of Object.keys(data)) {
      assert.ok(
        keysOf(trigger.variables).includes(key) || keysOf(trigger.fields).includes(key),
        `${trigger.key}: "${key}" is declared`,
      );
    }
    for (const field of trigger.fields.filter((f) => f.options)) {
      assert.ok(
        field.options.some((option) => option.value === data[field.key]),
        `${trigger.key}.${field.key}: "${data[field.key]}" is an option`,
      );
    }
  }
  const buttons = manifest.scene_triggers
    .find((trigger) => trigger.key === TRIGGERS.BUTTON)
    .fields.find((field) => field.key === 'button')
    .options.map((option) => option.value);
  assert.deepEqual(buttons.sort(), Object.values(BUTTON_KEYS).sort());
});

test('every widget has a handler', () => {
  assert.deepEqual(keysOf(manifest.widgets), [WIDGET_KEY]);
  assert.deepEqual(Object.keys(WIDGETS), [WIDGET_KEY]);
});

test('every select field has unique options and a valid default', () => {
  for (const field of allFields.filter((f) => f.type === 'select' && f.options)) {
    const values = field.options.map((option) => option.value);
    assert.equal(new Set(values).size, values.length, `${field.key}: duplicate option`);
    if (field.default !== undefined) {
      assert.ok(values.includes(field.default), `${field.key}: default not an option`);
    }
  }
});
