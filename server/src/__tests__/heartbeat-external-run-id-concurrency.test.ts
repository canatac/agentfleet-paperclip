import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
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

// AF-OBS-004: mandatory branches of the external run id contract (§5.4):
// concurrent finalization of an already finished run, idempotent repetition,
// conflict between two Hermes run ids, no id before creation, and no
// substitution by the Paperclip run id.

const adapterExecute = vi.hoisted(() => vi.fn());

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "hermes_gateway",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: () => ({
    type: "hermes_gateway",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  runningProcesses: new Map(),
}));

import { heartbeatService } from "../services/heartbeat.js";
import { recordExternalRunIdIfUnset } from "../services/heartbeat-external-run-id.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres external run id concurrency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type ExecuteContext = { runId: string };

function succeeded(sessionParams: Record<string, unknown> | null) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    provider: "hermes_gateway",
    model: "hermes-test",
    summary: "Hermes run finished.",
    sessionParams,
    sessionDisplayId: null,
  };
}

describeEmbeddedPostgres("heartbeat external run id: concurrency, idempotence and conflicts", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const projectId = randomUUID();
  const projectWorkspaceId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-external-run-id-concurrency-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: false });
    await db.insert(companies).values({
      id: companyId,
      name: "External run id concurrency",
      issuePrefix: "XRC",
      status: "active",
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Hermes link", status: "active" });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      isPrimary: true,
    });
  }, 30_000);

  afterAll(async () => {
    if (temporary) {
      await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
      await temporary.cleanup();
    }
  });

  async function runOnce(
    execute: (ctx: ExecuteContext, heartbeat: ReturnType<typeof heartbeatService>) => Promise<unknown>,
  ) {
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent ${agentId.slice(0, 8)}`,
      adapterType: "hermes_gateway",
      adapterConfig: {},
      status: "idle",
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Link the Hermes run",
      status: "in_progress",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    const heartbeat = heartbeatService(db);
    adapterExecute.mockImplementationOnce(async (ctx: ExecuteContext) => execute(ctx, heartbeat));
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
    return { heartbeat, runId: queued!.id, row: row! };
  }

  async function waitForStatus(runId: string, status: string) {
    await vi.waitFor(async () => {
      const [row] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(row?.status).toBe(status);
    }, { timeout: 10_000, interval: 50 });
  }

  it("records the Hermes run id on a run stopped while Hermes was working, without changing its outcome", async () => {
    const { runId, row, heartbeat } = await runOnce(async (ctx, hb) => {
      // The user stops the run while the Hermes execution is in flight: the
      // cancellation path, not the adapter, writes the terminal status.
      void hb.cancelRun(ctx.runId, "stopped by the user");
      await waitForStatus(ctx.runId, "cancelled");
      return succeeded({ hermesRunId: "run-hermes-stopped", strategy: "task" });
    });
    expect(row.status).toBe("cancelled");
    expect(row.externalRunId).toBe("run-hermes-stopped");
    expect((await heartbeat.getRun(runId))?.externalRunId).toBe("run-hermes-stopped");
  }, 30_000);

  it("keeps the outcome written by the path that finished the run first", async () => {
    const { row } = await runOnce(async (ctx) => {
      await db.update(heartbeatRuns).set({
        status: "failed",
        error: "reconciled elsewhere",
        errorCode: "reconciled",
        finishedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(heartbeatRuns.id, ctx.runId));
      return succeeded({ hermesRunId: "run-hermes-reconciled" });
    });
    expect(row.status).toBe("failed");
    expect(row.errorCode).toBe("reconciled");
    expect(row.error).toBe("reconciled elsewhere");
    expect(row.externalRunId).toBe("run-hermes-reconciled");
  }, 30_000);

  it("is idempotent when the same Hermes run id is written again", async () => {
    const { runId, row } = await runOnce(async () => succeeded({ hermesRunId: "run-hermes-repeat" }));
    expect(row.externalRunId).toBe("run-hermes-repeat");
    const updatedAt = row.updatedAt;

    await expect(recordExternalRunIdIfUnset(db, runId, "run-hermes-repeat")).resolves.toEqual({ outcome: "unchanged" });
    await expect(recordExternalRunIdIfUnset(db, runId, "run-hermes-repeat")).resolves.toEqual({ outcome: "unchanged" });

    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(after!.externalRunId).toBe("run-hermes-repeat");
    expect(after!.updatedAt).toEqual(updatedAt);
  }, 30_000);

  it("keeps the first Hermes run id when a different one arrives at the terminal write", async () => {
    const { row } = await runOnce(async (ctx) => {
      await db.update(heartbeatRuns).set({ externalRunId: "run-hermes-first" }).where(eq(heartbeatRuns.id, ctx.runId));
      return succeeded({ hermesRunId: "run-hermes-second" });
    });
    expect(row.status).toBe("succeeded");
    expect(row.externalRunId).toBe("run-hermes-first");
    expect(row.resultJson).toMatchObject({
      externalRunIdError: {
        code: "external_run_id_conflict",
        existingExternalRunId: "run-hermes-first",
        receivedExternalRunId: "run-hermes-second",
      },
    });
  }, 30_000);

  it("reports a conflict on the targeted write without overwriting", async () => {
    const { runId } = await runOnce(async () => succeeded({ hermesRunId: "run-hermes-kept" }));
    await expect(recordExternalRunIdIfUnset(db, runId, "run-hermes-other")).resolves.toEqual({
      outcome: "conflict",
      existingExternalRunId: "run-hermes-kept",
    });
    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(after!.externalRunId).toBe("run-hermes-kept");
    await expect(recordExternalRunIdIfUnset(db, randomUUID(), "run-hermes-kept")).resolves.toEqual({ outcome: "missing" });
  }, 30_000);

  it("leaves the column null when the adapter failed before creating a Hermes run", async () => {
    const { row } = await runOnce(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      provider: "hermes_gateway",
      errorCode: "hermes_gateway_connect_failed",
      errorMessage: "connect ECONNREFUSED 127.0.0.1:8642",
    }));
    expect(row.externalRunId).toBeNull();
  }, 30_000);

  it("never substitutes the Paperclip run id", async () => {
    const withoutId = await runOnce(async () => succeeded({ strategy: "task" }));
    expect(withoutId.row.externalRunId).toBeNull();

    const withId = await runOnce(async () => succeeded({ hermesRunId: "run-hermes-own" }));
    expect(withId.row.externalRunId).toBe("run-hermes-own");
    expect(withId.row.externalRunId).not.toBe(withId.runId);
  }, 30_000);
});
