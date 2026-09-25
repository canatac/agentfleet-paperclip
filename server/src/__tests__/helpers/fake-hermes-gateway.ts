import http from "node:http";
import type { AddressInfo } from "node:net";

// A local stand-in for the Hermes API server used by the hermes_gateway
// adapter (POST /v1/runs, SSE events, status, stop). No model, no tool, no
// outbound call: it only replays the scenario it is given (AF-OBS-005).

export type FakeHermesScenario = {
  /** HTTP status of POST /v1/runs. */
  createStatus?: number;
  /** Body of POST /v1/runs, sent as JSON. */
  createBody: Record<string, unknown>;
  /** Terminal event name, for example run.completed or run.failed. */
  terminalEvent?: string;
  /** Terminal event data and final status body. */
  terminal?: Record<string, unknown>;
};

export type FakeHermesRequest = { method: string; path: string; runId: string | null };

export type FakeHermesGateway = {
  baseUrl: string;
  requests: FakeHermesRequest[];
  /** Queues the scenario served to the next POST /v1/runs. */
  enqueue(scenario: FakeHermesScenario): void;
  close(): Promise<void>;
};

const RUN_PATH = /^\/v1\/runs\/([^/]+)(\/events|\/stop)?$/;

export async function startFakeHermesGateway(): Promise<FakeHermesGateway> {
  const queue: FakeHermesScenario[] = [];
  const active = new Map<string, FakeHermesScenario>();
  const requests: FakeHermesRequest[] = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (method === "POST" && url.pathname === "/v1/runs") {
        requests.push({ method, path: url.pathname, runId: null });
        const scenario = queue.shift();
        if (!scenario) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "no scenario queued" }));
          return;
        }
        const runId = scenario.createBody.run_id;
        if (typeof runId === "string") active.set(runId, scenario);
        res.writeHead(scenario.createStatus ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(scenario.createBody));
        return;
      }

      const match = RUN_PATH.exec(url.pathname);
      const runId = match ? decodeURIComponent(match[1]!) : null;
      requests.push({ method, path: url.pathname, runId });
      const scenario = runId === null ? undefined : active.get(runId);
      if (!match || !scenario) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unknown run" }));
        return;
      }
      const terminal = scenario.terminal ?? { status: "completed", output: "done" };
      if (match[2] === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`event: ${scenario.terminalEvent ?? "run.completed"}\ndata: ${JSON.stringify(terminal)}\n\n`);
        return;
      }
      if (match[2] === "/stop") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "cancelled" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(terminal));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    enqueue(scenario) {
      queue.push(scenario);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
