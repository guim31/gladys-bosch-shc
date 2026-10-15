// -----------------------------------------------------------------------------
// Conformity with the Gladys core, on every device discovered from realistic
// fixtures (test/fixtures/shc: a house with every supported Bosch family, a
// few unsupported models and the intrusion system), read through the fake
// controller, in every feature-name language.
//
// The table (test/fixtures/gladys-feature-table.json) is extracted from the
// core code: a category/type couple missing there shows as "undefined" or
// without icon in Gladys, a poll frequency outside its list is a 400 on
// discovery, a feature without min/max is a 422 on "Add to Gladys".
// Do not loosen this test to make it pass: fix the integration.
// (Adapted from guim31/gladys-wled.)
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FakeController, createWorld } from './helpers/world.js';

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

const scenarios = [
  { label: 'English names', config: { language: 'en' } },
  { label: 'French names', config: { language: 'fr' } },
  { label: 'German names', config: { language: 'de' } },
  { label: 'Spanish names', config: { language: 'es' } },
  { label: 'no intrusion system', config: { language: 'fr' }, intrusion: false },
];

for (const scenario of scenarios) {
  test(`every discovered device follows the Gladys rules (${scenario.label})`, async (t) => {
    const controller = await new FakeController({ intrusion: scenario.intrusion ?? true }).start();
    const world = await createWorld({ controller, config: scenario.config });
    t.after(async () => {
      await world.stop();
      await controller.stop();
    });
    const devices = world.fake.discoveredDevices;
    // 20 supported Bosch devices (3 unsupported ignored), plus the alarm system.
    assert.equal(devices.length, scenario.intrusion === false ? 20 : 21);

    const deviceIds = new Set();
    const allFeatureIds = new Set();
    for (const device of devices) {
      const where = device.name;
      assert.ok(device.name && device.name.length <= 100, `${where}: name`);
      assert.ok(!deviceIds.has(device.external_id), `${where}: duplicate device external_id`);
      deviceIds.add(device.external_id);

      // should_poll: true if and only if poll_frequency is provided, in ms.
      if (device.poll_frequency === undefined) {
        assert.notEqual(device.should_poll, true, `${where}: should_poll without poll_frequency`);
      } else {
        assert.equal(device.should_poll, true, `${where}: poll_frequency without should_poll`);
        assert.ok(
          table.poll_frequencies_ms.includes(device.poll_frequency),
          `${where}: poll_frequency ${device.poll_frequency} is not one of ${table.poll_frequencies_ms}`,
        );
      }

      assert.ok(device.features.length > 0, `${where}: no feature`);
      const names = new Set();
      for (const feature of device.features) {
        const at = `${where} / ${feature.name}`;
        const pair = table.pairs[`${feature.category}/${feature.type}`];
        assert.ok(pair, `${at}: ${feature.category}/${feature.type} is not a couple Gladys knows`);
        assert.ok(
          pair.label_en && pair.label_fr && pair.icon,
          `${at}: couple without label or icon`,
        );

        assert.equal(typeof feature.min, 'number', `${at}: min must be a number`);
        assert.equal(typeof feature.max, 'number', `${at}: max must be a number`);
        assert.ok(
          Number.isFinite(feature.min) && Number.isFinite(feature.max),
          `${at}: finite min/max`,
        );
        assert.ok(feature.min <= feature.max, `${at}: min > max`);
        assert.equal(typeof feature.read_only, 'boolean', `${at}: read_only must be a boolean`);
        assert.equal(
          typeof feature.has_feedback,
          'boolean',
          `${at}: has_feedback must be a boolean`,
        );
        if (feature.unit !== undefined) {
          assert.ok(table.units.includes(feature.unit), `${at}: unknown unit ${feature.unit}`);
        }
        for (const option of feature.supported_options ?? []) {
          assert.ok(Number.isInteger(option.value), `${at}: option values are integers`);
          assert.ok(option.value >= feature.min && option.value <= feature.max, `${at}: option`);
          assert.ok(option.label, `${at}: option without label`);
        }

        assert.ok(!allFeatureIds.has(feature.external_id), `${at}: duplicate external_id`);
        allFeatureIds.add(feature.external_id);
        assert.ok(feature.external_id.startsWith(`${device.external_id}:`), `${at}: id prefix`);
        assert.ok(!names.has(feature.name), `${at}: duplicate feature name on the device`);
        names.add(feature.name);

        // The value read from the fixtures fits the declared bounds.
        const value = world.fake.lastState(feature.external_id);
        if (feature.category === 'text') {
          assert.equal(typeof value, 'string', `${at}: no text published`);
          assert.ok(value.length > 0, `${at}: empty text`);
          continue;
        }
        assert.equal(typeof value, 'number', `${at}: no state published`);
        assert.ok(value >= feature.min && value <= feature.max, `${at}: ${value} out of bounds`);
        if (['binary', 'integer', 'mode', 'state', 'operating-state'].includes(feature.type)) {
          assert.ok(Number.isInteger(value), `${at}: ${value} is not an integer`);
        }
      }
    }
  });
}

test('the core scheduler is never relied upon: no device asks to be polled', async (t) => {
  const world = await createWorld();
  t.after(() => world.stop());
  for (const device of world.fake.discoveredDevices) {
    assert.equal(device.should_poll, false, device.name);
    assert.equal(device.poll_frequency, undefined, device.name);
  }
});
