// Wire fixtures for the T3 Code mock and the unit tests, in the shapes of
// packages/contracts/src/orchestrationV2.ts (see docs/protocol.md). The
// approval is the one of the testkit fixture `subagent_v2_approval`: a subagent
// asks to run a shell command and its parent thread waits.

export const ENVIRONMENT_ID = '5d0c7a52-7f0e-4f0e-9d53-6f1f3b1f0001';
export const PROJECT_ID = 'project-visor';
export const APPROVAL_COMMAND = "printf 'subagent approval fixture' > subagent-approval.txt";

export const descriptor = (version = 2, environmentId = ENVIRONMENT_ID, label = 'mock') => ({
  environmentId,
  label,
  platform: { os: 'linux', arch: 'x64' },
  serverVersion: '0.0.0-mock',
  orchestrationProtocolVersion: version,
  capabilities: {
    repositoryIdentity: true,
    threadStop: true,
    shellThreadFamilies: true,
    shellOlderSettled: true,
  },
});

export const project = (overrides = {}) => ({
  id: PROJECT_ID,
  title: 'visor',
  workspaceRoot: '/home/dev/visor',
  defaultModelSelection: null,
  scripts: [],
  createdAt: '2026-11-01T08:00:00.000Z',
  updatedAt: '2026-11-01T08:00:00.000Z',
  ...overrides,
});

const iso = ms => new Date(ms).toISOString();

/** A thread shell. `now` anchors the times, `overrides` wins over everything. */
export function thread(id, now, overrides = {}) {
  return {
    createdBy: 'user',
    creationSource: 'web',
    id,
    projectId: PROJECT_ID,
    title: id,
    providerInstanceId: 'codex',
    modelSelection: { instanceId: 'codex', model: 'gpt-5.5' },
    runtimeMode: 'approval-required',
    interactionMode: 'default',
    branch: null,
    worktreePath: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: null,
    activeRunId: null,
    status: 'idle',
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: iso(now - 3_600_000),
    updatedAt: iso(now - 60_000),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    ...overrides,
  };
}

const message = (text, now) => ({ id: 'message-1', role: 'assistant', text, updatedAt: iso(now) });

export const running = (id, now, overrides = {}) =>
  thread(id, now, {
    status: 'running',
    activityRunStatus: 'running',
    activeRunId: `run-${id}`,
    latestRunId: `run-${id}`,
    latestRunStartedAt: iso(now - 256_000),
    activityRunStartedAt: iso(now - 256_000),
    updatedAt: iso(now - 5_000),
    ...overrides,
  });

export const completed = (id, now, overrides = {}) =>
  thread(id, now, {
    status: 'completed',
    latestRunId: `run-${id}`,
    latestRunStartedAt: iso(now - 600_000),
    latestRunCompletedAt: iso(now - 20_000),
    updatedAt: iso(now - 20_000),
    ...overrides,
  });

export const failed = (id, now, overrides = {}) =>
  completed(id, now, {
    status: 'failed',
    lastError: 'The provider process exited with code 1.',
    latestRunCompletedAt: iso(now - 40_000),
    updatedAt: iso(now - 40_000),
    ...overrides,
  });

export const pendingRequest = (id, now, kind = 'command') => ({
  id,
  kind,
  createdAt: iso(now - 12_000),
});

/** The subagent of `parentId` that asks for approval, as in `subagent_v2_approval`. */
export const waitingSubagent = (id, parentId, now, requestId = 'request-1') =>
  running(id, now, {
    title: 'Run the shell command',
    lineage: { parentThreadId: parentId, relationshipToParent: 'subagent', rootThreadId: parentId },
    status: 'waiting',
    activityRunStatus: 'waiting',
    pendingRuntimeRequest: pendingRequest(requestId, now),
  });

/** The turn item that says what an approval asks. */
export const approvalItem = (requestId, prompt = APPROVAL_COMMAND) => ({
  id: `item-${requestId}`,
  type: 'approval_request',
  requestId,
  requestKind: 'command',
  prompt,
});

/** Named sets of threads. Each returns `{threads, prompts}`; prompts are by request id. */
export const FIXTURES = {
  /** Waiting (through a subagent), running, done, failed, plus threads that have no row. */
  default(now) {
    return {
      threads: [
        running('thread-wait', now, {
          title: 'Spawn a subagent for the fixture',
          latestVisibleMessage: message(
            'I asked a subagent to write the fixture file.\nIt needs your approval to run the command.',
            now,
          ),
        }),
        waitingSubagent('thread-wait-child', 'thread-wait', now),
        running('thread-run', now, {
          title: 'Fix the flaky websocket test',
          updatedAt: iso(now - 2_000),
          latestVisibleMessage: message('Running the test suite again to confirm the fix.', now),
        }),
        completed('thread-done', now, {
          title: 'Update the changelog',
          latestVisibleMessage: message('Written.', now),
        }),
        failed('thread-error', now, { title: 'Bump dependencies' }),
        thread('thread-idle', now, { title: 'An idle thread' }),
        completed('thread-old', now, {
          title: 'Finished long ago',
          latestRunCompletedAt: iso(now - 3_000_000),
          updatedAt: iso(now - 3_000_000),
        }),
      ],
      prompts: { 'request-1': APPROVAL_COMMAND },
    };
  },
  /** One waiting, one running, one done: the screenshot. */
  shots(now) {
    const { threads, prompts } = FIXTURES.default(now);
    return { threads: threads.filter(t => t.id !== 'thread-error'), prompts };
  },
  /** Nothing runs. */
  empty(now) {
    return { threads: [thread('thread-idle', now, { title: 'An idle thread' })], prompts: {} };
  },
};

export const snapshotItem = threads => ({
  kind: 'snapshot',
  snapshot: {
    schemaVersion: 1,
    snapshotSequence: 1,
    projects: [project()],
    threads,
    archivedThreads: [],
  },
});

/** What the server sends after the first snapshot: projects of resolved repositories, never threads. */
export const enrichmentItem = () => ({
  kind: 'snapshot',
  snapshot: {
    schemaVersion: 1,
    snapshotSequence: 1,
    projects: [project()],
    threads: [],
    archivedThreads: [],
  },
  resolvedRepositoryIdentityRoots: ['/home/user/project'],
});
