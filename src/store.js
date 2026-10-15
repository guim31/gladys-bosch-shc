// -----------------------------------------------------------------------------
// The pairing, kept under /data (the only writable path of the container):
// the client private key and certificate registered on the controller, and
// the client id they were registered under. The key never leaves /data and
// never reaches the logs; the files are readable by the container user only.
// Losing them means pairing again (button and system password).
// -----------------------------------------------------------------------------

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'bosch-store' });

const FILES = {
  key: 'bosch-shc-client-key.pem',
  cert: 'bosch-shc-client-cert.pem',
  state: 'bosch-shc.json',
};

async function writeAtomic(path, content) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

export class Store {
  constructor(directory = process.env.BOSCH_SHC_DATA_DIR || '/data') {
    this.directory = directory;
  }

  path(name) {
    return join(this.directory, FILES[name]);
  }

  /**
   * @returns {Promise<{ key: string, cert: string, clientId: string, host: string|null, pairedAt: string|null }|null>}
   */
  async loadPairing() {
    try {
      const [key, cert, raw] = await Promise.all([
        readFile(this.path('key'), 'utf8'),
        readFile(this.path('cert'), 'utf8'),
        readFile(this.path('state'), 'utf8'),
      ]);
      const state = JSON.parse(raw);
      if (!key.includes('PRIVATE KEY') || !cert.includes('CERTIFICATE') || !state?.clientId) {
        logger.warn('The saved pairing is incomplete: pair the controller again');
        return null;
      }
      return {
        key,
        cert,
        clientId: String(state.clientId),
        host: typeof state.host === 'string' ? state.host : null,
        pairedAt: typeof state.pairedAt === 'string' ? state.pairedAt : null,
      };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn(`Cannot read the saved pairing: ${err.message}`);
      }
      return null;
    }
  }

  /** Save a new pairing (key and certificate first, the state file last). */
  async savePairing({ key, cert, clientId, host, pairedAt }) {
    await mkdir(this.directory, { recursive: true });
    await writeAtomic(this.path('key'), key);
    await writeAtomic(this.path('cert'), cert);
    await writeAtomic(this.path('state'), JSON.stringify({ clientId, host, pairedAt }));
  }

  async clearPairing() {
    await Promise.all(Object.keys(FILES).map((name) => rm(this.path(name), { force: true })));
  }
}
