#!/usr/bin/env bash
# Tests of release-notes.sh (AF-CI-003c, paperclip-fleet#142), run by the
# source-integrity job of ci.yml:
# - a synthetic repository: check, notes (fields, DB compatibility) and
#   assets (synthetic Sigstore bundles, refused bundles);
# - the real history of this checkout (fetch-depth 0): check and notes of a
#   release of origin/main, against upstream-version.json.
# Nothing is fetched or published. Exit code 0 when every case passes.
set -Eeuo pipefail

SCRIPT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-notes.sh
REPO=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
failures=0
cases=0

pass() { cases=$((cases + 1)); echo "ok $cases - $1"; }
fail() { cases=$((cases + 1)); failures=$((failures + 1)); echo "not ok $cases - $1"; }
expect() { # expect LABEL COMMAND... : the command succeeds
  local label=$1
  shift
  if "$@" >"$WORK/out" 2>"$WORK/err"; then pass "$label"; else fail "$label"; sed 's/^/# /' "$WORK/err"; fi
}
refuse() { # refuse LABEL PATTERN COMMAND... : exit 1 with PATTERN on stderr
  local label=$1 pattern=$2 status=0
  shift 2
  "$@" >"$WORK/out" 2>"$WORK/err" || status=$?
  if [[ $status == 1 ]] && grep -q -- "$pattern" "$WORK/err"; then pass "$label"; else
    fail "$label (exit $status)"
    sed 's/^/# /' "$WORK/err"
  fi
}
has() { # has LABEL LINE_REGEX : a line of the last output matches
  if grep -Eq -- "$2" "$WORK/out"; then pass "$1"; else fail "$1"; sed 's/^/# /' "$WORK/out"; fi
}

hex() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
DIGEST="sha256:$(hex image)"
export RELEASE_URL=https://example.invalid/releases/tag/v0.1.0
export ATTESTATIONS="verified (fixture)"
export RELEASE_IMAGE_RUN=https://example.invalid/runs/1 CI_RUN=https://example.invalid/runs/2
export SECURITY_RUN=https://example.invalid/runs/3 IMAGE_REPOSITORY=ghcr.io/example/image
export SBOM_SHA256 SBOM_PACKAGES=12 SBOM_BUNDLE_SHA256 PROVENANCE_BUNDLE_SHA256
SBOM_SHA256=$(hex sbom)
SBOM_BUNDLE_SHA256=$(hex sbom-bundle)
PROVENANCE_BUNDLE_SHA256=$(hex provenance-bundle)

# ---- synthetic repository ---------------------------------------------------
repo=$WORK/repo
git init -q "$repo"
g() { git -C "$repo" -c user.name=test -c user.email=test@example.invalid "$@"; }
mkdir -p "$repo/packages/db/src/migrations"
echo "-- 0001" >"$repo/packages/db/src/migrations/0001_init.sql"
echo base >"$repo/README.md"
g add -A
g commit -q -m "upstream base"
base=$(g rev-parse HEAD)
jq -n --arg commit "$base" '{repository: "https://github.com/example/upstream", commit: $commit,
  syncedAt: "2026-09-25T00:00:00Z", tag: "v2026.1.1", version: "0.3.1"}' >"$repo/upstream-version.json"
g add -A
g commit -q -m "fork: record the upstream base"
fork=$(g rev-parse HEAD)
g update-ref refs/remotes/origin/main "$fork"
g checkout -q -b side
echo side >"$repo/side.txt"
g add -A
g commit -q -m "not on main"
side=$(g rev-parse HEAD)
g checkout -q -

cd "$repo"
expect "check accepts a SemVer tag on main" "$SCRIPT" check v0.1.0 "$fork"
refuse "check refuses a tag outside the image-lock pattern" "does not match" "$SCRIPT" check 0.1.0 "$fork"
refuse "check refuses an upstream version as the tag" "does not match" "$SCRIPT" check v2026.1.1.0 "$fork"
refuse "check refuses a commit that is not on main" "is not on main" "$SCRIPT" check v0.1.0 "$side"

expect "notes of the first release" "$SCRIPT" notes v0.1.0 "$fork" "$DIGEST"
for field in "Version AgentFleet: v0.1.0" "Tag upstream de base: v2026.1.1" \
  "Commit upstream: https://github.com/example/upstream @ \`$base\`" "Commit source: $fork" \
  "Digest: $DIGEST" "SBOM: \`sbom.spdx.json\` \(SPDX 2.3, 12 paquets, sha256 \`$SBOM_SHA256\`\)" \
  "Provenance: SLSA, bundle Sigstore \`provenance.sigstore.jsonl\` \(sha256 \`$PROVENANCE_BUNDLE_SHA256\`\)" \
  "Attestation: verified" "Release: $RELEASE_URL" "CI: " "Compatibilité DB: none"; do
  has "notes field: ${field%%:*}" "^- $field"
done
has "notes list the changes since the upstream base" "^- fork: record the upstream base"
refuse "notes require the SBOM hash" "SBOM_SHA256" env -u SBOM_SHA256 "$SCRIPT" notes v0.1.0 "$fork" "$DIGEST"
refuse "notes refuse a malformed hash" "not a SHA-256" env SBOM_BUNDLE_SHA256=abc "$SCRIPT" notes v0.1.0 "$fork" "$DIGEST"
refuse "notes refuse a zero package count" "not a package count" env SBOM_PACKAGES=0 "$SCRIPT" notes v0.1.0 "$fork" "$DIGEST"

echo "-- 0002" >"$repo/packages/db/src/migrations/0002_more.sql"
g add -A
g commit -q -m "fork: add a migration"
g update-ref refs/remotes/origin/main HEAD
expect "notes after a migration change" "$SCRIPT" notes v0.2.0 HEAD "$DIGEST" "$fork"
has "a changed migration is left to the promotion PR" "^- Compatibilité DB: à classer"
has "the changed migration is listed" "A \`packages/db/src/migrations/0002_more.sql\`"
cd - >/dev/null

# ---- assets -------------------------------------------------------------------
# bundle PREDICATE_TYPE SUBJECT_HEX PREDICATE_JSON — one synthetic bundle line.
bundle() {
  local statement
  statement=$(jq -cn --arg type "$1" --arg hex "$2" --argjson predicate "$3" \
    '{_type: "https://in-toto.io/Statement/v1", subject: [{name: "ghcr.io/example/image", digest: {sha256: $hex}}],
      predicateType: $type, predicate: $predicate}')
  jq -cn --arg payload "$(printf '%s' "$statement" | base64 -w0)" \
    '{mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      dsseEnvelope: {payload: $payload, payloadType: "application/vnd.in-toto+json", signatures: [{sig: "fixture"}]}}'
}
image_hex=${DIGEST#sha256:}
spdx='{"spdxVersion": "SPDX-2.3", "name": "fixture", "packages": [{"name": "a"}, {"name": "b"}, {"name": "c"}]}'
provenance='{"buildDefinition": {"buildType": "fixture"}}'
bundle https://slsa.dev/provenance/v1 "$image_hex" "$provenance" >"$WORK/provenance.jsonl"
bundle https://spdx.dev/Document/v2.3 "$image_hex" "$spdx" >"$WORK/sbom.jsonl"
bundle https://spdx.dev/Document/v2.3 "$image_hex" "$spdx" >>"$WORK/sbom.jsonl"

expect "assets from the bundles of the digest" "$SCRIPT" assets "$DIGEST" "$WORK/provenance.jsonl" "$WORK/sbom.jsonl" "$WORK/assets"
has "assets output: SBOM hash" "^sbom_sha256=[0-9a-f]{64}$"
has "assets output: SBOM package count" "^sbom_packages=3$"
has "assets output: bundle hashes" "^provenance_bundle_sha256=[0-9a-f]{64}$"
if [[ $(jq -c . "$WORK/assets/sbom.spdx.json") == "$(jq -c . <<<"$spdx")" ]]; then
  pass "sbom.spdx.json is the SPDX document of the attestation"
else fail "sbom.spdx.json is the SPDX document of the attestation"; fi
if (cd "$WORK/assets" && sha256sum --quiet -c SHA256SUMS) &&
  cmp -s "$WORK/provenance.jsonl" "$WORK/assets/provenance.sigstore.jsonl" &&
  cmp -s "$WORK/sbom.jsonl" "$WORK/assets/sbom.sigstore.jsonl"; then
  pass "bundles attached unchanged, SHA256SUMS consistent"
else fail "bundles attached unchanged, SHA256SUMS consistent"; fi
if grep -qx "sbom_sha256=$(sha256sum "$WORK/assets/sbom.spdx.json" | cut -d' ' -f1)" "$WORK/out"; then
  pass "the printed SBOM hash is the hash of the attached file"
else fail "the printed SBOM hash is the hash of the attached file"; fi

bundle https://spdx.dev/Document/v2.3 "$(hex other-image)" "$spdx" >"$WORK/other-subject.jsonl"
refuse "assets refuse a bundle about another digest" "is not about" \
  "$SCRIPT" assets "$DIGEST" "$WORK/provenance.jsonl" "$WORK/other-subject.jsonl" "$WORK/a1"
refuse "assets refuse a provenance bundle given as SBOM" "is not a https://spdx.dev" \
  "$SCRIPT" assets "$DIGEST" "$WORK/provenance.jsonl" "$WORK/provenance.jsonl" "$WORK/a2"
cp "$WORK/sbom.jsonl" "$WORK/two-documents.jsonl"
bundle https://spdx.dev/Document/v2.3 "$image_hex" '{"spdxVersion": "SPDX-2.3", "packages": [{"name": "z"}]}' \
  >>"$WORK/two-documents.jsonl"
refuse "assets refuse two different SBOM documents" "different SBOM documents" \
  "$SCRIPT" assets "$DIGEST" "$WORK/provenance.jsonl" "$WORK/two-documents.jsonl" "$WORK/a3"
bundle https://spdx.dev/Document/v2.3 "$image_hex" '{"spdxVersion": "SPDX-2.2", "packages": [{"name": "a"}]}' \
  >"$WORK/old-spdx.jsonl"
refuse "assets refuse an SBOM that is not SPDX 2.3" "not an SPDX 2.3 document" \
  "$SCRIPT" assets "$DIGEST" "$WORK/provenance.jsonl" "$WORK/old-spdx.jsonl" "$WORK/a4"
bundle https://spdx.dev/Document/v2.3 "$image_hex" '{"spdxVersion": "SPDX-2.3", "packages": []}' >"$WORK/empty-sbom.jsonl"
refuse "assets refuse an SBOM without package" "lists no package" \
  "$SCRIPT" assets "$DIGEST" "$WORK/provenance.jsonl" "$WORK/empty-sbom.jsonl" "$WORK/a5"
: >"$WORK/none.jsonl"
refuse "assets refuse a missing bundle" "no attestation bundle" \
  "$SCRIPT" assets "$DIGEST" "$WORK/none.jsonl" "$WORK/sbom.jsonl" "$WORK/a6"
echo '{"dsseEnvelope": {"payloadType": "text/plain", "payload": ""}}' >"$WORK/not-dsse.jsonl"
refuse "assets refuse a bundle that is not an in-toto envelope" "not a DSSE envelope" \
  "$SCRIPT" assets "$DIGEST" "$WORK/not-dsse.jsonl" "$WORK/sbom.jsonl" "$WORK/a7"

# ---- real history -------------------------------------------------------------
if git -C "$REPO" rev-parse --verify --quiet origin/main >/dev/null &&
  git -C "$REPO" cat-file -e "$(jq -r .commit "$REPO/upstream-version.json")^{commit}" 2>/dev/null; then
  cd "$REPO"
  head=$(git rev-parse origin/main)
  expect "real history: check v0.1.0 on origin/main" "$SCRIPT" check v0.1.0 "$head"
  expect "real history: notes of v0.1.0" "$SCRIPT" notes v0.1.0 "$head" "$DIGEST"
  has "real history: upstream tag of upstream-version.json" \
    "^- Tag upstream de base: $(git show "$head:upstream-version.json" | jq -r .tag)$"
  has "real history: upstream commit of upstream-version.json" \
    "^- Commit upstream: .* @ \`$(git show "$head:upstream-version.json" | jq -r .commit)\`"
  has "real history: source commit" "^- Commit source: $head$"
  cd - >/dev/null
else
  fail "real history: origin/main and the upstream base commit are required (fetch-depth: 0)"
fi

echo "1..$cases"
((failures == 0)) || { echo "$failures of $cases cases failed"; exit 1; }
echo "all $cases cases passed"
