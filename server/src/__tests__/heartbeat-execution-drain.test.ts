import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const { mockAdapterExecute, beforeComment, afterComment } = vi.hoisted(() => ({
  mockAdapterExecute: vi.fn(),
  beforeComment: vi.fn<() => Promise<void>>(),
  afterComment: vi.fn<() => void>(),
}));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute }) };
});

// Keep the real writer and database. The adapter arms this gate only after its
// setup comments; the next addComment is executeRun's post-terminal summary.
vi.mock("../services/issues.ts", async () => {
  const actual = await vi.importActual<typeof import("../services/issues.ts")>("../services/issues.ts");
  return {
    ...actual,
    issueService: (...args: Parameters<typeof actual.issueService>) => {
      const service = actual.issueService(...args);
      return {
        ...service,
        addComment: async (...commentArgs: Parameters<typeof service.addComment>) => {
          await beforeComment();
          const comment = await service.addComment(...commentArgs);
          afterComment();
          return comment;
        },
      };
    },
  };
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const result = { exitCode: 0, signal: null, timedOut: false, summary: "Controlled drain summary." };
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("heartbeat execution drain", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-drain-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    vi.useRealTimers();
    await heartbeat.drainActiveRunExecutions({ timeoutMs: 5_000 });
    vi.restoreAllMocks();
    mockAdapterExecute.mockReset();
    beforeComment.mockReset();
    afterComment.mockReset();
  });

  afterAll(async () => { await tempDb?.cleanup(); });

  async function fixture(withIssue = true) {
    mockAdapterExecute.mockImplementation(async () => result);
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Drain test", issuePrefix: `T${companyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Drain agent", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, permissions: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    });
    if (withIssue) await db.insert(issues).values({ id: issueId, companyId, title: "Drain issue", status: "in_progress", assigneeAgentId: agentId });
    return { companyId, agentId, issueId };
  }

  async function heldSummary() {
    const ids = await fixture();
    const entered = deferred();
    const release = deferred();
    const trace: string[] = [];
    mockAdapterExecute.mockImplementationOnce(async () => {
      // Finish the assigned work so liveness recovery does not create unrelated
      // follow-up runs; the service still writes its own terminal summary.
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, ids.issueId));
      afterComment.mockImplementationOnce(() => { trace.push("post-terminal-comment-inserted"); });
      beforeComment.mockImplementationOnce(async () => {
        trace.push("post-terminal-writer-held");
        entered.resolve();
        await release.promise;
        trace.push("post-terminal-writer-released");
      });
      return result;
    });
    const run = await heartbeat.wakeup(ids.agentId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: ids.issueId }, contextSnapshot: { issueId: ids.issueId, wakeReason: "issue_assigned" },
    });
    await entered.promise;
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    expect(stored.status).toBe("succeeded");
    trace.push("terminal-status-confirmed");
    return { ...ids, entered, release, trace };
  }

  // Same critical order as the dependency suite: barrier, mock/process reset,
  // comments deletion, then issue deletion. No second delete or FK suppression.
  async function cleanupFixture(companyId: string, trace: string[], afterComments: () => Promise<void>, timeoutMs = 5_000) {
    await heartbeat.drainActiveRunExecutions({ timeoutMs });
    trace.push("mock-reset");
    mockAdapterExecute.mockReset();
    runningProcesses.clear();
    await db.delete(issueComments).where(eq(issueComments.companyId, companyId));
    trace.push("comments-deleted");
    await afterComments();
    trace.push("issues-delete-attempt");
    await db.delete(issues).where(eq(issues.companyId, companyId));
    trace.push("issues-deleted");
  }

  it("C1 waits for the actual post-terminal write before cleanup", async () => {
    const held = await heldSummary();
    const drainEntered = deferred();
    const commentsDeleted = deferred();
    const writerFinished = deferred();
    const originalDrain = heartbeat.drainActiveRunExecutions;
    vi.spyOn(heartbeat, "drainActiveRunExecutions").mockImplementation((options) => {
      const draining = originalDrain(options);
      drainEntered.resolve();
      return draining;
    });
    const cleanup = cleanupFixture(held.companyId, held.trace, async () => {
      commentsDeleted.resolve();
      await writerFinished.promise;
    });
    try {
      // With the barrier: drain entry wins. Under ablation: comments deletion
      // wins. Both schedules hold the identical real writer until this handshake.
      const first = await Promise.race([
        drainEntered.promise.then(() => "drain"),
        commentsDeleted.promise.then(() => "comments-deleted"),
      ]);
      held.release.resolve();
      await originalDrain({ timeoutMs: 5_000 });
      if (first === "comments-deleted") {
        const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, held.issueId));
        expect(comments.length).toBeGreaterThan(0);
        held.trace.push("post-terminal-comment-present-after-delete");
      }
      writerFinished.resolve();
      await cleanup;
      expect(held.trace.indexOf("mock-reset")).toBeGreaterThan(held.trace.indexOf("post-terminal-comment-inserted"));
      expect(held.trace.at(-1)).toBe("issues-deleted");
      console.info("C1 trace", held.trace);
    } finally {
      console.info("drain causal trace", held.trace);
      held.release.resolve();
      writerFinished.resolve();
      await originalDrain({ timeoutMs: 5_000 });
    }
  });

  it("C3 rejects with a named timeout before cleanup while the writer stays held", async () => {
    const held = await heldSummary();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const cleanup = cleanupFixture(held.companyId, held.trace, async () => {}, 25);
      const assertion = expect(cleanup).rejects.toThrow("Timed out waiting for heartbeat run executions to drain after 25ms");
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
      expect(held.trace).toEqual(["post-terminal-writer-held", "terminal-status-confirmed"]);
      expect(vi.getTimerCount()).toBe(0);
      console.info("C3: Timed out waiting for heartbeat run executions to drain after 25ms; cleanup operations = 0; gate never fulfilled");
    } finally {
      vi.useRealTimers();
      // Abort the test writer after the timeout assertion; never fulfill its gate.
      // Join executeRun before stopping Postgres, even on an assertion failure.
      held.release.reject(new Error("Controlled writer aborted after timeout proof"));
      await heartbeat.drainActiveRunExecutions({ timeoutMs: 5_000 });
    }
  });

  it("drains a queued successor dispatched during the parent's finally", async () => {
    const ids = await fixture(false);
    const firstEntered = deferred();
    const firstRelease = deferred();
    const secondEntered = deferred();
    const secondRelease = deferred();
    mockAdapterExecute.mockImplementationOnce(async () => { firstEntered.resolve(); await firstRelease.promise; return result; });
    mockAdapterExecute.mockImplementationOnce(async () => { secondEntered.resolve(); await secondRelease.promise; return result; });
    let draining: Promise<void> | undefined;
    try {
      await heartbeat.wakeup(ids.agentId, { source: "manual", reason: "drain_first" });
      await firstEntered.promise;
      // Insert a distinct queued run: a second unscoped wake may coalesce with
      // the first. Only executeRun's finally can dispatch this row.
      const [second] = await db.insert(heartbeatRuns).values({
        companyId: ids.companyId, agentId: ids.agentId, status: "queued",
        invocationSource: "manual", contextSnapshot: {},
      }).returning();
      let drained = false;
      draining = heartbeat.drainActiveRunExecutions({ timeoutMs: 5_000 }).then(() => { drained = true; });
      firstRelease.resolve();
      await secondEntered.promise;
      expect(drained).toBe(false);
      secondRelease.resolve();
      await draining;
      const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, second.id));
      expect(stored.status).toBe("succeeded");
      expect(mockAdapterExecute).toHaveBeenCalledTimes(2);
    } finally {
      firstRelease.resolve();
      secondRelease.resolve();
      await draining;
      await heartbeat.drainActiveRunExecutions({ timeoutMs: 5_000 });
    }
  });

  it("drains an empty service and rejects invalid deadlines", async () => {
    await expect(heartbeat.drainActiveRunExecutions({ timeoutMs: 0 })).resolves.toBeUndefined();
    for (const timeoutMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(heartbeat.drainActiveRunExecutions({ timeoutMs })).rejects.toThrow(RangeError);
    }
  });
});
