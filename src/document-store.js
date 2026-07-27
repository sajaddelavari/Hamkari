import { createHash, randomUUID } from 'node:crypto';
import { AppError, badRequest, notFound } from './errors.js';
import { withTransaction } from './database.js';

const DOCUMENT_CATEGORIES = new Set([
  'project',
  'financial',
  'legal',
  'contract',
  'identity',
  'meeting',
  'evidence',
  'report',
  'other',
]);
const DOCUMENT_VISIBILITIES = new Set(['private', 'organization', 'project', 'public']);
const DOCUMENT_STATUSES = new Set(['draft', 'active', 'archived']);

export const ALLOWED_DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
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

function mapDocument(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    folder: row.folder,
    title: row.title,
    category: row.category,
    visibility: row.visibility,
    status: row.status,
    currentVersionNo: Number(row.current_version_no),
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function mapVersion(row, { content = false } = {}) {
  return {
    id: row.id,
    documentId: row.document_id,
    versionNo: Number(row.version_no),
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    changeNote: row.change_note,
    uploadedByUserId: row.uploaded_by_user_id,
    createdAt: row.created_at,
    ...(content ? { content: row.content } : {}),
  };
}

function permissionSet(actor) {
  return new Set(actor?.permissions || []);
}

function isInteractiveCreator(row, actor) {
  return Boolean(
    row.created_by_user_id &&
    actor?.userId &&
    !actor?.apiKey &&
    actor?.actorType !== 'api_key' &&
    row.created_by_user_id === actor.userId
  );
}

function canReadPrivateDocument(row, actor) {
  if (isInteractiveCreator(row, actor)) return true;
  const permissions = permissionSet(actor);
  if (permissions.has('*') || permissions.has('project.manage')) return true;
  if (
    ['financial', 'report'].includes(row.category) &&
    (permissions.has('finance.read') || permissions.has('audit.read'))
  ) return true;
  if (
    ['legal', 'contract'].includes(row.category) &&
    (permissions.has('contracts.read') || permissions.has('compliance.read'))
  ) return true;
  if (
    ['identity', 'evidence'].includes(row.category) &&
    permissions.has('compliance.read')
  ) return true;
  return row.category === 'meeting' && permissions.has('governance.manage');
}

function canReadDocument(row, actor) {
  return row.visibility !== 'private' || canReadPrivateDocument(row, actor);
}

function canManageDocument(row, actor) {
  if (isInteractiveCreator(row, actor)) return true;
  const permissions = permissionSet(actor);
  if (permissions.has('*') || permissions.has('project.manage')) return true;
  if (
    ['financial', 'report'].includes(row.category) &&
    permissions.has('finance.manage')
  ) return true;
  if (
    ['legal', 'contract'].includes(row.category) &&
    permissions.has('contracts.manage')
  ) return true;
  if (
    ['identity', 'evidence'].includes(row.category) &&
    permissions.has('compliance.manage')
  ) return true;
  return row.category === 'meeting' && permissions.has('governance.manage');
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

export function createDocumentStore(db, options = {}) {
  const clock = options.clock || (() => new Date());
  const audit = options.audit || (() => {});
  const projectQuotaBytes = Number.isSafeInteger(options.projectQuotaBytes)
    ? options.projectQuotaBytes
    : 256 * 1024 * 1024;
  const organizationQuotaBytes = Number.isSafeInteger(options.organizationQuotaBytes)
    ? options.organizationQuotaBytes
    : 1024 * 1024 * 1024;
  const maximumVersionsPerDocument =
    Number.isSafeInteger(options.maximumVersionsPerDocument)
      ? options.maximumVersionsPerDocument
      : 100;

  function requireProject(projectId, organizationId) {
    const row = db.prepare(`
      SELECT id, organization_id
      FROM projects
      WHERE id=? AND archived_at IS NULL
    `).get(projectId);
    if (!row || (organizationId && row.organization_id !== organizationId)) {
      throw notFound('PROJECT_NOT_FOUND', 'پروژه پیدا نشد.');
    }
    return row;
  }

  function requireDocument(projectId, documentId, actor, { manage = false } = {}) {
    const row = db.prepare(`
      SELECT *
      FROM documents
      WHERE id=? AND project_id=?
    `).get(documentId, projectId);
    if (
      !row ||
      (actor && !(manage
        ? canManageDocument(row, actor)
        : canReadDocument(row, actor)))
    ) {
      throw notFound('DOCUMENT_NOT_FOUND', 'سند پیدا نشد.');
    }
    return row;
  }

  function list(
    projectId,
    { includeArchived = false, category, query } = {},
    actor = {},
  ) {
    const clauses = ['project_id=?'];
    const values = [projectId];
    if (!includeArchived) clauses.push('archived_at IS NULL');
    if (category) {
      clauses.push('category=?');
      values.push(enumValue(category, DOCUMENT_CATEGORIES, 'category'));
    }
    const selectedQuery = text(query, 'query', { max: 100 });
    if (selectedQuery) {
      clauses.push(`(title LIKE ? ESCAPE '\\' OR folder LIKE ? ESCAPE '\\')`);
      const pattern = `%${selectedQuery
        .replaceAll('\\', '\\\\')
        .replaceAll('%', '\\%')
        .replaceAll('_', '\\_')}%`;
      values.push(pattern, pattern);
    }
    const documents = db.prepare(`
      SELECT *
      FROM documents
      WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at DESC, id
      LIMIT 500
    `).all(...values)
      .filter((row) => canReadDocument(row, actor))
      .map(mapDocument);
    const versionStatement = db.prepare(`
      SELECT id, document_id, version_no, filename, mime_type, size_bytes,
             sha256, change_note, uploaded_by_user_id, created_at
      FROM document_versions
      WHERE document_id=?
      ORDER BY version_no DESC
    `);
    return {
      documents: documents.map((document) => ({
        ...document,
        versions: versionStatement.all(document.id).map(mapVersion),
      })),
    };
  }

  function create(projectId, organizationId, input, actor = {}) {
    requireProject(projectId, organizationId);
    const now = clock().toISOString();
    const document = {
      id: randomUUID(),
      folder: text(input.folder, 'folder', { max: 240 }),
      title: text(input.title, 'title', { required: true, max: 240 }),
      category: enumValue(input.category, DOCUMENT_CATEGORIES, 'category', 'other'),
      visibility: enumValue(
        input.visibility,
        DOCUMENT_VISIBILITIES,
        'visibility',
        'private',
      ),
      status: enumValue(input.status, DOCUMENT_STATUSES, 'status', 'draft'),
    };
    withTransaction(db, () => {
      db.prepare(`
        INSERT INTO documents(
          id, organization_id, project_id, folder, title, category, visibility,
          status, current_version_no, created_by_user_id, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,0,?,?,?)
      `).run(
        document.id,
        organizationId,
        projectId,
        document.folder,
        document.title,
        document.category,
        document.visibility,
        document.status,
        actor.userId || null,
        now,
        now,
      );
      audit({
        organizationId,
        projectId,
        ...auditIdentity(actor),
        action: 'document.created',
        resourceType: 'document',
        resourceId: document.id,
        after: document,
      });
    });
    return {
      document: mapDocument(requireDocument(projectId, document.id, actor)),
    };
  }

  function patch(projectId, documentId, input, actor = {}) {
    const previous = requireDocument(
      projectId,
      documentId,
      actor,
      { manage: true },
    );
    const next = {
      folder: input.folder === undefined
        ? previous.folder
        : text(input.folder, 'folder', { max: 240 }),
      title: input.title === undefined
        ? previous.title
        : text(input.title, 'title', { required: true, max: 240 }),
      category: input.category === undefined
        ? previous.category
        : enumValue(input.category, DOCUMENT_CATEGORIES, 'category'),
      visibility: input.visibility === undefined
        ? previous.visibility
        : enumValue(input.visibility, DOCUMENT_VISIBILITIES, 'visibility'),
      status: input.status === undefined
        ? previous.status
        : enumValue(input.status, DOCUMENT_STATUSES, 'status'),
      archivedAt: input.archived === undefined
        ? previous.archived_at
        : (input.archived ? clock().toISOString() : null),
    };
    const now = clock().toISOString();
    withTransaction(db, () => {
      db.prepare(`
        UPDATE documents
        SET folder=?, title=?, category=?, visibility=?, status=?,
            archived_at=?, updated_at=?
        WHERE id=? AND project_id=?
      `).run(
        next.folder,
        next.title,
        next.category,
        next.visibility,
        next.status,
        next.archivedAt,
        now,
        documentId,
        projectId,
      );
      audit({
        organizationId: previous.organization_id,
        projectId,
        ...auditIdentity(actor),
        action: 'document.updated',
        resourceType: 'document',
        resourceId: documentId,
        before: mapDocument(previous),
        after: next,
      });
    });
    return {
      document: mapDocument(
        requireDocument(projectId, documentId, actor, { manage: true }),
      ),
    };
  }

  function addVersion(projectId, documentId, file, actor = {}) {
    const document = requireDocument(
      projectId,
      documentId,
      actor,
      { manage: true },
    );
    if (!ALLOWED_DOCUMENT_MIME_TYPES.has(file.mimeType)) {
      throw badRequest('UNSUPPORTED_DOCUMENT_TYPE', 'نوع این فایل مجاز نیست.');
    }
    const filename = text(file.filename, 'filename', {
      required: true,
      max: 240,
    });
    const changeNote = text(file.changeNote, 'changeNote', { max: 1000 });
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const now = clock().toISOString();
    let version;
    withTransaction(db, () => {
      const usage = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM document_versions WHERE document_id=?) AS version_count,
          (
            SELECT COALESCE(SUM(v.size_bytes),0)
            FROM document_versions v
            JOIN documents d ON d.id=v.document_id
            WHERE d.project_id=?
          ) AS project_bytes,
          (
            SELECT COALESCE(SUM(v.size_bytes),0)
            FROM document_versions v
            JOIN documents d ON d.id=v.document_id
            WHERE d.organization_id=?
          ) AS organization_bytes
      `).get(documentId, projectId, document.organization_id);
      if (Number(usage.version_count) >= maximumVersionsPerDocument) {
        throw new AppError(
          413,
          'DOCUMENT_VERSION_LIMIT_EXCEEDED',
          `هر سند حداکثر ${maximumVersionsPerDocument} نسخه می‌تواند داشته باشد.`,
        );
      }
      if (Number(usage.project_bytes) + file.buffer.length > projectQuotaBytes) {
        throw new AppError(
          413,
          'PROJECT_DOCUMENT_QUOTA_EXCEEDED',
          'سهمیهٔ فضای اسناد این پروژه تکمیل شده است.',
        );
      }
      if (
        Number(usage.organization_bytes) + file.buffer.length >
        organizationQuotaBytes
      ) {
        throw new AppError(
          413,
          'ORGANIZATION_DOCUMENT_QUOTA_EXCEEDED',
          'سهمیهٔ فضای اسناد این سازمان تکمیل شده است.',
        );
      }
      const nextVersion = Number(usage.version_count) + 1;
      version = {
        id: randomUUID(),
        versionNo: nextVersion,
      };
      db.prepare(`
        INSERT INTO document_versions(
          id, document_id, version_no, filename, mime_type, size_bytes, sha256,
          content, change_note, uploaded_by_user_id, created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        version.id,
        documentId,
        nextVersion,
        filename,
        file.mimeType,
        file.buffer.length,
        sha256,
        file.buffer,
        changeNote,
        actor.userId || null,
        now,
      );
      db.prepare(`
        UPDATE documents
        SET current_version_no=?, status='active', updated_at=?
        WHERE id=?
      `).run(nextVersion, now, documentId);
      audit({
        organizationId: document.organization_id,
        projectId,
        ...auditIdentity(actor),
        action: 'document.version_uploaded',
        resourceType: 'document_version',
        resourceId: version.id,
        after: {
          documentId,
          versionNo: nextVersion,
          filename,
          mimeType: file.mimeType,
          sizeBytes: file.buffer.length,
          sha256,
        },
      });
    }, 'IMMEDIATE');
    const row = db.prepare(`
      SELECT id, document_id, version_no, filename, mime_type, size_bytes,
             sha256, change_note, uploaded_by_user_id, created_at
      FROM document_versions WHERE id=?
    `).get(version.id);
    return { version: mapVersion(row) };
  }

  function versionContent(projectId, documentId, versionId, actor = {}) {
    requireDocument(projectId, documentId, actor);
    const row = db.prepare(`
      SELECT v.*
      FROM document_versions v
      WHERE v.id=? AND v.document_id=?
    `).get(versionId, documentId);
    if (!row) throw notFound('DOCUMENT_VERSION_NOT_FOUND', 'نسخهٔ سند پیدا نشد.');
    return mapVersion(row, { content: true });
  }

  function link(projectId, documentId, input, actor = {}) {
    const document = requireDocument(
      projectId,
      documentId,
      actor,
      { manage: true },
    );
    const resourceType = text(input.resourceType, 'resourceType', {
      required: true,
      max: 80,
    });
    const resourceId = text(input.resourceId, 'resourceId', {
      required: true,
      max: 120,
    });
    const now = clock().toISOString();
    withTransaction(db, () => {
      db.prepare(`
        INSERT OR IGNORE INTO document_links(
          document_id, resource_type, resource_id, created_at
        ) VALUES(?,?,?,?)
      `).run(documentId, resourceType, resourceId, now);
      audit({
        organizationId: document.organization_id,
        projectId,
        ...auditIdentity(actor),
        action: 'document.linked',
        resourceType,
        resourceId,
        metadata: { documentId },
      });
    });
    return {
      link: { documentId, resourceType, resourceId, createdAt: now },
    };
  }

  return Object.freeze({
    list,
    create,
    patch,
    addVersion,
    versionContent,
    link,
  });
}
