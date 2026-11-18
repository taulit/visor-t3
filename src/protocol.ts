// The part of the T3 Code protocol Visor speaks, see docs/protocol.md.
// Pure: frames in, state out. Everything from the server is untrusted, so
// every field is checked and every text is cut to a length.

/** The orchestration protocol this file was written for. */
export const PROTOCOL_VERSION = 2;
/** How long a finished session keeps its row. */
export const DONE_MS = 120_000;

export const METHODS = {
  subscribeShell: 'orchestration.subscribeShell',
  dispatchCommand: 'orchestration.dispatchCommand',
  getThreadProjection: 'orchestration.getThreadProjection',
  launchThread: 'orchestration.launchThread',
} as const;

const MAX_ID = 200;
const MAX_TITLE = 80;
const MAX_PROJECT = 40;
const MAX_DETAIL = 200;
/** A whole command or path as the expanded row shows it. */
export const MAX_COMMAND = 4000;
/** What the one-line preview of a row shows for certain, at any width of the panel. */
export const PREVIEW_CHARS = 16;
const MAX_MESSAGE = 600;
const MAX_ERROR = 160;
/** A reply typed into Visor; the server takes far more. */
export const MAX_REPLY = 4000;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One line without control characters, at most `max` characters. Format
 * characters go too: they are invisible, and the bidi ones reorder what follows.
 */
export function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // The slice keeps a huge input from being scanned in full.
  const text = value
    .slice(0, max * 4)
    .replace(/[\p{Cf}\p{Cs}]+/gu, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ');
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const id = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_ID ? value : null;

/** Milliseconds since the epoch of an ISO time, or of a number that already is one. */
function time(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.length > 64) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

// --- finding and addressing the server ---

/** True for the names of this machine: `localhost`, `127.0.0.0/8` and `[::1]`. */
const isLoopback = (host: string): boolean => {
  const name = host.toLowerCase();
  if (name === 'localhost' || name === '[::1]') return true;
  const parts = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  return parts !== null && parts.slice(1).every(part => Number(part) <= 255);
};

function parseOrigin(value: unknown): { origin: string; secure: boolean } | null {
  if (typeof value !== 'string' || value.length > 300) return null;
  const match = /^(https?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?\/?$/.exec(
    value.trim(),
  );
  if (!match) return null;
  return {
    origin: `${match[1]}://${match[2]}${match[3] ?? ''}`,
    secure: match[1] === 'https' || isLoopback(match[2]!),
  };
}

/**
 * The origin without a trailing slash, or null when it is not a plain http(s)
 * address. Plain http is taken for this machine only: the token travels there.
 */
export function cleanOrigin(value: unknown): string | null {
  const parsed = parseOrigin(value);
  return parsed?.secure ? parsed.origin : null;
}

/** True for a well-formed address that is refused only because it is http to another machine. */
export const isInsecureOrigin = (value: unknown): boolean => parseOrigin(value)?.secure === false;

/** The origin a running server wrote into `server-runtime.json`. */
export function decodeRuntimeState(text: string): string | null {
  try {
    const state: unknown = JSON.parse(text);
    return isObject(state) ? cleanOrigin(state.origin) : null;
  } catch {
    return null;
  }
}

export interface Descriptor {
  environmentId: string;
  /** Null when the server is too old to say. */
  version: number | null;
  threadStop: boolean;
  shellThreadFamilies: boolean;
  shellOlderSettled: boolean;
}

/** The answer of `/.well-known/t3/environment`. */
export function decodeDescriptor(text: string): Descriptor | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(json)) return null;
  const environmentId = id(json.environmentId);
  if (!environmentId) return null;
  const version = json.orchestrationProtocolVersion;
  const capabilities = isObject(json.capabilities) ? json.capabilities : {};
  return {
    environmentId,
    version: typeof version === 'number' && Number.isInteger(version) ? version : null,
    threadStop: capabilities.threadStop === true,
    shellThreadFamilies: capabilities.shellThreadFamilies === true,
    shellOlderSettled: capabilities.shellOlderSettled === true,
  };
}

export const isCompatible = (descriptor: Descriptor): boolean =>
  descriptor.version === PROTOCOL_VERSION;

/** The ticket of `/api/auth/websocket-ticket/rpc`. */
export function decodeTicket(text: string): string | null {
  try {
    const json: unknown = JSON.parse(text);
    const ticket = isObject(json) ? json.ticket : null;
    return typeof ticket === 'string' && ticket.length > 0 && ticket.length <= 4096 ? ticket : null;
  } catch {
    return null;
  }
}

export const descriptorUrl = (origin: string): string => `${origin}/.well-known/t3/environment`;
export const ticketUrl = (origin: string): string => `${origin}/api/auth/websocket-ticket/rpc`;

export function socketUrl(origin: string, ticket: string): string {
  const base = origin.replace(/^http/, 'ws');
  return `${base}/ws?orchestrationProtocol=${PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket)}`;
}

/** The scheme the desktop app of T3 Code registers for its links. */
export const APP_SCHEME = 't3code';

/** The link that opens a thread in the desktop app (`promptLinkAppPath` in `packages/shared`). */
export const threadAppLink = (environmentId: string, threadId: string): string =>
  `${APP_SCHEME}://threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;

/** The address that opens a thread of T3 Code in the browser. */
export const threadLink = (origin: string, environmentId: string, threadId: string): string =>
  `${origin}/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;

// --- frames ---

type ServerFrame =
  | { tag: 'chunk'; requestId: string; values: unknown[] }
  | { tag: 'exit'; requestId: string; ok: true; value: unknown }
  | { tag: 'exit'; requestId: string; ok: false; error: string }
  | { tag: 'ping' }
  | { tag: 'pong' }
  | { tag: 'defect' };

const requestIdOf = (frame: Json): string | null =>
  typeof frame.requestId === 'number' ? String(frame.requestId) : id(frame.requestId);

/** What went wrong, from the `cause` of a failed exit. Never empty. */
function failureText(exit: Json): string {
  const causes = Array.isArray(exit.cause) ? exit.cause : [];
  for (const cause of causes) {
    if (!isObject(cause)) continue;
    const error = cause._tag === 'Fail' ? cause.error : cause.defect;
    const text = isObject(error)
      ? clean(error.message, MAX_ERROR) || clean(error._tag, MAX_ERROR)
      : clean(error, MAX_ERROR);
    if (text) return text;
  }
  return 'failed';
}

function decodeFrame(frame: unknown): ServerFrame | null {
  if (!isObject(frame)) return null;
  switch (frame._tag) {
    case 'Chunk': {
      const requestId = requestIdOf(frame);
      return requestId && Array.isArray(frame.values)
        ? { tag: 'chunk', requestId, values: frame.values }
        : null;
    }
    case 'Exit': {
      const requestId = requestIdOf(frame);
      if (!requestId || !isObject(frame.exit)) return null;
      return frame.exit._tag === 'Success'
        ? { tag: 'exit', requestId, ok: true, value: frame.exit.value }
        : { tag: 'exit', requestId, ok: false, error: failureText(frame.exit) };
    }
    case 'Ping':
      return { tag: 'ping' };
    case 'Pong':
      return { tag: 'pong' };
    case 'Defect':
    case 'ClientProtocolError':
      return { tag: 'defect' };
    default:
      return null;
  }
}

/** The frames of one socket message: one JSON value, an object or a list. Unknown ones are dropped. */
export function decodeFrames(text: string): ServerFrame[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const frames = Array.isArray(json) ? json : [json];
  return frames.map(decodeFrame).filter(frame => frame !== null);
}

export const requestFrame = (requestId: string, method: string, payload: unknown): string =>
  JSON.stringify({ _tag: 'Request', id: requestId, tag: method, payload, headers: [] });
export const ackFrame = (requestId: string): string => JSON.stringify({ _tag: 'Ack', requestId });
export const PONG_FRAME = JSON.stringify({ _tag: 'Pong' });

// --- commands ---

export const subscribeShellPayload = (descriptor: Descriptor): Json => ({
  ...(descriptor.shellThreadFamilies ? { omitIdleSubagents: true } : {}),
  ...(descriptor.shellOlderSettled ? { omitOlderSettled: true } : {}),
});

export const respondCommand = (
  commandId: string,
  threadId: string,
  requestId: string,
  decision: 'accept' | 'decline',
): Json => ({ type: 'runtime-request.respond', commandId, threadId, requestId, decision });

export const replyCommand = (
  commandId: string,
  messageId: string,
  threadId: string,
  text: string,
): Json => ({
  type: 'message.dispatch',
  commandId,
  createdBy: 'user',
  creationSource: 'web',
  threadId,
  messageId,
  text: text.slice(0, MAX_REPLY),
  attachments: [],
  deliveryIntent: 'auto',
  dispatchMode: { type: 'start_immediately' },
});

/** Servers without `threadStop` stop the run they are told. */
export function stopCommand(
  commandId: string,
  session: Pick<Session, 'id' | 'runId'>,
  descriptor: Pick<Descriptor, 'threadStop'>,
): Json | null {
  if (descriptor.threadStop) return { type: 'thread.stop', commandId, threadId: session.id };
  if (!session.runId) return null;
  return { type: 'run.interrupt', commandId, threadId: session.id, runId: session.runId };
}

/** A new thread in the project of `like`, with its model and mode. */
export function launchPayload(
  ids: { commandId: string; threadId: string; messageId: string },
  like: Session,
  text: string,
): Json | null {
  if (!like.launch) return null;
  const message = text.slice(0, MAX_REPLY);
  return {
    commandId: ids.commandId,
    creationSource: 'web',
    threadId: ids.threadId,
    projectId: like.projectId,
    title: clean(message, MAX_TITLE) || 'New thread',
    generateTitle: true,
    ...like.launch,
    workspaceStrategy: { type: 'root' },
    initialMessage: { messageId: ids.messageId, text: message, attachments: [] },
  };
}

/** What an approval asks about, as far as Visor can show it. */
export interface Prompt {
  /** What is shown. Differs from the command when `exact` is false. */
  text: string;
  /**
   * True when `text` is the whole command and reads as it runs. False when it
   * was cut at MAX_COMMAND or holds characters that cannot be shown.
   */
  exact: boolean;
  /** True when characters that cannot be shown were replaced by U+FFFD. */
  hidden: boolean;
}

/**
 * Characters that are invisible or change how the text around them reads:
 * format characters (bidi controls, zero-width ones, the BOM), control
 * characters other than line break and tab, and lone surrogates.
 */
const UNREADABLE = /[\p{Cf}\p{Cs}]|[^\P{Cc}\n\t]/gu;

/**
 * A command as it is shown. Nothing is stripped, because then the shown text
 * would not be the one that runs: what cannot be shown becomes U+FFFD and the
 * command counts as not exact. Null when there is nothing to show.
 */
export function commandPrompt(value: unknown): Prompt | null {
  if (typeof value !== 'string') return null;
  const cut = value.length > MAX_COMMAND;
  const raw = cut ? value.slice(0, MAX_COMMAND - 1) : value;
  const replaced = raw.replace(UNREADABLE, '�');
  const hidden = replaced !== raw;
  const text = replaced
    .replace(/[\p{Zl}\p{Zp}]/gu, '\n')
    .replace(/\t/g, '  ')
    .replace(/[ ]+$/gm, '')
    .replace(/^\n+|\n+$/g, '');
  if (!text) return null;
  return { text: cut ? `${text}…` : text, exact: !cut && !hidden, hidden };
}

/**
 * The whole command or file an approval asks about, from the answer of
 * getThreadProjection. Null when the answer does not say: then the request
 * can only be answered in T3 Code.
 */
export function approvalPrompt(projection: unknown, requestId: string): Prompt | null {
  const items =
    isObject(projection) && Array.isArray(projection.turnItems) ? projection.turnItems : [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item: unknown = items[i];
    if (isObject(item) && item.type === 'approval_request' && item.requestId === requestId)
      return commandPrompt(item.prompt) ?? commandPrompt(item.reason);
  }
  return null;
}

/** The one line a collapsed row shows of a command. */
export const promptPreview = (prompt: Prompt): string => clean(prompt.text, MAX_DETAIL);

/** Columns a text takes in a monospace font: 2 for everything beyond ASCII, to be safe. */
function columns(text: string): number {
  let count = 0;
  for (const char of text) count += char.codePointAt(0)! < 0x7f ? 1 : 2;
  return count;
}

/**
 * True when the one-line preview shows the command whole and as it runs, so
 * it can be allowed from there. Counts what the preview shows.
 */
export const fitsPreview = (prompt: Prompt): boolean =>
  prompt.exact && promptPreview(prompt) === prompt.text && columns(prompt.text) <= PREVIEW_CHARS;

/** The lines the expanded row shows of a command, see `.visor-t3-command`. */
const COMMAND_LINES = 8;
/**
 * What one wrapped line holds for certain. The narrowest column gives the
 * command about 32 columns, and wrapping at words wastes less than half of two
 * lines in a row, so 16 per line is safe.
 */
export const COMMAND_LINE_CHARS = 16;

/**
 * The text the expanded row gets: the first COMMAND_LINES lines by line break.
 * Pango keeps a line of every paragraph however little room there is, so more
 * of them would be drawn below the box instead of being cut.
 */
export function commandLines(text: string): string {
  const lines = text.split('\n');
  return lines.length <= COMMAND_LINES ? text : `${lines.slice(0, COMMAND_LINES).join('\n')}…`;
}

/**
 * True when the expanded row surely shows the command whole and as it runs.
 * Decided from the text alone, before any layout: a wrong "yes" would offer
 * Allow for a command whose end is not on screen.
 */
export function fitsExpanded(prompt: Prompt): boolean {
  if (!prompt.exact) return false;
  let lines = 0;
  for (const line of prompt.text.split('\n'))
    lines += Math.max(1, Math.ceil(columns(line) / COMMAND_LINE_CHARS));
  return lines <= COMMAND_LINES;
}

/** How often the command of a request is asked for before it counts as unknown for good. */
const PROMPT_TRIES = 3;

/** The wait before the command is asked for again after `failures` failures; null: not again. */
export const promptRetryMs = (failures: number): number | null =>
  failures >= PROMPT_TRIES ? null : 1000 * 2 ** Math.max(0, failures - 1);

/** How long a request that took the place of another one ignores Allow and Deny. */
export const ANSWER_GUARD_MS = 500;

/**
 * True when a click on a button rendered for `requestId` may answer: the row
 * still waits for that request, and not only since a moment ago, when the
 * click may have been meant for the request before it.
 */
export const mayAnswer = (
  current: { id: string; since: number } | undefined,
  requestId: string | null,
  now: number,
): boolean =>
  current !== undefined && current.id === requestId && now - current.since >= ANSWER_GUARD_MS;

// --- the threads ---

type RequestKind = 'command' | 'file' | 'permission' | 'question';

interface Thread {
  id: string;
  projectId: string;
  title: string;
  parentId: string | null;
  listed: boolean;
  /** `activityRunStatus ?? status`. */
  status: string;
  request: { id: string; kind: RequestKind; createdAt: number } | null;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
  stopRequested: boolean;
  settled: boolean;
  gone: boolean;
  runId: string | null;
  lastMessage: string;
  lastError: string;
  launch: Json | null;
}

export interface ShellState {
  /** Titles by project id. */
  projects: Map<string, string>;
  threads: Map<string, Thread>;
}

export const emptyShell = (): ShellState => ({ projects: new Map(), threads: new Map() });

const REQUEST_KINDS: Record<string, RequestKind> = {
  command: 'command',
  'file-read': 'file',
  'file-change': 'file',
  permission: 'permission',
  'mcp-elicitation': 'permission',
  dynamic_tool_call: 'permission',
  user_input: 'question',
};

function decodeThread(value: unknown): Thread | null {
  if (!isObject(value)) return null;
  const threadId = id(value.id);
  if (!threadId) return null;
  const lineage = isObject(value.lineage) ? value.lineage : {};
  const pending = isObject(value.pendingRuntimeRequest) ? value.pendingRuntimeRequest : null;
  const requestId = pending ? id(pending.id) : null;
  const kind =
    pending && typeof pending.kind === 'string' ? REQUEST_KINDS[pending.kind] : undefined;
  const status =
    typeof value.activityRunStatus === 'string' ? value.activityRunStatus : value.status;
  const message = isObject(value.latestVisibleMessage) ? value.latestVisibleMessage : null;
  const { modelSelection, runtimeMode, interactionMode } = value;
  const updatedAt = time(value.updatedAt) ?? 0;
  return {
    id: threadId,
    projectId: id(value.projectId) ?? '',
    title: clean(value.title, MAX_TITLE),
    parentId: id(lineage.parentThreadId),
    listed: lineage.relationshipToParent !== 'subagent' && lineage.sideChat !== true,
    status: typeof status === 'string' ? status.slice(0, 32) : 'idle',
    request:
      requestId && kind
        ? { id: requestId, kind, createdAt: time(pending?.createdAt) ?? updatedAt }
        : null,
    startedAt: time(value.activityRunStartedAt) ?? time(value.latestRunStartedAt),
    completedAt: time(value.latestRunCompletedAt),
    updatedAt,
    stopRequested: value.latestRunStopRequested === true,
    settled: value.settledOverride === 'settled',
    gone: Boolean(value.archivedAt) || Boolean(value.deletedAt),
    runId: id(value.activeRunId),
    lastMessage: message?.role === 'assistant' ? clean(message.text, MAX_MESSAGE) : '',
    lastError: clean(value.lastError, MAX_ERROR),
    launch:
      isObject(modelSelection) &&
      typeof runtimeMode === 'string' &&
      typeof interactionMode === 'string'
        ? { modelSelection, runtimeMode, interactionMode }
        : null,
  };
}

function setProject(state: ShellState, value: unknown): boolean {
  if (!isObject(value)) return false;
  const projectId = id(value.id);
  if (!projectId) return false;
  state.projects.set(projectId, clean(value.title, MAX_PROJECT));
  return true;
}

/** True for the item that carries the whole state, the first of a shell stream. */
export const isSnapshot = (item: unknown): boolean => isObject(item) && item.kind === 'snapshot';

/** Applies one item of the shell stream. Returns whether the state changed. */
export function applyShellItem(state: ShellState, item: unknown): boolean {
  if (!isObject(item)) return false;
  switch (item.kind) {
    case 'snapshot': {
      const snapshot = isObject(item.snapshot) ? item.snapshot : {};
      state.projects.clear();
      state.threads.clear();
      for (const project of Array.isArray(snapshot.projects) ? snapshot.projects : [])
        setProject(state, project);
      for (const value of Array.isArray(snapshot.threads) ? snapshot.threads : []) {
        const thread = decodeThread(value);
        if (thread) state.threads.set(thread.id, thread);
      }
      return true;
    }
    case 'thread.updated': {
      const thread = decodeThread(item.thread);
      if (!thread) return false;
      if (item.location === 'archive') return state.threads.delete(thread.id);
      state.threads.set(thread.id, thread);
      return true;
    }
    case 'thread.removed': {
      const threadId = id(item.threadId);
      return threadId !== null && state.threads.delete(threadId);
    }
    case 'project.updated':
      return setProject(state, item.project);
    case 'project.removed': {
      const projectId = id(item.projectId);
      return projectId !== null && state.projects.delete(projectId);
    }
    default:
      return false;
  }
}

// --- what Visor shows ---

type Phase = 'starting' | 'working' | 'approval' | 'question' | 'done' | 'error';

export interface Session {
  /** The thread id. */
  id: string;
  title: string;
  projectId: string;
  project: string;
  phase: Phase;
  /** What it waits for; `threadId` is the thread that asked, which may be a subagent. */
  request: { id: string; kind: RequestKind; threadId: string } | null;
  /** When the run began, for the elapsed time. */
  startedAt: number | null;
  /** When a finished session loses its row. */
  until: number | null;
  updatedAt: number;
  runId: string | null;
  lastMessage: string;
  error: string;
  launch: Json | null;
}

export const isWaiting = (session: Session): boolean =>
  session.phase === 'approval' || session.phase === 'question';

function phaseOf(thread: Thread): Exclude<Phase, 'approval' | 'question'> | null {
  switch (thread.status) {
    case 'preparing':
    case 'starting':
      return 'starting';
    case 'running':
    case 'waiting':
      return 'working';
    case 'completed':
      return thread.stopRequested || thread.settled ? null : 'done';
    case 'failed':
      return thread.settled ? null : 'error';
    default:
      return null;
  }
}

const RANK: Record<Phase, number> = {
  approval: 0,
  question: 0,
  starting: 1,
  working: 1,
  error: 2,
  done: 2,
};

/**
 * The sessions worth a row at `now`: waiting ones first (the one that waits
 * longest on top), then the running ones, then what finished in the last two
 * minutes.
 */
export function sessionsOf(state: ShellState, now: number): Session[] {
  // A request of a subagent makes the thread wait that the user sees.
  const requests = new Map<string, NonNullable<Session['request']> & { createdAt: number }>();
  for (const thread of state.threads.values()) {
    if (!thread.request || thread.gone) continue;
    let owner: Thread | undefined = thread;
    for (let depth = 0; owner && !owner.listed && depth < 16; depth++)
      owner = owner.parentId ? state.threads.get(owner.parentId) : undefined;
    if (!owner?.listed || owner.gone) continue;
    const known = requests.get(owner.id);
    if (!known || thread.request.createdAt < known.createdAt)
      requests.set(owner.id, { ...thread.request, threadId: thread.id });
  }

  const sessions: (Session & { order: number })[] = [];
  for (const thread of state.threads.values()) {
    if (!thread.listed || thread.gone) continue;
    const request = requests.get(thread.id);
    let phase: Phase | null = phaseOf(thread);
    if (request) phase = request.kind === 'question' ? 'question' : 'approval';
    if (!phase) continue;
    const finished = phase === 'done' || phase === 'error';
    const until = finished ? (thread.completedAt ?? thread.updatedAt) + DONE_MS : null;
    if (until !== null && until <= now) continue;
    sessions.push({
      id: thread.id,
      title: thread.title,
      projectId: thread.projectId,
      project: state.projects.get(thread.projectId) ?? '',
      phase,
      request: request ? { id: request.id, kind: request.kind, threadId: request.threadId } : null,
      startedAt: thread.startedAt,
      until,
      updatedAt: thread.updatedAt,
      runId: thread.runId,
      lastMessage: thread.lastMessage,
      error: phase === 'error' ? thread.lastError : '',
      launch: thread.launch,
      // Waiting: oldest request first. Otherwise: newest first.
      order: request ? request.createdAt : -(until ?? thread.startedAt ?? thread.updatedAt),
    });
  }
  sessions.sort(
    (a, b) => RANK[a.phase] - RANK[b.phase] || a.order - b.order || (a.id < b.id ? -1 : 1),
  );
  return sessions.map(({ order: _order, ...session }) => session);
}

/** The thread a message from the search goes to: the one that was active last. */
export function lastActive(state: ShellState): Session | null {
  let best: Thread | null = null;
  for (const thread of state.threads.values()) {
    if (!thread.listed || thread.gone) continue;
    if (!best || thread.updatedAt > best.updatedAt) best = thread;
  }
  if (!best) return null;
  return {
    id: best.id,
    title: best.title,
    projectId: best.projectId,
    project: state.projects.get(best.projectId) ?? '',
    phase: 'working',
    request: null,
    startedAt: best.startedAt,
    until: null,
    updatedAt: best.updatedAt,
    runId: best.runId,
    lastMessage: best.lastMessage,
    error: '',
    launch: best.launch,
  };
}

/** The rows and how many sessions are behind "+ n more". */
export function visibleSessions(
  sessions: Session[],
  showAll: boolean,
  max = 3,
): { shown: Session[]; more: number } {
  if (showAll || sessions.length <= max) return { shown: sessions, more: 0 };
  return { shown: sessions.slice(0, max), more: sessions.length - max };
}

/** The next wait of the reconnect: 1 s, 2 s, 4 s … 60 s. */
export const backoffSeconds = (attempt: number): number => Math.min(60, 2 ** Math.min(attempt, 6));
