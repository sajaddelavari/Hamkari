import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { openDatabase } from '../../src/database.js';
import { createEnterpriseAudit } from '../../src/enterprise-audit.js';
import { createEnterpriseHubStore } from '../../src/enterprise-hub-store.js';
import { createPasswordHash } from '../../src/security.js';
import {
  deliverManualNotification,
  listManualNotifications,
  MANUAL_NOTIFICATION_EXIT_CODES,
  runManualNotificationCli,
} from '../../scripts/manual-notification.js';

const NOW = '2026-07-24T12:00:00.000Z';
const ORGANIZATION_ID = 'default-organization';

function fixture(t) {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    SESSION_SECRET: 'manual-notification-session-secret-000000000001',
    AUTH_ENCRYPTION_KEY: 'manual-notification-encryption-key-0000000002',
    AUDIT_HMAC_KEY: 'manual-notification-audit-key-000000000000003',
    ADMIN_DEV_PASSWORD: 'manual-notification-development-password',
  });
  const db = openDatabase(config, { seed: true });
  t.after(() => db.close());
  const clock = () => new Date(NOW);
  const auditService = createEnterpriseAudit(db, {
    clock,
    hmacKey: config.auditHmacKey,
  });
  const hubStore = createEnterpriseHubStore(db, {
    clock,
    encryptionKey: config.authEncryptionKey,
    audit: (event) => auditService.append(event),
  });
  function enqueue({
    token,
    destination = 'operator-recipient@example.test',
    templateKey = 'password-reset',
    provider = 'manual',
  }) {
    return hubStore.enqueueNotification({
      organizationId: ORGANIZATION_ID,
      channel: 'email',
      destination,
      templateKey,
      provider,
      payload: templateKey === 'organization-invitation'
        ? {
            url: `https://app.example.test/accept-invitation#token=${token}`,
            expiresAt: '2026-07-25T12:00:00.000Z',
            organizationName: 'سازمان آزمون',
            roleKey: 'viewer',
          }
        : {
            url: `https://app.example.test/reset-password#token=${token}`,
            expiresAt: '2026-07-25T12:00:00.000Z',
            fullName: 'کاربر آزمون',
          },
    });
  }
  function deliver(id, overrides = {}) {
    return deliverManualNotification(db, {
      id,
      clock,
      encryptionKey: config.authEncryptionKey,
      auditHmacKey: config.auditHmacKey,
      ...overrides,
    });
  }
  return {
    config,
    db,
    clock,
    auditService,
    enqueue,
    deliver,
  };
}

test('manual notification list is redacted and exact delivery is one-time and audited', (t) => {
  const {
    db,
    auditService,
    enqueue,
    deliver,
  } = fixture(t);
  const firstToken = 'first-reset-token-abcdefghijklmnopqrstuvwxyz';
  const secondToken = 'second-reset-token-abcdefghijklmnopqrstuvwxyz';
  const firstDestination = 'first-recipient@example.test';
  const firstId = enqueue({
    token: firstToken,
    destination: firstDestination,
  });
  const secondId = enqueue({
    token: secondToken,
    destination: 'second-recipient@example.test',
    templateKey: 'organization-invitation',
  });

  const listed = listManualNotifications(db, {
    clock: () => new Date(NOW),
  });
  assert.deepEqual(
    new Set(listed.map((item) => item.id)),
    new Set([firstId, secondId]),
  );
  const metadata = JSON.stringify(listed);
  for (const secret of [
    firstToken,
    secondToken,
    firstDestination,
    'reset-password',
    'accept-invitation',
  ]) {
    assert.equal(metadata.includes(secret), false);
  }

  const delivery = deliver(firstId);
  assert.equal(delivery.id, firstId);
  assert.equal(delivery.status, 'sent');
  assert.equal(delivery.recipient, firstDestination);
  assert.equal(delivery.link.includes(firstToken), true);
  assert.equal(delivery.link.includes(secondToken), false);

  const stored = db.prepare(`
    SELECT status,attempts,sent_at,payload_json,last_error
    FROM notification_outbox WHERE id=?
  `).get(firstId);
  assert.equal(stored.status, 'sent');
  assert.equal(Number(stored.attempts), 1);
  assert.equal(stored.sent_at, NOW);
  assert.equal(stored.payload_json.includes(firstToken), false);
  assert.equal(stored.last_error, '');

  assert.throws(
    () => deliver(firstId),
    (error) => {
      assert.equal(error.code, 'OUTBOX_ITEM_NOT_DELIVERABLE');
      assert.equal(String(error.message).includes(firstToken), false);
      assert.equal(String(error.message).includes(firstDestination), false);
      return true;
    },
  );
  assert.deepEqual(
    listManualNotifications(db).map((item) => item.id),
    [secondId],
  );

  const verification = auditService.verify();
  assert.equal(verification.valid, true);
  assert.equal(verification.checked, 1);
  const event = db.prepare(`
    SELECT action,organization_id,metadata_json,before_json,after_json
    FROM enterprise_audit_events
  `).get();
  assert.equal(event.action, 'notification_outbox.manual_delivered');
  assert.equal(event.organization_id, ORGANIZATION_ID);
  assert.equal(
    JSON.stringify(event).includes(firstDestination) ||
      JSON.stringify(event).includes(firstToken),
    false,
  );
});

test('wrong encryption key fails closed without leaking and remains recoverable', (t) => {
  const { db, enqueue, deliver } = fixture(t);
  const token = 'recoverable-reset-token-abcdefghijklmnopqrstuvwxyz';
  const destination = 'recoverable-recipient@example.test';
  const id = enqueue({ token, destination });

  assert.throws(
    () => deliver(id, {
      encryptionKey: 'wrong-manual-notification-key-000000000000000',
    }),
    (error) => {
      assert.equal(error.code, 'INVALID_PAYLOAD');
      const output = `${error.code}:${error.message}`;
      assert.equal(output.includes(token), false);
      assert.equal(output.includes(destination), false);
      return true;
    },
  );
  let stored = db.prepare(`
    SELECT status,attempts,last_error,payload_json
    FROM notification_outbox WHERE id=?
  `).get(id);
  assert.equal(stored.status, 'failed');
  assert.equal(Number(stored.attempts), 1);
  assert.equal(stored.last_error.includes(token), false);
  assert.equal(stored.last_error.includes(destination), false);
  assert.equal(stored.payload_json.includes(token), false);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM enterprise_audit_events')
      .get().count,
    0,
  );

  assert.equal(deliver(id).link.includes(token), true);
  stored = db.prepare(`
    SELECT status,attempts FROM notification_outbox WHERE id=?
  `).get(id);
  assert.equal(stored.status, 'sent');
  assert.equal(Number(stored.attempts), 2);
});

test('audit failure atomically rolls manual delivery back', (t) => {
  const { db, enqueue, deliver } = fixture(t);
  const token = 'audit-rollback-token-abcdefghijklmnopqrstuvwxyz';
  const destination = 'audit-rollback@example.test';
  const id = enqueue({ token, destination });
  db.exec(`
    CREATE TRIGGER reject_manual_notification_audit
    BEFORE INSERT ON enterprise_audit_events
    WHEN NEW.action='notification_outbox.manual_delivered'
    BEGIN
      SELECT RAISE(ABORT, 'manual audit unavailable');
    END;
  `);

  assert.throws(
    () => deliver(id),
    (error) => {
      const output = String(error?.message || error);
      assert.equal(output.includes(token), false);
      assert.equal(output.includes(destination), false);
      return true;
    },
  );
  let stored = db.prepare(`
    SELECT status,attempts,sent_at FROM notification_outbox WHERE id=?
  `).get(id);
  assert.equal(stored.status, 'pending');
  assert.equal(Number(stored.attempts), 0);
  assert.equal(stored.sent_at, null);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM enterprise_audit_events')
      .get().count,
    0,
  );

  db.exec('DROP TRIGGER reject_manual_notification_audit');
  assert.equal(deliver(id).link.includes(token), true);
  stored = db.prepare(`
    SELECT status,attempts FROM notification_outbox WHERE id=?
  `).get(id);
  assert.equal(stored.status, 'sent');
  assert.equal(Number(stored.attempts), 1);
});

test('manual delivery refuses unknown, non-manual and non-actionable rows without secrets', (t) => {
  const { db, enqueue, deliver } = fixture(t);
  const token = 'refused-reset-token-abcdefghijklmnopqrstuvwxyz';
  const states = ['processing', 'cancelled', 'sent'];
  for (const status of states) {
    const id = enqueue({
      token: `${token}-${status}`,
      destination: `${status}@example.test`,
    });
    db.prepare(`
      UPDATE notification_outbox SET status=? WHERE id=?
    `).run(status, id);
    assert.throws(
      () => deliver(id),
      (error) => {
        assert.equal(error.code, 'OUTBOX_ITEM_NOT_DELIVERABLE');
        assert.equal(String(error.message).includes(token), false);
        assert.equal(String(error.message).includes(`${status}@example.test`), false);
        return true;
      },
    );
  }

  const sandboxId = enqueue({
    token: `${token}-sandbox`,
    destination: 'sandbox@example.test',
    provider: 'sandbox',
  });
  assert.throws(
    () => deliver(sandboxId),
    (error) => error.code === 'OUTBOX_ITEM_NOT_ELIGIBLE',
  );
  assert.throws(
    () => deliver('missing-exact-outbox-id'),
    (error) => error.code === 'OUTBOX_ITEM_NOT_FOUND',
  );
  assert.throws(
    () => deliver('../unsafe'),
    (error) => error.code === 'INVALID_OUTBOX_ID',
  );
});

test('non-interactive CLI requires explicit confirmation before opening the database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hamkari-manual-cli-'));
  const output = [];
  const errors = [];
  try {
    const exitCode = await runManualNotificationCli(
      ['deliver', 'exact-outbox-id'],
      {
        rootDir: directory,
        cwd: directory,
        stdin: { isTTY: false },
        stdout: { write: (value) => output.push(String(value)) },
        stderr: { write: (value) => errors.push(String(value)) },
        env: {
          NODE_ENV: 'production',
          PUBLIC_ORIGIN: 'https://app.example.test',
          DATABASE_PATH: join(directory, 'must-not-be-opened.db'),
          SESSION_SECRET: 'production-session-secret-00000000000000000001',
          AUTH_ENCRYPTION_KEY: 'production-encryption-key-000000000000000002',
          AUDIT_HMAC_KEY: 'production-audit-key-0000000000000000000003',
          ADMIN_PASSWORD_HASH: createPasswordHash(
            'production-bootstrap-password',
            { salt: Buffer.from('0123456789abcdef').toString('base64url') },
          ),
          TRUST_PROXY: 'false',
          NOTIFICATION_PROVIDER: 'manual',
          PAYMENT_PROVIDER_MODE: 'manual',
          DISTRIBUTION_KYC_REQUIRED: 'true',
        },
      },
    );
    assert.equal(exitCode, MANUAL_NOTIFICATION_EXIT_CODES.usage);
    assert.equal(output.join(''), '');
    assert.match(errors.join(''), /CONFIRMATION_REQUIRED/);
    assert.equal(errors.join('').includes('production-encryption-key'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production CLI reveals one exact record and refuses a second reveal', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hamkari-manual-cli-live-'));
  const databasePath = join(directory, 'operator.db');
  const sessionSecret = 'operator-cli-production-session-secret-0000000001';
  const encryptionKey = 'operator-cli-production-encryption-key-000000002';
  const auditHmacKey = 'operator-cli-production-audit-key-00000000000003';
  const token = 'operator-cli-reset-token-abcdefghijklmnopqrstuvwxyz';
  const destination = 'operator-cli-recipient@example.test';
  const setupConfig = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: databasePath,
    SESSION_SECRET: sessionSecret,
    AUTH_ENCRYPTION_KEY: encryptionKey,
    AUDIT_HMAC_KEY: auditHmacKey,
    ADMIN_DEV_PASSWORD: 'operator-cli-development-password',
  });
  const setupDb = openDatabase(setupConfig, { seed: true });
  const setupClock = () => new Date(NOW);
  const setupAudit = createEnterpriseAudit(setupDb, {
    clock: setupClock,
    hmacKey: auditHmacKey,
  });
  const setupHub = createEnterpriseHubStore(setupDb, {
    clock: setupClock,
    encryptionKey,
    audit: (event) => setupAudit.append(event),
  });
  const id = setupHub.enqueueNotification({
    organizationId: ORGANIZATION_ID,
    channel: 'email',
    destination,
    templateKey: 'password-reset',
    provider: 'manual',
    payload: {
      url: `https://app.example.test/reset-password#token=${token}`,
      expiresAt: '2026-07-25T12:00:00.000Z',
      fullName: 'Operator CLI User',
    },
  });
  setupDb.close();

  const environment = {
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PUBLIC_ORIGIN: 'https://app.example.test',
    DATA_DIR: directory,
    BACKUP_DIR: join(directory, 'backups'),
    DATABASE_PATH: databasePath,
    SESSION_SECRET: sessionSecret,
    AUTH_ENCRYPTION_KEY: encryptionKey,
    AUDIT_HMAC_KEY: auditHmacKey,
    ADMIN_PASSWORD_HASH: createPasswordHash(
      'operator-cli-production-bootstrap-password',
      { salt: Buffer.from('fedcba9876543210').toString('base64url') },
    ),
    TRUST_PROXY: 'false',
    NOTIFICATION_PROVIDER: 'manual',
    PAYMENT_PROVIDER_MODE: 'manual',
    DISTRIBUTION_KYC_REQUIRED: 'true',
  };
  const invoke = async (argv) => {
    const stdout = [];
    const stderr = [];
    const exitCode = await runManualNotificationCli(argv, {
      rootDir: directory,
      cwd: directory,
      stdin: { isTTY: false },
      stdout: { write: (value) => stdout.push(String(value)) },
      stderr: { write: (value) => stderr.push(String(value)) },
      env: environment,
    });
    return {
      exitCode,
      stdout: stdout.join(''),
      stderr: stderr.join(''),
    };
  };

  try {
    const listed = await invoke(['list', '--json']);
    assert.equal(listed.exitCode, MANUAL_NOTIFICATION_EXIT_CODES.success);
    assert.equal(listed.stderr, '');
    assert.equal(listed.stdout.includes(id), true);
    assert.equal(listed.stdout.includes(token), false);
    assert.equal(listed.stdout.includes(destination), false);

    const delivered = await invoke([
      'deliver',
      id,
      '--confirm',
      '--json',
    ]);
    assert.equal(delivered.exitCode, MANUAL_NOTIFICATION_EXIT_CODES.success);
    assert.equal(delivered.stderr, '');
    const output = JSON.parse(delivered.stdout);
    assert.equal(output.id, id);
    assert.equal(output.recipient, destination);
    assert.equal(output.link.includes(token), true);

    const repeated = await invoke([
      'deliver',
      id,
      '--confirm',
      '--json',
    ]);
    assert.equal(repeated.exitCode, MANUAL_NOTIFICATION_EXIT_CODES.refused);
    assert.equal(repeated.stdout, '');
    assert.equal(repeated.stderr.includes('OUTBOX_ITEM_NOT_DELIVERABLE'), true);
    assert.equal(repeated.stderr.includes(token), false);
    assert.equal(repeated.stderr.includes(destination), false);

    const verifiedDb = openDatabase(setupConfig, { seed: false });
    try {
      assert.equal(
        verifiedDb.prepare(`
          SELECT status FROM notification_outbox WHERE id=?
        `).get(id).status,
        'sent',
      );
      assert.equal(
        createEnterpriseAudit(verifiedDb, {
          clock: setupClock,
          hmacKey: auditHmacKey,
        }).verify().valid,
        true,
      );
    } finally {
      verifiedDb.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
