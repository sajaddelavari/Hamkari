import { assertMutationOrigin, decodeSegment, sendJson } from './http.js';
import { badRequest } from './errors.js';
import {
  validateNeed,
  validateNeedOrder,
  validateIdempotencyKey,
  validateProposalPatch,
} from './validation.js';

const ADMIN_PREFIX = '/api/v1/admin/projects';

function segmentsAfterPrefix(pathname) {
  if (pathname === ADMIN_PREFIX) return [];
  if (!pathname.startsWith(`${ADMIN_PREFIX}/`)) return null;
  return pathname
    .slice(ADMIN_PREFIX.length + 1)
    .split('/')
    .filter(Boolean)
    .map(decodeSegment);
}

function authorizeRead(context, readSession) {
  readSession(context);
}

async function authorizeMutation(context, readSession, { body = true } = {}) {
  assertMutationOrigin(context.request, context.config);
  const authorization = readSession(context, { csrf: true });
  const bearerApiKey = /^Bearer\s+hmk_/i.test(
    String(context.request.headers.authorization || ''),
  );
  context.platformAuthorization = bearerApiKey
    ? {
      ...authorization,
      apiKey: authorization?.apiKey || { compatibilityBearer: true },
      actorType: 'api_key',
    }
    : authorization;
  return body ? context.readJson() : null;
}

function publishToSlug(context, slug, projectId, reason, details = {}) {
  context.broker.publish(slug, null, {
    slug,
    projectId,
    reason,
    updatedAt: context.now().toISOString(),
    ...details,
  });
}

function publish(context, projectId, reason, details = {}) {
  const project = context.platformStore.getProject(projectId, {
    includeArchived: true,
  }).project;
  publishToSlug(context, project.slug, projectId, reason, details);
}

export async function routePlatformAdminApi(context, readSession) {
  const { request, response, url, platformStore } = context;
  const parts = segmentsAfterPrefix(url.pathname);
  if (parts === null) return false;

  if (parts.length === 0 && request.method === 'GET') {
    authorizeRead(context, readSession);
    const includeArchived = url.searchParams.get('includeArchived') === 'true';
    sendJson(response, 200, platformStore.portfolio(false, {
      includeArchived,
      limit: url.searchParams.get('limit') || 100,
    }));
    return true;
  }
  if (parts.length === 0 && request.method === 'POST') {
    const input = await authorizeMutation(context, readSession);
    const result = platformStore.createProject(input);
    publish(context, result.project.id, 'project-created');
    sendJson(response, 201, result);
    return true;
  }

  const [projectId, resource, resourceId, nested, nestedId, action] = parts;
  if (!projectId) return false;

  if (parts.length === 1 && request.method === 'GET') {
    authorizeRead(context, readSession);
    sendJson(response, 200, platformStore.getProject(projectId, {
      includeArchived: true,
    }));
    return true;
  }
  if (parts.length === 1 && request.method === 'PATCH') {
    const input = await authorizeMutation(context, readSession);
    const previous = platformStore.getProject(projectId, {
      includeArchived: true,
    }).project;
    const result = platformStore.updateProject(projectId, input);
    if (previous.slug !== result.project.slug) {
      publishToSlug(
        context,
        previous.slug,
        projectId,
        'project-renamed',
        { movedTo: result.project.slug },
      );
    }
    if (
      previous.status === 'published' &&
      result.project.status !== 'published'
    ) {
      publish(context, projectId, 'project-unpublished', { unavailable: true });
    } else {
      publish(context, projectId, 'project-updated');
    }
    sendJson(response, 200, result);
    return true;
  }
  if (parts.length === 1 && request.method === 'DELETE') {
    await authorizeMutation(context, readSession, { body: false });
    const result = platformStore.archiveProject(projectId);
    publish(context, projectId, 'project-archived', { unavailable: true });
    sendJson(response, 200, result);
    return true;
  }

  if (parts.length === 2 && resource === 'dashboard' && request.method === 'GET') {
    authorizeRead(context, readSession);
    sendJson(response, 200, platformStore.dashboard(projectId));
    return true;
  }
  if (parts.length === 2 && resource === 'audit-events' && request.method === 'GET') {
    authorizeRead(context, readSession);
    sendJson(response, 200, platformStore.auditEvents(projectId, {
      limit: url.searchParams.get('limit') || 200,
    }));
    return true;
  }
  if (parts.length === 2 && resource === 'cap-table' && request.method === 'GET') {
    authorizeRead(context, readSession);
    sendJson(response, 200, platformStore.capTable(projectId));
    return true;
  }

  if (parts.length === 2 && resource === 'needs' && request.method === 'GET') {
    authorizeRead(context, readSession);
    sendJson(response, 200, {
      needs: context.store.adminProject(projectId).needs,
    });
    return true;
  }
  if (parts.length === 2 && resource === 'needs' && request.method === 'POST') {
    const input = validateNeed(await authorizeMutation(context, readSession));
    const result = context.store.createNeed(input, projectId);
    publish(context, projectId, 'need-created');
    sendJson(response, 201, result);
    return true;
  }
  if (
    resource === 'needs' &&
    resourceId === 'order' &&
    parts.length === 3 &&
    request.method === 'PUT'
  ) {
    const ids = validateNeedOrder(await authorizeMutation(context, readSession));
    const result = context.store.reorderNeeds(ids, projectId);
    publish(context, projectId, 'needs-reordered');
    sendJson(response, 200, result);
    return true;
  }
  if (
    resource === 'needs' &&
    resourceId &&
    parts.length === 3 &&
    request.method === 'PATCH'
  ) {
    const input = validateNeed(
      await authorizeMutation(context, readSession),
      { partial: true },
    );
    const result = context.store.updateNeed(resourceId, input, projectId);
    publish(context, projectId, 'need-updated');
    sendJson(response, 200, result);
    return true;
  }
  if (
    resource === 'needs' &&
    resourceId &&
    parts.length === 3 &&
    request.method === 'DELETE'
  ) {
    await authorizeMutation(context, readSession, { body: false });
    const result = context.store.archiveNeed(resourceId, projectId);
    publish(context, projectId, 'need-archived');
    sendJson(response, 200, result);
    return true;
  }

  if (parts.length === 2 && resource === 'proposals' && request.method === 'GET') {
    authorizeRead(context, readSession);
    const status = url.searchParams.get('status') || '';
    if (status && !context.store.proposalStatuses.includes(status)) {
      throw badRequest('INVALID_STATUS', 'فیلتر وضعیت معتبر نیست.');
    }
    const query = (url.searchParams.get('q') || '').trim();
    if (query.length > 100) {
      throw badRequest('INVALID_QUERY', 'عبارت جستجو بیش از حد طولانی است.');
    }
    const needId = (url.searchParams.get('needId') || '').trim();
    const limit = Number(url.searchParams.get('limit') || 200);
    const offset = Number(url.searchParams.get('offset') || 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw badRequest('INVALID_PAGINATION', 'limit باید بین ۱ تا ۲۰۰ باشد.');
    }
    if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
      throw badRequest('INVALID_PAGINATION', 'offset معتبر نیست.');
    }
    sendJson(response, 200, context.store.proposalList({
      projectId,
      status: status || null,
      query: query || null,
      needId: needId || null,
      limit,
      offset,
    }));
    return true;
  }
  if (
    resource === 'proposals' &&
    resourceId &&
    parts.length === 3 &&
    request.method === 'GET'
  ) {
    authorizeRead(context, readSession);
    sendJson(
      response,
      200,
      context.store.proposalDetail(resourceId, projectId),
    );
    return true;
  }
  if (
    resource === 'proposals' &&
    resourceId &&
    parts.length === 3 &&
    request.method === 'PATCH'
  ) {
    assertMutationOrigin(request, context.config);
    const auth = readSession(context, { csrf: true });
    const patch = validateProposalPatch(await context.readJson());
    const result = context.store.updateProposal(
      resourceId,
      patch,
      auth.session.id,
      projectId,
    );
    publish(context, projectId, 'proposal-updated');
    sendJson(response, 200, result);
    return true;
  }

  const collections = {
    stakeholders: {
      list: () => platformStore.stakeholders(projectId),
      create: (input) => platformStore.createStakeholder(projectId, input),
      patch: (id, input) => platformStore.patchStakeholder(projectId, id, input),
      createdKey: 'stakeholder',
    },
    'share-classes': {
      list: () => platformStore.shareClasses(projectId),
      create: (input) => platformStore.createShareClass(projectId, input),
      patch: (id, input) => platformStore.patchShareClass(projectId, id, input),
      createdKey: 'share-class',
    },
    'share-offers': {
      list: () => platformStore.shareOffers(projectId),
      create: (input, idempotencyKey) =>
        platformStore.createShareOffer(projectId, input, idempotencyKey),
      patch: (id, input) => platformStore.patchShareOffer(projectId, id, input),
      createdKey: 'share-offer',
      idempotent: true,
    },
    'share-transfers': {
      list: () => platformStore.shareTransfers(projectId),
      create: (input, idempotencyKey) =>
        platformStore.createShareTransfer(
          projectId,
          input,
          idempotencyKey,
          context.platformAuthorization,
        ),
      patch: (id, input) => platformStore.patchShareTransfer(
        projectId,
        id,
        input,
        context.platformAuthorization,
      ),
      createdKey: 'share-transfer',
      idempotent: true,
    },
    'financial-entries': {
      list: () => platformStore.financialEntries(projectId),
      create: (input, idempotencyKey) =>
        platformStore.createFinancialEntry(projectId, input, idempotencyKey),
      createdKey: 'financial-entry',
      idempotent: true,
    },
    goals: {
      list: () => platformStore.goals(projectId),
      create: (input) => platformStore.createGoal(projectId, input),
      patch: (id, input) => platformStore.patchGoal(projectId, id, input),
      createdKey: 'goal',
    },
    meetings: {
      list: () => platformStore.meetings(projectId),
      create: (input) => platformStore.createMeeting(projectId, input),
      patch: (id, input) => platformStore.patchMeeting(projectId, id, input),
      createdKey: 'meeting',
    },
  };
  const selected = collections[resource];

  if (selected && parts.length === 2 && request.method === 'GET') {
    authorizeRead(context, readSession);
    sendJson(response, 200, selected.list());
    return true;
  }
  if (selected && parts.length === 2 && request.method === 'POST') {
    const input = await authorizeMutation(context, readSession);
    const idempotencyKey = selected.idempotent
      ? validateIdempotencyKey(request.headers['idempotency-key'])
      : null;
    const result = selected.create(input, idempotencyKey);
    if (!result.idempotentReplay) {
      publish(context, projectId, `${selected.createdKey}-created`);
    }
    sendJson(response, result.idempotentReplay ? 200 : 201, result);
    return true;
  }
  if (selected?.patch && parts.length === 3 && request.method === 'PATCH') {
    const input = await authorizeMutation(context, readSession);
    const result = selected.patch(resourceId, input);
    publish(context, projectId, `${selected.createdKey}-updated`);
    sendJson(response, 200, result);
    return true;
  }

  if (
    resource === 'share-classes' &&
    resourceId &&
    nested === 'issuances' &&
    parts.length === 4 &&
    request.method === 'POST'
  ) {
    const input = await authorizeMutation(context, readSession);
    const idempotencyKey = validateIdempotencyKey(
      request.headers['idempotency-key'],
    );
    const result = platformStore.issueShares(projectId, {
      ...input,
      shareClassId: resourceId,
    }, idempotencyKey);
    if (!result.idempotentReplay) publish(context, projectId, 'shares-issued');
    sendJson(response, result.idempotentReplay ? 200 : 201, result);
    return true;
  }

  if (
    resource === 'financial-entries' &&
    resourceId &&
    nested === 'reversal' &&
    parts.length === 4 &&
    request.method === 'POST'
  ) {
    const input = await authorizeMutation(context, readSession);
    const result = platformStore.reverseFinancialEntry(projectId, resourceId, input);
    publish(context, projectId, 'financial-entry-reversed');
    sendJson(response, 201, result);
    return true;
  }

  if (
    resource === 'goals' &&
    resourceId &&
    nested === 'milestones' &&
    parts.length === 4 &&
    request.method === 'POST'
  ) {
    const input = await authorizeMutation(context, readSession);
    const result = platformStore.createMilestone(projectId, resourceId, input);
    publish(context, projectId, 'goal-milestone-created');
    sendJson(response, 201, result);
    return true;
  }
  if (
    resource === 'goals' &&
    resourceId &&
    nested === 'milestones' &&
    nestedId &&
    parts.length === 5 &&
    request.method === 'PATCH'
  ) {
    const input = await authorizeMutation(context, readSession);
    const result = platformStore.patchMilestone(
      projectId,
      resourceId,
      nestedId,
      input,
    );
    publish(context, projectId, 'goal-milestone-updated');
    sendJson(response, 200, result);
    return true;
  }

  if (
    resource === 'meetings' &&
    resourceId &&
    nested === 'attendees' &&
    nestedId &&
    parts.length === 5 &&
    request.method === 'PUT'
  ) {
    const input = await authorizeMutation(context, readSession);
    const result = platformStore.setAttendance(
      projectId,
      resourceId,
      nestedId,
      input,
    );
    publish(context, projectId, 'meeting-attendance-updated');
    sendJson(response, 200, result);
    return true;
  }
  if (
    resource === 'meetings' &&
    resourceId &&
    nested === 'resolutions' &&
    parts.length === 4 &&
    request.method === 'POST'
  ) {
    const input = await authorizeMutation(context, readSession);
    const result = platformStore.createResolution(projectId, resourceId, input);
    publish(context, projectId, 'resolution-created');
    sendJson(response, 201, result);
    return true;
  }
  if (
    resource === 'meetings' &&
    resourceId &&
    nested === 'resolutions' &&
    nestedId &&
    parts.length === 5 &&
    request.method === 'PATCH'
  ) {
    const input = await authorizeMutation(context, readSession);
    const result = platformStore.patchResolution(
      projectId,
      resourceId,
      nestedId,
      input,
    );
    publish(context, projectId, 'resolution-updated');
    sendJson(response, 200, result);
    return true;
  }
  if (
    resource === 'meetings' &&
    resourceId &&
    nested === 'resolutions' &&
    nestedId &&
    action === 'votes' &&
    parts.length === 6 &&
    ['POST', 'PUT'].includes(request.method)
  ) {
    const input = await authorizeMutation(context, readSession);
    const result = platformStore.vote(
      projectId,
      resourceId,
      nestedId,
      input,
      context.platformAuthorization,
    );
    publish(context, projectId, 'resolution-vote-recorded');
    sendJson(response, 200, result);
    return true;
  }

  return false;
}
