// -----------------------------------------------------------------------------
// A fake Bosch Smart Home Controller, for end-to-end tests: three real HTTPS
// servers on localhost, like the controller's ports.
//
//   - pairing (8443): POST /smarthome/clients, open only in pairing mode
//     (otherwise the TLS handshake is refused), checks the system password
//     (`Systempassword` header, base64) and registers the client certificate;
//   - API (8444): asks for a client certificate and answers 401 to one it
//     did not register; serves the devices, services, rooms, the intrusion
//     system, the state changes and the JSON-RPC long polling;
//   - public (8446): /smarthome/public/information, no client certificate.
//
// The servers present a certificate signed by a test authority (`ca`), which
// the integration is given in place of the Bosch root. The shapes of the
// answers follow test/fixtures/shc (see the README there).
// -----------------------------------------------------------------------------

import { X509Certificate, generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { createCertificate } from '../../src/shc/x509.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/shc/${name}.json`, import.meta.url), 'utf8'));

// --- Test PKI (once per process) --------------------------------------------------

function createPki() {
  const ca = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const caCert = createCertificate({
    subject: { commonName: 'Test Smart Home Controller Root CA', organization: 'Test' },
    publicKey: ca.publicKey,
    signingKey: ca.privateKey,
  });
  const server = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const serverCert = createCertificate({
    subject: { commonName: 'shc0a1b2c', organization: 'Test' },
    issuer: { commonName: 'Test Smart Home Controller Root CA', organization: 'Test' },
    publicKey: server.publicKey,
    signingKey: ca.privateKey,
    ca: false,
  });
  // A second, unrelated authority: a controller the integration must refuse.
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const otherCert = createCertificate({
    subject: { commonName: 'Untrusted', organization: 'Test' },
    publicKey: other.publicKey,
    signingKey: other.privateKey,
  });
  return {
    ca: caCert,
    server: { key: server.privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: serverCert },
    untrusted: { key: other.privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: otherCert },
  };
}

let pki;
export const testPki = () => (pki ??= createPki());

const json = (res, status, body) => {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(text);
};

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

export class FakeController {
  /**
   * @param {object} [options]
   * @param {string} [options.password] system password
   * @param {boolean} [options.intrusion] the controller has an intrusion system
   * @param {boolean} [options.untrusted] present a certificate of another authority
   */
  constructor({ password = 'Secret-System-Pw1', intrusion = true, untrusted = false } = {}) {
    this.password = password;
    this.devices = fixture('devices');
    this.services = new Map(
      fixture('services').map((service) => [`${service.deviceId}/${service.id}`, service]),
    );
    this.rooms = fixture('rooms');
    this.intrusion = intrusion ? fixture('intrusion-system') : null;
    this.information = fixture('information');
    this.publicInformation = fixture('public-information');
    this.untrusted = untrusted;

    this.pairingMode = false;
    this.online = true;
    /** Fingerprints of the registered client certificates, with their client. */
    this.clients = new Map();
    this.subscriptions = new Map();
    /** Every API request: `{ method, path, body }`. */
    this.requests = [];
    this.pairings = [];
    this.waiting = new Set();
  }

  async start() {
    const { server, untrusted } = testPki();
    const identity = this.untrusted ? untrusted : server;
    const tls = { key: identity.key, cert: identity.cert };

    this.pairingServer = createServer(tls, (req, res) => this.handlePairing(req, res));
    // Outside pairing mode the controller refuses the TLS session itself.
    this.pairingServer.on('connection', (socket) => {
      if (!this.pairingMode || !this.online) {
        socket.destroy();
      }
    });

    this.apiServer = createServer(
      { ...tls, requestCert: true, rejectUnauthorized: false },
      (req, res) => this.handleApi(req, res),
    );
    this.apiServer.on('secureConnection', (socket) => {
      if (!this.online) {
        socket.destroy();
      }
    });

    this.publicServer = createServer(tls, (req, res) => {
      if (req.url === '/smarthome/public/information') {
        json(res, 200, this.publicInformation);
      } else {
        json(res, 404, {
          '@type': 'JsonRestExceptionResponseEntity',
          errorCode: 'ENTITY_NOT_FOUND',
        });
      }
    });

    await Promise.all(
      [this.pairingServer, this.apiServer, this.publicServer].map(
        (s) => new Promise((resolve) => s.listen(0, '127.0.0.1', resolve)),
      ),
    );
    this.ports = {
      pairing: this.pairingServer.address().port,
      api: this.apiServer.address().port,
      public: this.publicServer.address().port,
    };
    return this;
  }

  async stop() {
    this.releaseAll();
    await Promise.all(
      [this.pairingServer, this.apiServer, this.publicServer].map(
        (s) =>
          new Promise((resolve) => {
            s.closeAllConnections?.();
            s.close(() => resolve());
          }),
      ),
    );
  }

  /** The integration's configuration fields for this controller. */
  get host() {
    return '127.0.0.1';
  }

  // --- Pairing ----------------------------------------------------------------------

  async handlePairing(req, res) {
    const body = await readBody(req);
    if (req.method !== 'POST' || req.url !== '/smarthome/clients') {
      json(res, 404, { errorCode: 'ENTITY_NOT_FOUND' });
      return;
    }
    const password = Buffer.from(req.headers.systempassword ?? '', 'base64').toString('utf8');
    if (password !== this.password) {
      json(res, 401, { '@type': 'JsonRestExceptionResponseEntity', errorCode: 'UNAUTHORIZED' });
      return;
    }
    const client = JSON.parse(body);
    this.pairings.push(client);
    // The controller takes the one-line form: rebuild the PEM to read it.
    const base64 = client.certificate
      .replace('-----BEGIN CERTIFICATE-----', '')
      .replace('-----END CERTIFICATE-----', '')
      .replace(/\s+/g, '');
    const pem = `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
    const certificate = new X509Certificate(pem);
    this.clients.set(certificate.fingerprint256, {
      id: client.id,
      name: client.name,
      primaryRole: client.primaryRole,
    });
    json(res, 201, {
      url: `/clients/${client.id}`,
      token: `${randomBytes(16).toString('hex')}:shc0a1b2c`,
    });
  }

  /** Forget every registered client (pairing deleted in the Bosch app). */
  revokeClients() {
    this.clients.clear();
    this.releaseAll();
  }

  // --- API ----------------------------------------------------------------------------

  async handleApi(req, res) {
    const body = await readBody(req);
    const peer = req.socket.getPeerX509Certificate?.();
    if (!peer || !this.clients.has(peer.fingerprint256)) {
      json(res, 401, {
        '@type': 'JsonRestExceptionResponseEntity',
        errorCode: 'UNAUTHORIZED',
        statusCode: 401,
      });
      return;
    }
    const parsed = body ? JSON.parse(body) : undefined;
    const path = decodeURIComponent(req.url.split('?')[0]);
    this.requests.push({ method: req.method, path, body: parsed });

    if (req.method === 'POST' && path === '/remote/json-rpc') {
      await this.handleRpc(parsed, res);
      return;
    }
    if (req.method === 'GET') {
      if (path === '/smarthome/devices') {
        return json(res, 200, this.devices);
      }
      if (path === '/smarthome/services') {
        return json(res, 200, [...this.services.values()]);
      }
      if (path === '/smarthome/rooms') {
        return json(res, 200, this.rooms);
      }
      if (path === '/smarthome/information') {
        return json(res, 200, this.information);
      }
      if (path === '/smarthome/intrusion/states/system') {
        return this.intrusion
          ? json(res, 200, this.intrusion)
          : json(res, 404, { errorCode: 'ENTITY_NOT_FOUND', statusCode: 404 });
      }
      const match = path.match(/^\/smarthome\/devices\/(.+)\/services$/);
      if (match) {
        return json(
          res,
          200,
          [...this.services.values()].filter((service) => service.deviceId === match[1]),
        );
      }
    }
    if (req.method === 'PUT') {
      const match = path.match(/^\/smarthome\/devices\/(.+)\/services\/([A-Za-z]+)\/state$/);
      const service = match && this.services.get(`${match[1]}/${match[2]}`);
      if (service) {
        this.updateState(match[1], match[2], parsed);
        res.writeHead(204);
        res.end();
        return;
      }
    }
    if (req.method === 'POST' && path === '/smarthome/intrusion/actions/arm') {
      if (!this.intrusion) {
        return json(res, 404, { errorCode: 'ENTITY_NOT_FOUND' });
      }
      this.setIntrusion('armingState', { state: 'SYSTEM_ARMING', remainingTimeUntilArmed: 30000 });
      this.setIntrusion('activeConfigurationProfile', { profileId: parsed.profileId });
      res.writeHead(204);
      res.end();
      return;
    }
    json(res, 404, {
      '@type': 'JsonRestExceptionResponseEntity',
      errorCode: 'ENTITY_NOT_FOUND',
      statusCode: 404,
    });
  }

  async handleRpc(calls, res) {
    const [call] = calls;
    const answer = (result) => json(res, 200, [{ jsonrpc: '2.0', result }]);
    const fail = (code, message) => json(res, 200, [{ jsonrpc: '2.0', error: { code, message } }]);
    if (call.method === 'RE/subscribe') {
      const id = `${randomBytes(8).toString('hex')}-${randomBytes(4).toString('hex')}`;
      this.subscriptions.set(id, []);
      return answer(id);
    }
    if (call.method === 'RE/unsubscribe') {
      this.subscriptions.delete(call.params[0]);
      return answer(null);
    }
    if (call.method === 'RE/longPoll') {
      const [id, seconds] = call.params;
      const queue = this.subscriptions.get(id);
      if (!queue) {
        return fail(-32001, `No subscription with id: ${id}`);
      }
      if (queue.length === 0) {
        await new Promise((resolve) => {
          const waiter = { resolve, timer: setTimeout(resolve, Math.min(seconds, 2) * 1000) };
          this.waiting.add(waiter);
          res.on('close', resolve);
        });
      }
      if (!this.subscriptions.has(id)) {
        return fail(-32001, `No subscription with id: ${id}`);
      }
      return answer(queue.splice(0));
    }
    return fail(-32601, 'Method not found');
  }

  releaseAll() {
    for (const waiter of this.waiting) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.waiting.clear();
  }

  // --- Changes, as the house would make them --------------------------------------------

  /** Queue an event for every subscription, and wake the long polls. */
  push(...events) {
    for (const queue of this.subscriptions.values()) {
      queue.push(...structuredClone(events));
    }
    this.releaseAll();
  }

  /** Drop every subscription (expired after 24 h, or the controller restarted). */
  expireSubscriptions() {
    this.subscriptions.clear();
    this.releaseAll();
  }

  service(deviceId, serviceId) {
    return this.services.get(`${deviceId}/${serviceId}`);
  }

  /** Change a service state (a PUT from a client, or the device itself). */
  updateState(deviceId, serviceId, patch, { faults, silent = false } = {}) {
    const service = this.service(deviceId, serviceId);
    service.state = { ...service.state, ...patch };
    if (faults !== undefined) {
      if (faults === null) {
        delete service.faults;
      } else {
        service.faults = faults;
      }
    }
    if (!silent) {
      this.push(structuredClone(service));
    }
    return service;
  }

  device(deviceId) {
    return this.devices.find((device) => device.id === deviceId);
  }

  updateDevice(deviceId, patch) {
    const device = this.device(deviceId);
    Object.assign(device, patch);
    this.push({ ...structuredClone(device) });
  }

  setIntrusion(part, patch) {
    this.intrusion[part] = { ...this.intrusion[part], ...patch };
    this.push(structuredClone(this.intrusion[part]));
  }
}
