import { createHash, randomUUID } from 'node:crypto';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { withTransaction } from './database.js';
import { PERMISSIONS } from './rbac.js';
import { sealData, unsealData } from './secure-data.js';
import { hashToken, randomToken } from './security.js';

export const API_KEY_PERMISSIONS = Object.freeze([
  PERMISSIONS.ORGANIZATION_READ,
  PERMISSIONS.ORGANIZATION_MANAGE,
  PERMISSIONS.PROJECTS_CREATE,
  PERMISSIONS.PROJECT_READ,
  PERMISSIONS.PROJECT_MANAGE,
  PERMISSIONS.PROJECT_ARCHIVE,
  PERMISSIONS.PROJECT_WORK_WRITE,
  PERMISSIONS.PROPOSALS_READ,
  PERMISSIONS.PROPOSALS_MANAGE,
  PERMISSIONS.STAKEHOLDERS_READ,
  PERMISSIONS.STAKEHOLDERS_MANAGE,
  PERMISSIONS.CAPITAL_READ,
  PERMISSIONS.CAPITAL_MANAGE,
  PERMISSIONS.FINANCE_READ,
  PERMISSIONS.FINANCE_MANAGE,
  PERMISSIONS.GOALS_MANAGE,
  PERMISSIONS.GOVERNANCE_READ,
  PERMISSIONS.GOVERNANCE_MANAGE,
  PERMISSIONS.COMPLIANCE_READ,
  PERMISSIONS.COMPLIANCE_MANAGE,
  PERMISSIONS.CONTRACTS_READ,
  PERMISSIONS.CONTRACTS_MANAGE,
  PERMISSIONS.AUDIT_READ,
]);

const API_KEY_PERMISSION_SET = new Set(API_KEY_PERMISSIONS);

const LISTING_TYPES = new Set([
  'collaboration',
  'investment',
  'share_offer',
  'supplier',
  'expert',
]);
const LISTING_STATUSES = new Set(['draft', 'published', 'paused', 'closed', 'archived']);
const INTEGRATION_MODES = new Set(['manual', 'sandbox', 'live']);
const INTEGRATION_STATUSES = new Set([
  'inactive',
  'configured',
  'healthy',
  'degraded',
  'disabled',
]);
const REPORT_KEYS = new Set([
  'management',
  'financial-summary',
  'trial-balance',
  'tasks',
  'risks',
  'kpis',
  'cap-table',
  'governance',
]);
const REPORT_FORMATS = new Set(['json', 'csv', 'html']);
const OUTBOX_STATUSES = new Set([
  'pending',
  'processing',
  'sent',
  'failed',
  'cancelled',
]);

function text(value, field, { required = false, max = 5000 } = {}) {
  const selected = String(value ?? '').trim();
  if (required && !selected) {
    throw badRequest('VALIDATION_ERROR', 'اطلاعات واردشده کامل نیست.', {
      [field]: 'این فیلد الزامی است.',
    });
  }
  if (selected.length > max) {
    throw badRequest('VALIDATION_ERROR', 'اطلاعات واردشده معتبر نیست.', {
      [field]: `حداکثر ${max} نویسه مجاز است.`,
    });
  }
  return selected;
}

function enumValue(value, allowed, field, fallback) {
  const selected = value === undefined ? fallback : String(value);
  if (!allowed.has(selected)) {
    throw badRequest('VALIDATION_ERROR', 'اطلاعات واردشده معتبر نیست.', {
      [field]: 'مقدار انتخاب‌شده معتبر نیست.',
    });
  }
  return selected;
}

function integer(value, field, { required = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if ((value === undefined || value === null || value === '') && !required) return null;
  const selected = Number(value);
  if (!Number.isSafeInteger(selected) || selected < min || selected > max) {
    throw badRequest('VALIDATION_ERROR', 'اطلاعات واردشده معتبر نیست.', {
      [field]: 'عدد واردشده معتبر نیست.',
    });
  }
  return selected;
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function jsonArray(value, field, maxItems = 30) {
  const selected = value === undefined ? [] : value;
  if (!Array.isArray(selected) || selected.length > maxItems) {
    throw badRequest('VALIDATION_ERROR', 'اطلاعات واردشده معتبر نیست.', {
      [field]: `حداکثر ${maxItems} مورد مجاز است.`,
    });
  }
  return selected.map((item) => text(item, field, { required: true, max: 80 }));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeCsvCell(value) {
  let selected = value === null || value === undefined
    ? ''
    : (typeof value === 'object' ? JSON.stringify(value) : String(value));
  if (/^[=+\-@]/.test(selected)) selected = `'${selected}`;
  return `"${selected.replaceAll('"', '""')}"`;
}

function toCsv(rows) {
  if (!rows.length) return '\uFEFF';
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return `\uFEFF${[
    headers.map(safeCsvCell).join(','),
    ...rows.map((row) => headers.map((header) => safeCsvCell(row[header])).join(',')),
  ].join('\r\n')}`;
}

function flattenForCsv(reportKey, report) {
  if (reportKey === 'tasks') return report.tasks;
  if (reportKey === 'risks') return report.risks;
  if (reportKey === 'kpis') return report.kpis;
  if (reportKey === 'trial-balance') return report.accounts;
  if (reportKey === 'cap-table') return report.holdings;
  if (reportKey === 'governance') return report.resolutions;
  if (reportKey === 'financial-summary') {
    return Object.entries(report.totals).map(([metric, amount]) => ({ metric, amount }));
  }
  return Object.entries(report.summary).map(([metric, value]) => ({ metric, value }));
}

function reportHtml(title, generatedAt, rows) {
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return `<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:Arial,sans-serif;color:#17221e;margin:2rem;line-height:1.7}table{border-collapse:collapse;width:100%;margin-top:1rem}th,td{border:1px solid #dde5e1;padding:.55rem;text-align:right}th{background:#f1f6f3}small{color:#52635d}@media print{body{margin:0}}</style>
</head><body><h1>${escapeHtml(title)}</h1><small>زمان تولید: ${escapeHtml(generatedAt)}</small>
<table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>
<tbody>${rows.map((row) => `<tr>${headers.map((header) => `<td>${escapeHtml(
    typeof row[header] === 'object' ? JSON.stringify(row[header]) : row[header],
  )}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`;
}

function mapListing(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    type: row.listing_type,
    title: row.title,
    summary: row.summary,
    tags: parseJson(row.tags_json, []),
    minimumAmount: row.minimum_amount,
    maximumAmount: row.maximum_amount,
    currency: row.currency,
    location: row.location,
    status: row.status,
    publishedAt: row.published_at,
    closesAt: row.closes_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function actorPermissions(actor) {
  return new Set(actor?.permissions || []);
}

function isProjectManager(actor) {
  const permissions = actorPermissions(actor);
  return permissions.has('*') || permissions.has('project.manage');
}

function isBoardActor(actor) {
  const permissions = actorPermissions(actor);
  return (
    isProjectManager(actor) ||
    actor?.organizationRole === 'board' ||
    actor?.projectRole === 'board' ||
    permissions.has('governance.manage')
  );
}

function isInteractiveAuthor(row, actor) {
  return Boolean(
    row.author_user_id &&
    actor?.userId &&
    !actor?.apiKey &&
    actor?.actorType !== 'api_key' &&
    row.author_user_id === actor.userId
  );
}

function canReadComment(row, actor) {
  if (row.visibility === 'private') {
    return isInteractiveAuthor(row, actor) || isProjectManager(actor);
  }
  if (row.visibility === 'board') return isBoardActor(actor);
  return true;
}

function auditIdentity(actor) {
  return {
    actorUserId: actor?.userId || null,
    actorType: actor?.apiKey
      ? 'api_key'
      : actor?.legacy ? 'legacy_admin' : 'user',
    actorId: actor?.apiKey?.id || actor?.userId || null,
  };
}

export function createEnterpriseHubStore(db, options = {}) {
  const clock = options.clock || (() => new Date());
  const audit = options.audit || (() => {});
  const encryptionKey = String(options.encryptionKey || '');

  function mapNotificationOutboxRow(row) {
    return {
      id: row.id,
      organizationId: row.organization_id,
      userId: row.user_id,
      channel: row.channel,
      destination: row.destination,
      templateKey: row.template_key,
      provider: row.provider,
      status: row.status,
      attempts: Number(row.attempts),
      nextAttemptAt: row.next_attempt_at,
      sentAt: row.sent_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function requireProject(projectId, organizationId) {
    const project = db.prepare(`
      SELECT *
      FROM projects
      WHERE id=? AND archived_at IS NULL
    `).get(projectId);
    if (!project || (organizationId && project.organization_id !== organizationId)) {
      throw notFound('PROJECT_NOT_FOUND', 'پروژه پیدا نشد.');
    }
    return project;
  }

  function addComment(projectId, organizationId, input, actor = {}) {
    requireProject(projectId, organizationId);
    const now = clock().toISOString();
    const comment = {
      id: randomUUID(),
      resourceType: text(input.resourceType, 'resourceType', { required: true, max: 80 }),
      resourceId: text(input.resourceId, 'resourceId', { required: true, max: 120 }),
      parentId: text(input.parentId, 'parentId', { max: 120 }) || null,
      body: text(input.body, 'body', { required: true, max: 10_000 }),
      visibility: enumValue(
        input.visibility,
        new Set(['private', 'team', 'board', 'public']),
        'visibility',
        'team',
      ),
    };
    if (comment.visibility === 'board' && !isBoardActor(actor)) {
      throw forbidden(
        'BOARD_VISIBILITY_FORBIDDEN',
        'فقط مدیر پروژه یا عضو هیئت‌مدیره می‌تواند نظر هیئت‌مدیره ثبت کند.',
      );
    }
    withTransaction(db, () => {
      if (comment.parentId) {
        const parent = db.prepare(`
          SELECT id FROM comments
          WHERE id=? AND project_id=? AND deleted_at IS NULL
        `).get(comment.parentId, projectId);
        if (!parent) throw notFound('COMMENT_NOT_FOUND', 'نظر والد پیدا نشد.');
      }
      db.prepare(`
        INSERT INTO comments(
          id, organization_id, project_id, resource_type, resource_id,
          parent_id, body, visibility, author_user_id, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        comment.id,
        organizationId,
        projectId,
        comment.resourceType,
        comment.resourceId,
        comment.parentId,
        comment.body,
        comment.visibility,
        actor.userId || null,
        now,
        now,
      );
      audit({
        organizationId,
        projectId,
        ...auditIdentity(actor),
        action: 'comment.created',
        resourceType: comment.resourceType,
        resourceId: comment.resourceId,
        metadata: { commentId: comment.id, visibility: comment.visibility },
      });
    });
    return { comment: { ...comment, authorUserId: actor.userId || null, createdAt: now } };
  }

  function comments(projectId, resourceType, resourceId, actor = {}) {
    return {
      comments: db.prepare(`
        SELECT c.id, c.parent_id, c.body, c.visibility, c.author_user_id,
               c.edited_at, c.created_at, u.full_name AS author_name
        FROM comments c
        LEFT JOIN users u ON u.id=c.author_user_id
        WHERE c.project_id=? AND c.resource_type=? AND c.resource_id=?
          AND c.deleted_at IS NULL
        ORDER BY c.created_at, c.id
      `).all(projectId, resourceType, resourceId)
        .filter((row) => canReadComment(row, actor))
        .map((row) => ({
        id: row.id,
        parentId: row.parent_id,
        body: row.body,
        visibility: row.visibility,
        authorUserId: row.author_user_id,
        authorName: row.author_name || 'کاربر سامانه',
        editedAt: row.edited_at,
        createdAt: row.created_at,
        })),
    };
  }

  function deleteComment(projectId, commentId, actor = {}) {
    const row = db.prepare(`
      SELECT * FROM comments WHERE id=? AND project_id=? AND deleted_at IS NULL
    `).get(commentId, projectId);
    if (!row) throw notFound('COMMENT_NOT_FOUND', 'نظر پیدا نشد.');
    if (
      !actor.legacy &&
      !isInteractiveAuthor(row, actor) &&
      !isProjectManager(actor)
    ) {
      throw conflict('COMMENT_OWNERSHIP_REQUIRED', 'فقط نویسنده یا مدیر می‌تواند این نظر را حذف کند.');
    }
    const now = clock().toISOString();
    withTransaction(db, () => {
      db.prepare(`
        UPDATE comments
        SET deleted_at=?, body='', updated_at=?
        WHERE id=?
      `).run(now, now, commentId);
      audit({
        organizationId: row.organization_id,
        projectId,
        ...auditIdentity(actor),
        action: 'comment.deleted',
        resourceType: 'comment',
        resourceId: commentId,
      });
    });
    return { deleted: true, id: commentId };
  }

  function notify(input) {
    const now = clock().toISOString();
    const id = randomUUID();
    db.prepare(`
      INSERT INTO notifications(
        id, user_id, organization_id, project_id, type, title, body,
        action_url, created_at
      ) VALUES(?,?,?,?,?,?,?,?,?)
    `).run(
      id,
      input.userId,
      input.organizationId,
      input.projectId || null,
      text(input.type, 'type', { required: true, max: 80 }),
      text(input.title, 'title', { required: true, max: 200 }),
      text(input.body, 'body', { required: true, max: 1000 }),
      text(input.actionUrl, 'actionUrl', { max: 500 }),
      now,
    );
    return id;
  }

  function enqueueNotification(input) {
    const now = clock().toISOString();
    const id = randomUUID();
    const sealedPayload = sealData(
      input.payload || {},
      encryptionKey,
      `notification-outbox:${id}`,
    );
    db.prepare(`
      INSERT INTO notification_outbox(
        id, organization_id, user_id, channel, destination, template_key,
        payload_json, provider, status, attempts, next_attempt_at,
        created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?, 'pending',0,?,?,?)
    `).run(
      id,
      input.organizationId,
      input.userId || null,
      enumValue(input.channel, new Set(['email', 'sms', 'webhook']), 'channel'),
      text(input.destination, 'destination', { required: true, max: 320 }),
      text(input.templateKey, 'templateKey', { required: true, max: 100 }),
      JSON.stringify({ sealed: sealedPayload }),
      text(input.provider, 'provider', { max: 80 }) || 'manual',
      input.nextAttemptAt || now,
      now,
      now,
    );
    return id;
  }

  function notificationOutbox(
    organizationId,
    { status, limit = 100 } = {},
  ) {
    const selectedLimit = Math.max(1, Math.min(200, Number(limit) || 100));
    if (status) enumValue(status, OUTBOX_STATUSES, 'status');
    const organization = db.prepare(`
      SELECT id FROM organizations WHERE id=? AND archived_at IS NULL
    `).get(organizationId);
    if (!organization) {
      throw notFound('ORGANIZATION_NOT_FOUND', 'سازمان پیدا نشد.');
    }
    const rows = db.prepare(`
      SELECT *
      FROM notification_outbox
      WHERE organization_id=? ${status ? 'AND status=?' : ''}
      ORDER BY created_at DESC,id DESC
      LIMIT ?
    `).all(...(status
      ? [organizationId, status, selectedLimit]
      : [organizationId, selectedLimit]));
    return {
      outbox: rows.map(mapNotificationOutboxRow),
    };
  }

  function updateNotificationOutbox(organizationId, outboxId, input, actor = {}) {
    const action = enumValue(
      input.action,
      new Set(['mark_sent', 'retry', 'cancel']),
      'action',
    );
    const current = db.prepare(`
      SELECT *
      FROM notification_outbox
      WHERE id=? AND organization_id=?
    `).get(outboxId, organizationId);
    if (!current) {
      throw notFound('OUTBOX_ITEM_NOT_FOUND', 'پیام صف ارسال پیدا نشد.');
    }
    const now = clock().toISOString();
    withTransaction(db, () => {
      if (action === 'mark_sent') {
        if (current.provider !== 'manual') {
          throw conflict(
            'MANUAL_DELIVERY_ONLY',
            'فقط ارسال دستی را می‌توان به‌صورت دستی تأیید کرد.',
          );
        }
        if (current.status === 'sent' || current.status === 'cancelled') {
          throw conflict(
            'OUTBOX_ITEM_FINAL',
            'A sent or cancelled outbox item is final.',
          );
        }
        const changed = db.prepare(`
          UPDATE notification_outbox
          SET status='sent',sent_at=?,next_attempt_at=NULL,last_error='',updated_at=?
          WHERE id=? AND organization_id=?
            AND provider='manual' AND status NOT IN ('sent','cancelled')
        `).run(now, now, outboxId, organizationId);
        if (Number(changed.changes) !== 1) {
          throw conflict(
            'OUTBOX_ITEM_FINAL',
            'A sent or cancelled outbox item is final.',
          );
        }
      } else if (action === 'retry') {
        if (current.status === 'sent' || current.status === 'cancelled') {
          throw conflict(
            'OUTBOX_ITEM_FINAL',
            'پیام ارسال‌شده یا لغوشده قابل تلاش مجدد نیست.',
          );
        }
        const changed = db.prepare(`
          UPDATE notification_outbox
          SET status='pending',next_attempt_at=?,last_error='',updated_at=?
          WHERE id=? AND organization_id=?
            AND status NOT IN ('sent','cancelled')
        `).run(now, now, outboxId, organizationId);
        if (Number(changed.changes) !== 1) {
          throw conflict(
            'OUTBOX_ITEM_FINAL',
            'A sent or cancelled outbox item is final.',
          );
        }
      } else {
        if (current.status === 'sent') {
          throw conflict('OUTBOX_ITEM_FINAL', 'پیام ارسال‌شده قابل لغو نیست.');
        }
        const changed = db.prepare(`
          UPDATE notification_outbox
          SET status='cancelled',next_attempt_at=NULL,updated_at=?
          WHERE id=? AND organization_id=? AND status<>'sent'
        `).run(now, outboxId, organizationId);
        if (Number(changed.changes) !== 1) {
          throw conflict(
            'OUTBOX_ITEM_FINAL',
            'A sent outbox item cannot be cancelled.',
          );
        }
      }
      audit({
        organizationId,
        ...auditIdentity(actor),
        action: `notification_outbox.${action}`,
        resourceType: 'notification_outbox',
        resourceId: outboxId,
        metadata: {
          channel: current.channel,
          provider: current.provider,
          previousStatus: current.status,
        },
      });
    });
    return mapNotificationOutboxRow(db.prepare(`
      SELECT * FROM notification_outbox
      WHERE id=? AND organization_id=?
    `).get(outboxId, organizationId));
  }

  function notifications(userId, { unreadOnly = false, limit = 100 } = {}) {
    const selectedLimit = Math.max(1, Math.min(200, Number(limit) || 100));
    return {
      notifications: db.prepare(`
        SELECT *
        FROM notifications
        WHERE user_id=? ${unreadOnly ? 'AND read_at IS NULL' : ''}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(userId, selectedLimit).map((row) => ({
        id: row.id,
        organizationId: row.organization_id,
        projectId: row.project_id,
        type: row.type,
        title: row.title,
        body: row.body,
        actionUrl: row.action_url,
        readAt: row.read_at,
        createdAt: row.created_at,
      })),
      unreadCount: Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM notifications
        WHERE user_id=? AND read_at IS NULL
      `).get(userId).count),
    };
  }

  function markNotifications(userId, input) {
    const now = clock().toISOString();
    if (input.all === true) {
      db.prepare(`
        UPDATE notifications SET read_at=COALESCE(read_at,?)
        WHERE user_id=?
      `).run(now, userId);
    } else {
      const ids = Array.isArray(input.ids) ? input.ids.slice(0, 200).map(String) : [];
      if (!ids.length) {
        throw badRequest('VALIDATION_ERROR', 'حداقل یک اعلان انتخاب کنید.');
      }
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`
        UPDATE notifications SET read_at=COALESCE(read_at,?)
        WHERE user_id=? AND id IN (${placeholders})
      `).run(now, userId, ...ids);
    }
    return notifications(userId);
  }

  function setNotificationPreferences(userId, input) {
    if (!Array.isArray(input.preferences) || input.preferences.length > 100) {
      throw badRequest('VALIDATION_ERROR', 'تنظیمات اعلان معتبر نیست.');
    }
    const now = clock().toISOString();
    withTransaction(db, () => {
      const upsert = db.prepare(`
        INSERT INTO notification_preferences(
          user_id, channel, event_key, enabled, quiet_hours_json, updated_at
        ) VALUES(?,?,?,?,?,?)
        ON CONFLICT(user_id,channel,event_key) DO UPDATE SET
          enabled=excluded.enabled,
          quiet_hours_json=excluded.quiet_hours_json,
          updated_at=excluded.updated_at
      `);
      for (const preference of input.preferences) {
        upsert.run(
          userId,
          enumValue(
            preference.channel,
            new Set(['in_app', 'email', 'sms', 'webhook']),
            'channel',
          ),
          text(preference.eventKey, 'eventKey', { required: true, max: 100 }),
          preference.enabled === false ? 0 : 1,
          JSON.stringify(preference.quietHours || {}),
          now,
        );
      }
    });
    return {
      preferences: db.prepare(`
        SELECT channel, event_key, enabled, quiet_hours_json, updated_at
        FROM notification_preferences WHERE user_id=?
        ORDER BY event_key, channel
      `).all(userId).map((row) => ({
        channel: row.channel,
        eventKey: row.event_key,
        enabled: Boolean(row.enabled),
        quietHours: parseJson(row.quiet_hours_json, {}),
        updatedAt: row.updated_at,
      })),
    };
  }

  function integrationConnections(organizationId, { includeSecrets = false } = {}) {
    return {
      connections: db.prepare(`
        SELECT * FROM integration_connections
        WHERE organization_id=?
        ORDER BY display_name, provider_key
      `).all(organizationId).map((row) => ({
        id: row.id,
        providerKey: row.provider_key,
        displayName: row.display_name,
        mode: row.mode,
        status: row.status,
        configured: Boolean(row.config_sealed),
        ...(includeSecrets && row.config_sealed
          ? {
            config: parseJson(
              unsealData(row.config_sealed, encryptionKey, `integration:${row.id}`),
              {},
            ),
          }
          : {}),
        lastCheckedAt: row.last_checked_at,
        lastError: row.last_error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    };
  }

  function apiKeys(organizationId, actor = {}) {
    if (actor.apiKey) {
      throw forbidden(
        'INTERACTIVE_SESSION_REQUIRED',
        'مدیریت کلیدهای API فقط با نشست تعاملی کاربر مجاز است.',
      );
    }
    return {
      apiKeys: db.prepare(`
        SELECT id,name,token_prefix,permissions_json,last_used_at,expires_at,
               revoked_at,created_at,user_id
        FROM api_keys
        WHERE organization_id=?
        ORDER BY revoked_at IS NOT NULL,created_at DESC,id
      `).all(organizationId).map((row) => ({
        id: row.id,
        name: row.name,
        prefix: row.token_prefix,
        permissions: parseJson(row.permissions_json, []),
        userId: row.user_id,
        lastUsedAt: row.last_used_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        createdAt: row.created_at,
      })),
    };
  }

  function createApiKey(organizationId, input, actor = {}) {
    if (actor.apiKey) {
      throw forbidden(
        'INTERACTIVE_SESSION_REQUIRED',
        'ساخت کلید API فقط با نشست تعاملی کاربر مجاز است.',
      );
    }
    const requestedPermissions = jsonArray(input.permissions, 'permissions', 100);
    if (!requestedPermissions.length) {
      throw badRequest(
        'VALIDATION_ERROR',
        'حداقل یک مجوز محدود برای کلید API انتخاب کنید.',
      );
    }
    const unsupportedPermissions = requestedPermissions.filter(
      (permission) =>
        permission !== '*' && !API_KEY_PERMISSION_SET.has(permission),
    );
    if (unsupportedPermissions.length) {
      throw badRequest(
        'API_KEY_PERMISSION_NOT_ALLOWED',
        'یک یا چند مجوز برای کلید API قابل واگذاری نیست.',
        {
          permissions: `مجوزهای غیرمجاز: ${unsupportedPermissions.join(', ')}`,
        },
      );
    }
    const actorPermissions = new Set(actor.permissions || []);
    const actorHasAllPermissions = actor.legacy || actorPermissions.has('*');
    const expandedPermissions = requestedPermissions.includes('*')
      ? API_KEY_PERMISSIONS.filter(
          (permission) =>
            actorHasAllPermissions || actorPermissions.has(permission),
        )
      : requestedPermissions;
    const permissions = [...new Set(expandedPermissions)].sort();
    if (
      !actorHasAllPermissions &&
      permissions.some((permission) => !actorPermissions.has(permission))
    ) {
      throw conflict(
        'API_KEY_PERMISSION_ESCALATION',
        'کلید API نمی‌تواند مجوزی بیشتر از سازندهٔ خود داشته باشد.',
      );
    }
    if (!permissions.length) {
      throw badRequest(
        'API_KEY_PERMISSION_NOT_ALLOWED',
        'هیچ مجوز قابل واگذاری برای کلید API انتخاب نشده است.',
      );
    }
    const nowDate = clock();
    const now = nowDate.toISOString();
    const expiresAtInput =
      text(input.expiresAt, 'expiresAt', { max: 80 }) || null;
    const expiresAtTimestamp = expiresAtInput
      ? Date.parse(expiresAtInput)
      : null;
    if (
      expiresAtInput &&
      (
        !Number.isFinite(expiresAtTimestamp) ||
        expiresAtTimestamp <= nowDate.getTime()
      )
    ) {
      throw badRequest('VALIDATION_ERROR', 'زمان انقضای کلید معتبر نیست.');
    }
    const expiresAt = expiresAtTimestamp === null
      ? null
      : new Date(expiresAtTimestamp).toISOString();
    const id = randomUUID();
    const rawToken = `hmk_${randomToken(32)}`;
    withTransaction(db, () => {
      db.prepare(`
        INSERT INTO api_keys(
          id,organization_id,user_id,name,token_prefix,token_hash,
          permissions_json,expires_at,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?)
      `).run(
        id,
        organizationId,
        actor.userId || null,
        text(input.name, 'name', { required: true, max: 120 }),
        rawToken.slice(0, 14),
        hashToken(rawToken),
        JSON.stringify(permissions),
        expiresAt,
        now,
      );
      audit({
        organizationId,
        ...auditIdentity(actor),
        action: 'api_key.created',
        resourceType: 'api_key',
        resourceId: id,
        metadata: { permissions, expiresAt },
      });
    });
    return {
      apiKey: apiKeys(organizationId, actor).apiKeys.find((item) => item.id === id),
      token: rawToken,
      tokenShownOnce: true,
    };
  }

  function revokeApiKey(organizationId, id, actor = {}) {
    if (actor.apiKey) {
      throw forbidden(
        'INTERACTIVE_SESSION_REQUIRED',
        'لغو کلید API فقط با نشست تعاملی کاربر مجاز است.',
      );
    }
    const row = db.prepare(`
      SELECT * FROM api_keys WHERE id=? AND organization_id=?
    `).get(id, organizationId);
    if (!row) throw notFound('API_KEY_NOT_FOUND', 'کلید API پیدا نشد.');
    const now = clock().toISOString();
    withTransaction(db, () => {
      db.prepare(`
        UPDATE api_keys SET revoked_at=COALESCE(revoked_at,?) WHERE id=?
      `).run(now, id);
      audit({
        organizationId,
        ...auditIdentity(actor),
        action: 'api_key.revoked',
        resourceType: 'api_key',
        resourceId: id,
      });
    });
    return { id, revoked: true, revokedAt: row.revoked_at || now };
  }

  function upsertIntegration(organizationId, input, actor = {}) {
    const providerKey = text(input.providerKey, 'providerKey', {
      required: true,
      max: 80,
    }).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,79}$/.test(providerKey)) {
      throw badRequest('VALIDATION_ERROR', 'شناسهٔ سرویس معتبر نیست.');
    }
    const existing = db.prepare(`
      SELECT * FROM integration_connections
      WHERE organization_id=? AND provider_key=?
    `).get(organizationId, providerKey);
    const id = existing?.id || randomUUID();
    const mode = enumValue(input.mode, INTEGRATION_MODES, 'mode', existing?.mode || 'manual');
    const status = enumValue(
      input.status,
      INTEGRATION_STATUSES,
      'status',
      existing?.status || 'inactive',
    );
    if (mode === 'live' && status === 'healthy' && !existing?.last_checked_at) {
      throw conflict(
        'PROVIDER_NOT_VERIFIED',
        'اتصال زنده پیش از بررسی واقعی سرویس نمی‌تواند سالم علامت‌گذاری شود.',
      );
    }
    const configSealed = input.config === undefined
      ? existing?.config_sealed || ''
      : sealData(input.config, encryptionKey, `integration:${id}`);
    const now = clock().toISOString();
    withTransaction(db, () => {
      db.prepare(`
        INSERT INTO integration_connections(
          id, organization_id, provider_key, display_name, mode, status,
          config_sealed, last_checked_at, last_error, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(organization_id,provider_key) DO UPDATE SET
          display_name=excluded.display_name,
          mode=excluded.mode,
          status=excluded.status,
          config_sealed=excluded.config_sealed,
          last_error=excluded.last_error,
          updated_at=excluded.updated_at
      `).run(
        id,
        organizationId,
        providerKey,
        text(input.displayName, 'displayName', { required: true, max: 120 }),
        mode,
        status,
        configSealed,
        existing?.last_checked_at || null,
        text(input.lastError, 'lastError', { max: 1000 }),
        existing?.created_at || now,
        now,
      );
      audit({
        organizationId,
        ...auditIdentity(actor),
        action: existing ? 'integration.updated' : 'integration.created',
        resourceType: 'integration_connection',
        resourceId: id,
        before: existing ? { mode: existing.mode, status: existing.status } : null,
        after: { providerKey, mode, status, configured: Boolean(configSealed) },
      });
    });
    return {
      connection: integrationConnections(organizationId).connections
        .find((connection) => connection.id === id),
    };
  }

  function listingList(projectId) {
    return {
      listings: db.prepare(`
        SELECT * FROM marketplace_listings
        WHERE project_id=?
        ORDER BY updated_at DESC, id
      `).all(projectId).map(mapListing),
    };
  }

  function upsertListing(projectId, organizationId, input, actor = {}, listingId = null) {
    const project = requireProject(projectId, organizationId);
    const existing = listingId
      ? db.prepare(`
        SELECT * FROM marketplace_listings
        WHERE id=? AND project_id=?
      `).get(listingId, projectId)
      : null;
    if (listingId && !existing) {
      throw notFound('LISTING_NOT_FOUND', 'فرصت پیدا نشد.');
    }
    const now = clock().toISOString();
    const status = enumValue(
      input.status,
      LISTING_STATUSES,
      'status',
      existing?.status || 'draft',
    );
    if (status === 'published' && project.status !== 'published') {
      throw conflict(
        'PROJECT_NOT_PUBLISHED',
        'برای انتشار فرصت، پروژه باید عمومی و منتشرشده باشد.',
      );
    }
    const minimumAmount = input.minimumAmount === undefined
      ? existing?.minimum_amount ?? null
      : integer(input.minimumAmount, 'minimumAmount');
    const maximumAmount = input.maximumAmount === undefined
      ? existing?.maximum_amount ?? null
      : integer(input.maximumAmount, 'maximumAmount');
    if (
      minimumAmount !== null &&
      maximumAmount !== null &&
      minimumAmount > maximumAmount
    ) {
      throw badRequest(
        'VALIDATION_ERROR',
        'حداقل مبلغ نمی‌تواند بیشتر از حداکثر مبلغ باشد.',
      );
    }
    const listing = {
      id: existing?.id || randomUUID(),
      type: input.type === undefined
        ? existing?.listing_type || 'collaboration'
        : enumValue(input.type, LISTING_TYPES, 'type'),
      title: input.title === undefined
        ? existing?.title
        : text(input.title, 'title', { required: true, max: 240 }),
      summary: input.summary === undefined
        ? existing?.summary
        : text(input.summary, 'summary', { required: true, max: 3000 }),
      tags: input.tags === undefined
        ? parseJson(existing?.tags_json || '[]', [])
        : jsonArray(input.tags, 'tags'),
      minimumAmount,
      maximumAmount,
      currency: text(
        input.currency === undefined ? existing?.currency || project.currency : input.currency,
        'currency',
        { required: true, max: 8 },
      ).toUpperCase(),
      location: input.location === undefined
        ? existing?.location || project.location
        : text(input.location, 'location', { max: 240 }),
      status,
      closesAt: input.closesAt === undefined ? existing?.closes_at || null : (
        text(input.closesAt, 'closesAt', { max: 40 }) || null
      ),
    };
    withTransaction(db, () => {
      db.prepare(`
        INSERT INTO marketplace_listings(
          id, organization_id, project_id, listing_type, title, summary,
          tags_json, minimum_amount, maximum_amount, currency, location,
          status, published_at, closes_at, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          listing_type=excluded.listing_type,
          title=excluded.title,
          summary=excluded.summary,
          tags_json=excluded.tags_json,
          minimum_amount=excluded.minimum_amount,
          maximum_amount=excluded.maximum_amount,
          currency=excluded.currency,
          location=excluded.location,
          status=excluded.status,
          published_at=excluded.published_at,
          closes_at=excluded.closes_at,
          updated_at=excluded.updated_at
      `).run(
        listing.id,
        organizationId,
        projectId,
        listing.type,
        listing.title,
        listing.summary,
        JSON.stringify(listing.tags),
        listing.minimumAmount,
        listing.maximumAmount,
        listing.currency,
        listing.location,
        listing.status,
        listing.status === 'published'
          ? existing?.published_at || now
          : existing?.published_at || null,
        listing.closesAt,
        existing?.created_at || now,
        now,
      );
      audit({
        organizationId,
        projectId,
        ...auditIdentity(actor),
        action: existing ? 'marketplace.updated' : 'marketplace.created',
        resourceType: 'marketplace_listing',
        resourceId: listing.id,
        before: existing ? mapListing(existing) : null,
        after: listing,
      });
    });
    return {
      listing: mapListing(
        db.prepare('SELECT * FROM marketplace_listings WHERE id=?').get(listing.id),
      ),
    };
  }

  function publicListings(input = {}) {
    const limit = Math.max(1, Math.min(50, Number(input.limit) || 20));
    const clauses = [
      `l.status='published'`,
      `p.status='published'`,
      `p.visibility='public'`,
      `p.archived_at IS NULL`,
      `o.status='active'`,
      `o.archived_at IS NULL`,
      `(l.closes_at IS NULL OR l.closes_at >= ?)`,
    ];
    const values = [clock().toISOString()];
    if (input.type) {
      clauses.push('l.listing_type=?');
      values.push(enumValue(input.type, LISTING_TYPES, 'type'));
    }
    if (input.currency) {
      clauses.push('l.currency=?');
      values.push(text(input.currency, 'currency', { max: 8 }).toUpperCase());
    }
    if (input.q) {
      const query = text(input.q, 'q', { max: 100 })
        .replaceAll('\\', '\\\\')
        .replaceAll('%', '\\%')
        .replaceAll('_', '\\_');
      clauses.push(`(l.title LIKE ? ESCAPE '\\' OR l.summary LIKE ? ESCAPE '\\' OR p.title LIKE ? ESCAPE '\\')`);
      values.push(`%${query}%`, `%${query}%`, `%${query}%`);
    }
    if (input.cursor) {
      const [publishedAt, id, extra] = String(input.cursor).split('|');
      if (!publishedAt || !id || extra !== undefined) {
        throw badRequest('INVALID_CURSOR', 'نشانگر صفحه معتبر نیست.');
      }
      clauses.push(`(l.published_at < ? OR (l.published_at=? AND l.id<?))`);
      values.push(publishedAt, publishedAt, id);
    }
    const rows = db.prepare(`
      SELECT l.*, p.slug AS project_slug, p.title AS project_title,
             p.industry, p.stage, o.name AS organization_name,
             op.verified AS organization_verified
      FROM marketplace_listings l
      JOIN projects p ON p.id=l.project_id
      JOIN organizations o ON o.id=l.organization_id
      LEFT JOIN organization_public_profiles op ON op.organization_id=o.id
      WHERE ${clauses.join(' AND ')}
      ORDER BY l.published_at DESC, l.id DESC
      LIMIT ?
    `).all(...values, limit + 1);
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    return {
      listings: selected.map((row) => ({
        ...mapListing(row),
        organization: {
          name: row.organization_name,
          verified: Boolean(row.organization_verified),
        },
        project: {
          slug: row.project_slug,
          title: row.project_title,
          industry: row.industry,
          stage: row.stage,
        },
      })),
      nextCursor: hasMore
        ? `${selected.at(-1).published_at}|${selected.at(-1).id}`
        : null,
    };
  }

  function marketplaceFacets() {
    const now = clock().toISOString();
    return {
      types: db.prepare(`
        SELECT l.listing_type AS value, COUNT(*) AS count
        FROM marketplace_listings l
        JOIN projects p ON p.id=l.project_id
        JOIN organizations o ON o.id=l.organization_id
        WHERE l.status='published'
          AND p.status='published' AND p.visibility='public'
          AND p.archived_at IS NULL
          AND o.status='active' AND o.archived_at IS NULL
          AND (l.closes_at IS NULL OR l.closes_at >= ?)
        GROUP BY l.listing_type
        ORDER BY count DESC, value
      `).all(now).map((row) => ({ value: row.value, count: Number(row.count) })),
      currencies: db.prepare(`
        SELECT l.currency AS value, COUNT(*) AS count
        FROM marketplace_listings l
        JOIN projects p ON p.id=l.project_id
        JOIN organizations o ON o.id=l.organization_id
        WHERE l.status='published'
          AND p.status='published' AND p.visibility='public'
          AND p.archived_at IS NULL
          AND o.status='active' AND o.archived_at IS NULL
          AND (l.closes_at IS NULL OR l.closes_at >= ?)
        GROUP BY l.currency
        ORDER BY count DESC, value
      `).all(now).map((row) => ({ value: row.value, count: Number(row.count) })),
      industries: db.prepare(`
        SELECT p.industry AS value, COUNT(*) AS count
        FROM marketplace_listings l
        JOIN projects p ON p.id=l.project_id
        JOIN organizations o ON o.id=l.organization_id
        WHERE l.status='published'
          AND p.status='published' AND p.visibility='public'
          AND p.archived_at IS NULL
          AND o.status='active' AND o.archived_at IS NULL
          AND (l.closes_at IS NULL OR l.closes_at >= ?)
          AND p.industry <> ''
        GROUP BY p.industry
        ORDER BY count DESC, value
      `).all(now).map((row) => ({ value: row.value, count: Number(row.count) })),
    };
  }

  function publicListing(listingId) {
    const row = db.prepare(`
      SELECT l.*, p.slug AS project_slug, p.title AS project_title,
             p.industry, p.stage, p.summary AS project_summary,
             o.name AS organization_name,
             op.verified AS organization_verified
      FROM marketplace_listings l
      JOIN projects p ON p.id=l.project_id
      JOIN organizations o ON o.id=l.organization_id
      LEFT JOIN organization_public_profiles op ON op.organization_id=o.id
      WHERE l.id=? AND l.status='published' AND p.status='published'
        AND p.visibility='public' AND p.archived_at IS NULL
        AND o.status='active' AND o.archived_at IS NULL
        AND (l.closes_at IS NULL OR l.closes_at >= ?)
    `).get(listingId, clock().toISOString());
    if (!row) throw notFound('LISTING_NOT_FOUND', 'فرصت پیدا نشد.');
    return {
      listing: {
        ...mapListing(row),
        organization: {
          name: row.organization_name,
          verified: Boolean(row.organization_verified),
        },
        project: {
          slug: row.project_slug,
          title: row.project_title,
          summary: row.project_summary,
          industry: row.industry,
          stage: row.stage,
        },
      },
    };
  }

  function saveListing(userId, listingId, saved) {
    publicListing(listingId);
    if (saved) {
      db.prepare(`
        INSERT OR IGNORE INTO saved_listings(user_id,listing_id,created_at)
        VALUES(?,?,?)
      `).run(userId, listingId, clock().toISOString());
    } else {
      db.prepare(`
        DELETE FROM saved_listings WHERE user_id=? AND listing_id=?
      `).run(userId, listingId);
    }
    return { listingId, saved: Boolean(saved) };
  }

  function savedListings(userId) {
    return {
      listings: db.prepare(`
        SELECT l.*
        FROM saved_listings s
        JOIN marketplace_listings l ON l.id=s.listing_id
        JOIN projects p ON p.id=l.project_id
        JOIN organizations o ON o.id=l.organization_id
        WHERE s.user_id=?
          AND l.status='published'
          AND p.status='published' AND p.visibility='public'
          AND p.archived_at IS NULL
          AND o.status='active' AND o.archived_at IS NULL
          AND (l.closes_at IS NULL OR l.closes_at >= ?)
        ORDER BY s.created_at DESC
      `).all(userId, clock().toISOString()).map(mapListing),
    };
  }

  function reportData(projectId, reportKey) {
    const project = requireProject(projectId);
    const taskRows = db.prepare(`
      SELECT id,title,status,priority,progress_percent AS progressPercent,
             due_date AS dueDate,assignee_user_id AS assigneeUserId
      FROM project_tasks
      WHERE project_id=? AND archived_at IS NULL
      ORDER BY due_date,order_no,id
    `).all(projectId);
    const risks = db.prepare(`
      SELECT id,kind,title,status,probability,impact,
             probability*impact AS score,due_date AS dueDate
      FROM project_risks
      WHERE project_id=?
      ORDER BY score DESC,updated_at DESC
    `).all(projectId);
    const kpis = db.prepare(`
      SELECT id,name,unit,direction,baseline_value AS baselineValue,
             target_value AS targetValue,current_value AS currentValue,
             target_date AS targetDate
      FROM project_kpis
      WHERE project_id=? AND archived_at IS NULL
      ORDER BY name,id
    `).all(projectId);
    const accounts = db.prepare(`
      SELECT a.code,a.name,a.account_type AS type,
             COALESCE(SUM(CASE WHEN e.status='posted' THEN l.debit-l.credit ELSE 0 END),0) AS balance
      FROM accounting_accounts a
      LEFT JOIN journal_lines l ON l.account_id=a.id
      LEFT JOIN journal_entries e
        ON e.id=l.journal_entry_id AND e.project_id=?
      WHERE a.project_id=? OR (
        a.project_id IS NULL AND a.organization_id=?
      )
      GROUP BY a.id
      ORDER BY a.code,a.id
    `).all(projectId, projectId, project.organization_id);
    const holdings = db.prepare(`
      SELECT s.id AS stakeholderId,s.name AS stakeholder,
             c.name AS shareClass,c.symbol,
             COALESCE(SUM(l.units),0) AS units
      FROM project_stakeholders s
      JOIN share_classes c ON c.project_id=s.project_id
      LEFT JOIN share_ledger l
        ON l.stakeholder_id=s.id AND l.share_class_id=c.id
      WHERE s.project_id=? AND s.archived_at IS NULL
      GROUP BY s.id,c.id
      HAVING units <> 0
      ORDER BY c.symbol,units DESC,s.name
    `).all(projectId);
    const resolutions = db.prepare(`
      SELECT r.id,r.title,r.status,r.approval_rule AS approvalRule,
             r.approval_threshold AS approvalThreshold,r.decision,
             r.result_json AS result,m.scheduled_at AS meetingDate
      FROM meeting_resolutions r
      JOIN project_meetings m ON m.id=r.meeting_id
      WHERE m.project_id=?
      ORDER BY m.scheduled_at DESC,r.created_at DESC
    `).all(projectId).map((row) => ({
      ...row,
      result: parseJson(row.result, {}),
    }));
    const totals = Object.fromEntries(
      db.prepare(`
        SELECT a.account_type AS type,
               COALESCE(SUM(l.debit-l.credit),0) AS balance
        FROM accounting_accounts a
        JOIN journal_lines l ON l.account_id=a.id
        JOIN journal_entries e ON e.id=l.journal_entry_id AND e.status='posted'
        WHERE e.project_id=?
        GROUP BY a.account_type
      `).all(projectId).map((row) => [row.type, Number(row.balance)]),
    );
    const doneTasks = taskRows.filter((task) => task.status === 'done').length;
    const summary = {
      project: project.title,
      lifecycle: project.lifecycle,
      tasksTotal: taskRows.length,
      tasksDone: doneTasks,
      taskProgressPercent: taskRows.length
        ? Math.round(taskRows.reduce((sum, task) => sum + Number(task.progressPercent), 0) / taskRows.length)
        : 0,
      openRisks: risks.filter((risk) => !['resolved', 'closed'].includes(risk.status)).length,
      criticalRisks: risks.filter((risk) => risk.score >= 16 && !['resolved', 'closed'].includes(risk.status)).length,
      kpisTotal: kpis.length,
      capitalUnits: holdings.reduce((sum, row) => sum + Number(row.units), 0),
      proposals: Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM proposals p JOIN needs n ON n.id=p.need_id
        WHERE n.project_id=?
      `).get(projectId).count),
    };
    if (reportKey === 'tasks') return { projectId, tasks: taskRows };
    if (reportKey === 'risks') return { projectId, risks };
    if (reportKey === 'kpis') return { projectId, kpis };
    if (reportKey === 'trial-balance') return { projectId, accounts };
    if (reportKey === 'cap-table') return { projectId, holdings };
    if (reportKey === 'governance') return { projectId, resolutions };
    if (reportKey === 'financial-summary') return { projectId, totals };
    return {
      projectId,
      summary,
      tasks: taskRows,
      risks,
      kpis,
      totals,
      holdings,
      resolutions,
    };
  }

  function generateReport(projectId, organizationId, reportKey, format, actor = {}) {
    const project = requireProject(projectId, organizationId);
    const selectedKey = enumValue(reportKey, REPORT_KEYS, 'reportKey');
    const selectedFormat = enumValue(format, REPORT_FORMATS, 'format', 'json');
    const now = clock().toISOString();
    const report = reportData(projectId, selectedKey);
    const rows = flattenForCsv(selectedKey, report);
    let content;
    let contentType;
    let extension;
    if (selectedFormat === 'csv') {
      content = Buffer.from(toCsv(rows), 'utf8');
      contentType = 'text/csv; charset=utf-8';
      extension = 'csv';
    } else if (selectedFormat === 'html') {
      content = Buffer.from(
        reportHtml(`${project.title} — ${selectedKey}`, now, rows),
        'utf8',
      );
      contentType = 'text/html; charset=utf-8';
      extension = 'html';
    } else {
      content = Buffer.from(JSON.stringify({
        generatedAt: now,
        asOf: now,
        reportKey: selectedKey,
        ...report,
      }, null, 2), 'utf8');
      contentType = 'application/json; charset=utf-8';
      extension = 'json';
    }
    const runId = randomUUID();
    withTransaction(db, () => {
      db.prepare(`
        INSERT INTO report_runs(
          id,organization_id,project_id,report_key,format,parameters_json,status,
          requested_by_user_id,requested_at,completed_at,expires_at
        ) VALUES(?,?,?,?,?,'{}','completed',?,?,?,?)
      `).run(
        runId,
        organizationId,
        projectId,
        selectedKey,
        selectedFormat,
        actor.userId || null,
        now,
        now,
        new Date(clock().getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      );
      audit({
        organizationId,
        projectId,
        ...auditIdentity(actor),
        action: 'report.generated',
        resourceType: 'report_run',
        resourceId: runId,
        metadata: {
          reportKey: selectedKey,
          format: selectedFormat,
          sha256: createHash('sha256').update(content).digest('hex'),
        },
      });
    });
    return {
      runId,
      content,
      contentType,
      filename: `${project.slug}-${selectedKey}.${extension}`,
      generatedAt: now,
    };
  }

  function organizationOverview(organizationId) {
    const organization = db.prepare(`
      SELECT id,slug,name,legal_name,national_id,website,description,
             timezone,default_currency,status,created_at,updated_at
      FROM organizations WHERE id=? AND archived_at IS NULL
    `).get(organizationId);
    if (!organization) throw notFound('ORGANIZATION_NOT_FOUND', 'سازمان پیدا نشد.');
    const projectMetrics = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN lifecycle IN ('executing','operating') THEN 1 ELSE 0 END) AS active,
             SUM(CASE WHEN status='published' THEN 1 ELSE 0 END) AS published,
             COALESCE(SUM(COALESCE(
               (
                 SELECT SUM(bl.planned_amount)
                 FROM budget_lines bl
                 WHERE bl.budget_version_id=(
                   SELECT bv.id
                   FROM budget_versions bv
                   WHERE bv.project_id=p.id AND bv.status='approved'
                   ORDER BY bv.version_no DESC,bv.approved_at DESC,bv.id
                   LIMIT 1
                 )
               ),
               p.budget_amount,
               0
             )),0) AS budget
      FROM projects p
      WHERE p.organization_id=? AND p.archived_at IS NULL
    `).get(organizationId);
    return {
      organization: {
        id: organization.id,
        slug: organization.slug,
        name: organization.name,
        legalName: organization.legal_name,
        nationalId: organization.national_id,
        website: organization.website,
        description: organization.description,
        timezone: organization.timezone,
        defaultCurrency: organization.default_currency,
        status: organization.status,
      },
      metrics: {
        projects: Number(projectMetrics.total),
        activeProjects: Number(projectMetrics.active || 0),
        publishedProjects: Number(projectMetrics.published || 0),
        portfolioBudget: Number(projectMetrics.budget || 0),
        members: Number(db.prepare(`
          SELECT COUNT(*) AS count
          FROM organization_memberships
          WHERE organization_id=? AND status='active'
        `).get(organizationId).count),
        unreadOutbox: Number(db.prepare(`
          SELECT COUNT(*) AS count
          FROM notification_outbox
          WHERE organization_id=? AND status IN ('pending','failed')
        `).get(organizationId).count),
      },
    };
  }

  function publicProfile(organizationId) {
    const organization = db.prepare(`
      SELECT id,name,slug,website,description
      FROM organizations
      WHERE id=? AND status='active' AND archived_at IS NULL
    `).get(organizationId);
    if (!organization) throw notFound('ORGANIZATION_NOT_FOUND', 'سازمان پیدا نشد.');
    const row = db.prepare(`
      SELECT * FROM organization_public_profiles WHERE organization_id=?
    `).get(organizationId);
    return {
      profile: {
        organizationId,
        name: organization.name,
        slug: organization.slug,
        headline: row?.headline || '',
        description: row?.description || organization.description,
        website: row?.website || organization.website,
        contactEmail: row?.contact_email || '',
        verified: Boolean(row?.verified),
        published: Boolean(row?.published),
        updatedAt: row?.updated_at || null,
      },
    };
  }

  function updatePublicProfile(organizationId, input, actor = {}) {
    const previous = publicProfile(organizationId).profile;
    const next = {
      headline: input.headline === undefined
        ? previous.headline
        : text(input.headline, 'headline', { max: 240 }),
      description: input.description === undefined
        ? previous.description
        : text(input.description, 'description', { max: 5000 }),
      website: input.website === undefined
        ? previous.website
        : text(input.website, 'website', { max: 500 }),
      contactEmail: input.contactEmail === undefined
        ? previous.contactEmail
        : text(input.contactEmail, 'contactEmail', { max: 320 }).toLowerCase(),
      published: input.published === undefined
        ? previous.published
        : input.published === true,
    };
    if (next.website) {
      let url;
      try {
        url = new URL(next.website);
      } catch {
        throw badRequest('VALIDATION_ERROR', 'نشانی وب‌سایت معتبر نیست.');
      }
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw badRequest('VALIDATION_ERROR', 'نشانی وب‌سایت معتبر نیست.');
      }
    }
    const now = clock().toISOString();
    withTransaction(db, () => {
      db.prepare(`
        INSERT INTO organization_public_profiles(
          organization_id,headline,description,website,contact_email,
          verified,published,updated_at
        ) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(organization_id) DO UPDATE SET
          headline=excluded.headline,
          description=excluded.description,
          website=excluded.website,
          contact_email=excluded.contact_email,
          published=excluded.published,
          updated_at=excluded.updated_at
      `).run(
        organizationId,
        next.headline,
        next.description,
        next.website,
        next.contactEmail,
        previous.verified ? 1 : 0,
        next.published ? 1 : 0,
        now,
      );
      audit({
        organizationId,
        ...auditIdentity(actor),
        action: 'organization.public_profile_updated',
        resourceType: 'organization_public_profile',
        resourceId: organizationId,
        before: previous,
        after: next,
      });
    });
    return publicProfile(organizationId);
  }

  return Object.freeze({
    addComment,
    comments,
    deleteComment,
    notify,
    enqueueNotification,
    notificationOutbox,
    updateNotificationOutbox,
    notifications,
    markNotifications,
    setNotificationPreferences,
    integrationConnections,
    upsertIntegration,
    apiKeys,
    createApiKey,
    revokeApiKey,
    listingList,
    upsertListing,
    publicListings,
    publicListing,
    marketplaceFacets,
    saveListing,
    savedListings,
    generateReport,
    organizationOverview,
    publicProfile,
    updatePublicProfile,
  });
}
