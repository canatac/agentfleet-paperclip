import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

const STABLE_PROMPT = "  You are a synthetic Product Owner.\r\nPreserve café, scope and approvals.\n\n";
const promptHash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function ctx(strategy = "issue", resumed = false): AdapterExecutionContext {
  const config = { apiBaseUrl: "http://127.0.0.1:18644", apiKey: "synthetic-api-key",
    sessionKeyStrategy: strategy, timeoutSec: 3, payloadTemplate: { instructions: STABLE_PROMPT, metadata: { fixture: true } } };
  return {
    runId: "paperclip-run-fixture",
    agent: { id: "agent-fixture", companyId: "company-fixture", name: "Fixture PO",
      adapterType: "hermes_gateway", adapterConfig: config },
    runtime: { sessionId: resumed ? "prior-fixture-session" : null, sessionParams: null,
      sessionDisplayId: null, taskKey: null },
    config,
    context: {
      issueId: "issue-fixture",
      paperclipTaskMarkdownAssignment: "FULL TICKET BRIEF: synthetic objective",
      paperclipTaskMarkdownAssignmentCompact: "COMPACT TICKET BRIEF",
      paperclipTaskCommunicationGuidance: "Initial communication guidance",
      paperclipWake: { reason: "issue_commented",
        issue: { id: "issue-fixture", identifier: "FIX-1", title: "Synthetic ticket",
          description: "synthetic objective", status: "in_progress" },
        comments: [{ id: "comment-fixture", body: "Updated ticket event", authorType: "user" }],
        commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 } },
    },
    onLog: vi.fn(async () => undefined), onMeta: vi.fn(async () => undefined),
  };
}

async function captureBody(value: AdapterExecutionContext) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
    String(input).endsWith("/v1/runs")
      ? { run_id: "hermes-fixture-run", status: "started" }
      : { status: "completed", output: "Explicit synthetic final response" },
  ), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const result = await execute(value);
  expect(result.exitCode).toBe(0);
  const call = (fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>)
    .find(([url]) => String(url).endsWith("/v1/runs"));
  const body = JSON.parse(String(call?.[1]?.body));
  expect(call?.[1]?.headers).toMatchObject({ "Idempotency-Key": value.runId });
  return body as { input: string; instructions: string; metadata: { fixture: boolean } };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Git instructions / Paperclip input gateway contract", () => {
  it.each(["issue", "agent", "run", "none"])("keeps instructions byte-identical on fresh and resumed %s sessions", async (strategy) => {
    for (const resumed of [false, true]) {
      const value = ctx(strategy, resumed);
      const body = await captureBody(value);
      expect(body.instructions).toBe(STABLE_PROMPT);
      expect(promptHash(body.instructions)).toBe(promptHash(STABLE_PROMPT));
      expect(body.input).not.toContain("synthetic Product Owner");
      expect(body.input).toContain("Updated ticket event");
      const compact = resumed && ["issue", "agent"].includes(strategy);
      expect(body.input).toContain(compact ? "COMPACT TICKET BRIEF" : "FULL TICKET BRIEF");
      expect(body.input.match(/Execution contract:/g)).toHaveLength(1);
      expect(body.metadata).toEqual({ fixture: true });
      const logged = JSON.stringify((value.onLog as ReturnType<typeof vi.fn>).mock.calls);
      expect(logged).not.toContain("synthetic-api-key");
      expect(logged).not.toContain("synthetic Product Owner");
    }
  });

  it("changes input when the ticket changes while instructions remain stable", async () => {
    const first = await captureBody(ctx());
    const next = ctx();
    next.runId = "paperclip-run-next";
    next.context.paperclipTaskMarkdownAssignment = "Different ticket objective";
    const second = await captureBody(next);
    expect(first.instructions).toBe(second.instructions);
    expect(first.input).not.toBe(second.input);
    expect(second.input).toContain("Different ticket objective");
  });

  it("does not let a legacy custom input hide the ticket context", async () => {
    const value = ctx();
    value.config.payloadTemplate = { input: "Legacy per-turn prefix", instructions: STABLE_PROMPT };
    const body = await captureBody(value);
    expect(body.input).toContain("Legacy per-turn prefix");
    expect(body.input).toContain("FULL TICKET BRIEF");
    expect(body.instructions).toBe(STABLE_PROMPT);
  });

  it("preserves supported top-level instruction precedence without trimming", async () => {
    const value = ctx();
    value.config.instructions = "  Explicit upstream instructions\n\n";
    expect((await captureBody(value)).instructions).toBe(value.config.instructions);
  });

  it("avoids a second serialized wake copy when upstream declares prompt-owned events", async () => {
    const value = ctx();
    value.context.paperclipTurnContext = { version: 1, events: { owner: "wake_prompt" } };
    const body = await captureBody(value);
    expect(body.input).toContain("Updated ticket event");
    expect(body.input).not.toContain("Structured wake payload JSON:");
  });

  it.each([false, true])("keeps stable instructions separate on conversation turns (resume=%s)", async (resumed) => {
    const value = ctx("issue", resumed);
    value.context.conversationMode = true;
    const body = await captureBody(value);
    expect(body.instructions).toBe(STABLE_PROMPT);
    expect(body.input).not.toContain("Execution contract:");
    expect(body.input).toContain(resumed ? "COMPACT TICKET BRIEF" : "FULL TICKET BRIEF");
  });
});
