#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Probe a real Bosch Smart Home Controller with the integration's own client,
// read-only, to check what could not be checked without the hardware.
//
//   node scripts/probe.mjs <controller-ip>
//   node scripts/probe.mjs <controller-ip> --cert client-cert.pem --key client-key.pem
//
// Without a pairing it checks, without sending anything that changes the
// controller: the public information (port 8446), that the controller
// certificate chains to the bundled Bosch root, how the API (8444) refuses a
// client without certificate, and how the pairing port (8443) behaves outside
// pairing mode. With the files of a pairing (the /data of the integration, or
// a boschshcpy pairing) it also reads the devices, services and rooms, and
// waits 10 s for events.
//
// It prints models, service ids, state keys and counts only: never a device
// name, id, serial, address, room name, key or certificate.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { connect } from 'node:tls';
import { BOSCH_ROOT_CA, DEFAULT_PORTS, ShcClient } from '../src/shc/client.js';
import { classify } from '../src/shc/http.js';
import { KIND_BY_MODEL } from '../src/shc/model.js';

const args = process.argv.slice(2);
const host = args.find(
  (arg) => !arg.startsWith('--') && !args[args.indexOf(arg) - 1]?.startsWith('--'),
);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
if (!host) {
  console.log('Usage: node scripts/probe.mjs <controller-ip> [--cert file --key file]');
  process.exit(2);
}

const say = (label, value) => console.log(`${label.padEnd(34)} ${value}`);
// The address is the user's: kept out of the output, like everything else.
const hide = (text) => String(text).replaceAll(host, '<controller>');
const describe = (err) => {
  const kind = classify(err, false);
  return hide(
    `${kind.kind} (${err.code ?? err.status ?? err.name}: ${String(err.message).slice(0, 120)})`,
  );
};

// For the tests of this script only: a fake controller on other ports, with
// its own authority.
const ports = option('ports')
  ? Object.fromEntries(
      option('ports')
        .split(',')
        .map((port, i) => [Object.keys(DEFAULT_PORTS)[i], Number(port)]),
    )
  : DEFAULT_PORTS;
const ca = option('ca') ? readFileSync(option('ca'), 'utf8') : BOSCH_ROOT_CA;

/** A bare TLS handshake: does it complete, and what does the server present? */
function handshake(port, { insecure }) {
  return new Promise((resolve) => {
    const socket = connect({
      host,
      port,
      ca,
      rejectUnauthorized: !insecure,
      checkServerIdentity: () => undefined,
      timeout: 10_000,
    });
    socket.once('secureConnect', () => {
      const peer = socket.getPeerX509Certificate();
      const chain = [];
      for (
        let cert = socket.getPeerCertificate(true);
        cert && !chain.includes(cert.fingerprint256);
        cert = cert.issuerCertificate
      ) {
        chain.push(cert.fingerprint256);
        if (cert.issuerCertificate === cert) {
          break;
        }
      }
      resolve({
        ok: true,
        protocol: socket.getProtocol(),
        issuer: peer?.issuer.replace(/\n/g, ', '),
        validTo: peer?.validTo,
        chainLength: chain.length,
        authorized: socket.authorized,
      });
      socket.end();
    });
    socket.once('timeout', () => {
      resolve({ ok: false, error: 'timeout' });
      socket.destroy();
    });
    socket.once('error', (err) => resolve({ ok: false, error: describe(err) }));
  });
}

console.log('--- Without pairing (nothing is changed on the controller)');
for (const [name, port] of Object.entries(ports)) {
  const verified = await handshake(port, { insecure: false });
  if (verified.ok) {
    say(
      `TLS ${name} (${port})`,
      `OK, ${verified.protocol}, issuer "${verified.issuer}", valid to ${verified.validTo}, chain ${verified.chainLength}`,
    );
    continue;
  }
  say(`TLS ${name} (${port}), verified`, verified.error);
  const unverified = await handshake(port, { insecure: true });
  say(
    `TLS ${name} (${port}), unverified`,
    unverified.ok
      ? `OK, ${unverified.protocol}, issuer "${unverified.issuer}", valid to ${unverified.validTo}`
      : unverified.error,
  );
}

const anonymous = new ShcClient({ host, ca, ports, timeoutMs: 15_000 });
try {
  const info = await anonymous.publicInformation();
  say(
    'Public information',
    `generation ${info?.shcGeneration}, software ${info?.softwareUpdateState?.swInstalledVersion}, API ${JSON.stringify(info?.apiVersions)}`,
  );
} catch (err) {
  say('Public information', describe(err));
}
try {
  await anonymous.devices();
  say('API without client certificate', 'ANSWERED (unexpected)');
} catch (err) {
  say('API without client certificate', `refused as ${describe(err)}`);
}

const certFile = option('cert');
const keyFile = option('key');
if (!certFile || !keyFile) {
  console.log('No --cert/--key: stopping before the authenticated reads.');
  process.exit(0);
}

console.log('--- With the pairing (read-only)');
const client = new ShcClient({
  host,
  cert: readFileSync(certFile, 'utf8'),
  key: readFileSync(keyFile, 'utf8'),
  insecure: args.includes('--insecure'),
  ca,
  ports,
  timeoutMs: 20_000,
});
try {
  const information = await client.information();
  say(
    'Information keys',
    Object.keys(information ?? {})
      .sort()
      .join(', '),
  );
  const [devices, services, rooms, intrusion] = await Promise.all([
    client.devices(),
    client.services(),
    client.rooms(),
    client.intrusionState(),
  ]);
  say('Devices, services, rooms', `${devices.length}, ${services.length}, ${rooms.length}`);
  const byModel = new Map();
  for (const device of devices) {
    const entry = byModel.get(device.deviceModel) ?? {
      count: 0,
      statuses: new Set(),
      services: new Map(),
    };
    entry.count += 1;
    entry.statuses.add(device.status);
    for (const service of services.filter((s) => s.deviceId === device.id)) {
      const keys = Object.keys(service.state ?? {})
        .sort()
        .join('|');
      entry.services.set(`${service.id}${service.faults ? '+faults' : ''}`, keys);
    }
    byModel.set(device.deviceModel, entry);
  }
  for (const [model, entry] of [...byModel].sort()) {
    say(
      `${model}${KIND_BY_MODEL[model] ? ` → ${KIND_BY_MODEL[model]}` : ' (ignored)'}`,
      `${entry.count} device(s), status ${[...entry.statuses].join('/')}`,
    );
    for (const [service, keys] of [...entry.services].sort()) {
      console.log(`${''.padEnd(36)}${service}: ${keys}`);
    }
  }
  say('Intrusion system', intrusion ? Object.keys(intrusion).sort().join(', ') : 'none');

  const pollId = await client.subscribe();
  say('Event subscription', 'OK');
  const events = await client.longPoll(pollId, { seconds: 10 });
  say(
    'Events in 10 s',
    events.map((event) => event['@type'] + (event.id ? `:${event.id}` : '')).join(', ') || 'none',
  );
  await client.unsubscribe(pollId);
} catch (err) {
  say('Authenticated read', describe(err));
  process.exitCode = 1;
}
