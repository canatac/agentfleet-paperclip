import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentRuntimeState,
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

// AF-OBS-007 (canatac/paperclip-fleet#90): PostgreSQL rejects U+0000 in text
// columns, so a session id or display id containing it is treated as absent:
// no session id on the run, no session to resume, and a warning is logged.

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
    `Skipping embedded Postgres session id NUL tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const absentSessionWarning = "session id contains a NUL character; the session is treated as absent";

function succeeded(sessionParams: Record<string, unknown>, sessionDisplayId: string | null = null) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    provider: "codex_local",
    model: "codex-test",
    summary: "Run finished.",
    resultJson: { status: "completed" },
    sessionParams,
    sessionDisplayId,
  };
}

function loggedMessages(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.map((call) => call.find((arg) => typeof arg === "string"));
}

describeEmbeddedPostgres("heartbeat session id containing NUL", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const projectId = randomUUID();
  const projectWorkspaceId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-session-id-nul-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: false });
    await db.insert(companies).values({
      id: companyId,
      name: "Session id NUL",
      issuePrefix: "SIN",
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
      title: "Record the session",
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

  async function runtimeSessionId(agentId: string) {
    const [state] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, agentId));
    return state?.sessionId ?? null;
  }

  it("records a session id without NUL on the run", async () => {
    const { agentId, issueId } = await createAgentWithTask();
    const row = await runOnce(agentId, issueId, succeeded({ sessionId: "session-plain" }));
    expect(row.status).toBe("succeeded");
    expect(row.sessionIdAfter).toBe("session-plain");
    expect(await taskSessions(agentId)).toHaveLength(1);
    expect(await runtimeSessionId(agentId)).toBe("session-plain");
  }, 30_000);

  it("treats a session id containing NUL as absent and keeps the run outcome", async () => {
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");
    const { agentId, issueId } = await createAgentWithTask();
    const row = await runOnce(agentId, issueId, succeeded({ sessionId: "session\u0000nul" }));
    expect(row.status).toBe("succeeded");
    expect(row.sessionIdAfter).toBeNull();
    expect(await taskSessions(agentId)).toHaveLength(0);
    expect(await runtimeSessionId(agentId)).toBeNull();
    expect(loggedMessages(error)).not.toContain("heartbeat execution failed");
    expect(loggedMessages(warn)).toContain(absentSessionWarning);
  }, 30_000);

  it("treats a display id containing NUL as absent", async () => {
    const { agentId, issueId } = await createAgentWithTask();
    const row = await runOnce(agentId, issueId, succeeded({ sessionId: "session-plain" }, "display\u0000nul"));
    expect(row.status).toBe("succeeded");
    expect(row.sessionIdAfter).toBeNull();
    expect(await taskSessions(agentId)).toHaveLength(0);
  }, 30_000);

  it("does not keep a previous session to resume after a session id containing NUL", async () => {
    const { agentId, issueId } = await createAgentWithTask();
    await runOnce(agentId, issueId, succeeded({ sessionId: "session-1" }));
    expect(await taskSessions(agentId)).toHaveLength(1);
    const second = await runOnce(agentId, issueId, succeeded({ sessionId: "session\u0000two" }));
    expect(second.status).toBe("succeeded");
    expect(second.sessionIdAfter).toBeNull();
    expect(await taskSessions(agentId)).toHaveLength(0);
    expect(await runtimeSessionId(agentId)).toBeNull();
  }, 60_000);
});
