import {
  assertMutationOrigin,
  decodeSegment,
  sendBuffer,
  sendJson,
} from './http.js';
import { forbidden } from './errors.js';

function segments(pathname, prefix) {
  if (pathname === prefix) return [];
  if (!pathname.startsWith(`${prefix}/`)) return null;
  return pathname
    .slice(prefix.length + 1)
    .split('/')
    .filter(Boolean)
    .map(decodeSegment);
}

async function mutation(context, authorize, scope, permission) {
  assertMutationOrigin(context.request, context.config);
  const auth = await authorize(context, {
    ...scope,
    permission,
    mutation: true,
  });
  return { auth, input: await context.readJson() };
}

async function routeProjectHub(context, authorize) {
  const parts = segments(context.url.pathname, '/api/v2/admin/projects');
  if (parts === null) return false;
  const [projectId, resource, resourceId, action] = parts;
  if (!projectId || !resource) return false;
  const { request, response, hubStore } = context;

  if (resource === 'comments' && parts.length === 2 && request.method === 'GET') {
    const auth = await authorize(context, {
      projectId,
      permission: 'comments.read',
      mutation: false,
    });
    sendJson(response, 200, hubStore.comments(
      projectId,
      context.url.searchParams.get('resourceType') || '',
      context.url.searchParams.get('resourceId') || '',
      auth,
    ));
    return true;
  }
  if (resource === 'comments' && parts.length === 2 && request.method === 'POST') {
    const { auth, input } = await mutation(
      context,
      authorize,
      { projectId },
      'comments.create',
    );
    sendJson(
      response,
      201,
      hubStore.addComment(projectId, auth.organizationId, input, auth),
    );
    return true;
  }
  if (resource === 'comments' && resourceId && request.method === 'DELETE') {
    assertMutationOrigin(request, context.config);
    const auth = await authorize(context, {
      projectId,
      permission: 'comments.create',
      mutation: true,
    });
    sendJson(response, 200, hubStore.deleteComment(projectId, resourceId, auth));
    return true;
  }

  if (
    resource === 'marketplace-listings' &&
    parts.length === 2 &&
    request.method === 'GET'
  ) {
    await authorize(context, {
      projectId,
      permission: 'marketplace.read',
      mutation: false,
    });
    sendJson(response, 200, hubStore.listingList(projectId));
    return true;
  }
  if (
    resource === 'marketplace-listings' &&
    parts.length === 2 &&
    request.method === 'POST'
  ) {
    const { auth, input } = await mutation(
      context,
      authorize,
      { projectId },
      'marketplace.manage',
    );
    sendJson(
      response,
      201,
      hubStore.upsertListing(projectId, auth.organizationId, input, auth),
    );
    return true;
  }
  if (
    resource === 'marketplace-listings' &&
    resourceId &&
    parts.length === 3 &&
    request.method === 'PATCH'
  ) {
    const { auth, input } = await mutation(
      context,
      authorize,
      { projectId },
      'marketplace.manage',
    );
    sendJson(
      response,
      200,
      hubStore.upsertListing(projectId, auth.organizationId, input, auth, resourceId),
    );
    return true;
  }

  if (
    resource === 'reports' &&
    resourceId &&
    parts.length === 3 &&
    request.method === 'POST'
  ) {
    const { auth, input } = await mutation(
      context,
      authorize,
      { projectId },
      'reports.read',
    );
    const result = hubStore.generateReport(
      projectId,
      auth.organizationId,
      resourceId,
      input.format || 'json',
      auth,
    );
    sendBuffer(response, 200, result.content, {
      contentType: result.contentType,
      filename: result.filename,
      headers: {
        'X-Report-Run-Id': result.runId,
        'X-Generated-At': result.generatedAt,
      },
    });
    return true;
  }
  return false;
}

async function routeOrganizationHub(context, authorize) {
  const parts = segments(context.url.pathname, '/api/v2/admin/organizations');
  if (parts === null) return false;
  const [organizationId, resource, resourceId] = parts;
  if (!organizationId || !resource) return false;
  const { request, response, hubStore, auditService } = context;

  if (resource === 'overview' && parts.length === 2 && request.method === 'GET') {
    await authorize(context, {
      organizationId,
      permission: 'organization.read',
      mutation: false,
    });
    sendJson(response, 200, hubStore.organizationOverview(organizationId));
    return true;
  }
  if (resource === 'integrations' && parts.length === 2 && request.method === 'GET') {
    await authorize(context, {
      organizationId,
      permission: 'integrations.read',
      mutation: false,
    });
    sendJson(response, 200, hubStore.integrationConnections(organizationId));
    return true;
  }
  if (
    resource === 'notification-outbox' &&
    parts.length === 2 &&
    request.method === 'GET'
  ) {
    await authorize(context, {
      organizationId,
      permission: 'organization.manage',
      mutation: false,
    });
    sendJson(response, 200, hubStore.notificationOutbox(organizationId, {
      status: context.url.searchParams.get('status') || undefined,
      limit: context.url.searchParams.get('limit') || 100,
    }));
    return true;
  }
  if (
    resource === 'notification-outbox' &&
    resourceId &&
    parts.length === 3 &&
    request.method === 'PATCH'
  ) {
    const { auth, input } = await mutation(
      context,
      authorize,
      { organizationId },
      'organization.manage',
    );
    sendJson(
      response,
      200,
      hubStore.updateNotificationOutbox(
        organizationId,
        resourceId,
        input,
        auth,
      ),
    );
    return true;
  }
  if (resource === 'api-keys' && parts.length === 2 && request.method === 'GET') {
    const auth = await authorize(context, {
      organizationId,
      permission: 'organization.manage',
      mutation: false,
    });
    sendJson(response, 200, hubStore.apiKeys(organizationId, auth));
    return true;
  }
  if (resource === 'api-keys' && parts.length === 2 && request.method === 'POST') {
    const { auth, input } = await mutation(
      context,
      authorize,
      { organizationId },
      'organization.manage',
    );
    sendJson(response, 201, hubStore.createApiKey(organizationId, input, auth));
    return true;
  }
  if (
    resource === 'api-keys' &&
    resourceId &&
    parts.length === 3 &&
    request.method === 'DELETE'
  ) {
    assertMutationOrigin(request, context.config);
    const auth = await authorize(context, {
      organizationId,
      permission: 'organization.manage',
      mutation: true,
    });
    sendJson(response, 200, hubStore.revokeApiKey(organizationId, resourceId, auth));
    return true;
  }
  if (resource === 'public-profile' && parts.length === 2 && request.method === 'GET') {
    await authorize(context, {
      organizationId,
      permission: 'organization.read',
      mutation: false,
    });
    sendJson(response, 200, hubStore.publicProfile(organizationId));
    return true;
  }
  if (resource === 'public-profile' && parts.length === 2 && request.method === 'PATCH') {
    const { auth, input } = await mutation(
      context,
      authorize,
      { organizationId },
      'organization.manage',
    );
    sendJson(
      response,
      200,
      hubStore.updatePublicProfile(organizationId, input, auth),
    );
    return true;
  }
  if (resource === 'integrations' && parts.length === 2 && request.method === 'POST') {
    const { auth, input } = await mutation(
      context,
      authorize,
      { organizationId },
      'integrations.manage',
    );
    sendJson(
      response,
      200,
      hubStore.upsertIntegration(organizationId, input, auth),
    );
    return true;
  }
  if (resource === 'audit-events' && parts.length === 2 && request.method === 'GET') {
    await authorize(context, {
      organizationId,
      permission: 'audit.read',
      mutation: false,
    });
    sendJson(response, 200, auditService.list({
      organizationId,
      projectId: context.url.searchParams.get('projectId') || undefined,
      limit: context.url.searchParams.get('limit') || 100,
    }));
    return true;
  }
  if (
    resource === 'audit-events' &&
    resourceId === 'verify' &&
    request.method === 'GET'
  ) {
    await authorize(context, {
      organizationId,
      permission: 'audit.read',
      mutation: false,
    });
    sendJson(response, 200, auditService.verify());
    return true;
  }
  return false;
}

async function routeMeHub(context, authorize) {
  const parts = segments(context.url.pathname, '/api/v2/admin/me');
  if (parts === null) return false;
  if (/^Bearer\s+hmk_/i.test(String(context.request.headers.authorization || ''))) {
    throw forbidden(
      'INTERACTIVE_SESSION_REQUIRED',
      'مسیرهای حساب شخصی فقط با نشست تعاملی کاربر قابل استفاده هستند.',
    );
  }
  const [resource, resourceId] = parts;
  const { request, response, hubStore } = context;
  if (resource === 'notifications' && parts.length === 1 && request.method === 'GET') {
    const auth = await authorize(context, {
      permission: 'session.read',
      mutation: false,
    });
    sendJson(response, 200, hubStore.notifications(auth.userId, {
      unreadOnly: context.url.searchParams.get('unread') === 'true',
      limit: context.url.searchParams.get('limit') || 100,
    }));
    return true;
  }
  if (resource === 'notifications' && parts.length === 1 && request.method === 'PATCH') {
    const { auth, input } = await mutation(
      context,
      authorize,
      {},
      'session.read',
    );
    sendJson(response, 200, hubStore.markNotifications(auth.userId, input));
    return true;
  }
  if (
    resource === 'notification-preferences' &&
    parts.length === 1 &&
    request.method === 'PUT'
  ) {
    const { auth, input } = await mutation(
      context,
      authorize,
      {},
      'session.read',
    );
    sendJson(
      response,
      200,
      hubStore.setNotificationPreferences(auth.userId, input),
    );
    return true;
  }
  if (resource === 'saved-listings' && parts.length === 1 && request.method === 'GET') {
    const auth = await authorize(context, {
      permission: 'session.read',
      mutation: false,
    });
    sendJson(response, 200, hubStore.savedListings(auth.userId));
    return true;
  }
  if (
    resource === 'saved-listings' &&
    resourceId &&
    parts.length === 2 &&
    request.method === 'PUT'
  ) {
    const { auth, input } = await mutation(
      context,
      authorize,
      {},
      'session.read',
    );
    sendJson(
      response,
      200,
      hubStore.saveListing(auth.userId, resourceId, input.saved !== false),
    );
    return true;
  }
  return false;
}

function routePublicMarketplace(context) {
  const parts = segments(context.url.pathname, '/api/v2/marketplace');
  if (parts === null) return false;
  const { request, response, hubStore } = context;
  const [resource, resourceId] = parts;
  if (resource === 'listings' && !resourceId && request.method === 'GET') {
    sendJson(response, 200, hubStore.publicListings({
      type: context.url.searchParams.get('type') || undefined,
      currency: context.url.searchParams.get('currency') || undefined,
      q: context.url.searchParams.get('q') || undefined,
      cursor: context.url.searchParams.get('cursor') || undefined,
      limit: context.url.searchParams.get('limit') || undefined,
    }));
    return true;
  }
  if (resource === 'listings' && resourceId && request.method === 'GET') {
    sendJson(response, 200, hubStore.publicListing(resourceId));
    return true;
  }
  if (resource === 'facets' && request.method === 'GET') {
    sendJson(response, 200, hubStore.marketplaceFacets());
    return true;
  }
  return false;
}

export async function routeEnterpriseHubApi(context, authorize) {
  if (routePublicMarketplace(context)) return true;
  if (await routeMeHub(context, authorize)) return true;
  if (await routeOrganizationHub(context, authorize)) return true;
  return routeProjectHub(context, authorize);
}
