import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentTaskSessions,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

// AF-OBS-006 (canatac/paperclip-fleet#68): PostgreSQL rejects U+0000 in jsonb,
// so task session parameters containing it are not recorded. The run keeps its
// outcome, the previous task session stays as it was, and a warning is logged.
// The NUL sits in a parameter other than sessionId, as in the Hermes case
// (hermesRunId): the adapters also copy sessionId into text columns of the run.

const adapterExecute = vi.hoisted(() => vi.fn());

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  runningProcesses: new Map(),
}));

import { logger } from "../middleware/logger.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres task session NUL tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function succeeded(sessionParams: Record<string, unknown>) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    provider: "codex_local",
    model: "codex-test",
    summary: "Run finished.",
    resultJson: { status: "completed" },
    sessionParams,
    sessionDisplayId: null,
  };
}

function loggedMessages(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.map((call) => call.find((arg) => typeof arg === "string"));
}

describeEmbeddedPostgres("heartbeat task session parameters containing NUL", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const projectId = randomUUID();
  const projectWorkspaceId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-task-session-nul-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: false });
    await db.insert(companies).values({
      id: companyId,
      name: "Task session NUL",
      issuePrefix: "TSN",
      status: "active",
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Sessions", status: "active" });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      isPrimary: true,
    });
  }, 30_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (temporary) {
      await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
      await temporary.cleanup();
    }
  });

  async function createAgentWithTask() {
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent ${agentId.slice(0, 8)}`,
      adapterType: "codex_local",
      adapterConfig: {},
      status: "idle",
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Record the task session",
      status: "in_progress",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    return { agentId, issueId };
  }

  async function runOnce(agentId: string, issueId: string, result: unknown) {
    adapterExecute.mockImplementationOnce(async () => result);
    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, skipIssueComment: true },
    });
    expect(queued).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id));
    return row!;
  }

  function taskSessions(agentId: string) {
    return db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, agentId));
  }

  it("records session parameters without NUL", async () => {
    const { agentId, issueId } = await createAgentWithTask();
    const row = await runOnce(agentId, issueId, succeeded({ sessionId: "session-plain" }));
    expect(row.status).toBe("succeeded");
    const sessions = await taskSessions(agentId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionParamsJson).toMatchObject({ sessionId: "session-plain" });
    expect(sessions[0]!.lastRunId).toBe(row.id);
  }, 30_000);

  it("does not record session parameters containing NUL and logs a warning instead of an error", async () => {
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");
    const { agentId, issueId } = await createAgentWithTask();
    const row = await runOnce(agentId, issueId, succeeded({ sessionId: "session-1", cursor: "a\u0000b" }));
    expect(row.status).toBe("succeeded");
    expect(await taskSessions(agentId)).toHaveLength(0);
    expect(loggedMessages(error)).not.toContain("heartbeat execution failed");
    expect(loggedMessages(warn)).toContain(
      "task session parameters contain a NUL character; the task session is not recorded",
    );
  }, 30_000);

  it("checks nested values and keys", async () => {
    const { agentId, issueId } = await createAgentWithTask();
    await runOnce(agentId, issueId, succeeded({ sessionId: "s", nested: [{ value: "a\u0000b" }] }));
    await runOnce(agentId, issueId, succeeded({ sessionId: "s", nested: { ["ke\u0000y"]: "v" } }));
    expect(await taskSessions(agentId)).toHaveLength(0);
  }, 60_000);

  it("keeps the previous task session when the new parameters contain NUL", async () => {
    const { agentId, issueId } = await createAgentWithTask();
    const first = await runOnce(agentId, issueId, succeeded({ sessionId: "session-1" }));
    const second = await runOnce(agentId, issueId, succeeded({ sessionId: "session-2", cursor: "a\u0000b" }));
    expect(second.status).toBe("succeeded");
    const sessions = await taskSessions(agentId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionParamsJson).toMatchObject({ sessionId: "session-1" });
    expect(sessions[0]!.lastRunId).toBe(first.id);
  }, 60_000);
});
