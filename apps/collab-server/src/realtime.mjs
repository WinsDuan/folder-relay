import { createHash } from 'node:crypto';

/**
 * Minimal RFC 6455 server used for the v1 push channel. The collaboration
 * channel keeps using Hocuspocus/crossws; this one owns `/v1/events` only so the
 * two protocols cannot interfere.
 */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_CLIENT_FRAME = 1024 * 1024;
const MAX_SOCKETS = 64;
const MAX_CHANGES_PER_FRAME = 512;
const MAX_REPLAY_PAGES = 16;

function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function textFrame(value) {
  return encodeFrame(0x1, Buffer.from(JSON.stringify(value), 'utf8'));
}

function closeFrame(code, reason) {
  const body = Buffer.from(reason ?? '', 'utf8');
  const payload = Buffer.alloc(2 + body.length);
  payload.writeUInt16BE(code, 0);
  body.copy(payload, 2);
  return encodeFrame(0x8, payload);
}

function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

function httpError(socket, status, text) {
  if (!socket.writable) return;
  const body = JSON.stringify({ error: text });
  socket.write('HTTP/1.1 ' + status + ' ' + statusText(status) + '\r\n'
    + 'Connection: close\r\n'
    + 'Content-Type: application/json; charset=utf-8\r\n'
    + 'Cache-Control: no-store\r\n'
    + 'Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
  socket.end();
}

function statusText(status) {
  switch (status) {
    case 400: return 'Bad Request';
    case 401: return 'Unauthorized';
    case 403: return 'Forbidden';
    case 404: return 'Not Found';
    case 426: return 'Upgrade Required';
    case 503: return 'Service Unavailable';
    default: return 'Error';
  }
}

export function requestedToken(headers) {
  const protocol = headers['sec-websocket-protocol'];
  if (typeof protocol === 'string') {
    for (const item of protocol.split(',')) {
      const value = item.trim();
      if (value.startsWith('lsw.token.')) return value.slice('lsw.token.'.length);
    }
  }
  const match = /^Bearer ([!-~]{8,1024})$/i.exec(headers.authorization ?? '');
  return match ? match[1] : null;
}

export function createRealtime({ workspaceId, heartbeatMs, logSize, seq, authorize, isStopping }) {
  const clients = new Set();
  let closed = false;
  // A client that never answers `ping` (some headless harnesses only speak
  // HTTP) would otherwise be cut 3×heartbeatMs after connecting. The protocol
  // default (25 s) keeps 75 s; the 30 s floor only changes tiny dev values.
  const silenceLimit = Math.max(3 * heartbeatMs, 30_000);

  const timer = setInterval(() => {
    if (closed) return;
    const at = Date.now();
    for (const client of [...clients]) {
      if (at - client.lastFrame > silenceLimit) {
        client.close(1001, 'heartbeat-timeout');
        continue;
      }
      client.send({ t: 'ping', seq: seq.head(workspaceId) });
    }
  }, heartbeatMs);
  timer.unref?.();

  function page(since) {
    const result = seq.since(workspaceId, since, MAX_CHANGES_PER_FRAME);
    if (!result.reset && result.changes.length === 0) return null;
    if (result.reset) return { t: 'reset', head: result.head };
    return { t: 'changes', changes: result.changes, head: result.head, floor: result.floor };
  }

  function makeClient(socket) {
    const client = {
      socket,
      buffer: Buffer.alloc(0),
      lastFrame: Date.now(),
      closed: false,
      send(value) {
        if (this.closed || !socket.writable) return;
        try {
          socket.write(textFrame(value));
        } catch {
          this.close(1011, 'write-failed');
        }
      },
      close(code, reason) {
        if (this.closed) return;
        this.closed = true;
        clients.delete(this);
        try {
          if (socket.writable) socket.write(closeFrame(code, reason));
        } catch { /* peer already gone */ }
        socket.end();
        const destroy = setTimeout(() => socket.destroy(), 1000);
        destroy.unref?.();
      },
    };

    function handleFrame(opcode, payload) {
      if (opcode === 0x8) {
        client.close(1000, 'bye');
        return;
      }
      if (opcode === 0x9) {
        if (socket.writable) socket.write(encodeFrame(0xA, payload));
        return;
      }
      if (opcode !== 0x1) return;
      let message;
      try {
        message = JSON.parse(payload.toString('utf8'));
      } catch {
        return;
      }
      if (!message || typeof message !== 'object') return;
      if (message.t === 'pong' || message.t === 'ack') return;
      if (message.t === 'resync') {
        const since = Number.isSafeInteger(message.since) && message.since >= 0 ? message.since : 0;
        const next = page(since);
        if (next) client.send(next);
      }
    }

    function drain() {
      for (;;) {
        if (client.buffer.length < 2) return;
        const first = client.buffer[0];
        const second = client.buffer[1];
        const fin = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let cursor = 2;
        if (length === 126) {
          if (client.buffer.length < 4) return;
          length = client.buffer.readUInt16BE(2);
          cursor = 4;
        } else if (length === 127) {
          if (client.buffer.length < 10) return;
          length = Number(client.buffer.readBigUInt64BE(2));
          cursor = 10;
        }
        if (length > MAX_CLIENT_FRAME) {
          client.close(1009, 'frame-too-large');
          return;
        }
        let mask;
        if (masked) {
          if (client.buffer.length < cursor + 4) return;
          mask = client.buffer.subarray(cursor, cursor + 4);
          cursor += 4;
        }
        if (client.buffer.length < cursor + length) return;
        const payload = Buffer.from(client.buffer.subarray(cursor, cursor + length));
        if (mask) for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index & 3];
        client.buffer = client.buffer.subarray(cursor + length);
        if (!fin) {
          client.close(1003, 'fragmented-frames-unsupported');
          return;
        }
        handleFrame(opcode, payload);
        if (client.closed) return;
      }
    }

    socket.on('data', chunk => {
      client.lastFrame = Date.now();
      client.buffer = client.buffer.length === 0 ? chunk : Buffer.concat([client.buffer, chunk]);
      drain();
    });    socket.on('error', () => {
      client.closed = true;
      clients.delete(client);
      socket.destroy();
    });
    socket.on('close', () => {
      client.closed = true;
      clients.delete(client);
    });
    client.feed = chunk => {
      client.lastFrame = Date.now();
      client.buffer = client.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([client.buffer, chunk]);
      drain();
    };
    return client;
  }

  return {
    get size() {
      return clients.size;
    },
    /**
     * @returns {boolean} true when this upgrade belonged to `/v1/events`.
     */
    handleUpgrade(request, socket, head) {
      let url;
      try {
        url = new URL(request.url, 'http://localhost');
      } catch {
        httpError(socket, 400, 'invalid-request');
        return true;
      }
      if (url.pathname !== '/v1/events') return false;
      if (request.method !== 'GET') {
        httpError(socket, 400, 'invalid-request');
        return true;
      }
      if (closed || isStopping()) {
        httpError(socket, 503, 'stopping');
        return true;
      }
      if (url.searchParams.get('workspace') !== workspaceId) {
        httpError(socket, 404, 'workspace-not-found');
        return true;
      }
      const key = request.headers['sec-websocket-key'];
      if (typeof key !== 'string' || key.length === 0) {
        httpError(socket, 400, 'invalid-handshake');
        return true;
      }
      if (clients.size >= MAX_SOCKETS) {
        httpError(socket, 503, 'socket-capacity');
        return true;
      }
      const identity = authorize(requestedToken(request.headers));
      if (!identity) {
        httpError(socket, 401, 'unauthorized');
        return true;
      }

      let since = null;
      const rawSince = url.searchParams.get('since');
      if (rawSince !== null) {
        if (!/^(?:0|[1-9][0-9]{0,15})$/.test(rawSince)) {
          httpError(socket, 400, 'invalid-since');
          return true;
        }
        since = Number(rawSince);
      }

      const offered = String(request.headers['sec-websocket-protocol'] ?? '')
        .split(',').map(value => value.trim()).filter(Boolean);
      const protocol = offered.includes('lsw.v1') ? 'lsw.v1' : (offered[0] ?? null);

      socket.setNoDelay(true);
      socket.write('HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + 'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n'
        + (protocol ? 'Sec-WebSocket-Protocol: ' + protocol + '\r\n' : '')
        + '\r\n');

      const client = makeClient(socket);
      clients.add(client);
      client.lastFrame = Date.now();
      client.send({
        t: 'hello',
        workspace: workspaceId,
        seq: seq.head(workspaceId),
        floor: seq.floor(workspaceId),
        proto: 1,
        heartbeatMs,
        resumeWindow: logSize,
      });
      if (since !== null) {
        let cursor = since;
        for (let sent = 0; sent < MAX_REPLAY_PAGES; sent++) {
          const next = page(cursor);
          if (!next) break;
          client.send(next);
          if (next.t === 'reset') break;
          cursor = next.head;
          if (next.changes.length < MAX_CHANGES_PER_FRAME) break;
        }
      }
      if (head && head.length > 0) client.feed(head);
      return true;
    },
    broadcastChanges(workspaceIdOfChange, changes, head) {
      if (closed || workspaceIdOfChange !== workspaceId) return;
      const floor = seq.floor(workspaceId);
      for (const client of [...clients]) client.send({ t: 'changes', changes, head, floor });
    },
    broadcastReset(head, reason = 'restart') {
      for (const client of [...clients]) client.send({ t: 'reset', head, reason });
    },
    closeAll(code = 1012, reason = 'Service Restart') {
      closed = true;
      clearInterval(timer);
      for (const client of [...clients]) client.close(code, reason);
    },
  };
}
