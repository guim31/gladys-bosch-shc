// -----------------------------------------------------------------------------
// The pure parts: the certificate builder, the configuration, the readers of
// the controller states, the HTTP error classification.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { createCertificate, generateClientIdentity, pairingCertificate } from '../src/shc/x509.js';
import { DEFAULT_CONFIG, normalizeConfig, parseHost } from '../src/config.js';
import { mergeIntrusion, read, readIntrusion } from '../src/shc/model.js';
import { BOSCH_ROOT_CA } from '../src/shc/client.js';
import { ERROR_KINDS, classify } from '../src/shc/http.js';

test('the client certificate is a valid self-signed X.509 v3, like boschshcpy makes', async () => {
  const now = new Date(Date.UTC(2026, 9, 15, 8, 0, 0));
  const { keyPem, certPem } = await generateClientIdentity({
    clientId: 'oss_gladys_00aa11bb22cc',
    organization: 'oss_Gladys_Assistant',
    now,
  });
  const certificate = new X509Certificate(certPem);
  assert.equal(certificate.subject, 'CN=oss_gladys_00aa11bb22cc\nO=oss_Gladys_Assistant');
  assert.equal(certificate.issuer, certificate.subject);
  assert.equal(certificate.ca, true);
  assert.ok(certificate.verify(certificate.publicKey), 'self-signed');
  assert.ok(certificate.checkPrivateKey(createPrivateKey(keyPem)));
  assert.equal(new Date(certificate.validFrom).getTime(), now.getTime());
  // Ten years.
  assert.ok(new Date(certificate.validTo).getUTCFullYear() >= 2036);
  assert.equal(certificate.publicKey.asymmetricKeyDetails.modulusLength, 2048);
  assert.match(keyPem, /^-----BEGIN RSA PRIVATE KEY-----/);
});

test('certificates past 2049 use GeneralizedTime, issued ones verify with their CA', () => {
  const ca = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const leaf = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const caPem = createCertificate({
    subject: { commonName: 'Root' },
    publicKey: ca.publicKey,
    signingKey: ca.privateKey,
  });
  const leafPem = createCertificate({
    subject: { commonName: 'Leaf', organization: 'Ünïcode Org' },
    issuer: { commonName: 'Root' },
    publicKey: leaf.publicKey,
    signingKey: ca.privateKey,
    notBefore: new Date(Date.UTC(2049, 0, 1)),
    notAfter: new Date(Date.UTC(2060, 5, 30)),
    ca: false,
    serial: Buffer.from([0x80, 0x01]),
  });
  const certificate = new X509Certificate(leafPem);
  assert.ok(certificate.verify(new X509Certificate(caPem).publicKey));
  assert.ok(certificate.checkIssued(new X509Certificate(caPem)));
  assert.equal(certificate.ca, false);
  assert.equal(new Date(certificate.validTo).toISOString(), '2060-06-30T00:00:00.000Z');
  assert.equal(certificate.serialNumber, '8001');
  assert.match(certificate.subject, /O=Ünïcode Org/);
});

test('the pairing request carries the certificate on one line, framed by \\r', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nAAAA\nBBBB\n-----END CERTIFICATE-----\n';
  assert.equal(
    pairingCertificate(pem),
    '-----BEGIN CERTIFICATE-----\rAAAABBBB\r-----END CERTIFICATE-----',
  );
});

test('the bundled authority is the Bosch "Smart Home Controller Productive Root CA"', () => {
  const root = new X509Certificate(BOSCH_ROOT_CA);
  assert.match(root.subject, /CN=Smart Home Controller Productive Root CA/);
  assert.equal(
    root.fingerprint256,
    'CA:D7:47:FB:48:25:BD:5B:7E:DA:E5:65:86:C9:81:B7:56:3B:30:F7:FE:EB:12:73:C0:E5:52:FE:8B:C1:E3:35',
  );
  assert.ok(new Date(root.validTo) > new Date('2035-01-01'));
});

test('the controller address: an IP or a name, whatever was pasted around it', () => {
  assert.equal(parseHost(' 192.168.1.20 '), '192.168.1.20');
  assert.equal(parseHost('https://192.168.1.20:8444/smarthome'), '192.168.1.20');
  assert.equal(parseHost('SHC-Living.local'), 'shc-living.local');
  assert.equal(parseHost('[fd00::1]:8444'), 'fd00::1');
  assert.equal(parseHost('fd00::1'), 'fd00::1');
  assert.equal(parseHost('https://admin:pw@192.168.1.20'), null);
  assert.equal(parseHost('192.168.1.20 ; rm'), null);
  assert.equal(parseHost(''), null);
  assert.equal(parseHost(42), null);
});

test('the configuration is normalized, the defaults safe', () => {
  const config = normalizeConfig({});
  assert.deepEqual(config, {
    host: null,
    hostTyped: false,
    password: '',
    language: 'fr',
    motionHoldMs: 60_000,
    allowArming: false,
    insecure: false,
  });
  assert.equal(DEFAULT_CONFIG.allow_arming, false);
  const typed = normalizeConfig({
    host: 'shc',
    system_password: ' pw with spaces ',
    language: 'xx',
    motion_hold_seconds: 300,
    allow_arming: 'true',
    skip_certificate_check: true,
  });
  assert.equal(typed.password, ' pw with spaces ');
  assert.equal(typed.language, 'fr');
  assert.equal(typed.motionHoldMs, 300_000);
  assert.equal(typed.allowArming, true);
  assert.equal(typed.insecure, true);
  assert.equal(normalizeConfig({ motion_hold_seconds: '7' }).motionHoldMs, 60_000);
});

test('the readers of the controller states', () => {
  const svc = (state, faults) => ({ state, ...(faults ? { faults } : {}) });
  assert.equal(read.contact(svc({ value: 'OPEN' })), 'open');
  assert.equal(read.contact(svc({ value: 'CLOSED' })), 'closed');
  assert.equal(read.contact(svc({})), null);
  assert.equal(read.contact(undefined), null);

  assert.equal(read.heatingMode(svc({ operationMode: 'AUTOMATIC', summerMode: true })), 'off');
  assert.equal(read.heatingMode(svc({ operationMode: 'MANUAL' })), 'manual');
  assert.equal(read.heatingMode(svc({ operationMode: 'AUTOMATIC' })), 'automatic');
  assert.equal(read.heatDemand(svc({ hasDemand: true, summerMode: true })), false);
  assert.equal(read.setpoint(svc({ setpointTemperature: '21.5' })), 21.5);

  assert.equal(read.smokeAlarm(svc({ value: 'PRIMARY_ALARM' })), 'smoke');
  assert.equal(read.smokeAlarm(svc({ value: 'SECONDARY_ALARM' })), 'relayed');
  assert.equal(read.smokeAlarm(svc({ value: 'INTRUSION_ALARM' })), 'intrusion');
  assert.equal(read.smokeAlarm(svc({ value: 'INTRUSION_ALARM_OFF_REQUESTED' })), 'idle');

  assert.equal(read.shutterPosition(svc({ level: '0.333' })), 33);
  assert.equal(read.shutterPosition(svc({ level: 1.4 })), 100);
  assert.equal(read.shutterMovement(svc({ level: 0.5 })), 'stopped');
  assert.equal(read.shutterMovement(svc({ operationState: 'CLOSING' })), 'closing');

  assert.equal(read.energy(svc({ energyConsumption: 1500 })), 1.5);
  assert.equal(read.power(svc({ powerConsumption: -0.4 })), 0);
  assert.equal(read.batteryLow(svc({})), false);
  assert.equal(read.batteryLow(svc({}, { entries: [{ type: 'CRITICAL_LOW' }] })), true);
  assert.equal(read.batteryLow(svc({}, { entries: [{ type: 'OTHER' }] })), false);
  assert.equal(read.leak(svc({ state: 'LEAKAGE_DETECTED' })), true);

  assert.deepEqual(
    read.keypad(
      svc({
        keyName: 'LOWER_RIGHT_BUTTON',
        eventType: 'PRESS_LONG',
        eventTimestamp: 1760000000000,
      }),
    ),
    { key: 'lower_right', press: 'long', timestamp: 1760000000000 },
  );
  assert.equal(
    read.keypad(
      svc({ keyName: 'UPPER_BUTTON', eventType: 'PRESS_LONG_RELEASED', eventTimestamp: 1 }),
    ),
    null,
  );
  assert.equal(read.keypad(svc({})), null);
});

test('the intrusion system: full state and partial events', () => {
  let system = {
    '@type': 'systemState',
    systemAvailability: { '@type': 'systemAvailabilityState', available: true },
    armingState: { '@type': 'armingState', state: 'SYSTEM_DISARMED' },
    alarmState: { '@type': 'alarmState', value: 'ALARM_OFF' },
    activeConfigurationProfile: { '@type': 'activeConfigurationProfile', profileId: '0' },
  };
  assert.deepEqual(readIntrusion(system), {
    available: true,
    arming: 'disarmed',
    alarm: 'off',
    profile: '0',
    remaining: null,
  });
  system = mergeIntrusion(system, {
    '@type': 'armingState',
    state: 'SYSTEM_ARMING',
    remainingTimeUntilArmed: 29000,
  });
  system = mergeIntrusion(system, { '@type': 'alarmState', value: 'PRE_ALARM' });
  assert.deepEqual(readIntrusion(system), {
    available: true,
    arming: 'arming',
    alarm: 'pre_alarm',
    profile: '0',
    remaining: 29000,
  });
  assert.equal(readIntrusion(null).available, false);
});

test('transport errors are classified for the user', () => {
  const kind = (err, done = false) => classify(err, done).kind;
  assert.equal(
    kind(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })),
    ERROR_KINDS.UNREACHABLE,
  );
  assert.equal(kind(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), ERROR_KINDS.UNREACHABLE);
  assert.equal(
    kind(Object.assign(new Error('x'), { name: 'TimeoutError' })),
    ERROR_KINDS.UNREACHABLE,
  );
  assert.equal(
    kind(Object.assign(new Error('x'), { code: 'CERT_HAS_EXPIRED' })),
    ERROR_KINDS.CERTIFICATE,
  );
  assert.equal(
    kind(Object.assign(new Error('x'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })),
    ERROR_KINDS.CERTIFICATE,
  );
  // A TLS session refused during the handshake: the client is not accepted.
  assert.equal(kind(Object.assign(new Error('x'), { code: 'ECONNRESET' })), ERROR_KINDS.REFUSED);
  assert.equal(
    kind(Object.assign(new Error('x'), { code: 'ECONNRESET' }), true),
    ERROR_KINDS.UNREACHABLE,
  );
  assert.equal(
    kind(
      Object.assign(new Error('ssl3_read_bytes:sslv3 alert handshake failure'), {
        code: 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
      }),
    ),
    ERROR_KINDS.REFUSED,
  );
});
