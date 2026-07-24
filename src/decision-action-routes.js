import { assertMutationOrigin, decodeSegment, sendJson } from './http.js';

const PREFIX = '/api/v2/admin/projects';
const READ_PERMISSION = 'governance.read';
const MANAGE_PERMISSION = 'governance.manage';

function segments(pathname) {
  if (!pathname.startsWith(`${PREFIX}/`)) return null;
  return pathname
    .slice(PREFIX.length + 1)
    .split('/')
    .filter(Boolean)
    .map(decodeSegment);
}

async function readAccess(context, authorize, projectId) {
  return authorize(context, {
    projectId,
    permission: READ_PERMISSION,
    mutation: false,
  });
}

async function mutationAccess(context, authorize, projectId, { body = true } = {}) {
  assertMutationOrigin(context.request, context.config);
  const actor = await authorize(context, {
    projectId,
    permission: MANAGE_PERMISSION,
    mutation: true,
  });
  return {
    actor,
    input: body ? await context.readJson() : {},
  };
}

function listFilters(url) {
  return {
    status: url.searchParams.get('status') ?? undefined,
    priority: url.searchParams.get('priority') ?? undefined,
    assigneeUserId: url.searchParams.get('assigneeUserId') ?? undefined,
    meetingId: url.searchParams.get('meetingId') ?? undefined,
    resolutionId: url.searchParams.get('resolutionId') ?? undefined,
    dueFrom: url.searchParams.get('dueFrom') ?? undefined,
    dueTo: url.searchParams.get('dueTo') ?? undefined,
    overdue: url.searchParams.get('overdue') ?? undefined,
    q: url.searchParams.get('q') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  };
}

/**
 * Shared authorization contract:
 * authorize(context, { projectId, permission, mutation }) -> actor
 */
export async function routeDecisionActionApi(context, authorize) {
  const parts = segments(context.url.pathname);
  if (parts === null) return false;
  const [projectId, resource, actionId, nested] = parts;
  if (
    !projectId ||
    resource !== 'decision-actions' ||
    parts.length < 2 ||
    parts.length > 4
  ) {
    return false;
  }
  const store = context.decisionActionStore;
  if (!store) return false;
  const { request, response, url } = context;

  if (parts.length === 2 && request.method === 'GET') {
    await readAccess(context, authorize, projectId);
    sendJson(response, 200, store.list(projectId, listFilters(url)));
    return true;
  }
  if (parts.length === 2 && request.method === 'POST') {
    const { actor, input } = await mutationAccess(context, authorize, projectId);
    sendJson(response, 201, store.create(projectId, input, actor));
    return true;
  }
  if (parts.length === 3 && request.method === 'GET') {
    await readAccess(context, authorize, projectId);
    sendJson(response, 200, store.get(projectId, actionId));
    return true;
  }
  if (parts.length === 3 && request.method === 'PATCH') {
    const { actor, input } = await mutationAccess(context, authorize, projectId);
    sendJson(response, 200, store.patch(projectId, actionId, input, actor));
    return true;
  }
  if (
    parts.length === 4 &&
    nested === 'transitions' &&
    request.method === 'POST'
  ) {
    const { actor, input } = await mutationAccess(context, authorize, projectId);
    sendJson(response, 200, store.transition(projectId, actionId, input, actor));
    return true;
  }
  if (
    parts.length === 4 &&
    nested === 'history' &&
    request.method === 'GET'
  ) {
    await readAccess(context, authorize, projectId);
    sendJson(response, 200, store.history(projectId, actionId, {
      limit: url.searchParams.get('limit') ?? undefined,
      offset: url.searchParams.get('offset') ?? undefined,
    }));
    return true;
  }
  return false;
}
