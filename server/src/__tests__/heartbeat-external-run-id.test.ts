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

// AF-OBS-003: the terminal write records the Hermes run id reported by the
// hermes_gateway adapter in heartbeat_runs.external_run_id.

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
import { instanceSettingsService } from "../services/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres external run id tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function succeeded(sessionParams: Record<string, unknown> | null) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    provider: "hermes_gateway",
    model: "hermes-test",
    summary: "Hermes run finished.",
    resultJson: { run_id: "echo", status: "completed" },
    sessionParams,
    sessionDisplayId: null,
  };
}

function failed(sessionParams: Record<string, unknown> | null, errorCode: string) {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    provider: "hermes_gateway",
    errorCode,
    errorMessage: `Hermes run ${errorCode}`,
    ...(sessionParams ? { sessionParams } : {}),
  };
}

describeEmbeddedPostgres("heartbeat external run id", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const projectId = randomUUID();
  const projectWorkspaceId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-external-run-id-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: false });
    await db.insert(companies).values({
      id: companyId,
      name: "External run id",
      issuePrefix: "XRI",
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

  async function runOnce(adapterType: string, result: unknown) {
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent ${agentId.slice(0, 8)}`,
      adapterType,
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
    return { heartbeat, runId: queued!.id, row: row! };
  }

  it("records the Hermes run id on a successful run and exposes it through the API", async () => {
    const { heartbeat, runId, row } = await runOnce(
      "hermes_gateway",
      succeeded({ hermesRunId: "run-hermes-success", strategy: "task" }),
    );
    expect(row.status).toBe("succeeded");
    expect(row.externalRunId).toBe("run-hermes-success");
    expect((await heartbeat.getRun(runId))?.externalRunId).toBe("run-hermes-success");
    expect(row.externalRunId).not.toBe(runId);
  }, 30_000);

  it("records the Hermes run id when the run fails after the Hermes run was created", async () => {
    const { row } = await runOnce(
      "hermes_gateway",
      failed({ hermesRunId: "run-hermes-failed", strategy: "task" }, "hermes_gateway_timeout"),
    );
    expect(row.status).not.toBe("succeeded");
    expect(row.externalRunId).toBe("run-hermes-failed");
  }, 30_000);

  it("keeps the identifier byte for byte", async () => {
    const { row } = await runOnce("hermes_gateway", succeeded({ hermesRunId: " run-hermes-é-1 " }));
    expect(row.externalRunId).toBe(" run-hermes-é-1 ");
  }, 30_000);

  it("leaves the column null when no Hermes run was created", async () => {
    const { row } = await runOnce("hermes_gateway", failed(null, "hermes_gateway_connect_failed"));
    expect(row.externalRunId).toBeNull();
    expect(row.resultJson).not.toHaveProperty("externalRunIdError");
  }, 30_000);

  it("does not record a malformed identifier and reports it on the run", async () => {
    const { row } = await runOnce("hermes_gateway", succeeded({ hermesRunId: "run\u0000hermes" }));
    expect(row.status).toBe("succeeded");
    expect(row.externalRunId).toBeNull();
    expect(row.resultJson).toMatchObject({
      externalRunIdError: { code: "hermes_run_id_invalid", reason: "control_character" },
    });
  }, 30_000);

  it("ignores a hermesRunId reported by another adapter", async () => {
    const { row } = await runOnce("codex_local", succeeded({ hermesRunId: "run-not-hermes" }));
    expect(row.externalRunId).toBeNull();
  }, 30_000);
});
