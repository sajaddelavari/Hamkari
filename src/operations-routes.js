import { assertMutationOrigin, decodeSegment, sendJson } from './http.js';

const PREFIX = '/api/v2/admin/projects';
const READ_PERMISSION = 'operations.read';
const MANAGE_PERMISSION = 'operations.manage';
const BUDGET_PERMISSION = 'finance.manage';

function routeParts(pathname) {
  if (!pathname.startsWith(`${PREFIX}/`)) return null;
  return pathname
    .slice(PREFIX.length + 1)
    .split('/')
    .filter(Boolean)
    .map(decodeSegment);
}

function actor(auth, extra = {}) {
  return {
    actorUserId: auth?.userId || null,
    ...extra,
  };
}

async function authorizeRead(context, authorize, projectId) {
  return authorize(context, {
    projectId,
    permission: READ_PERMISSION,
    mutation: false,
  });
}

async function authorizeMutation(
  context,
  authorize,
  projectId,
  permission = MANAGE_PERMISSION,
  { body = true } = {},
) {
  assertMutationOrigin(context.request, context.config);
  const auth = await authorize(context, {
    projectId,
    permission,
    mutation: true,
  });
  return {
    auth,
    input: body ? await context.readJson() : null,
  };
}

function includeArchived(url) {
  return url.searchParams.get('includeArchived') === 'true';
}

export async function routeOperationsApi(context, authorize) {
  const selected = routeParts(context.url.pathname);
  if (!selected) return false;
  const [projectId, resource, resourceId, nested, nestedId] = selected;
  if (!projectId || !resource) return false;

  const { request, response, operationsStore: store } = context;
  if (!store) {
    throw new Error('Operations routes require context.operationsStore.');
  }

  if (
    request.method === 'GET' &&
    (
      (resource === 'operations' &&
        (selected.length === 2 || (selected.length === 3 && resourceId === 'dashboard'))) ||
      (resource === 'operations-dashboard' && selected.length === 2)
    )
  ) {
    await authorizeRead(context, authorize, projectId);
    sendJson(response, 200, store.dashboard(projectId));
    return true;
  }

  if (resource === 'phases') {
    if (selected.length === 2 && request.method === 'GET') {
      await authorizeRead(context, authorize, projectId);
      sendJson(response, 200, store.phases(projectId, {
        includeArchived: includeArchived(context.url),
      }));
      return true;
    }
    if (selected.length === 2 && request.method === 'POST') {
      const { auth, input } = await authorizeMutation(
        context,
        authorize,
        projectId,
      );
      sendJson(response, 201, store.createPhase(projectId, input, actor(auth)));
      return true;
    }
    if (selected.length === 3 && request.method === 'GET') {
      await authorizeRead(context, authorize, projectId);
      sendJson(response, 200, store.getPhase(projectId, resourceId));
      return true;
    }
    if (selected.length === 3 && request.method === 'PATCH') {
      const { auth, input } = await authorizeMutation(
        context,
        authorize,
        projectId,
      );
      sendJson(
        response,
        200,
        store.patchPhase(projectId, resourceId, input, actor(auth)),
      );
      return true;
    }
    if (selected.length === 3 && request.method === 'DELETE') {
      const { auth } = await authorizeMutation(
        context,
        authorize,
        projectId,
        MANAGE_PERMISSION,
        { body: false },
      );
      sendJson(
        response,
        200,
        store.archivePhase(projectId, resourceId, actor(auth)),
      );
      return true;
    }
    return false;
  }

  if (resource === 'tasks') {
    if (selected.length === 2 && request.method === 'GET') {
      await authorizeRead(context, authorize, projectId);
      sendJson(response, 200, store.tasks(projectId, {
        includeArchived: includeArchived(context.url),
      }));
      return true;
    }
    if (selected.length === 2 && request.method === 'POST') {
      const { auth, input } = await authorizeMutation(
        context,
        authorize,
        projectId,
      );
      sendJson(response, 201, store.createTask(projectId, input, actor(auth)));
      return true;
    }
    if (selected.length === 3 && request.method === 'GET') {
      await authorizeRead(context, authorize, projectId);
      sendJson(response, 200, store.getTask(projectId, resourceId));
      return true;
    }
    if (selected.length === 3 && request.method === 'PATCH') {
      const { auth, input } = await authorizeMutation(
        context,
        authorize,
        projectId,
      );
      sendJson(
        response,
        200,
        store.patchTask(projectId, resourceId, input, actor(auth)),
      );
      return true;
    }
    if (selected.length === 3 && request.method === 'DELETE') {
      const { auth } = await authorizeMutation(
        context,
        authorize,
        projectId,
        MANAGE_PERMISSION,
        { body: false },
      );
      sendJson(
        response,
        200,
        store.archiveTask(projectId, resourceId, actor(auth)),
      );
      return true;
    }
    if (
      selected.length === 4 &&
      nested === 'dependencies' &&
      request.method === 'GET'
    ) {
      await authorizeRead(context, authorize, projectId);
      sendJson(response, 200, {
        dependencies: store.getTask(projectId, resourceId).task.dependencies,
      });
      return true;
    }
    if (
      selected.length === 4 &&
      nested === 'dependencies' &&
      request.method === 'POST'
    ) {
      const { auth, input } = await authorizeMutation(
        context,
        authorize,
        projectId,
      );
      sendJson(
        response,
        201,
        store.addDependency(projectId, resourceId, input, actor(auth)),
      );
      return true;
    }
    if (
      selected.length === 5 &&
      nested === 'dependencies' &&
      request.method === 'DELETE'
    ) {
      const { auth } = await authorizeMutation(
        context,
        authorize,
        projectId,
        MANAGE_PERMISSION,
        { body: false },
      );
      sendJson(
        response,
        200,
        store.removeDependency(
          projectId,
          resourceId,
          nestedId,
          actor(auth),
        ),
      );
      return true;
    }
    if (
      selected.length === 4 &&
      nested === 'time-entries' &&
      request.method === 'GET'
    ) {
      await authorizeRead(context, authorize, projectId);
      sendJson(response, 200, store.timeEntries(projectId, {
        taskId: resourceId,
      }));
      return true;
    }
    if (
      selected.length === 4 &&
      nested === 'time-entries' &&
      request.method === 'POST'
    ) {
      const { auth, input } = await authorizeMutation(
        context,
        authorize,
        projectId,
      );
      sendJson(
        response,
        201,
        store.createTimeEntry(
          projectId,
          input,
          actor(auth, { taskId: resourceId }),
        ),
      );
      return true;
    }
    return false;
  }

  if (resource === 'time-entries') {
    if (selected.length === 2 && request.method === 'GET') {
      await authorizeRead(context, authorize, projectId);
      sendJson(response, 200, store.timeEntries(projectId, {
        taskId: context.url.searchParams.get('taskId') || null,
      }));
      return true;
    }
    if (selected.length === 2 && request.method === 'POST') {
      const { auth, input } = await authorizeMutation(
        context,
        authorize,
        projectId,
      );
      sendJson(
        response,
        201,
        store.createTimeEntry(projectId, input, actor(auth)),
      );
      return true;
    }
    if (selected.length === 3 && request.method === 'GET') {
      await authorizeRead(context, authorize, projectId);
      sendJson(response, 200, store.getTimeEntry(projectId, resourceId));
      return true;
    }
    if (selected.length === 3 && request.method === 'PATCH') {
      const { auth, input } = await authorizeMutation(
        context,
        authorize,
        projectId,
      );
      sendJson(
        response,
        200,
        store.patchTimeEntry(projectId, resourceId, input, actor(auth)),
      );
      return true;
    }
    if (selected.length === 3 && request.method === 'DELETE') {
      const { auth } = await authorizeMutation(
        context,
        authorize,
        projectId,
        MANAGE_PERMISSION,
        { body: false },
      );
      sendJson(
        response,
        200,
        store.deleteTimeEntry(projectId, resourceId, actor(auth)),
      );
      return true;
    }
    return false;
  }

  if (resource === 'resources') {
    if (selected.length === 2 && request.method === 'GET') {
      await authorizeRead(context, authorize, projectId);
      sendJson(response, 200, store.resources(projectId, {
        includeArchived: includeArchived(context.url),
      }));
      return true;
    }
    if (selected.length === 2 && request.method === 'POST') {
      const { auth, input } = await authorizeMutation(
        context,
        authorize,
        projectId,
      );
      sendJson(
        response,
        201,
        store.createResource(projectId, input, actor(auth)),
      );
      return true;
    }
    if (selected.length === 3 && request.method === 'GET') {
      await authorizeRead(context, authorize, projectId);
      sendJson(response, 200, store.getResource(projectId, resourceId));
      return true;
    }
    if (selected.length === 3 && request.method === 'PATCH') {
      const { auth, input } = await authorizeMutation(
        context,
        authorize,
        projectId,
      );
      sendJson(
        response,
        200,
        store.patchResource(projectId, resourceId, input, actor(auth)),
      );
      return true;
    }
    if (selected.length === 3 && request.method === 'DELETE') {
      const { auth } = await authorizeMutation(
        context,
        authorize,
        projectId,
        MANAGE_PERMISSION,
        { body: false },
      );
      sendJson(
        response,
        200,
        store.archiveResource(projectId, resourceId, actor(auth)),
      );
      return true;
    }
    return false;
  }

  if (resource === 'allocations') {
    if (selected.length === 2 && request.method === 'GET') {
      await authorizeRead(context, authorize, projectId);
      sendJson(response, 200, store.allocations(projectId, {
        resourceId: context.url.searchParams.get('resourceId') || null,
        taskId: context.url.searchParams.get('taskId') || null,
        phaseId: context.url.searchParams.get('phaseId') || null,
      }));
      return true;
    }
    if (selected.length === 2 && request.method === 'POST') {
      const { auth, input } = await authorizeMutation(
        context,
        authorize,
        projectId,
      );
      sendJson(
        response,
        201,
        store.createAllocation(projectId, input, actor(auth)),
      );
      return true;
    }
    if (selected.length === 3 && request.method === 'GET') {
      await authorizeRead(context, authorize, projectId);
      sendJson(response, 200, store.getAllocation(projectId, resourceId));
      return true;
    }
    if (selected.length === 3 && request.method === 'PATCH') {
      const { auth, input } = await authorizeMutation(
        context,
        authorize,
        projectId,
      );
      sendJson(
        response,
        200,
        store.patchAllocation(projectId, resourceId, input, actor(auth)),
      );
      return true;
    }
    if (selected.length === 3 && request.method === 'DELETE') {
      const { auth } = await authorizeMutation(
        context,
        authorize,
        projectId,
        MANAGE_PERMISSION,
        { body: false },
      );
      sendJson(
        response,
        200,
        store.deleteAllocation(projectId, resourceId, actor(auth)),
      );
      return true;
    }
    return false;
  }

  if (resource === 'risks' || resource === 'issues') {
    const forcedKind = resource === 'issues' ? 'issue' : null;
    if (selected.length === 2 && request.method === 'GET') {
      await authorizeRead(context, authorize, projectId);
      sendJson(response, 200, store.risks(projectId, {
        kind: forcedKind || context.url.searchParams.get('kind') || null,
      }));
      return true;
    }
    if (selected.length === 2 && request.method === 'POST') {
      const { auth, input } = await authorizeMutation(
        context,
        authorize,
        projectId,
      );
      sendJson(
        response,
        201,
        store.createRisk(
          projectId,
          input,
          actor(auth, { forcedKind }),
        ),
      );
      return true;
    }
    if (selected.length === 3 && request.method === 'GET') {
      await authorizeRead(context, authorize, projectId);
      sendJson(
        response,
        200,
        store.getRisk(projectId, resourceId, forcedKind),
      );
      return true;
    }
    if (selected.length === 3 && request.method === 'PATCH') {
      const { auth, input } = await authorizeMutation(
        context,
        authorize,
        projectId,
      );
      sendJson(
        response,
        200,
        store.patchRisk(
          projectId,
          resourceId,
          input,
          actor(auth, { forcedKind }),
        ),
      );
      return true;
    }
    if (selected.length === 3 && request.method === 'DELETE') {
      const { auth } = await authorizeMutation(
        context,
        authorize,
        projectId,
        MANAGE_PERMISSION,
        { body: false },
      );
      sendJson(
        response,
        200,
        store.deleteRisk(
          projectId,
          resourceId,
          actor(auth, { forcedKind }),
        ),
      );
      return true;
    }
    return false;
  }

  if (resource === 'kpis') {
    if (selected.length === 2 && request.method === 'GET') {
      await authorizeRead(context, authorize, projectId);
      sendJson(response, 200, store.kpis(projectId, {
        includeArchived: includeArchived(context.url),
      }));
      return true;
    }
    if (selected.length === 2 && request.method === 'POST') {
      const { auth, input } = await authorizeMutation(
        context,
        authorize,
        projectId,
      );
      sendJson(response, 201, store.createKpi(projectId, input, actor(auth)));
      return true;
    }
    if (selected.length === 3 && request.method === 'GET') {
      await authorizeRead(context, authorize, projectId);
      sendJson(response, 200, store.getKpi(projectId, resourceId));
      return true;
    }
    if (selected.length === 3 && request.method === 'PATCH') {
      const { auth, input } = await authorizeMutation(
        context,
        authorize,
        projectId,
      );
      sendJson(
        response,
        200,
        store.patchKpi(projectId, resourceId, input, actor(auth)),
      );
      return true;
    }
    if (selected.length === 3 && request.method === 'DELETE') {
      const { auth } = await authorizeMutation(
        context,
        authorize,
        projectId,
        MANAGE_PERMISSION,
        { body: false },
      );
      sendJson(
        response,
        200,
        store.archiveKpi(projectId, resourceId, actor(auth)),
      );
      return true;
    }
    if (
      selected.length === 4 &&
      nested === 'measurements' &&
      request.method === 'GET'
    ) {
      await authorizeRead(context, authorize, projectId);
      sendJson(response, 200, {
        measurements: store.getKpi(projectId, resourceId).kpi.measurements,
      });
      return true;
    }
    if (
      selected.length === 4 &&
      nested === 'measurements' &&
      request.method === 'POST'
    ) {
      const { auth, input } = await authorizeMutation(
        context,
        authorize,
        projectId,
      );
      sendJson(
        response,
        201,
        store.addKpiMeasurement(projectId, resourceId, input, actor(auth)),
      );
      return true;
    }
    return false;
  }

  if (resource === 'progress-updates') {
    if (selected.length === 2 && request.method === 'GET') {
      await authorizeRead(context, authorize, projectId);
      sendJson(response, 200, store.progressUpdates(projectId, {
        phaseId: context.url.searchParams.get('phaseId') || null,
        taskId: context.url.searchParams.get('taskId') || null,
      }));
      return true;
    }
    if (selected.length === 2 && request.method === 'POST') {
      const { auth, input } = await authorizeMutation(
        context,
        authorize,
        projectId,
      );
      sendJson(
        response,
        201,
        store.createProgressUpdate(projectId, input, actor(auth)),
      );
      return true;
    }
    return false;
  }

  if (resource === 'budgets') {
    if (selected.length === 2 && request.method === 'GET') {
      await authorizeRead(context, authorize, projectId);
      sendJson(response, 200, store.budgets(projectId));
      return true;
    }
    if (selected.length === 2 && request.method === 'POST') {
      const { auth, input } = await authorizeMutation(
        context,
        authorize,
        projectId,
        BUDGET_PERMISSION,
      );
      sendJson(response, 201, store.createBudget(projectId, input, actor(auth)));
      return true;
    }
    if (selected.length === 3 && request.method === 'GET') {
      await authorizeRead(context, authorize, projectId);
      sendJson(response, 200, store.getBudget(projectId, resourceId));
      return true;
    }
    if (selected.length === 3 && request.method === 'PATCH') {
      const { auth, input } = await authorizeMutation(
        context,
        authorize,
        projectId,
        BUDGET_PERMISSION,
      );
      sendJson(
        response,
        200,
        store.patchBudget(projectId, resourceId, input, actor(auth)),
      );
      return true;
    }
    if (selected.length === 3 && request.method === 'DELETE') {
      const { auth } = await authorizeMutation(
        context,
        authorize,
        projectId,
        BUDGET_PERMISSION,
        { body: false },
      );
      sendJson(
        response,
        200,
        store.cancelBudget(projectId, resourceId, actor(auth)),
      );
      return true;
    }
    if (
      selected.length === 4 &&
      nested === 'lines' &&
      request.method === 'GET'
    ) {
      await authorizeRead(context, authorize, projectId);
      sendJson(response, 200, {
        budgetLines: store.getBudget(projectId, resourceId).budget.budgetLines,
      });
      return true;
    }
    if (
      selected.length === 4 &&
      nested === 'lines' &&
      request.method === 'POST'
    ) {
      const { auth, input } = await authorizeMutation(
        context,
        authorize,
        projectId,
        BUDGET_PERMISSION,
      );
      sendJson(
        response,
        201,
        store.createBudgetLine(
          projectId,
          resourceId,
          input,
          actor(auth),
        ),
      );
      return true;
    }
    if (
      selected.length === 5 &&
      nested === 'lines' &&
      request.method === 'GET'
    ) {
      await authorizeRead(context, authorize, projectId);
      sendJson(
        response,
        200,
        store.getBudgetLine(projectId, resourceId, nestedId),
      );
      return true;
    }
    if (
      selected.length === 5 &&
      nested === 'lines' &&
      request.method === 'PATCH'
    ) {
      const { auth, input } = await authorizeMutation(
        context,
        authorize,
        projectId,
        BUDGET_PERMISSION,
      );
      sendJson(
        response,
        200,
        store.patchBudgetLine(
          projectId,
          resourceId,
          nestedId,
          input,
          actor(auth),
        ),
      );
      return true;
    }
    if (
      selected.length === 5 &&
      nested === 'lines' &&
      request.method === 'DELETE'
    ) {
      const { auth } = await authorizeMutation(
        context,
        authorize,
        projectId,
        BUDGET_PERMISSION,
        { body: false },
      );
      sendJson(
        response,
        200,
        store.deleteBudgetLine(
          projectId,
          resourceId,
          nestedId,
          actor(auth),
        ),
      );
      return true;
    }
    if (
      selected.length === 4 &&
      nested === 'approve' &&
      request.method === 'POST'
    ) {
      const { auth } = await authorizeMutation(
        context,
        authorize,
        projectId,
        BUDGET_PERMISSION,
        { body: false },
      );
      sendJson(
        response,
        200,
        store.approveBudget(projectId, resourceId, actor(auth)),
      );
      return true;
    }
    if (
      selected.length === 4 &&
      nested === 'revise' &&
      request.method === 'POST'
    ) {
      const { auth, input } = await authorizeMutation(
        context,
        authorize,
        projectId,
        BUDGET_PERMISSION,
      );
      sendJson(
        response,
        201,
        store.reviseBudget(projectId, resourceId, input, actor(auth)),
      );
      return true;
    }
    return false;
  }

  return false;
}
