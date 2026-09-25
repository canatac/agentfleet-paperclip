import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { startFakeHermesGateway, type FakeHermesGateway, type FakeHermesScenario } from "./helpers/fake-hermes-gateway.js";
import { routeApp, seedCompanyWithBoardAccess, type SeededCompany } from "./helpers/route-test-harness.js";
import { agentRoutes } from "../routes/agents.js";
import { heartbeatService } from "../services/heartbeat.js";
import { recordExternalRunIdIfUnset } from "../services/heartbeat-external-run-id.js";
import { instanceSettingsService } from "../services/instance-settings.js";

// AF-OBS-005: end-to-end proof of the external run id contract with the real
// hermes_gateway adapter, a fake Hermes gateway on loopback, an ephemeral
// PostgreSQL and the Paperclip HTTP API:
//   FAKE_HERMES_RUN_ID = DATABASE_EXTERNAL_RUN_ID = API_EXTERNAL_RUN_ID
// No inference provider is involved and outbound HTTP is limited to the fake
// gateway (any other destination fails the suite).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Hermes gateway integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("hermes_gateway external run id, end to end", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let gateway: FakeHermesGateway;
  let seeded: SeededCompany;
  const projectId = randomUUID();
  const projectWorkspaceId = randomUUID();
  const originalFetch = globalThis.fetch;
  const blockedOutbound: string[] = [];

  beforeAll(async () => {
    gateway = await startFakeHermesGateway();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith(`${gateway.baseUrl}/`)) {
        blockedOutbound.push(url);
        throw new Error(`outbound request blocked by the integration test: ${url}`);
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    temporary = await startEmbeddedPostgresTestDatabase("paperclip-hermes-gateway-e2e-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: false });
    seeded = await seedCompanyWithBoardAccess(db, "Hermes link");
    await db.update(companies).set({ status: "active", defaultResponsibleUserId: seeded.userId })
      .where(eq(companies.id, seeded.companyId));
    await db.insert(projects).values({ id: projectId, companyId: seeded.companyId, name: "Hermes link", status: "active" });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId: seeded.companyId,
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
    globalThis.fetch = originalFetch;
    await gateway?.close();
  });

  async function runScenario(scenario: FakeHermesScenario) {
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: seeded.companyId,
      name: `Hermes ${agentId.slice(0, 8)}`,
      adapterType: "hermes_gateway",
      adapterConfig: { apiBaseUrl: gateway.baseUrl, apiKey: "fake-gateway-key", timeoutSec: 10, pollIntervalMs: 100 },
      status: "idle",
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId: seeded.companyId,
      projectId,
      projectWorkspaceId,
      title: "Link the Hermes run",
      status: "in_progress",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    gateway.enqueue(scenario);
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
    const runId = queued!.id;
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const api = await request(routeApp(db, seeded.actor, (routeDb) => agentRoutes(routeDb, {})))
      .get(`/api/heartbeat-runs/${runId}`);
    expect(api.status).toBe(200);
    return { heartbeat, runId, row: row!, apiExternalRunId: api.body.externalRunId as string | null };
  }

  it("normal identifier: FAKE_HERMES_RUN_ID = DATABASE_EXTERNAL_RUN_ID = API_EXTERNAL_RUN_ID", async () => {
    const fakeHermesRunId = `run-${randomUUID()}`;
    const { row, apiExternalRunId } = await runScenario({
      createBody: { run_id: fakeHermesRunId, status: "started" },
      terminal: { run_id: fakeHermesRunId, status: "completed", output: "done" },
    });
    expect(row.status).toBe("succeeded");
    expect(row.externalRunId).toBe(fakeHermesRunId);
    expect(apiExternalRunId).toBe(fakeHermesRunId);
    expect(gateway.requests.some((req) => req.method === "POST" && req.path === "/v1/runs")).toBe(true);
    expect(gateway.requests).toContainEqual({
      method: "GET",
      path: `/v1/runs/${encodeURIComponent(fakeHermesRunId)}/events`,
      runId: fakeHermesRunId,
    });
  }, 30_000);

  it("absent before creation: the gateway refuses the run, the column stays null", async () => {
    const { row, apiExternalRunId } = await runScenario({
      createStatus: 503,
      createBody: { error: "gateway busy" },
    });
    expect(row.status).not.toBe("succeeded");
    expect(row.externalRunId).toBeNull();
    expect(apiExternalRunId).toBeNull();
  }, 30_000);

  it("absent after the Hermes terminal event: the id from run creation is kept", async () => {
    const fakeHermesRunId = "run-created-only";
    const { row, apiExternalRunId } = await runScenario({
      createBody: { run_id: fakeHermesRunId, status: "started" },
      terminal: { status: "completed", output: "done" },
    });
    expect(row.status).toBe("succeeded");
    expect(row.externalRunId).toBe(fakeHermesRunId);
    expect(apiExternalRunId).toBe(fakeHermesRunId);
  }, 30_000);

  it("absent from the create response: protocol error, the column stays null", async () => {
    const { row, apiExternalRunId } = await runScenario({ createBody: { status: "started" } });
    expect(row.status).not.toBe("succeeded");
    expect(row.errorCode).toBe("hermes_gateway_protocol_error");
    expect(row.externalRunId).toBeNull();
    expect(apiExternalRunId).toBeNull();
  }, 30_000);

  it("empty string: rejected", async () => {
    const { row, apiExternalRunId } = await runScenario({ createBody: { run_id: "", status: "started" } });
    expect(row.errorCode).toBe("hermes_gateway_protocol_error");
    expect(row.externalRunId).toBeNull();
    expect(apiExternalRunId).toBeNull();
  }, 30_000);

  it("too long: rejected and reported on the run", async () => {
    const tooLong = `run-${"x".repeat(253)}`;
    expect(Buffer.byteLength(tooLong, "utf8")).toBe(257);
    const { row, apiExternalRunId } = await runScenario({
      createBody: { run_id: tooLong, status: "started" },
      terminal: { status: "completed", output: "done" },
    });
    expect(row.externalRunId).toBeNull();
    expect(apiExternalRunId).toBeNull();
    expect(row.resultJson).toMatchObject({ externalRunIdError: { code: "hermes_run_id_invalid", reason: "too_long" } });
  }, 30_000);

  it("control characters: rejected and reported on the run", async () => {
    const { row, apiExternalRunId } = await runScenario({
      createBody: { run_id: "run\u001bhermes", status: "started" },
      terminal: { status: "completed", output: "done" },
    });
    expect(row.externalRunId).toBeNull();
    expect(apiExternalRunId).toBeNull();
    expect(row.resultJson).toMatchObject({
      externalRunIdError: { code: "hermes_run_id_invalid", reason: "control_character" },
    });
  }, 30_000);

  it("valid non-UUID identifier: accepted byte for byte", async () => {
    const fakeHermesRunId = " hermes:run/2026-09-25#7 é ";
    const { row, apiExternalRunId } = await runScenario({
      createBody: { run_id: fakeHermesRunId, status: "started" },
      terminal: { status: "completed", output: "done" },
    });
    expect(row.externalRunId).toBe(fakeHermesRunId);
    expect(apiExternalRunId).toBe(fakeHermesRunId);
  }, 30_000);

  it("different Paperclip runs: each keeps its own Hermes id, never its Paperclip run id", async () => {
    const first = await runScenario({ createBody: { run_id: "run-hermes-a", status: "started" } });
    const second = await runScenario({ createBody: { run_id: "run-hermes-b", status: "started" } });
    expect(first.row.externalRunId).toBe("run-hermes-a");
    expect(second.row.externalRunId).toBe("run-hermes-b");
    expect(first.row.externalRunId).not.toBe(first.runId);
    expect(second.row.externalRunId).not.toBe(second.runId);
    expect(first.apiExternalRunId).toBe("run-hermes-a");
    expect(second.apiExternalRunId).toBe("run-hermes-b");
  }, 60_000);

  it("failed execution: the id Hermes provided is kept", async () => {
    const { row, apiExternalRunId } = await runScenario({
      createBody: { run_id: "run-hermes-failed", status: "started" },
      terminalEvent: "run.failed",
      terminal: { status: "failed", error: "tool crashed" },
    });
    expect(row.status).not.toBe("succeeded");
    expect(row.externalRunId).toBe("run-hermes-failed");
    expect(apiExternalRunId).toBe("run-hermes-failed");
  }, 30_000);

  it("repeated reconciliation: idempotent", async () => {
    const { heartbeat, runId, row } = await runScenario({ createBody: { run_id: "run-hermes-reconciled", status: "started" } });
    expect(row.externalRunId).toBe("run-hermes-reconciled");

    await heartbeat.reapOrphanedRuns();
    await heartbeat.reapOrphanedRuns();
    await expect(recordExternalRunIdIfUnset(db, runId, "run-hermes-reconciled")).resolves.toEqual({ outcome: "unchanged" });
    await expect(recordExternalRunIdIfUnset(db, runId, "run-hermes-reconciled")).resolves.toEqual({ outcome: "unchanged" });

    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(after!.externalRunId).toBe("run-hermes-reconciled");
    expect(after!.status).toBe(row.status);
    expect(after!.updatedAt).toEqual(row.updatedAt);
    const api = await request(routeApp(db, seeded.actor, (routeDb) => agentRoutes(routeDb, {})))
      .get(`/api/heartbeat-runs/${runId}`);
    expect(api.body.externalRunId).toBe("run-hermes-reconciled");
  }, 30_000);

  it("made no outbound request other than the fake gateway", () => {
    expect(blockedOutbound).toEqual([]);
  });
});
