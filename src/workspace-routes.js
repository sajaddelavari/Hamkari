import { badRequest, forbidden, notFound, unauthorized } from './errors.js';
import { assertMutationOrigin, decodeSegment, sendJson } from './http.js';
import {
  authorizeOrganization,
  authorizeProject,
  readIdentitySession,
} from './identity-routes.js';
import { API_KEY_PERMISSIONS } from './enterprise-hub-store.js';
import { PERMISSIONS } from './rbac.js';
import { routePlatformAdminApi } from './platform-routes.js';
import { hashToken } from './security.js';

const PROJECT_PREFIX = '/api/v2/admin/projects';

const PERMISSION_ALIASES = Object.freeze({
  'session.read': null,
  'organization.read': PERMISSIONS.ORGANIZATION_READ,
  'organization.manage': PERMISSIONS.ORGANIZATION_MANAGE,
  'integrations.read': PERMISSIONS.ORGANIZATION_READ,
  'integrations.manage': PERMISSIONS.ORGANIZATION_MANAGE,
  'project.read': PERMISSIONS.PROJECT_READ,
  'project.manage': PERMISSIONS.PROJECT_MANAGE,
  'execution.read': PERMISSIONS.PROJECT_READ,
  'execution.manage': PERMISSIONS.PROJECT_WORK_WRITE,
  'operations.read': PERMISSIONS.PROJECT_READ,
  'operations.manage': PERMISSIONS.PROJECT_WORK_WRITE,
  'documents.read': PERMISSIONS.PROJECT_READ,
  'documents.manage': PERMISSIONS.PROJECT_WORK_WRITE,
  'comments.read': PERMISSIONS.PROJECT_READ,
  'comments.create': PERMISSIONS.PROJECT_WORK_WRITE,
  'comments.moderate': PERMISSIONS.PROJECT_MANAGE,
  'marketplace.read': PERMISSIONS.PROJECT_READ,
  'marketplace.manage': PERMISSIONS.PROJECT_MANAGE,
  'reports.read': PERMISSIONS.PROJECT_READ,
  'audit.read': PERMISSIONS.AUDIT_READ,
  'finance.read': PERMISSIONS.FINANCE_READ,
  'finance.manage': PERMISSIONS.FINANCE_MANAGE,
  'capital.read': PERMISSIONS.CAPITAL_READ,
  'capital.manage': PERMISSIONS.CAPITAL_MANAGE,
  'governance.read': PERMISSIONS.GOVERNANCE_READ,
  'governance.manage': PERMISSIONS.GOVERNANCE_MANAGE,
  'compliance.read': PERMISSIONS.COMPLIANCE_READ,
  'compliance.manage': PERMISSIONS.COMPLIANCE_MANAGE,
  'contracts.read': PERMISSIONS.CONTRACTS_READ,
  'contracts.manage': PERMISSIONS.CONTRACTS_MANAGE,
});

function mappedPermission(permission) {
  if (permission === undefined || permission === null) return null;
  return PERMISSION_ALIASES[permission] || permission;
}

function permissionSet(values) {
  const selected = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const permission = mappedPermission(String(value || ''));
    if (permission) selected.add(permission);
  }
  return selected;
}

function intersectPermissions(keyPermissions, currentPermissions) {
  const allowed = new Set(API_KEY_PERMISSIONS);
  const configured = permissionSet(keyPermissions);
  const granted = permissionSet(currentPermissions);
  const key = configured.has('*')
    ? new Set(allowed)
    : new Set([...configured].filter((permission) => allowed.has(permission)));
  const current = granted.has('*')
    ? new Set(allowed)
    : new Set([...granted].filter((permission) => allowed.has(permission)));
  return [...key].filter((permission) => current.has(permission)).sort();
}

function normalizedAuth(auth) {
  const authorization = auth.authorization || null;
  return {
    userId: auth.user.id,
    user: auth.user,
    session: auth.session,
    csrfToken: auth.csrfToken,
    organizationId:
      authorization?.organization?.id ||
      authorization?.project?.organizationId ||
      null,
    permissions: authorization?.serializedPermissions || [],
    organizationRole: authorization?.organizationRole || null,
    projectRole: authorization?.projectRole || null,
    legacy: false,
    authorization,
  };
}

function apiKeyAuthorization(
  context,
  { projectId, organizationId, permission } = {},
) {
  const header = String(context.request.headers.authorization || '');
  if (!header) return null;
  const match = header.match(/^Bearer (hmk_[A-Za-z0-9_-]{32,200})$/);
  if (!match) throw unauthorized('کلید API معتبر نیست.');
  const nowDate = context.now();
  const now = nowDate.toISOString();
  const row = context.db.prepare(`
    SELECT k.*,o.status AS organization_status,
           o.archived_at AS organization_archived_at,
           u.status AS creator_status,
           m.status AS membership_status
    FROM api_keys k
    JOIN organizations o ON o.id=k.organization_id
    JOIN users u ON u.id=k.user_id
    JOIN organization_memberships m
      ON m.organization_id=k.organization_id AND m.user_id=k.user_id
    WHERE k.token_hash=? AND k.revoked_at IS NULL
  `).get(hashToken(match[1]));
  const expirationTimestamp = row?.expires_at
    ? Date.parse(row.expires_at)
    : null;
  if (
    !row ||
    row.organization_status !== 'active' ||
    row.organization_archived_at ||
    row.creator_status !== 'active' ||
    row.membership_status !== 'active' ||
    (
      row.expires_at &&
      (
        !Number.isFinite(expirationTimestamp) ||
        expirationTimestamp <= nowDate.getTime()
      )
    )
  ) {
    throw unauthorized('کلید API معتبر یا فعال نیست.');
  }
  if (organizationId && row.organization_id !== organizationId) {
    throw notFound('ORGANIZATION_NOT_FOUND', 'سازمان پیدا نشد.');
  }
  if (projectId) {
    const project = context.db.prepare(`
      SELECT organization_id FROM projects WHERE id=? AND archived_at IS NULL
    `).get(projectId);
    if (!project || project.organization_id !== row.organization_id) {
      throw notFound('PROJECT_NOT_FOUND', 'پروژه پیدا نشد.');
    }
  }
  let configuredPermissions = [];
  try {
    configuredPermissions = JSON.parse(row.permissions_json);
  } catch {
    configuredPermissions = [];
  }
  const currentAuthorization = projectId
    ? context.identityStore.projectAuthorization(row.user_id, projectId)
    : context.identityStore.organizationAuthorization(
        row.user_id,
        row.organization_id,
      );
  if (!currentAuthorization) {
    if (projectId) {
      throw notFound('PROJECT_NOT_FOUND', 'Project not found.');
    }
    throw unauthorized('API key is no longer active.');
  }
  const permissions = intersectPermissions(
    configuredPermissions,
    currentAuthorization.serializedPermissions,
  );
  const selectedPermission = mappedPermission(permission);
  if (
    selectedPermission &&
    !permissions.includes('*') &&
    !permissions.includes(selectedPermission) &&
    !permissions.includes(permission)
  ) {
    throw forbidden(
      'INSUFFICIENT_API_KEY_PERMISSION',
      'کلید API مجوز انجام این عملیات را ندارد.',
    );
  }
  context.db.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(now, row.id);
  return {
    userId: row.user_id,
    user: row.user_id ? context.identityStore.userById(row.user_id) : null,
    session: null,
    csrfToken: null,
    organizationId: row.organization_id,
    permissions,
    organizationRole: currentAuthorization.organizationRole || null,
    projectRole: currentAuthorization.projectRole || null,
    legacy: false,
    apiKey: { id: row.id, name: row.name, prefix: row.token_prefix },
    actorType: 'api_key',
    authorization: currentAuthorization,
  };
}

/**
 * Shared authorization contract used by every enterprise feature module.
 * Mutations always validate the identity CSRF token; out-of-scope projects stay
 * concealed as 404 by identity-routes.
 */
export function authorizeWorkspace(
  context,
  {
    projectId,
    organizationId,
    permission,
    mutation = false,
  } = {},
) {
  const apiKeyAuth = apiKeyAuthorization(context, {
    projectId,
    organizationId,
    permission,
  });
  if (apiKeyAuth) {
    context.setAuditActor?.(apiKeyAuth);
    return apiKeyAuth;
  }
  const selectedPermission = mappedPermission(permission);
  let auth;
  if (projectId) {
    auth = normalizedAuth(authorizeProject(
      context,
      projectId,
      selectedPermission || PERMISSIONS.PROJECT_READ,
      { csrf: mutation },
    ));
  } else if (organizationId) {
    auth = normalizedAuth(authorizeOrganization(
      context,
      organizationId,
      selectedPermission || PERMISSIONS.ORGANIZATION_READ,
      { csrf: mutation },
    ));
  } else {
    auth = normalizedAuth(readIdentitySession(context, { csrf: mutation }));
  }
  context.setAuditActor?.(auth);
  return auth;
}

function projectSegments(pathname) {
  if (pathname === PROJECT_PREFIX) return [];
  if (!pathname.startsWith(`${PROJECT_PREFIX}/`)) return null;
  return pathname
    .slice(PROJECT_PREFIX.length + 1)
    .split('/')
    .filter(Boolean)
    .map(decodeSegment);
}

function workspaceProjects(context, auth, organizationId) {
  const organizations = context.identityStore
    .organizationsForUser(auth.userId).organizations;
  const availableOrganizations = auth.apiKey
    ? organizations.filter(
        (organization) => organization.id === auth.organizationId,
      )
    : organizations;
  const selectedOrganization = availableOrganizations.find(
    (organization) => organization.id === organizationId,
  ) || availableOrganizations[0] || null;
  if (!selectedOrganization) return { selectedOrganization: null, projects: [] };
  const projectIds = context.identityStore.accessibleProjectIds(
    auth.userId,
    selectedOrganization.id,
  );
  if (!projectIds.length) {
    return { selectedOrganization, projects: [] };
  }
  const placeholders = projectIds.map(() => '?').join(',');
  const rows = context.db.prepare(`
    SELECT *
    FROM projects
    WHERE id IN (${placeholders})
    ORDER BY archived_at IS NOT NULL, updated_at DESC, title, id
  `).all(...projectIds);
  return {
    selectedOrganization,
    projects: rows.map((row) => context.platformStore.getProject(row.id, {
      includeArchived: true,
    }).project),
  };
}

function permissionForLegacyResource(parts, method) {
  const resource = parts[1] || '';
  const mutation = !['GET', 'HEAD'].includes(method);
  if (!resource || resource === 'dashboard') return mutation
    ? PERMISSIONS.PROJECT_MANAGE
    : PERMISSIONS.PROJECT_READ;
  if (resource === 'audit-events') return PERMISSIONS.AUDIT_READ;
  if (resource === 'proposals') {
    return mutation ? PERMISSIONS.PROPOSALS_MANAGE : PERMISSIONS.PROPOSALS_READ;
  }
  if (resource === 'needs' || resource === 'goals') {
    return mutation ? PERMISSIONS.PROJECT_WORK_WRITE : PERMISSIONS.PROJECT_READ;
  }
  if (resource === 'stakeholders') {
    return mutation
      ? PERMISSIONS.STAKEHOLDERS_MANAGE
      : PERMISSIONS.STAKEHOLDERS_READ;
  }
  if (
    ['share-classes', 'share-offers', 'share-transfers', 'cap-table'].includes(resource)
  ) {
    return mutation ? PERMISSIONS.CAPITAL_MANAGE : PERMISSIONS.CAPITAL_READ;
  }
  if (resource === 'financial-entries') {
    return mutation ? PERMISSIONS.FINANCE_MANAGE : PERMISSIONS.FINANCE_READ;
  }
  if (resource === 'meetings') {
    return mutation ? PERMISSIONS.GOVERNANCE_MANAGE : PERMISSIONS.GOVERNANCE_READ;
  }
  return mutation ? PERMISSIONS.PROJECT_MANAGE : PERMISSIONS.PROJECT_READ;
}

function platformReadSession(context, parts, { csrf = false } = {}) {
  const projectId = parts[0];
  const auth = authorizeWorkspace(context, {
    projectId,
    permission: permissionForLegacyResource(parts, context.request.method),
    mutation: csrf,
  });
  return {
    rawToken: auth.rawToken || null,
    csrfToken: auth.csrfToken,
    session: {
      ...(auth.session || {}),
      id: auth.apiKey
        ? {
          actorType: 'api_key',
          actorId: auth.apiKey.id,
          actorUserId: auth.userId,
        }
        : auth.userId,
    },
    // Do not let compatibility consumers mistake a bearer credential for an
    // interactive user session. The creator remains available for attribution.
    user: auth.apiKey ? null : auth.user,
    actorUser: auth.user,
    apiKey: auth.apiKey || null,
    actorType: auth.apiKey ? 'api_key' : 'user',
    authorization: auth.authorization || null,
    permissions: auth.permissions || [],
  };
}

async function routeProjectCompatibility(context) {
  const parts = projectSegments(context.url.pathname);
  if (parts === null || parts.length < 2) return false;
  const originalUrl = context.url;
  const compatibilityUrl = new URL(originalUrl);
  compatibilityUrl.pathname = `/api/v1/admin/projects/${parts
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
  context.url = compatibilityUrl;
  try {
    return await routePlatformAdminApi(
      context,
      (selectedContext, options) => platformReadSession(
        selectedContext,
        parts,
        options,
      ),
    );
  } finally {
    context.url = originalUrl;
  }
}

export async function routeWorkspaceApi(context) {
  const { request, response, url } = context;

  if (url.pathname === '/api/v2/admin/workspace' && request.method === 'GET') {
    const auth = authorizeWorkspace(context, { permission: 'session.read' });
    const organizations = context.identityStore
      .organizationsForUser(auth.userId).organizations;
    const requestedOrganizationId = url.searchParams.get('organizationId') || '';
    const { selectedOrganization, projects } = workspaceProjects(
      context,
      auth,
      requestedOrganizationId,
    );
    const selectedProjectId = url.searchParams.get('projectId') || '';
    const selectedProject = projects.find((project) => project.id === selectedProjectId) ||
      projects.find((project) => !project.archivedAt) ||
      projects[0] ||
      null;
    let dashboard = null;
    let selectedProjectAuthorization = null;
    if (selectedProject && !selectedProject.archivedAt) {
      const projectAuth = authorizeProject(
        context,
        selectedProject.id,
        PERMISSIONS.PROJECT_READ,
      );
      selectedProjectAuthorization = {
        organizationRole: projectAuth.authorization.organizationRole,
        projectRole: projectAuth.authorization.projectRole,
        permissions: projectAuth.authorization.serializedPermissions,
        serializedPermissions: projectAuth.authorization.serializedPermissions,
      };
      dashboard = context.platformStore.dashboard(selectedProject.id);
    }
    sendJson(response, 200, {
      authenticated: true,
      csrfToken: auth.csrfToken,
      user: auth.user,
      organizations,
      selectedOrganizationId: selectedOrganization?.id || null,
      projects,
      selectedProjectId: selectedProject?.id || null,
      selectedProjectAuthorization,
      dashboard,
    });
    return true;
  }

  const parts = projectSegments(url.pathname);
  if (parts === null) return false;
  if (parts.length === 0 && request.method === 'GET') {
    const auth = authorizeWorkspace(context, { permission: 'session.read' });
    const organizationId = url.searchParams.get('organizationId') || '';
    const result = workspaceProjects(context, auth, organizationId);
    sendJson(response, 200, {
      organization: result.selectedOrganization,
      projects: result.projects,
    });
    return true;
  }
  if (parts.length === 0 && request.method === 'POST') {
    assertMutationOrigin(request, context.config);
    const input = await context.readJson();
    const organizationId = String(input.organizationId || '');
    if (!organizationId) {
      throw badRequest(
        'ORGANIZATION_REQUIRED',
        'برای ساخت پروژه، سازمان را انتخاب کنید.',
      );
    }
    const auth = authorizeWorkspace(context, {
      organizationId,
      permission: PERMISSIONS.PROJECTS_CREATE,
      mutation: true,
    });
    const result = context.platformStore.createProject({
      ...input,
      organizationId: auth.organizationId,
      ownerUserId: input.ownerUserId || auth.userId,
    });
    sendJson(response, 201, result);
    return true;
  }
  if (parts.length === 1 && request.method === 'GET') {
    authorizeWorkspace(context, {
      projectId: parts[0],
      permission: PERMISSIONS.PROJECT_READ,
    });
    sendJson(response, 200, context.platformStore.getProject(parts[0], {
      includeArchived: true,
    }));
    return true;
  }
  if (parts.length === 1 && request.method === 'PATCH') {
    assertMutationOrigin(request, context.config);
    authorizeWorkspace(context, {
      projectId: parts[0],
      permission: PERMISSIONS.PROJECT_MANAGE,
      mutation: true,
    });
    sendJson(
      response,
      200,
      context.platformStore.updateProject(parts[0], await context.readJson()),
    );
    return true;
  }
  if (parts.length === 1 && request.method === 'DELETE') {
    assertMutationOrigin(request, context.config);
    authorizeWorkspace(context, {
      projectId: parts[0],
      permission: PERMISSIONS.PROJECT_ARCHIVE,
      mutation: true,
    });
    sendJson(response, 200, context.platformStore.archiveProject(parts[0]));
    return true;
  }
  return routeProjectCompatibility(context);
}
