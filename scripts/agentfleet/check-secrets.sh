#!/usr/bin/env bash
# AgentFleet secret scan (AF-CI-001e, docs/agentfleet/CI.md).
#
#   scripts/agentfleet/check-secrets.sh <gitleaks binary>
#
# 1. The tracked tree at HEAD, with the default gitleaks rules
#    (.gitleaks.toml) and the reviewed upstream findings of .gitleaksignore.
# 2. .gitleaksignore stays exact: without it, the findings are exactly its
#    entries, so a stale entry fails and forces a new review.
# 3. A secret added in a new file is reported, with .gitleaksignore active:
#    no global suppression hides it.
# 4. The AgentFleet history (every commit since the upstream base commit of
#    upstream-version.json), scanned from a mirror clone so that no
#    .gitleaksignore entry applies.
set -euo pipefail

gitleaks="$(realpath "${1:?usage: check-secrets.sh <gitleaks binary>}")"
repo="$(git rev-parse --show-toplevel)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
scan=("$gitleaks" --no-banner --redact --log-level warn)

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

mkdir "$work/tree"
git -C "$repo" archive --format=tar HEAD | tar -x -C "$work/tree"

step "1. tracked tree at HEAD, reviewed findings ignored"
(cd "$work/tree" && "${scan[@]}" dir . --config .gitleaks.toml) || fail "secret found in the tree"

step "2. .gitleaksignore matches the findings exactly"
mv "$work/tree/.gitleaksignore" "$work/gitleaksignore"
(cd "$work/tree" && "${scan[@]}" dir . --config .gitleaks.toml --exit-code 0 --log-level error \
  --report-format json --report-path "$work/raw.json")
jq -r '.[].Fingerprint' "$work/raw.json" | sort -u >"$work/found"
grep -v '^[[:space:]]*#' "$work/gitleaksignore" | sed '/^[[:space:]]*$/d' | sort -u >"$work/listed"
stale="$(comm -23 "$work/listed" "$work/found")"
[[ -z "$stale" ]] || fail "entries of .gitleaksignore that match no finding: $stale"
echo "$(wc -l <"$work/listed") entries, $(wc -l <"$work/found") findings: identical"
mv "$work/gitleaksignore" "$work/tree/.gitleaksignore"

step "3. a new secret is reported"
# Built at run time, so that this script holds no secret.
chars="$(head -c 1024 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')"
(( ${#chars} >= 36 )) || fail "not enough random characters for the canary token"
token="ghp_${chars:0:36}"
key_body="$(head -c 600 /dev/urandom | base64 -w 64)"
mkdir -p "$work/tree/agentfleet-canary"
printf 'GITHUB_TOKEN="%s"\n' "$token" >"$work/tree/agentfleet-canary/token.env"
printf -- '-----BEGIN PRIVATE KEY-----\n%s\n-----END PRIVATE KEY-----\n' "$key_body" \
  >"$work/tree/agentfleet-canary/key.pem"
(cd "$work/tree" && "${scan[@]}" dir . --config .gitleaks.toml --exit-code 0 --log-level error \
  --report-format json --report-path "$work/canary.json")
reported="$(jq -r '[.[] | select(.File | startswith("agentfleet-canary/")) | .RuleID] | unique | join(" ")' "$work/canary.json")"
others="$(jq '[.[] | select(.File | startswith("agentfleet-canary/") | not)] | length' "$work/canary.json")"
[[ "$reported" == *github-pat* && "$reported" == *private-key* ]] || fail "canary secrets not reported (got: $reported)"
[[ "$others" == 0 ]] || fail "unexpected findings outside the canary: $others"
echo "canary reported: $reported"

step "4. AgentFleet history, no ignore entry"
base="$(jq -r .commit "$repo/upstream-version.json")"
head="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" cat-file -e "$base^{commit}" || fail "base commit $base is not in the clone (fetch the full history)"
git clone --quiet --mirror "$repo" "$work/history.git"
git -C "$work/history.git" cat-file -e "$head^{commit}" 2>/dev/null \
  || git -C "$work/history.git" fetch --quiet "$repo" "$head"
echo "commits: $(git -C "$work/history.git" rev-list --count "$base..$head") ($base..$head)"
(cd "$work" && "${scan[@]}" git history.git --config "$work/tree/.gitleaks.toml" --log-opts="$base..$head") \
  || fail "secret found in the AgentFleet history"

printf '\nSecret scan: pass.\n'
