// -----------------------------------------------------------------------------
// The pairing, end to end against the fake controller: the button not
// pressed, a wrong password, then a pairing that works and survives a
// restart. The generated certificate is the one the controller authenticates.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { FakeController, PASSWORD, createWorld } from './helpers/world.js';

async function unpaired(t, config = {}) {
  const controller = await new FakeController().start();
  const world = await createWorld({
    controller,
    paired: false,
    config: { system_password: PASSWORD, ...config },
  });
  t.after(async () => {
    await world.stop();
    await controller.stop();
  });
  return world;
}

test('before the pairing, the status says what to do', async (t) => {
  const world = await unpaired(t);
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.en, /press the button of the controller/);
  assert.deepEqual(world.fake.discoveredDevices, []);
  const ack = await world.fake.action('test_connection', {});
  assert.match(ack.data.message.en, /Not paired yet/);
});

test('the controller not in pairing mode: say to press its button', async (t) => {
  const world = await unpaired(t);
  const ack = await world.fake.action('pair', {});
  assert.equal(ack.success, true);
  assert.match(ack.data.message.en, /not in pairing mode \(press its button/);
  assert.match(ack.data.message.de, /Kopplungsmodus/);
  assert.equal(world.controller.clients.size, 0);
});

test('a wrong system password is reported as such', async (t) => {
  const world = await unpaired(t, { system_password: 'wrong-password' });
  world.controller.pairingMode = true;
  const ack = await world.fake.action('pair', {});
  assert.match(ack.data.message.en, /system password refused/);
  assert.equal(world.controller.clients.size, 0);
});

test('no password, no address: nothing is sent', async (t) => {
  const world = await unpaired(t, { system_password: '' });
  world.controller.pairingMode = true;
  let ack = await world.fake.action('pair', {});
  assert.match(ack.data.message.en, /system password/);
  await world.fake.configUpdated({ host: '' });
  ack = await world.fake.action('pair', {});
  assert.match(ack.data.message.en, /Enter the IP address/);
  await world.fake.configUpdated({ host: 'https://user:pw@192.0.2.10/' });
  ack = await world.fake.action('pair', {});
  assert.match(ack.data.message.en, /Address not understood/);
  assert.equal(world.controller.pairings.length, 0);
});

test('a pairing that works: certificate registered, devices found, password erased', async (t) => {
  const world = await unpaired(t);
  world.controller.pairingMode = true;
  const ack = await world.fake.action('pair', {});
  assert.match(ack.data.message.en, /^Paired\. 21 device\(s\) found/);

  // What the controller received.
  const [client] = world.controller.pairings;
  assert.equal(client['@type'], 'client');
  assert.match(client.id, /^oss_gladys_[0-9a-f]{12}$/);
  assert.equal(client.name, 'oss_Gladys_Assistant');
  assert.equal(client.primaryRole, 'ROLE_RESTRICTED_CLIENT');
  assert.match(client.certificate, /^-----BEGIN CERTIFICATE-----\r[A-Za-z0-9+/=]+\r-----END/);

  // What the container keeps: the key, readable by its user only.
  const saved = await world.store.loadPairing();
  assert.equal(saved.clientId, client.id);
  assert.equal((await stat(world.store.path('key'))).mode & 0o777, 0o600);
  const certificate = new X509Certificate(saved.cert);
  assert.equal(certificate.subject, `CN=${client.id}\nO=oss_Gladys_Assistant`);
  assert.ok(certificate.checkPrivateKey((await import('node:crypto')).createPrivateKey(saved.key)));

  // Connected with it, and the system password is not kept in Gladys.
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
  assert.equal(world.fake.discoveredDevices.length, 21);
  assert.equal(world.fake.config.system_password, '');
});

test('the pairing survives a restart of the container', async (t) => {
  const first = await unpaired(t);
  first.controller.pairingMode = true;
  await first.fake.action('pair', {});
  await first.app.stop();
  first.controller.pairingMode = false;

  const second = await createWorld({
    controller: first.controller,
    paired: false,
    dataDir: first.dataDir,
  });
  t.after(() => second.stop());
  assert.deepEqual(second.fake.connectionStatus, { connected: true });
  assert.equal(second.fake.discoveredDevices.length, 21);
});

test('a new controller address keeps the pairing (DHCP): only the connection moves', async (t) => {
  const world = await createWorld();
  t.after(() => world.stop());
  await world.fake.configUpdated({ host: '127.0.0.2', language: 'en' });
  assert.equal(world.hub.client.host, '127.0.0.2');
  assert.ok(world.hub.pairing, 'the pairing is kept');
  await world.fake.configUpdated({ host: world.controller.host, language: 'en' });
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
});
