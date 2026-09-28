#!/usr/bin/env bash
# Smoke test of a Paperclip image built by release-image.yml, before anything
# is published (AF-CI-002, specification §7.2 and §7.3; contract:
# paperclip-fleet docs/deploy/PROMOTION.md). Documented in
# docs/agentfleet/CI.md.
#
#   image-smoke.sh IMAGE EXPECTED_COMMIT OUT_DIR
#
# The image runs as it does in production: its own entrypoint (tini as PID 1),
# the embedded PostgreSQL on a fresh data volume, authenticated mode. Nothing
# leaves the runner: telemetry is off, no agent or adapter is configured, the
# port is published on loopback only.
#
# Checks, in order (a failed image-metadata check stops the run: the image is
# not the one expected, so testing it further proves nothing):
#   image-metadata      PAPERCLIP_BUILD_COMMIT, OCI revision and source labels,
#                       linux/amd64
#   build-stamp         server/dist/build-info.json holds EXPECTED_COMMIT
#   runtime-tools       curl (compose healthcheck), tini, gosu
#   pid1-reaps-orphans  upstream scripts/assert-orphan-reaping.sh
#   first-start         /api/health answers "ok" on a fresh data volume
#   health-commit       /api/health reports EXPECTED_COMMIT
#   migrations          every migration of the image is recorded in
#                       drizzle.__drizzle_migrations, and matches the label
#   agentfleet-code     the AgentFleet adapter code, loaded as the server loads
#                       it: Hermes run ID kept byte for byte (AF-OBS-002),
#                       missing final response rejected (PC-OBS-HERMES-H3)
#   graceful-stop       docker stop ends the container before the grace period
#   restart             the same volume starts again, migrations unchanged
#
# OUT_DIR receives smoke-report.json (one entry per check) and the container
# log. Exit code: 0 when every check passes, 1 otherwise, 2 on usage error.
set -Eeuo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 IMAGE EXPECTED_COMMIT OUT_DIR" >&2
  exit 2
fi
IMAGE=$1
EXPECTED_COMMIT=$2
OUT_DIR=$3
if [[ ! $EXPECTED_COMMIT =~ ^[0-9a-f]{40}$ ]]; then
  echo "EXPECTED_COMMIT must be a full lowercase commit SHA" >&2
  exit 2
fi

EXPECTED_SOURCE=${EXPECTED_SOURCE:-https://github.com/canatac/agentfleet-paperclip}
SMOKE_PORT=${SMOKE_PORT:-3100}
HEALTH_TIMEOUT_SEC=${HEALTH_TIMEOUT_SEC:-300}
STOP_GRACE_SEC=${STOP_GRACE_SEC:-60}
NAME=agentfleet-image-smoke-$$
VOLUME=$NAME-data
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

mkdir -p "$OUT_DIR"
REPORT=$OUT_DIR/smoke-report.json
LOG_FILE=$OUT_DIR/smoke-container.log
printf '[]\n' >"$REPORT"
failures=0

record() {
  local check=$1 status=$2 detail=$3
  jq --arg check "$check" --arg status "$status" --arg detail "$detail" \
    '. + [{check: $check, status: $status, detail: $detail}]' "$REPORT" >"$REPORT.tmp"
  mv "$REPORT.tmp" "$REPORT"
  printf '%-20s %s  %s\n' "$check" "$status" "$detail"
  if [[ $status != PASS ]]; then
    failures=$((failures + 1))
  fi
}

# shellcheck disable=SC2317 # called by the EXIT trap
cleanup() {
  if docker inspect "$NAME" >/dev/null 2>&1; then
    docker logs "$NAME" >"$LOG_FILE" 2>&1 || true
    docker rm -f "$NAME" >/dev/null 2>&1 || true
  fi
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

finish() {
  if ((failures > 0)); then
    echo "image smoke: $failures check(s) failed" >&2
    exit 1
  fi
  echo "image smoke: all checks passed"
  exit 0
}

# ---- image-metadata ---------------------------------------------------------
inspect=$(docker image inspect "$IMAGE" | jq '.[0]')
env_commit=$(jq -r '.Config.Env[] | select(startswith("PAPERCLIP_BUILD_COMMIT=")) | sub("^PAPERCLIP_BUILD_COMMIT="; "")' <<<"$inspect")
revision=$(jq -r '.Config.Labels["org.opencontainers.image.revision"] // ""' <<<"$inspect")
source_label=$(jq -r '.Config.Labels["org.opencontainers.image.source"] // ""' <<<"$inspect")
platform=$(jq -r '"\(.Os)/\(.Architecture)"' <<<"$inspect")
problems=()
[[ $env_commit == "$EXPECTED_COMMIT" ]] || problems+=("PAPERCLIP_BUILD_COMMIT=${env_commit:-<unset>}")
[[ $revision == "$EXPECTED_COMMIT" ]] || problems+=("revision=${revision:-<unset>}")
[[ $source_label == "$EXPECTED_SOURCE" ]] || problems+=("source=${source_label:-<unset>}")
[[ $platform == linux/amd64 ]] || problems+=("platform=$platform")
if ((${#problems[@]} > 0)); then
  record image-metadata FAIL "expected commit $EXPECTED_COMMIT; got ${problems[*]}"
  finish
fi
record image-metadata PASS "commit $EXPECTED_COMMIT, source $EXPECTED_SOURCE, $platform"

# ---- build-stamp ------------------------------------------------------------
stamp=$(docker run --rm --entrypoint cat "$IMAGE" /app/server/dist/build-info.json 2>/dev/null | jq -r '.commit // ""' || true)
if [[ $stamp == "$EXPECTED_COMMIT" ]]; then
  record build-stamp PASS "server/dist/build-info.json commit $stamp"
else
  record build-stamp FAIL "server/dist/build-info.json commit '${stamp}'"
fi

# ---- runtime-tools ----------------------------------------------------------
if tools=$(docker run --rm --entrypoint sh "$IMAGE" -c 'for t in curl tini gosu; do command -v "$t" || exit 1; done' 2>&1); then
  record runtime-tools PASS "$(tr '\n' ' ' <<<"$tools")"
else
  record runtime-tools FAIL "missing tool: $(tr '\n' ' ' <<<"$tools")"
fi

# ---- pid1-reaps-orphans -----------------------------------------------------
if reap=$(docker run --rm -i "$IMAGE" sh -s <"$REPO_ROOT/scripts/assert-orphan-reaping.sh" 2>&1); then
  record pid1-reaps-orphans PASS "$(tail -n 1 <<<"$reap")"
else
  record pid1-reaps-orphans FAIL "$(tail -n 3 <<<"$reap" | tr '\n' ' ')"
fi

# ---- first-start ------------------------------------------------------------
docker volume create "$VOLUME" >/dev/null
# A throwaway auth secret for this container only; never printed.
docker run -d --name "$NAME" \
  -p "127.0.0.1:$SMOKE_PORT:3100" \
  -e "BETTER_AUTH_SECRET=$(openssl rand -hex 32)" \
  -e "PAPERCLIP_PUBLIC_URL=http://127.0.0.1:$SMOKE_PORT" \
  -e PAPERCLIP_TELEMETRY_DISABLED=1 \
  -e DO_NOT_TRACK=1 \
  -v "$VOLUME:/paperclip" \
  "$IMAGE" >/dev/null

# wait_healthy LABEL -> prints the last health body; 0 when status is "ok".
wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SEC)) body
  while ((SECONDS < deadline)); do
    if [[ $(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null) != true ]]; then
      echo "container exited (code $(docker inspect -f '{{.State.ExitCode}}' "$NAME" 2>/dev/null))"
      return 1
    fi
    if body=$(curl -fsS --max-time 5 "http://127.0.0.1:$SMOKE_PORT/api/health" 2>/dev/null) &&
      [[ $(jq -r '.status // ""' <<<"$body" 2>/dev/null) == ok ]]; then
      printf '%s' "$body"
      return 0
    fi
    sleep 3
  done
  echo "no healthy answer within ${HEALTH_TIMEOUT_SEC}s"
  return 1
}

started=$SECONDS
if ! health=$(wait_healthy); then
  record first-start FAIL "$health"
  finish
fi
record first-start PASS "healthy after $((SECONDS - started))s on a fresh volume"

# ---- health-commit ----------------------------------------------------------
health_commit=$(jq -r '.commit // ""' <<<"$health")
if [[ $health_commit == "$EXPECTED_COMMIT" ]]; then
  record health-commit PASS "/api/health commit $health_commit"
else
  record health-commit FAIL "/api/health commit '${health_commit}'"
fi

# ---- migrations -------------------------------------------------------------
# count_migrations -> {"applied": N, "files": M}, read with the image's own
# PostgreSQL client from the embedded database (default port, first-run
# credentials of server/src/index.ts).
count_migrations() {
  docker exec -u node -w /app/packages/db "$NAME" node -e '
    const postgres = require("postgres");
    const fs = require("node:fs");
    (async () => {
      const sql = postgres("postgres://paperclip:paperclip@127.0.0.1:54329/paperclip", { max: 1, onnotice: () => {} });
      try {
        const [{ applied }] = await sql`select count(*)::int as applied from drizzle.__drizzle_migrations`;
        const files = fs.readdirSync("src/migrations").filter((name) => name.endsWith(".sql")).length;
        console.log(JSON.stringify({ applied, files }));
      } finally {
        await sql.end({ timeout: 5 });
      }
    })().catch((error) => { console.error(error.message); process.exit(1); });'
}
label_count=$(jq -r '.Config.Labels["io.github.paperclipai.schema.migration-count"] // ""' <<<"$inspect")
if counts=$(count_migrations 2>&1); then
  applied=$(jq -r .applied <<<"$counts")
  files=$(jq -r .files <<<"$counts")
  if ((applied > 0)) && [[ $applied == "$files" && $files == "$label_count" ]]; then
    record migrations PASS "$applied applied = $files files = label $label_count"
  else
    record migrations FAIL "applied $applied, files $files, label ${label_count:-<unset>}"
  fi
else
  record migrations FAIL "$(tail -n 2 <<<"$counts" | tr '\n' ' ')"
fi

# ---- agentfleet-code --------------------------------------------------------
# Same loader and module resolution as the image CMD (tsx, from /app/server).
if code=$(docker exec -u node -w /app/server "$NAME" node \
  --import /app/server/node_modules/tsx/dist/loader.mjs --input-type=module -e '
    const gateway = await import("@paperclipai/hermes-paperclip-adapter/gateway");
    const server = await import("@paperclipai/hermes-paperclip-adapter/gateway/server");
    const problems = [];
    if (gateway.normalizeHermesRunId(" run 42 ") !== " run 42 ") problems.push("run id rewritten");
    try {
      gateway.normalizeHermesRunId("run\u0000id");
      problems.push("control character accepted");
    } catch (error) {
      if (error?.reason !== "control_character") problems.push(`unexpected error ${error?.reason ?? error}`);
    }
    const result = server.mapFinalResultForTest({
      terminal: { runId: "smoke-run", status: "completed", eventName: "run.completed", payload: { status: "completed", output: null }, output: null },
      outputChunks: ["tool text"],
      sessionKey: "smoke-session",
      strategy: "run",
    });
    if (result.exitCode !== 1 || result.errorCode !== "MISSING_FINAL_RESPONSE") problems.push(`missing final response mapped to ${result.exitCode}/${result.errorCode}`);
    if (result.diagnosticTranscript !== "tool text") problems.push("tool text not kept as diagnostic transcript");
    if (problems.length) { console.log(problems.join("; ")); process.exit(1); }
    console.log("run id kept byte for byte, control character rejected, MISSING_FINAL_RESPONSE");' 2>&1); then
  record agentfleet-code PASS "$code"
else
  record agentfleet-code FAIL "$(tail -n 3 <<<"$code" | tr '\n' ' ')"
fi

# ---- graceful-stop ----------------------------------------------------------
stop_started=$SECONDS
docker stop -t "$STOP_GRACE_SEC" "$NAME" >/dev/null
stop_code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
# 137: SIGKILL at the end of the grace period, i.e. no clean shutdown.
if [[ $stop_code != 137 ]]; then
  record graceful-stop PASS "stopped in $((SECONDS - stop_started))s, exit code $stop_code"
else
  record graceful-stop FAIL "killed after ${STOP_GRACE_SEC}s (exit code 137)"
fi

# ---- restart ----------------------------------------------------------------
docker start "$NAME" >/dev/null
started=$SECONDS
if ! health=$(wait_healthy); then
  record restart FAIL "$health"
  finish
fi
if counts_after=$(count_migrations 2>&1) && [[ $(jq -r .applied <<<"$counts_after") == "${applied:-}" ]]; then
  record restart PASS "healthy after $((SECONDS - started))s on the same volume, $(jq -r .applied <<<"$counts_after") migrations"
else
  record restart FAIL "migrations after restart: $(tr '\n' ' ' <<<"$counts_after")"
fi

finish
