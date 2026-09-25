import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";
import { sessionCodec } from "./index.js";

// AF-OBS-003: the Hermes run id reaches sessionParams.hermesRunId byte for
// byte, on every exit after the Hermes run was created.

function makeCtx(): AdapterExecutionContext {
  return {
    runId: "pc-run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_gateway",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
      pollIntervalMs: 250,
    },
    context: {
      issueId: "issue-1",
      wakeReason: "manual",
      paperclipWake: { issue: { identifier: "PAP-1", title: "Do the thing" } },
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
  } as AdapterExecutionContext;
}

function gateway(createBody: unknown, finalStatus: Record<string, unknown>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/v1/runs")) {
      return new Response(JSON.stringify(createBody), { status: 200 });
    }
    if (url.endsWith("/events")) {
      return new Response("no stream", { status: 503 });
    }
    return new Response(JSON.stringify(finalStatus), { status: 200 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Hermes run id passthrough", () => {
  it("keeps the created run id unchanged, including surrounding spaces", async () => {
    const fetchMock = gateway(
      { run_id: " run-hermes-1 ", status: "started" },
      { status: "completed", output: "done" },
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx());

    expect(result.exitCode).toBe(0);
    expect(result.sessionParams).toMatchObject({ hermesRunId: " run-hermes-1 " });
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/v1/runs/%20run-hermes-1%20"))).toBe(true);
  });

  it("reports the run id when the Hermes run fails after creation", async () => {
    vi.stubGlobal("fetch", gateway(
      { run_id: "run-hermes-2", status: "started" },
      { status: "failed", error: "tool crashed" },
    ));

    const result = await execute(makeCtx());

    expect(result.exitCode).not.toBe(0);
    expect(result.sessionParams).toMatchObject({ hermesRunId: "run-hermes-2" });
  });

  it("reports no run id when the create response carries none", async () => {
    vi.stubGlobal("fetch", gateway({ status: "started" }, { status: "completed" }));

    const result = await execute(makeCtx());

    expect(result.errorCode).toBe("hermes_gateway_protocol_error");
    expect(result.sessionParams ?? null).toBeNull();
  });

  it("does not treat a blank run id as a run id", async () => {
    vi.stubGlobal("fetch", gateway({ run_id: "   ", status: "started" }, { status: "completed" }));

    const result = await execute(makeCtx());

    expect(result.errorCode).toBe("hermes_gateway_protocol_error");
  });

  it("serializes and deserializes the run id without trimming it", () => {
    expect(sessionCodec.serialize({ hermesRunId: " run-hermes-1 ", strategy: "task" })).toEqual({
      hermesRunId: " run-hermes-1 ",
      strategy: "task",
    });
    expect(sessionCodec.deserialize({ hermesRunId: " run-hermes-1 " })).toEqual({ hermesRunId: " run-hermes-1 " });
    expect(sessionCodec.deserialize({ hermesRunId: "   " })).toBeNull();
  });
});
