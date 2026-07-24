import {
  existsSync,
  lstatSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadEnvFile, stdin, stdout, stderr } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../src/config.js';
import { SCHEMA_VERSION, withTransaction } from '../src/database.js';
import { createEnterpriseAudit } from '../src/enterprise-audit.js';
import { unsealData } from '../src/secure-data.js';

const ROOT_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const AUTH_TEMPLATE_KEYS = new Set([
  'organization-invitation',
  'password-reset',
]);
const DELIVERABLE_STATUSES = new Set(['pending', 'failed']);
const REQUIRED_OUTBOX_COLUMNS = new Set([
  'id',
  'organization_id',
  'channel',
  'destination',
  'template_key',
  'payload_json',
  'provider',
  'status',
  'attempts',
  'next_attempt_at',
  'sent_at',
  'last_error',
  'created_at',
  'updated_at',
]);
const SAFE_OUTBOX_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export const MANUAL_NOTIFICATION_EXIT_CODES = Object.freeze({
  success: 0,
  usage: 2,
  refused: 3,
  unsafeRuntime: 4,
  operationFailed: 5,
});

export class ManualNotificationError extends Error {
  constructor(code, message, exitCode = MANUAL_NOTIFICATION_EXIT_CODES.operationFailed) {
    super(message);
    this.name = 'ManualNotificationError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

function fail(code, message, exitCode) {
  throw new ManualNotificationError(code, message, exitCode);
}

function safeOutboxId(value) {
  const selected = String(value || '');
  if (!SAFE_OUTBOX_ID.test(selected)) {
    fail(
      'INVALID_OUTBOX_ID',
      'The outbox id must be one exact, valid identifier.',
      MANUAL_NOTIFICATION_EXIT_CODES.usage,
    );
  }
  return selected;
}

function selectedLimit(value) {
  const parsed = value === undefined ? 50 : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    fail(
      'INVALID_LIMIT',
      'The list limit must be an integer between 1 and 200.',
      MANUAL_NOTIFICATION_EXIT_CODES.usage,
    );
  }
  return parsed;
}

function isoTime(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    fail('INVALID_CLOCK', 'The operator clock is unavailable.');
  }
  return value.toISOString();
}

function requiredSafeText(value, maximum = 500) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    CONTROL_CHARACTERS.test(value)
  ) {
    fail('INVALID_PAYLOAD', 'The sealed notification payload is invalid.');
  }
  return value.trim();
}

function optionalSafeText(value, fallback, maximum = 500) {
  if (value === undefined || value === null || value === '') return fallback;
  return requiredSafeText(value, maximum);
}

function secureBearerLink(value, templateKey) {
  const link = requiredSafeText(value, 2_000);
  let parsed;
  try {
    parsed = new URL(link);
  } catch {
    fail('INVALID_PAYLOAD', 'The sealed notification payload is invalid.');
  }
  const expectedPath = templateKey === 'organization-invitation'
    ? '/accept-invitation'
    : '/reset-password';
  const fragment = new URLSearchParams(parsed.hash.slice(1));
  const tokens = fragment.getAll('token');
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== expectedPath ||
    parsed.search ||
    tokens.length !== 1 ||
    tokens[0].length < 20 ||
    [...fragment.keys()].some((key) => key !== 'token') ||
    CONTROL_CHARACTERS.test(tokens[0])
  ) {
    fail('INVALID_PAYLOAD', 'The sealed notification payload is invalid.');
  }
  return link;
}

function expiresAtText(value) {
  const selected = requiredSafeText(value, 80);
  if (Number.isNaN(Date.parse(selected))) {
    fail('INVALID_PAYLOAD', 'The sealed notification payload is invalid.');
  }
  return selected;
}

function parseSealedPayload(row, encryptionKey) {
  try {
    const envelope = JSON.parse(row.payload_json);
    if (
      !envelope ||
      typeof envelope !== 'object' ||
      Array.isArray(envelope) ||
      typeof envelope.sealed !== 'string' ||
      Object.keys(envelope).some((key) => key !== 'sealed')
    ) {
      fail('INVALID_PAYLOAD', 'The sealed notification payload is invalid.');
    }
    const payload = JSON.parse(unsealData(
      envelope.sealed,
      encryptionKey,
      `notification-outbox:${row.id}`,
    ));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      fail('INVALID_PAYLOAD', 'The sealed notification payload is invalid.');
    }
    return payload;
  } catch (error) {
    if (error instanceof ManualNotificationError) throw error;
    fail('INVALID_PAYLOAD', 'The sealed notification payload is invalid.');
  }
}

function renderDelivery(row, payload) {
  const recipient = requiredSafeText(row.destination, 320);
  const link = secureBearerLink(payload.url, row.template_key);
  const expiresAt = expiresAtText(payload.expiresAt);

  if (row.template_key === 'organization-invitation') {
    const organizationName = requiredSafeText(payload.organizationName, 240);
    const roleKey = requiredSafeText(payload.roleKey, 80);
    return Object.freeze({
      recipient,
      subject: `Invitation to ${organizationName}`,
      text:
        `You have been invited to join ${organizationName} with the ${roleKey} role. ` +
        `Use the one-time link before ${expiresAt}.`,
      link,
    });
  }

  const fullName = optionalSafeText(payload.fullName, 'your account', 240);
  return Object.freeze({
    recipient,
    subject: 'Hamkari password reset',
    text:
      `A password reset was requested for ${fullName}. ` +
      `Use the one-time link before ${expiresAt}.`,
    link,
  });
}

function assertEligibleRow(row) {
  if (!row) {
    fail(
      'OUTBOX_ITEM_NOT_FOUND',
      'No notification exists with that exact outbox id.',
      MANUAL_NOTIFICATION_EXIT_CODES.refused,
    );
  }
  if (
    row.provider !== 'manual' ||
    row.channel !== 'email' ||
    !AUTH_TEMPLATE_KEYS.has(row.template_key)
  ) {
    fail(
      'OUTBOX_ITEM_NOT_ELIGIBLE',
      'That outbox item is not an eligible manual authentication notification.',
      MANUAL_NOTIFICATION_EXIT_CODES.refused,
    );
  }
  if (!DELIVERABLE_STATUSES.has(row.status)) {
    fail(
      'OUTBOX_ITEM_NOT_DELIVERABLE',
      'That outbox item is not pending or failed and cannot be revealed.',
      MANUAL_NOTIFICATION_EXIT_CODES.refused,
    );
  }
}

/**
 * Returns only non-secret metadata for actionable manual authentication mail.
 * The SELECT intentionally cannot load destination, payload_json, or last_error.
 */
export function listManualNotifications(db, options = {}) {
  const limit = selectedLimit(options.limit);
  const now = isoTime(options.clock || (() => new Date()));
  const rows = db.prepare(`
    SELECT
      id, organization_id, channel, template_key, provider, status, attempts,
      next_attempt_at, created_at, updated_at
    FROM notification_outbox
    WHERE provider='manual'
      AND channel='email'
      AND template_key IN ('organization-invitation','password-reset')
      AND status IN ('pending','failed')
    ORDER BY created_at,id
    LIMIT ?
  `).all(limit);
  return rows.map((row) => Object.freeze({
    id: row.id,
    organizationId: row.organization_id,
    channel: row.channel,
    templateKey: row.template_key,
    provider: row.provider,
    status: row.status,
    attempts: Number(row.attempts),
    deferred: Boolean(
      row.status === 'pending' &&
      row.next_attempt_at &&
      row.next_attempt_at > now
    ),
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/**
 * Atomically validates, decrypts, renders, and marks one exact row sent.
 * The delivery object is returned only after COMMIT, giving the CLI at-most-once
 * reveal semantics even if another worker or operator races for the same id.
 */
export function deliverManualNotification(db, options = {}) {
  const id = safeOutboxId(options.id);
  const encryptionKey = String(options.encryptionKey || '');
  if (encryptionKey.length < 32) {
    fail(
      'INVALID_ENCRYPTION_KEY',
      'The authentication encryption key is unavailable.',
      MANUAL_NOTIFICATION_EXIT_CODES.unsafeRuntime,
    );
  }
  const auditHmacKey = String(options.auditHmacKey || '');
  if (auditHmacKey.length < 32) {
    fail(
      'INVALID_AUDIT_KEY',
      'The audit integrity key is unavailable.',
      MANUAL_NOTIFICATION_EXIT_CODES.unsafeRuntime,
    );
  }
  const clock = options.clock || (() => new Date());
  const completedAt = isoTime(clock);
  const audit = createEnterpriseAudit(db, {
    clock,
    hmacKey: auditHmacKey,
  });

  return withTransaction(db, () => {
    const row = db.prepare(`
      SELECT
        id, organization_id, channel, destination, template_key, payload_json,
        provider, status, attempts
      FROM notification_outbox
      WHERE id=?
    `).get(id);
    assertEligibleRow(row);

    let delivery;
    try {
      delivery = renderDelivery(row, parseSealedPayload(row, encryptionKey));
    } catch (error) {
      const failed = db.prepare(`
        UPDATE notification_outbox
        SET status='failed',
            attempts=attempts+1,
            next_attempt_at=NULL,
            last_error='Manual operator delivery could not validate the sealed payload.',
            updated_at=?
        WHERE id=? AND status=? AND provider='manual'
      `).run(completedAt, id, row.status);
      if (Number(failed.changes) !== 1) {
        fail(
          'OUTBOX_CLAIM_LOST',
          'The outbox item changed before it could be delivered.',
          MANUAL_NOTIFICATION_EXIT_CODES.refused,
        );
      }
      return { error };
    }

    const marked = db.prepare(`
      UPDATE notification_outbox
      SET status='sent',
          attempts=attempts+1,
          next_attempt_at=NULL,
          sent_at=?,
          last_error='',
          updated_at=?
      WHERE id=? AND status=? AND provider='manual'
    `).run(completedAt, completedAt, id, row.status);
    if (Number(marked.changes) !== 1) {
      fail(
        'OUTBOX_CLAIM_LOST',
        'The outbox item changed before it could be delivered.',
        MANUAL_NOTIFICATION_EXIT_CODES.refused,
      );
    }
    audit.append({
      organizationId: row.organization_id,
      actorType: 'system',
      action: 'notification_outbox.manual_delivered',
      resourceType: 'notification_outbox',
      resourceId: id,
      before: { status: row.status },
      after: { status: 'sent' },
      metadata: {
        templateKey: row.template_key,
        provider: 'manual',
      },
      createdAt: completedAt,
    });
    return {
      delivery: Object.freeze({
        id,
        status: 'sent',
        ...delivery,
      }),
    };
  }, 'IMMEDIATE').delivery || (() => {
    fail('INVALID_PAYLOAD', 'The sealed notification payload is invalid.');
  })();
}

function localPath(value, baseDirectory) {
  const selected = String(value || '');
  if (!selected || selected.startsWith('\\\\') || selected.startsWith('//')) {
    fail(
      'NON_LOCAL_PATH',
      'Only a local filesystem path is allowed.',
      MANUAL_NOTIFICATION_EXIT_CODES.unsafeRuntime,
    );
  }
  return isAbsolute(selected)
    ? resolve(selected)
    : resolve(baseDirectory, selected);
}

function assertPrivateLocalFile(path, label) {
  if (!existsSync(path)) {
    fail(
      'LOCAL_FILE_MISSING',
      `${label} does not exist.`,
      MANUAL_NOTIFICATION_EXIT_CODES.unsafeRuntime,
    );
  }
  const linkInfo = lstatSync(path);
  if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
    fail(
      'UNSAFE_LOCAL_FILE',
      `${label} must be a regular local file, not a link.`,
      MANUAL_NOTIFICATION_EXIT_CODES.unsafeRuntime,
    );
  }
  const info = statSync(realpathSync(path));
  if (
    process.platform !== 'win32' &&
    (info.mode & 0o077) !== 0
  ) {
    fail(
      'UNSAFE_LOCAL_FILE_PERMISSIONS',
      `${label} must not be accessible by group or other users.`,
      MANUAL_NOTIFICATION_EXIT_CODES.unsafeRuntime,
    );
  }
  if (
    typeof process.geteuid === 'function' &&
    process.geteuid() !== 0 &&
    info.uid !== process.geteuid()
  ) {
    fail(
      'UNSAFE_LOCAL_FILE_OWNER',
      `${label} must be owned by the current operator account.`,
      MANUAL_NOTIFICATION_EXIT_CODES.unsafeRuntime,
    );
  }
}

function verifyOutboxSchema(db) {
  const schemaVersion = Number(
    db.prepare('PRAGMA user_version').get().user_version,
  );
  if (schemaVersion !== SCHEMA_VERSION) {
    fail(
      'SCHEMA_VERSION_MISMATCH',
      'The database schema does not match this operator CLI.',
      MANUAL_NOTIFICATION_EXIT_CODES.unsafeRuntime,
    );
  }
  const table = db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type='table' AND name='notification_outbox'
  `).get();
  if (!table) {
    fail(
      'OUTBOX_SCHEMA_MISSING',
      'The database does not contain the notification outbox.',
      MANUAL_NOTIFICATION_EXIT_CODES.unsafeRuntime,
    );
  }
  const columns = new Set(
    db.prepare('PRAGMA table_info(notification_outbox)')
      .all()
      .map((row) => row.name),
  );
  if ([...REQUIRED_OUTBOX_COLUMNS].some((column) => !columns.has(column))) {
    fail(
      'OUTBOX_SCHEMA_MISMATCH',
      'The notification outbox schema is not supported.',
      MANUAL_NOTIFICATION_EXIT_CODES.unsafeRuntime,
    );
  }
  const quickCheck = db.prepare('PRAGMA quick_check(1)').get().quick_check;
  if (quickCheck !== 'ok') {
    fail(
      'DATABASE_CHECK_FAILED',
      'The database did not pass its safety check.',
      MANUAL_NOTIFICATION_EXIT_CODES.unsafeRuntime,
    );
  }
}

export function openManualNotificationDatabase(config, options = {}) {
  if (!config?.isProduction || config.nodeEnv !== 'production') {
    fail(
      'PRODUCTION_REQUIRED',
      'Manual notification delivery is restricted to production configuration.',
      MANUAL_NOTIFICATION_EXIT_CODES.unsafeRuntime,
    );
  }
  if (config.notificationProvider !== 'manual') {
    fail(
      'MANUAL_PROVIDER_REQUIRED',
      'NOTIFICATION_PROVIDER must be manual.',
      MANUAL_NOTIFICATION_EXIT_CODES.unsafeRuntime,
    );
  }
  if (!config.databasePath || config.databasePath === ':memory:') {
    fail(
      'PERSISTENT_DATABASE_REQUIRED',
      'A persistent local production database is required.',
      MANUAL_NOTIFICATION_EXIT_CODES.unsafeRuntime,
    );
  }
  const path = localPath(config.databasePath, config.rootDir || ROOT_DIR);
  assertPrivateLocalFile(path, 'The production database');
  const db = new DatabaseSync(path, {
    readOnly: options.readOnly === true,
    timeout: config.sqliteBusyTimeoutMs,
  });
  try {
    db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=${Number(config.sqliteBusyTimeoutMs)};
    `);
    verifyOutboxSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function takeOptionValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    fail(
      'MISSING_OPTION_VALUE',
      `${name} requires a value.`,
      MANUAL_NOTIFICATION_EXIT_CODES.usage,
    );
  }
  return value;
}

export function parseManualNotificationArguments(argv) {
  const values = {
    command: null,
    id: null,
    limit: undefined,
    envFile: null,
    json: false,
    confirm: false,
    help: false,
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') values.json = true;
    else if (argument === '--confirm') values.confirm = true;
    else if (argument === '--help' || argument === '-h') values.help = true;
    else if (argument === '--env-file') {
      values.envFile = takeOptionValue(argv, index, '--env-file');
      index += 1;
    } else if (argument.startsWith('--env-file=')) {
      values.envFile = argument.slice('--env-file='.length);
    } else if (argument === '--limit') {
      values.limit = takeOptionValue(argv, index, '--limit');
      index += 1;
    } else if (argument.startsWith('--limit=')) {
      values.limit = argument.slice('--limit='.length);
    } else if (argument.startsWith('-')) {
      fail(
        'UNKNOWN_OPTION',
        'An unsupported command option was provided.',
        MANUAL_NOTIFICATION_EXIT_CODES.usage,
      );
    } else {
      positional.push(argument);
    }
  }

  if (values.help && positional.length === 0) return values;
  values.command = positional[0] || null;
  if (values.command === 'list') {
    if (positional.length !== 1 || values.confirm) {
      fail(
        'INVALID_LIST_COMMAND',
        'Usage: manual-notification list [--limit N] [--json] [--env-file PATH]',
        MANUAL_NOTIFICATION_EXIT_CODES.usage,
      );
    }
    selectedLimit(values.limit);
  } else if (values.command === 'deliver' || values.command === 'show') {
    if (positional.length !== 2 || values.limit !== undefined) {
      fail(
        'INVALID_DELIVER_COMMAND',
        'Usage: manual-notification deliver OUTBOX_ID [--confirm] [--json] [--env-file PATH]',
        MANUAL_NOTIFICATION_EXIT_CODES.usage,
      );
    }
    values.id = safeOutboxId(positional[1]);
  } else if (!values.help) {
    fail(
      'UNKNOWN_COMMAND',
      'Use the list or deliver command.',
      MANUAL_NOTIFICATION_EXIT_CODES.usage,
    );
  }
  return Object.freeze(values);
}

function helpText() {
  return [
    'Usage:',
    '  npm run notification:manual -- list [--limit N] [--json] [--env-file PATH]',
    '  npm run notification:manual -- deliver OUTBOX_ID [--confirm] [--json] [--env-file PATH]',
    '',
    'list emits metadata only. deliver/show reveals one exact authentication',
    'message and atomically marks it sent. Non-interactive delivery requires --confirm.',
    '',
  ].join('\n');
}

function loadRuntimeEnvironment(envFile, rootDir, cwd) {
  const selected = envFile
    ? localPath(envFile, cwd)
    : join(rootDir, '.env');
  if (!existsSync(selected)) {
    if (!envFile) return;
    fail(
      'ENV_FILE_MISSING',
      'The requested environment file does not exist.',
      MANUAL_NOTIFICATION_EXIT_CODES.unsafeRuntime,
    );
  }
  assertPrivateLocalFile(selected, 'The environment file');
  try {
    loadEnvFile(selected);
  } catch {
    fail(
      'ENV_FILE_INVALID',
      'The environment file could not be loaded.',
      MANUAL_NOTIFICATION_EXIT_CODES.unsafeRuntime,
    );
  }
}

async function confirmExactDelivery(parsed, io) {
  if (parsed.confirm) return;
  if (!io.stdin.isTTY) {
    fail(
      'CONFIRMATION_REQUIRED',
      'Non-interactive delivery requires --confirm.',
      MANUAL_NOTIFICATION_EXIT_CODES.usage,
    );
  }
  const prompt = createInterface({
    input: io.stdin,
    output: io.stderr,
    terminal: true,
  });
  try {
    const answer = await prompt.question(
      `Reveal and mark outbox item ${parsed.id} sent? Type "yes" to continue: `,
    );
    if (answer.trim().toLowerCase() !== 'yes') {
      fail(
        'DELIVERY_CANCELLED',
        'Manual notification delivery was cancelled.',
        MANUAL_NOTIFICATION_EXIT_CODES.refused,
      );
    }
  } finally {
    prompt.close();
  }
}

function writeList(items, parsed, output) {
  if (parsed.json) {
    output.write(`${JSON.stringify({ notifications: items })}\n`);
    return;
  }
  if (!items.length) {
    output.write('No pending, failed, or deferred manual authentication notifications.\n');
    return;
  }
  for (const item of items) {
    output.write(
      [
        `id=${item.id}`,
        `status=${item.status}`,
        `template=${item.templateKey}`,
        `organization=${item.organizationId}`,
        `attempts=${item.attempts}`,
        `deferred=${item.deferred}`,
        `nextAttemptAt=${item.nextAttemptAt || '-'}`,
        `createdAt=${item.createdAt}`,
      ].join(' ') + '\n',
    );
  }
}

function writeDelivery(delivery, parsed, output) {
  if (parsed.json) {
    output.write(`${JSON.stringify(delivery)}\n`);
    return;
  }
  output.write(
    [
      `Outbox ID: ${delivery.id}`,
      `Status: ${delivery.status}`,
      `Recipient: ${delivery.recipient}`,
      `Subject: ${delivery.subject}`,
      'Text:',
      delivery.text,
      `Link: ${delivery.link}`,
      '',
    ].join('\n'),
  );
}

function normalizedCliError(error) {
  if (error instanceof ManualNotificationError) return error;
  return new ManualNotificationError(
    'OPERATION_FAILED',
    'The operation failed without revealing notification data.',
  );
}

function writeCliError(error, json, output) {
  if (json) {
    output.write(`${JSON.stringify({
      error: {
        code: error.code,
        message: error.message,
      },
    })}\n`);
    return;
  }
  output.write(`manual-notification: ${error.code}: ${error.message}\n`);
}

export async function runManualNotificationCli(argv = process.argv.slice(2), options = {}) {
  const io = {
    stdin: options.stdin || stdin,
    stdout: options.stdout || stdout,
    stderr: options.stderr || stderr,
  };
  let parsed;
  let db;
  try {
    parsed = parseManualNotificationArguments(argv);
    if (parsed.help) {
      io.stdout.write(helpText());
      return MANUAL_NOTIFICATION_EXIT_CODES.success;
    }
    const rootDir = resolve(options.rootDir || ROOT_DIR);
    loadRuntimeEnvironment(
      parsed.envFile,
      rootDir,
      resolve(options.cwd || process.cwd()),
    );
    let config;
    try {
      config = loadConfig(options.env || process.env, { rootDir });
    } catch {
      fail(
        'INVALID_PRODUCTION_CONFIGURATION',
        'Production configuration is incomplete or unsafe.',
        MANUAL_NOTIFICATION_EXIT_CODES.unsafeRuntime,
      );
    }
    if (parsed.command === 'deliver' || parsed.command === 'show') {
      await confirmExactDelivery(parsed, io);
    }
    db = openManualNotificationDatabase(config, {
      readOnly: parsed.command === 'list',
    });
    if (parsed.command === 'list') {
      writeList(
        listManualNotifications(db, { limit: parsed.limit }),
        parsed,
        io.stdout,
      );
    } else {
      writeDelivery(
        deliverManualNotification(db, {
          id: parsed.id,
          encryptionKey: config.authEncryptionKey,
          auditHmacKey: config.auditHmacKey,
        }),
        parsed,
        io.stdout,
      );
    }
    return MANUAL_NOTIFICATION_EXIT_CODES.success;
  } catch (caught) {
    const error = normalizedCliError(caught);
    writeCliError(error, parsed?.json || argv.includes('--json'), io.stderr);
    return error.exitCode;
  } finally {
    db?.close();
  }
}

const executedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (executedPath.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  process.exitCode = await runManualNotificationCli();
}
