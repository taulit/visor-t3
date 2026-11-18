#!/usr/bin/env node
// A stand-in for the local T3 Code server: the descriptor, the WebSocket
// ticket and the RPC socket of docs/protocol.md, with the threads of
// fixtures.js. No dependencies; the WebSocket side is a small RFC 6455 server.
//
// Usage: node tests/mock/server.js [--port N] [--token T] [--fixture NAME]
//                                     [--protocol N] [--home DIR] [--pairing CODE]
//   --port      port on 127.0.0.1 (default 3799)
//   --token     the bearer token it accepts (default "mock-token")
//   --fixture   a set of fixtures.js (default "default")
//   --protocol  the orchestration protocol it claims to speak (default 2)
//   --pairing   the one-time pairing code `POST /oauth/token` exchanges for the
//               token (default "mock-pairing"); it works once, as on the real server
//   --home      writes <DIR>/userdata/server-runtime.json while it runs, as
//               the real server does below ~/.t3
//
// Test controls, plain HTTP on the same port:
//   GET  /__mock/actions        what clients did: [{type, threadId, …}]
//   GET  /__mock/state          {clients, acks, tickets, ticketRequests, pairings}
//                               tickets: issued; ticketRequests: asked for, refused ones too;
//                               pairings: [{label, scope}] of the exchanges that worked;
//                               exchanges: how often a code was offered
//   POST /__mock/pairing?code=C a new one-time pairing code
//   POST /__mock/wait?thread=ID[&request=ID][&prompt=TEXT][&kind=KIND][&projection=MODE]
//                               the thread asks for approval; a request the thread already
//                               has is replaced. MODE says what getThreadProjection answers
//                               for it: "fail" (an error), "empty" (no such item) or "big"
//                               (a frame of 5 MB); `projections` in the state counts them
//   POST /__mock/thread         body: a thread shell (at least {id}); merged and announced
//   POST /__mock/remove?thread=ID
//   POST /__mock/slow-token?ms=N the next token exchange answers N ms late
//   POST /__mock/fail-next      the next command fails
//   POST /__mock/reset          forgets the recorded actions
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import {
  FIXTURES,
  approvalItem,
  descriptor,
  pendingRequest,
  snapshotItem,
  enrichmentItem,
  thread,
} from './fixtures.js';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const port = Number(option('port', '3799'));
const token = option('token', 'mock-token');
const protocol = Number(option('protocol', '2'));
const home = option('home', '');
const pairingCodes = new Set([option('pairing', 'mock-pairing')]);
const pairings = [];

const fixture = FIXTURES[option('fixture', 'default')](Date.now());
const threads = new Map(fixture.threads.map(t => [t.id, t]));
const prompts = new Map(Object.entries(fixture.prompts));
/** How getThreadProjection misbehaves, by request id. */
const projectionModes = new Map();
let projections = 0;
const actions = [];
const tickets = new Set();
/** Open sockets with the id of their shell subscription. */
const clients = new Set();
let acks = 0;
let ticketCount = 0;
let ticketRequests = 0;
let exchanges = 0;
let slowToken = 0;
let failNext = false;
let sequence = 1;

const now = () => new Date().toISOString();

function announce(id) {
  const item = {
    kind: 'thread.updated',
    sequence: ++sequence,
    location: 'active',
    thread: threads.get(id),
  };
  for (const client of clients) client.chunk(item);
}

function patch(id, changes) {
  const known = threads.get(id) ?? thread(id, Date.now());
  threads.set(id, { ...known, ...changes, id, updatedAt: now() });
  announce(id);
}

/** What a command does to the threads, roughly as the real server would. */
function apply(command) {
  const { type, threadId } = command;
  if (type === 'runtime-request.respond') {
    prompts.delete(command.requestId);
    patch(threadId, {
      pendingRuntimeRequest: null,
      status: 'running',
      activityRunStatus: 'running',
    });
  } else if (type === 'thread.stop' || type === 'run.interrupt') {
    for (const t of [...threads.values()]) {
      if (t.id !== threadId && t.lineage?.parentThreadId !== threadId) continue;
      patch(t.id, {
        pendingRuntimeRequest: null,
        status: 'interrupted',
        activityRunStatus: null,
        activeRunId: null,
        latestRunStopRequested: true,
        latestRunCompletedAt: now(),
      });
    }
  } else if (type === 'message.dispatch') {
    patch(threadId, {
      status: 'running',
      activityRunStatus: 'running',
      activityRunStartedAt: now(),
      latestRunStartedAt: now(),
      latestUserMessageAt: now(),
    });
  }
}

function rpc(client, frame) {
  const { id, tag, payload } = frame;
  const succeed = value =>
    client.send({ _tag: 'Exit', requestId: id, exit: { _tag: 'Success', value } });
  const fail = message =>
    client.send({
      _tag: 'Exit',
      requestId: id,
      exit: {
        _tag: 'Failure',
        cause: [{ _tag: 'Fail', error: { _tag: 'OrchestrationDispatchCommandError', message } }],
      },
    });
  switch (tag) {
    case 'orchestration.subscribeShell':
      client.shell = id;
      client.chunk(snapshotItem([...threads.values()]));
      client.chunk(enrichmentItem());
      client.chunk({ kind: 'synchronized' });
      break;
    case 'orchestration.dispatchCommand':
      if (failNext) {
        failNext = false;
        actions.push({ ...payload, failed: true });
        fail('The mock was told to fail this command.');
        break;
      }
      actions.push(payload);
      succeed({ sequence: ++sequence });
      apply(payload);
      break;
    case 'orchestration.getThreadProjection': {
      const pending = threads.get(payload.threadId)?.pendingRuntimeRequest;
      const prompt = pending ? prompts.get(pending.id) : undefined;
      const mode = pending ? projectionModes.get(pending.id) : undefined;
      projections++;
      if (mode === 'fail') {
        fail('The mock was told to fail this projection.');
        break;
      }
      if (mode === 'big') {
        succeed({ turnItems: [approvalItem(pending.id, prompt)], filler: 'x'.repeat(5 << 20) });
        break;
      }
      if (mode === 'empty') {
        succeed({ turnItems: [] });
        break;
      }
      succeed({ turnItems: prompt === undefined ? [] : [approvalItem(pending.id, prompt)] });
      break;
    }
    case 'orchestration.launchThread': {
      actions.push({ type: 'launchThread', ...payload });
      const like = [...threads.values()].find(t => t.projectId === payload.projectId);
      threads.set(
        payload.threadId,
        thread(payload.threadId, Date.now(), {
          title: payload.title,
          projectId: payload.projectId,
          modelSelection: payload.modelSelection ?? like?.modelSelection,
          status: 'running',
          activityRunStatus: 'running',
          activityRunStartedAt: now(),
          updatedAt: now(),
        }),
      );
      succeed({ threadId: payload.threadId, resumed: false, projection: {}, sequence: ++sequence });
      announce(payload.threadId);
      break;
    }
    default:
      fail(`The mock does not know ${tag}.`);
  }
}

// --- WebSocket (RFC 6455): text frames, no extensions ---

function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) header = Buffer.from([0x80 | opcode, length]);
  else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function accept(socket) {
  const client = {
    shell: null,
    send: value => socket.write(encodeFrame(1, Buffer.from(JSON.stringify(value)))),
    chunk(value) {
      if (this.shell !== null) this.send({ _tag: 'Chunk', requestId: this.shell, values: [value] });
    },
  };
  clients.add(client);
  let buffer = Buffer.alloc(0);
  let parts = [];
  socket.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      const final = (buffer[0] & 0x80) !== 0;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (masked) for (let i = 0; i < length; i++) payload[i] ^= buffer[maskOffset + (i % 4)];
      buffer = buffer.subarray(offset + length);
      if (opcode === 8) {
        socket.end(encodeFrame(8, payload.subarray(0, 2)));
        return;
      }
      if (opcode === 9) {
        socket.write(encodeFrame(10, payload));
        continue;
      }
      if (opcode !== 0 && opcode !== 1) continue;
      parts.push(payload);
      if (!final) continue;
      const text = Buffer.concat(parts).toString('utf8');
      parts = [];
      let frames;
      try {
        frames = JSON.parse(text);
      } catch {
        continue;
      }
      for (const frame of Array.isArray(frames) ? frames : [frames]) {
        if (frame._tag === 'Request') rpc(client, frame);
        else if (frame._tag === 'Ack') acks++;
        else if (frame._tag === 'Ping') client.send({ _tag: 'Pong' });
      }
    }
  });
  const gone = () => clients.delete(client);
  socket.on('close', gone);
  socket.on('error', gone);
}

// --- HTTP ---

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  const json = (status, value) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  const body = () =>
    new Promise(resolve => {
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

  if (url.pathname === '/.well-known/t3/environment') return json(200, descriptor(protocol));
  if (url.pathname === '/oauth/token' && request.method === 'POST') {
    exchanges++;
    const form = new URLSearchParams(await body());
    const wellFormed =
      request.headers['content-type']?.startsWith('application/x-www-form-urlencoded') &&
      form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:token-exchange' &&
      form.get('subject_token_type') === 'urn:t3:params:oauth:token-type:environment-bootstrap' &&
      form.get('requested_token_type') === 'urn:ietf:params:oauth:token-type:access_token';
    if (!wellFormed) return json(400, { _tag: 'EnvironmentRequestInvalidError' });
    if (!pairingCodes.delete(form.get('subject_token')))
      return json(401, { _tag: 'EnvironmentAuthInvalidError', reason: 'invalid_credential' });
    const scope = form.get('scope') ?? 'orchestration:read orchestration:operate';
    pairings.push({ label: form.get('client_label'), scope });
    if (slowToken) await new Promise(resolve => setTimeout(resolve, slowToken));
    slowToken = 0;
    return json(200, {
      access_token: token,
      issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope,
    });
  }
  if (url.pathname === '/api/auth/websocket-ticket/rpc' && request.method === 'POST') {
    ticketRequests++;
    if (request.headers.authorization !== `Bearer ${token}`)
      return json(401, { _tag: 'EnvironmentAuthInvalidError', reason: 'invalid_credential' });
    const ticket = randomUUID();
    tickets.add(ticket);
    ticketCount++;
    return json(200, { ticket, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  }

  if (url.pathname === '/__mock/actions') return json(200, actions);
  if (url.pathname === '/__mock/state')
    return json(200, {
      clients: clients.size,
      acks,
      tickets: ticketCount,
      ticketRequests,
      pairings,
      exchanges,
      projections,
    });
  if (request.method !== 'POST') return json(404, {});
  const id = url.searchParams.get('thread');
  switch (url.pathname) {
    case '/__mock/wait': {
      const requestId = url.searchParams.get('request') ?? `request-${randomUUID()}`;
      prompts.set(requestId, url.searchParams.get('prompt') ?? 'pnpm test');
      if (url.searchParams.has('projection'))
        projectionModes.set(requestId, url.searchParams.get('projection'));
      patch(id, {
        status: 'waiting',
        activityRunStatus: 'waiting',
        pendingRuntimeRequest: pendingRequest(
          requestId,
          Date.now() + 12_000,
          url.searchParams.get('kind') ?? 'command',
        ),
      });
      return json(200, { requestId });
    }
    case '/__mock/thread':
      return void body().then(text => {
        const changes = JSON.parse(text);
        patch(changes.id, changes);
        json(200, {});
      });
    case '/__mock/remove':
      threads.delete(id);
      for (const client of clients)
        client.chunk({
          kind: 'thread.removed',
          sequence: ++sequence,
          location: 'active',
          threadId: id,
        });
      return json(200, {});
    case '/__mock/pairing':
      pairingCodes.add(url.searchParams.get('code') ?? 'mock-pairing');
      return json(200, {});
    case '/__mock/slow-token':
      slowToken = Number(url.searchParams.get('ms') ?? 1000);
      return json(200, {});
    case '/__mock/fail-next':
      failNext = true;
      return json(200, {});
    case '/__mock/reset':
      actions.length = 0;
      return json(200, {});
    default:
      return json(404, {});
  }
});

server.on('upgrade', (request, socket) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  const refuse = (status, reason, value) => {
    const text = JSON.stringify(value);
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\ncontent-type: application/json\r\n` +
        `content-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`,
    );
  };
  if (url.pathname !== '/ws') return refuse(404, 'Not Found', {});
  if (url.searchParams.get('orchestrationProtocol') !== String(protocol)) {
    return refuse(426, 'Upgrade Required', {
      code: 'orchestration_protocol_incompatible',
      orchestrationProtocolVersion: protocol,
    });
  }
  // A ticket opens one socket.
  if (!tickets.delete(url.searchParams.get('wsTicket')))
    return refuse(401, 'Unauthorized', { _tag: 'EnvironmentAuthInvalidError' });
  const key = createHash('sha1')
    .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${key}\r\n\r\n`,
  );
  return accept(socket);
});

const statePath = home ? join(home, 'userdata', 'server-runtime.json') : '';
const stop = () => {
  if (statePath) rmSync(statePath, { force: true });
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

server.listen(port, '127.0.0.1', () => {
  if (statePath) {
    mkdirSync(join(home, 'userdata'), { recursive: true });
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        pid: process.pid,
        port,
        origin: `http://127.0.0.1:${port}`,
        startedAt: now(),
        serverVersion: '0.0.0-mock',
      })}\n`,
    );
  }
  console.log(`t3-mock listening on http://127.0.0.1:${port}`);
});
