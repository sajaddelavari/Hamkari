import { createHmac, randomUUID } from 'node:crypto';
import { badRequest } from './errors.js';

const SENSITIVE_KEY = /(password|secret|token|authorization|cookie|mobile|email|national|identity|account|card|iban|content)/i;

function stableValue(value) {
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [
      key,
      SENSITIVE_KEY.test(key) ? '[REDACTED]' : stableValue(value[key]),
    ]),
  );
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function eventDigest(key, payload) {
  return createHmac('sha256', key).update(stableJson(payload)).digest('base64url');
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function createEnterpriseAudit(db, options = {}) {
  const clock = options.clock || (() => new Date());
  const hmacKey = String(options.hmacKey || '');
  if (hmacKey.length < 32) throw new Error('Enterprise audit HMAC key is too short.');

  const insert = db.prepare(`
    INSERT INTO enterprise_audit_events(
      id, organization_id, project_id, actor_type, actor_id, request_id,
      ip_hash, action, resource_type, resource_id, before_json, after_json,
      metadata_json, previous_hash, event_hash, created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  function append(event) {
    const createdAt = event.createdAt || clock().toISOString();
    const previous = db.prepare(`
      SELECT event_hash
      FROM enterprise_audit_events
      ORDER BY rowid DESC
      LIMIT 1
    `).get();
    const previousHash = previous?.event_hash || '';
    const id = event.id || randomUUID();
    const actorType = event.actorType || (event.actorUserId ? 'user' : 'system');
    const payload = {
      id,
      organizationId: event.organizationId || null,
      projectId: event.projectId || null,
      actorType,
      actorId: event.actorId || event.actorUserId || null,
      requestId: event.requestId || '',
      ipHash: event.ipHash || '',
      action: String(event.action || ''),
      resourceType: String(event.resourceType || ''),
      resourceId: String(event.resourceId || ''),
      before: event.before ?? null,
      after: event.after ?? null,
      metadata: event.metadata || {},
      previousHash,
      createdAt,
    };
    if (!payload.action || !payload.resourceType) {
      throw badRequest(
        'INVALID_AUDIT_EVENT',
        'رویداد حسابرسی باید عملیات و نوع منبع داشته باشد.',
      );
    }
    const hash = eventDigest(hmacKey, payload);
    insert.run(
      id,
      payload.organizationId,
      payload.projectId,
      payload.actorType,
      payload.actorId,
      payload.requestId,
      payload.ipHash,
      payload.action,
      payload.resourceType,
      payload.resourceId,
      payload.before === null ? null : stableJson(payload.before),
      payload.after === null ? null : stableJson(payload.after),
      stableJson(payload.metadata),
      previousHash,
      hash,
      createdAt,
    );
    return { id, hash, createdAt };
  }

  function list({ organizationId, projectId, cursor, limit = 100 } = {}) {
    const selectedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const clauses = [];
    const values = [];
    if (organizationId) {
      clauses.push('organization_id=?');
      values.push(organizationId);
    }
    if (projectId) {
      clauses.push('project_id=?');
      values.push(projectId);
    }
    if (cursor) {
      clauses.push(`(created_at < ? OR (created_at = ? AND id < ?))`);
      values.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const rows = db.prepare(`
      SELECT *
      FROM enterprise_audit_events
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...values, selectedLimit + 1);
    const hasMore = rows.length > selectedLimit;
    const selected = rows.slice(0, selectedLimit);
    return {
      events: selected.map((row) => ({
        id: row.id,
        organizationId: row.organization_id,
        projectId: row.project_id,
        actorType: row.actor_type,
        actorId: row.actor_id,
        requestId: row.request_id,
        action: row.action,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        before: row.before_json ? parseJson(row.before_json, null) : null,
        after: row.after_json ? parseJson(row.after_json, null) : null,
        metadata: parseJson(row.metadata_json, {}),
        previousHash: row.previous_hash,
        eventHash: row.event_hash,
        createdAt: row.created_at,
      })),
      nextCursor: hasMore
        ? {
          createdAt: selected.at(-1).created_at,
          id: selected.at(-1).id,
        }
        : null,
    };
  }

  function verify() {
    const rows = db.prepare(`
      SELECT *
      FROM enterprise_audit_events
      ORDER BY rowid
    `).all();
    let previousHash = '';
    for (const row of rows) {
      if (row.previous_hash !== previousHash) {
        return {
          valid: false,
          checked: rows.indexOf(row),
          failedEventId: row.id,
          reason: 'PREVIOUS_HASH_MISMATCH',
        };
      }
      const payload = {
        id: row.id,
        organizationId: row.organization_id,
        projectId: row.project_id,
        actorType: row.actor_type,
        actorId: row.actor_id,
        requestId: row.request_id,
        ipHash: row.ip_hash,
        action: row.action,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        before: row.before_json ? parseJson(row.before_json, null) : null,
        after: row.after_json ? parseJson(row.after_json, null) : null,
        metadata: parseJson(row.metadata_json, {}),
        previousHash: row.previous_hash,
        createdAt: row.created_at,
      };
      const expected = eventDigest(hmacKey, payload);
      if (expected !== row.event_hash) {
        return {
          valid: false,
          checked: rows.indexOf(row),
          failedEventId: row.id,
          reason: 'EVENT_HASH_MISMATCH',
        };
      }
      previousHash = row.event_hash;
    }
    return {
      valid: true,
      checked: rows.length,
      headHash: previousHash,
      verifiedAt: clock().toISOString(),
    };
  }

  return Object.freeze({ append, list, verify });
}
