import { forbidden } from './errors.js';
import { assertMutationOrigin, decodeSegment, sendJson } from './http.js';

const ORGANIZATION_PREFIX = '/api/v2/admin/organizations';
const PROJECT_PREFIX = '/api/v2/admin/projects';

function segments(pathname, prefix) {
  if (!pathname.startsWith(`${prefix}/`)) return null;
  return pathname.slice(prefix.length + 1).split('/').filter(Boolean).map(decodeSegment);
}

function actor(auth) {
  return {
    userId: auth?.userId || null,
    apiKey: auth?.apiKey || null,
  };
}

async function mutation(context, authorize, scope, { body = true } = {}) {
  assertMutationOrigin(context.request, context.config);
  const auth = await authorize(context, { ...scope, mutation: true });
  return { auth, input: body ? await context.readJson() : {} };
}

function requireInteractive(auth) {
  if (auth?.apiKey) {
    throw forbidden(
      'INTERACTIVE_APPROVAL_REQUIRED',
      'فعال‌سازی یا توقف بهره‌برداری باید توسط مدیر واردشده در پنل انجام شود.',
    );
  }
}

export async function routeReadinessApi(context, authorize) {
  const organizationParts = segments(context.url.pathname, ORGANIZATION_PREFIX);
  const projectParts = segments(context.url.pathname, PROJECT_PREFIX);
  const { request, response, readinessStore: store } = context;
  if (!store) throw new Error('Readiness routes require context.readinessStore.');

  if (organizationParts) {
    const [organizationId, resource, templateId, nested, stepId] = organizationParts;
    if (resource !== 'readiness-templates') return false;
    if (organizationParts.length === 2 && request.method === 'GET') {
      await authorize(context, {
        organizationId,
        permission: 'organization.read',
        mutation: false,
      });
      sendJson(response, 200, store.listTemplates(organizationId, {
        includeArchived: context.url.searchParams.get('includeArchived') === 'true',
      }));
      return true;
    }
    if (organizationParts.length === 2 && request.method === 'POST') {
      const { auth, input } = await mutation(context, authorize, {
        organizationId,
        permission: 'organization.manage',
      });
      sendJson(response, 201, store.createTemplate(organizationId, input, actor(auth)));
      return true;
    }
    if (organizationParts.length === 3 && request.method === 'GET') {
      await authorize(context, {
        organizationId,
        permission: 'organization.read',
        mutation: false,
      });
      sendJson(response, 200, store.getTemplate(organizationId, templateId));
      return true;
    }
    if (organizationParts.length === 3 && request.method === 'PATCH') {
      const { auth, input } = await mutation(context, authorize, {
        organizationId,
        permission: 'organization.manage',
      });
      sendJson(response, 200, store.patchTemplate(organizationId, templateId, input, actor(auth)));
      return true;
    }
    if (organizationParts.length === 3 && request.method === 'DELETE') {
      const { auth } = await mutation(context, authorize, {
        organizationId,
        permission: 'organization.manage',
      }, { body: false });
      sendJson(response, 200, store.archiveTemplate(organizationId, templateId, actor(auth)));
      return true;
    }
    if (organizationParts.length === 4 && nested === 'steps' && request.method === 'POST') {
      const { auth, input } = await mutation(context, authorize, {
        organizationId,
        permission: 'organization.manage',
      });
      sendJson(response, 201, store.createTemplateStep(organizationId, templateId, input, actor(auth)));
      return true;
    }
    if (organizationParts.length === 5 && nested === 'steps' && request.method === 'PATCH') {
      const { auth, input } = await mutation(context, authorize, {
        organizationId,
        permission: 'organization.manage',
      });
      sendJson(response, 200, store.patchTemplateStep(organizationId, templateId, stepId, input, actor(auth)));
      return true;
    }
    if (organizationParts.length === 5 && nested === 'steps' && request.method === 'DELETE') {
      const { auth } = await mutation(context, authorize, {
        organizationId,
        permission: 'organization.manage',
      }, { body: false });
      sendJson(response, 200, store.deleteTemplateStep(organizationId, templateId, stepId, actor(auth)));
      return true;
    }
    return false;
  }

  if (projectParts) {
    const [projectId, resource, action, stepId, stepAction] = projectParts;
    if (resource !== 'readiness') return false;
    if (projectParts.length === 2 && request.method === 'GET') {
      await authorize(context, {
        projectId,
        permission: 'project.read',
        mutation: false,
      });
      const summary = store.projectSummary(projectId);
      sendJson(response, 200, summary.initialized ? store.details(projectId) : summary);
      return true;
    }
    if (projectParts.length === 3 && action === 'initialize' && request.method === 'POST') {
      const { auth, input } = await mutation(context, authorize, {
        projectId,
        permission: 'project.manage',
      });
      sendJson(response, 201, store.initialize(projectId, input, actor(auth)));
      return true;
    }
    if (projectParts.length === 3 && action === 'evaluate' && request.method === 'GET') {
      await authorize(context, {
        projectId,
        permission: 'project.read',
        mutation: false,
      });
      sendJson(response, 200, store.evaluate(projectId));
      return true;
    }
    if (projectParts.length === 3 && action === 'activate' && request.method === 'POST') {
      const { auth } = await mutation(context, authorize, {
        projectId,
        permission: 'project.manage',
      }, { body: false });
      requireInteractive(auth);
      sendJson(response, 200, store.activate(projectId, actor(auth)));
      return true;
    }
    if (projectParts.length === 3 && action === 'suspend' && request.method === 'POST') {
      const { auth, input } = await mutation(context, authorize, {
        projectId,
        permission: 'project.manage',
      });
      requireInteractive(auth);
      sendJson(response, 200, store.suspend(projectId, input, actor(auth)));
      return true;
    }
    if (projectParts.length === 5 && action === 'steps' && request.method === 'POST') {
      const { auth, input } = await mutation(context, authorize, {
        projectId,
        permission: 'project.manage',
      });
      if (stepAction === 'submit') {
        sendJson(response, 200, store.submitStep(projectId, stepId, input, actor(auth)));
        return true;
      }
      if (stepAction === 'approve') {
        requireInteractive(auth);
        sendJson(response, 200, store.approveStep(projectId, stepId, input, actor(auth)));
        return true;
      }
      if (stepAction === 'reopen') {
        requireInteractive(auth);
        sendJson(response, 200, store.reopenStep(projectId, stepId, input, actor(auth)));
        return true;
      }
    }
    return false;
  }
  return false;
}

