# T3 Code protocol, as far as the module uses it

Read from the local checkout `~/development/t3code` at commit `afe7e876` (2026-11-07, a fork of
[pingdotgg/t3code](https://github.com/pingdotgg/t3code), MIT); what is about several machines (§2a)
from upstream `main` at `2f577fa3` (2026-11-19). Paths below are relative to that repository.
The only request sent to a real server while writing this was the public
`GET /.well-known/t3/environment`; everything else is from the source and runs against `tests/mock/`.

## 1. Finding the local server

- The server writes `<base>/userdata/server-runtime.json` while it runs and removes it when it stops
  (`apps/server/src/serverRuntimeState.ts`, path from `deriveServerPaths` in `apps/server/src/config.ts`).
  `<base>` is `$T3CODE_HOME`, else `~/.t3` (`apps/server/src/cli/app.ts`). A development server uses
  `<base>/dev/` instead of `userdata/`.
- The file is one JSON object: `{"version":1,"pid":…,"port":3773,"origin":"http://127.0.0.1:3773",…}`.
  Visor uses `origin`. The default port is 3773 (`DEFAULT_PORT`).
- Visor connects to the origins in the setting `servers` (§2a), not to what this file says; it watches
  the file to reconnect at once when the local server starts. The settings window reads `origin` to
  know which server a bare code or Connect next to "This machine" pairs with.

## 2. Connecting and authenticating

The environment issues its own sessions (`docs/internals/environment-auth.md`,
`apps/server/src/auth/EnvironmentAuth.ts`, routes in `packages/contracts/src/environmentHttp.ts`).

1. **Descriptor** (public): `GET /.well-known/t3/environment` →
   `{environmentId, label, serverVersion, orchestrationProtocolVersion, capabilities}`.
2. **Pairing**, once per device, as the mobile app does (`apps/mobile/src/features/connection/pairing.ts`,
   `packages/client-runtime/src/authorization/remote.ts`): the user creates a one-time pairing token in
   T3 Code (Settings → Sharing & access, or `t3 auth pairing create`), shown as `<origin>/pair#token=<code>`.
   The client exchanges it:
   `POST /oauth/token`, form-encoded: `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`,
   `subject_token=<code>`, `subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap`,
   `requested_token_type=urn:ietf:params:oauth:token-type:access_token`, optional `scope` (space
   separated), `client_label`, `client_device_type`, `client_os` →
   `{access_token, token_type: "Bearer", expires_in, scope}`.
   Visor needs the scopes `orchestration:read orchestration:operate`
   (`apps/server/src/auth/RpcAuthorization.ts`). `t3 auth session issue` prints such a token directly.
3. **WebSocket ticket**, per connection: `POST /api/auth/websocket-ticket/rpc` with
   `Authorization: Bearer <access_token>` → `{ticket, expiresAt}`. 401 means the token is unknown or
   revoked.
4. **Socket**: `ws://<host>/ws?orchestrationProtocol=2&wsTicket=<ticket>` (`apps/server/src/ws.ts`).

The module does step 1, 3 and 4, once per paired server. Step 2 is done by the settings window
(Modules → T3 Code, `src/pairing-group.ts`; what both sides share is in `src/pairing.ts` and
`keyring.ts`): it takes the pairing link or the bare code, checks the descriptor, exchanges the code,
stores the token in the keyring and adds the origin to `servers`. The session T3 Code lists under
Sharing & access is named after the label of the pairing code, not after `client_label`. The token endpoint answers a
wrong, used or expired code with 401 (`EnvironmentAuthInvalidError`) and a malformed request with 400. A
401 or 403 on the ticket request means the token is no good: the module logs one line and asks again only
when the pairing or the address changes.

**Where the token is kept.** In the keyring of the user, through libsecret (`gi://Secret`, async calls
only): one item per server of the schema `io.github.taulit.Visor.T3` with the attribute `origin`, in the
default collection. It is not in GSettings, so not in dconf, its dumps and backups. GSettings has only
what is no secret: `servers`, the origins Visor is paired with (empty: not paired, the keyring is not
asked at all), and `token-serial`, a counter the settings window raises whenever it stored or removed a
token. The module in the shell, another process, watches both: a new origin gets a client, a removed
one loses it, and on a new count every client reads its token again and starts over only when it
changed.
Disconnect removes the item; disabling the extension does not. The schema name is the one the module
had while it was part of Visor, so a token stored then is found and replaced by the next pairing.

Without a usable keyring (no Secret Service on the session bus, an unlock that was dismissed, no answer
within 60 seconds) the module shows nothing and logs one line; it does not ask again for the same pairing
as long as the shell runs, so a locked keyring prompts once and not at every unlock of the screen. The
settings window asks the keyring before it sends the pairing code and shows "The keyring is not available"
instead, so the code, which is good once, is not used up.

**Where the token goes.** Each token is stored for the origin that issued it and is sent to that
origin only. Plain http is taken for this machine (`localhost`, `127.0.0.0/8`, `[::1]`) and for
Tailscale addresses (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`), whose traffic WireGuard encrypts; T3 Code
itself offers such an address for pairing (`t3 pair`, `startupAccess.ts`). Any other server needs https.
None of the requests that carry the pairing code, the token or the ticket follows a redirect.

**Revoking.** `POST /api/auth/clients/revoke` (`{sessionId}`) needs the scope `access:write`, which Visor
does not ask for, and refuses the session that calls it (`current_session_revoke_not_allowed`, 403). A
client cannot end its own session, so Disconnect only forgets the token; the session stays listed in
T3 Code under Settings → Sharing & access until it is revoked there or expires.

## 2a. Several machines

The sessions of one machine live on its own server: a project and its threads belong to one
environment (`docs/internals/remote.md`). The T3 Code app shows other machines because the client
connects to each of them, with credentials of its own kept in its connection catalog
(`apps/desktop/src/app/DesktopConnectionCatalogStore.ts`, encrypted with Electron's safe storage).
A server knows nothing of the machines its app knows. Its **peer links** (`apps/server/src/peer/`,
`t3 environment link|list`) are not that either: they sign one server in to another's `/mcp` so that
agents can work there, they are behind the "Linked environments" beta, and they forward MCP tool
calls, not the shell stream.

So Visor does what a client does: it pairs with every server itself and keeps one connection per
server.

- **Settings.** `servers` (`as`) lists the origins, in the order they were paired, at most eight.
  The token of each is in the keyring under its origin. The keys of 0.1, `server-url` and
  `token-origin`, are carried over into `servers` once when the module or the settings window starts,
  and emptied then (`carryOverPairing`).
- **One list.** `sessionsOfAll` merges the shells of all servers with the order of `sessionsOf`.
  Thread and request ids are the server's, so the module keys what it remembers by
  `<origin> <id>`. A row keeps `t3:<thread id>` as its id unless two servers show the same thread id.
  Two origins that report the same `environmentId` are one machine: only the first shows.
- **The machine of a row.** A server that is not this machine (not a loopback origin) puts the
  `label` of its descriptor (its host name, as T3 Code reports it) in front of the subtitle.
- **Opening a thread** uses `t3code://threads/<environmentId>/<threadId>`, which the desktop app
  resolves to the machine as long as the app knows it.
- **Pairing this machine without a link.** `t3 auth pairing create --json --ttl 2m --scope
orchestration:read --scope orchestration:operate --label "Visor (<host>)"` prints
  `{id, credential, label, scopes, expiresAt, pairUrl?}`; the settings window exchanges `credential`
  as in step 2. The command is `$T3CODE_HOME/bin/t3` (default `~/.t3/bin/t3`, where the desktop app
  installs it), else `t3` on the `PATH`.
- **A link for another machine** comes from Settings → Sharing & access there, or from
  `t3 auth pairing create … --base-url http://<address>:3773`, which prints `pairUrl`
  (`<base-url>/pair#token=<code>`). `t3 pair --tailscale` publishes the server over Tailscale Serve
  and pairs through its https address instead.
- **T3 Connect**, the relay, is not supported: its tokens last an hour and the client renews them
  (`docs/internals/connection-runtime.md`), which the module does not do.

## 3. Messages

The socket speaks Effect RPC with JSON serialization (`effect/rpc/RpcMessage.ts`, effect 4.1.2): one JSON
value per frame, an object or an array of objects.

| Direction       | Frame                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| client → server | `{"_tag":"Request","id":"<n>","tag":"<method>","payload":{…},"headers":[]}`                                                         |
| server → client | `{"_tag":"Chunk","requestId":"<n>","values":[…]}` for streams                                                                       |
| client → server | `{"_tag":"Ack","requestId":"<n>"}` after every chunk, or the stream stalls                                                          |
| server → client | `{"_tag":"Exit","requestId":"<n>","exit":{"_tag":"Success","value":…}}` or `{"_tag":"Failure","cause":[{"_tag":"Fail","error":…}]}` |
| both            | `{"_tag":"Ping"}` / `{"_tag":"Pong"}`; `{"_tag":"Defect","defect":…}` ends everything                                               |

Methods and schemas are in `packages/contracts/src/orchestrationV2.ts` (`ORCHESTRATION_V2_WS_METHODS`,
`OrchestrationV2RpcSchemas`).

### Threads: `orchestration.subscribeShell`

Payload `{}` (plus `omitIdleSubagents` / `omitOlderSettled` only for servers that advertise the capabilities
`shellThreadFamilies` / `shellOlderSettled`). Stream items (`OrchestrationV2ShellStreamItem`):

- `{kind:"snapshot", snapshot:{projects:[{id,title,…}], threads:[ThreadShell], archivedThreads:[…]}}`
- The same item with `resolvedRepositoryIdentityRoots:[…]` is not the whole state: it follows the first
  snapshot and every identified repository, carries the projects of those roots and empty `threads`. Visor
  takes its projects and keeps its threads (`mergeShellSnapshotProjects` in `packages/client-runtime`).
- `{kind:"thread.updated", location:"active"|"archive", thread:ThreadShell}`, `{kind:"thread.removed", threadId}`
- `{kind:"project.updated", project}`, `{kind:"project.removed", projectId}`, `{kind:"synchronized"}`

Of `OrchestrationV2ThreadShell` Visor reads: `id`, `projectId`, `title`, `lineage`
(`parentThreadId`, `relationshipToParent`, `sideChat`), `status`
(`idle|preparing|queued|starting|running|waiting|completed|interrupted|failed|cancelled|rolled_back`),
`activityRunStatus`, `activityRunStartedAt`, `latestRunStartedAt`, `latestRunCompletedAt`,
`latestRunStopRequested`, `lastError`, `pendingRuntimeRequest` (`{id, kind, createdAt}`),
`latestVisibleMessage` (`{role, text}`), `settledOverride`, `archivedAt`, `deletedAt`, `updatedAt`, and
`modelSelection`, `runtimeMode`, `interactionMode` to start a thread like the last one.

Status as in `packages/shared/src/agentAwareness.ts`: a pending request of kind `user_input` is a question,
any other except `auth_refresh` an approval; else `activityRunStatus ?? status`: `preparing|starting` →
starting, `running|waiting` → working, `completed` → done, `failed` → error, the rest is not shown.
Subagent threads (`relationshipToParent: "subagent"`) and side chats are not listed; a pending request of a
subagent makes its listed ancestor wait, and the answer goes to the subagent's thread.

### What an approval asks: `orchestration.getThreadProjection`

The shell names only the request id and kind (`command`, `file-read`, `file-change`, `mcp-elicitation`,
`permission`). The command or file is the `prompt` of the turn item
`{type:"approval_request", requestId, requestKind, prompt, reason}` in the projection
(`packages/client-runtime/src/state/threadRequests.ts`). Payload `{threadId}` → `{turnItems:[…], …}`.

### Actions: `orchestration.dispatchCommand`

Payload is one `OrchestrationV2Command`, the result `{sequence}`. `commandId` and `messageId` are fresh
UUIDs (`packages/client-runtime/src/operations/commands.ts`).

- Approve / deny: `{type:"runtime-request.respond", commandId, threadId, requestId, decision:"accept"|"decline"}`
- Reply: `{type:"message.dispatch", commandId, createdBy:"user", creationSource:"web", threadId, messageId,
text, attachments:[], dispatchMode:{type:"start_immediately"}, deliveryIntent:"auto"}`
- Stop: `{type:"thread.stop", commandId, threadId}`; servers without the capability
  `threadStop` get `{type:"run.interrupt", commandId, threadId, runId}` with the `activeRunId` of the shell
- New thread: `orchestration.launchThread` with `{commandId, creationSource:"web", threadId, projectId,
title, generateTitle:true, modelSelection, runtimeMode, interactionMode, workspaceStrategy:{type:"root"},
initialMessage:{messageId, text, attachments:[]}}`

### Last agent message

`latestVisibleMessage` of the thread shell, when its `role` is `assistant`.

### Open in T3 Code

`<origin>/threads/<environmentId>/<threadId>` (`buildAgentAwarenessDeepLink`, web route
`apps/web/src/routes/threads.$environmentId.$threadId.tsx`). The desktop app registers the
scheme `t3code` and takes `t3code://threads/<environmentId>/<threadId>` (`promptLinkAppPath` in
`packages/shared/src/promptLinks.ts`, handled in `apps/desktop/src/app/DesktopClerk.ts`). Visor opens that
link when an application is registered for the scheme, and the browser address otherwise; the browser has
a session of its own and shows the pairing page when it has none.

## 4. Version

`ORCHESTRATION_PROTOCOL_VERSION = 2` (`packages/contracts/src/environment.ts`). The descriptor carries it
as `orchestrationProtocolVersion`; the socket requires `?orchestrationProtocol=2` and answers anything else
with HTTP 426 and `{"code":"orchestration_protocol_incompatible","orchestrationProtocolVersion":2}`; the
HTTP API wants the header `x-t3-orchestration-protocol: 2`. Visor compares the descriptor with the version
it was written for before it asks for a ticket, logs one line when they differ and stays empty.
