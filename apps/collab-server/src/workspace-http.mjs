import { isWorkspacePath, MAX_FILE_BYTES } from './workspace-store.mjs';

const MAX_UPLOADS = 4;

function revision(value) {
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(value ?? '')) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

/**
 * Single-range `Range: bytes=a-b` / `bytes=a-` / `bytes=-n` parser.
 * Returns null when the header should be ignored (multiple ranges, bad syntax),
 * `{unsatisfiable: true}` for a 416, or the inclusive offsets.
 */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (size === 0) return { unsatisfiable: true };
  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
    if (start >= size) return { unsatisfiable: true };
    if (end < start) return null;
    if (end >= size) end = size - 1;
  }
  return { start, end };
}

export function workspaceHandler({ store, workspaceId, reply, readBody, stopping, commit, head }) {
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
      return reply(response, 200, { files: store.manifest(workspaceId) }, { 'X-LSW-Seq': String(head()) });
    }
    const path = url.searchParams.get('path');
    if (!isWorkspacePath(path)) return reply(response, 400, { error: 'invalid-path' });
    if (method === 'GET') {
      const version = revision(url.searchParams.get('revision'));
      if (!version) return reply(response, 400, { error: 'invalid-revision' });
      const file = store.read(workspaceId, path, version);
      if (!file) return reply(response, 412, { error: 'revision-changed' });
      const bytes = Buffer.from(file.bytes);
      const common = {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ETag: '"' + version + '"',
        'X-LSW-SHA256': file.sha256,
        'Accept-Ranges': 'bytes',
      };
      const range = request.headers.range === undefined ? null : parseRange(request.headers.range, bytes.length);
      if (range?.unsatisfiable) {
        response.writeHead(416, { ...common, 'Content-Range': 'bytes */' + bytes.length });
        return response.end();
      }
      if (range) {
        const slice = bytes.subarray(range.start, range.end + 1);
        response.writeHead(206, {
          ...common,
          'Content-Length': slice.length,
          'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + bytes.length,
        });
        return response.end(slice);
      }
      response.writeHead(200, { ...common, 'Content-Length': bytes.length });
      return response.end(bytes);
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
    const result = commit(workspaceId, path, base, bytes);
    if (result.status === 200) {
      response.setHeader('ETag', '"' + result.body.file.revision + '"');
      response.setHeader('X-LSW-Seq', String(result.body.seq));
      return reply(response, 200, result.body.file);
    }
    return reply(response, result.status, { error: result.error });
  };
}
