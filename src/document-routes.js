import {
  assertMutationOrigin,
  decodeHeaderComponent,
  decodeSegment,
  readBinary,
  sendBuffer,
  sendJson,
} from './http.js';
import { ALLOWED_DOCUMENT_MIME_TYPES } from './document-store.js';

const PREFIX = '/api/v2/admin/projects';

function parts(pathname) {
  if (!pathname.startsWith(`${PREFIX}/`)) return null;
  return pathname
    .slice(PREFIX.length + 1)
    .split('/')
    .filter(Boolean)
    .map(decodeSegment);
}

async function authorizeMutation(context, authorize, projectId, permission, { body = true } = {}) {
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

export async function routeDocumentApi(context, authorize) {
  const selected = parts(context.url.pathname);
  if (!selected) return false;
  const [projectId, resource, documentId, nested, nestedId] = selected;
  if (resource !== 'documents') return false;
  const { request, response, documentStore } = context;

  if (selected.length === 2 && request.method === 'GET') {
    const auth = await authorize(context, {
      projectId,
      permission: 'documents.read',
      mutation: false,
    });
    sendJson(response, 200, documentStore.list(projectId, {
      includeArchived: context.url.searchParams.get('includeArchived') === 'true',
      category: context.url.searchParams.get('category') || undefined,
      query: context.url.searchParams.get('q') || undefined,
    }, auth));
    return true;
  }
  if (selected.length === 2 && request.method === 'POST') {
    const { auth, input } = await authorizeMutation(
      context,
      authorize,
      projectId,
      'documents.manage',
    );
    sendJson(
      response,
      201,
      documentStore.create(projectId, auth.organizationId, input, auth),
    );
    return true;
  }
  if (selected.length === 3 && request.method === 'PATCH') {
    const { auth, input } = await authorizeMutation(
      context,
      authorize,
      projectId,
      'documents.manage',
    );
    sendJson(response, 200, documentStore.patch(projectId, documentId, input, auth));
    return true;
  }
  if (
    selected.length === 4 &&
    nested === 'versions' &&
    request.method === 'POST'
  ) {
    assertMutationOrigin(request, context.config);
    const auth = await authorize(context, {
      projectId,
      permission: 'documents.manage',
      mutation: true,
    });
    const actorKey = auth.apiKey?.id || auth.userId || auth.user?.id || 'unknown';
    context.rateLimiter?.consume(
      'document-upload-actor',
      `${projectId}:${actorKey}`,
      {
        limit: context.config.documentUploadsPerHour || 30,
        windowMs: 60 * 60 * 1_000,
      },
    );
    const file = await readBinary(
      request,
      context.config.uploadLimitBytes,
      { allowedTypes: ALLOWED_DOCUMENT_MIME_TYPES },
    );
    const result = documentStore.addVersion(projectId, documentId, {
      ...file,
      changeNote: decodeHeaderComponent(
        request.headers['x-change-note'],
        'X-Change-Note',
        1000,
      ),
    }, auth);
    sendJson(response, 201, result);
    return true;
  }
  if (
    selected.length === 5 &&
    nested === 'versions' &&
    nestedId &&
    request.method === 'GET'
  ) {
    const auth = await authorize(context, {
      projectId,
      permission: 'documents.read',
      mutation: false,
    });
    const version = documentStore.versionContent(
      projectId,
      documentId,
      nestedId,
      auth,
    );
    sendBuffer(response, 200, version.content, {
      contentType: version.mimeType,
      filename: version.filename,
    });
    return true;
  }
  if (
    selected.length === 4 &&
    nested === 'links' &&
    request.method === 'POST'
  ) {
    const { auth, input } = await authorizeMutation(
      context,
      authorize,
      projectId,
      'documents.manage',
    );
    sendJson(
      response,
      201,
      documentStore.link(projectId, documentId, input, auth),
    );
    return true;
  }
  return false;
}
