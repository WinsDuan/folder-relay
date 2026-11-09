import { isWorkspacePath, MAX_FILE_BYTES } from './workspace-store.mjs';

const MAX_UPLOADS = 4;

function revision(value) {
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(value ?? '')) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

export function workspaceHandler({ store, workspaceId, reply, readBody, stopping }) {
  let uploads = 0;
  return async (request, response, url) => {
    if (url.searchParams.get('workspace') !== workspaceId) {
      return reply(response, 404, { error: 'workspace-not-found' });
    }
    const method = request.method;
    if (url.pathname === '/workspace/manifest') {
      if (method !== 'GET') {
        response.setHeader('Allow', 'GET');
        return reply(response, 405, { error: 'method-not-allowed' });
      }
      return reply(response, 200, { files: store.manifest(workspaceId) });
    }
    const path = url.searchParams.get('path');
    if (!isWorkspacePath(path)) return reply(response, 400, { error: 'invalid-path' });
    if (method === 'GET') {
      const version = revision(url.searchParams.get('revision'));
      if (!version) return reply(response, 400, { error: 'invalid-revision' });
      const file = store.read(workspaceId, path, version);
      if (!file) return reply(response, 412, { error: 'revision-changed' });
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': file.bytes.byteLength,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ETag: '"' + version + '"',
        'X-LSW-SHA256': file.sha256,
      });
      return response.end(file.bytes);
    }
    if (method !== 'PUT' && method !== 'DELETE') {
      response.setHeader('Allow', 'GET, PUT, DELETE');
      return reply(response, 405, { error: 'method-not-allowed' });
    }

    const base = revision(request.headers['if-match']?.match(/^"([0-9]+)"$/)?.[1]);
    if (base === undefined) return reply(response, 428, { error: 'revision-precondition-required' });
    let bytes = null;
    if (method === 'PUT') {
      const length = Number(request.headers['content-length'] ?? NaN);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_FILE_BYTES) {
        return reply(response, 413, { error: 'invalid-content-length' });
      }
      if (uploads >= MAX_UPLOADS) return reply(response, 503, { error: 'upload-capacity' });
      uploads++;
      try {
        bytes = await readBody(request, length, 30_000);
      } catch {
        if (!response.destroyed) reply(response, 400, { error: 'invalid-file-body' });
        return;
      } finally {
        uploads--;
      }
    }

    if (stopping()) return reply(response, 503, { error: 'stopping' });
    const result = store.commit(workspaceId, path, base, bytes);
    if (result.file) {
      response.setHeader('ETag', '"' + result.file.revision + '"');
      return reply(response, 200, result.file);
    }
    return reply(response, result.status, { error: result.error });
  };
}
