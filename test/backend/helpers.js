import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createPasswordHash } from '../../src/security.js';

export const TEST_PASSWORD = 'correct-hamkari-password';

export async function startTestApplication(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'hamkari-test-'));
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const config = loadConfig({
    NODE_ENV: 'test',
    PORT: String(address.port),
    HOST: '127.0.0.1',
    PUBLIC_ORIGIN: origin,
    DATABASE_PATH: options.databasePath || join(directory, 'test.db'),
    SESSION_SECRET: 'test-session-secret-that-is-longer-than-thirty-two-characters',
    ADMIN_PASSWORD_HASH: createPasswordHash(TEST_PASSWORD, {
      salt: Buffer.from('0123456789abcdef').toString('base64url'),
    }),
  });
  const application = createApplication({
    config,
    logger: null,
    seed: options.seed !== false,
    ...(options.applicationOptions || {}),
  });
  server.on('request', application.handler);

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    application.close();
    rmSync(directory, { recursive: true, force: true });
  }

  return {
    application,
    config,
    origin,
    directory,
    close,
    client: () => new TestClient(origin),
  };
}

export class TestClient {
  constructor(origin) {
    this.origin = origin;
    this.cookies = new Map();
  }

  cookie(name) {
    return this.cookies.get(name);
  }

  async request(path, options = {}) {
    const method = options.method || 'GET';
    const headers = new Headers(options.headers || {});
    if (this.cookies.size) {
      headers.set(
        'Cookie',
        [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '),
      );
    }
    if (!['GET', 'HEAD'].includes(method) && options.origin !== false) {
      headers.set('Origin', options.origin || this.origin);
    }
    let body = options.body;
    if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) {
      body = JSON.stringify(body);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    }
    const response = await fetch(`${this.origin}${path}`, {
      method,
      headers,
      body,
    });
    const setCookies = response.headers.getSetCookie?.() || [];
    for (const cookie of setCookies) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json')
      ? await response.json()
      : await response.text();
    return { response, data };
  }
}

