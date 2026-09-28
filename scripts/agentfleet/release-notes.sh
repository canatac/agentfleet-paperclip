#!/usr/bin/env bash
# Checks, notes and assets of a release of the fork, run by release.yml
# (AF-CI-003a, paperclip-fleet#126; AF-CI-003c, paperclip-fleet#142).
# Documented in docs/agentfleet/CI.md. Git and files only: the registry and
# the GitHub API are queried by the workflow, which passes the results in the
# environment or as files. Tests: release-notes.test.sh.
#
#   release-notes.sh check TAG COMMIT
#       TAG has the format of the tag field of the paperclip-fleet image lock
#       (schemas/image-lock.schema.json) and COMMIT is reachable from
#       origin/main. Exit code 1 otherwise.
#
#   release-notes.sh notes TAG COMMIT DIGEST [SINCE]
#       Release notes on stdout, with the fields of a paperclip-fleet release
#       note (docs/deploy/PROMOTION.md) and those of the release decision
#       (paperclip-fleet#127). SINCE is the commit of the previous release;
#       without it, the upstream base commit of upstream-version.json.
#       Environment: RELEASE_URL, ATTESTATIONS (summary of the verification),
#       RELEASE_IMAGE_RUN, CI_RUN, SECURITY_RUN (run URLs), IMAGE_REPOSITORY,
#       and the outputs of assets: SBOM_SHA256, SBOM_PACKAGES,
#       SBOM_BUNDLE_SHA256, PROVENANCE_BUNDLE_SHA256.
#
#   release-notes.sh assets DIGEST PROVENANCE_JSONL SBOM_JSONL OUTDIR
#       Release assets from the Sigstore bundles of DIGEST (gh attestation
#       download, verified by the workflow): OUTDIR/sbom.spdx.json (the SPDX
#       document of the SBOM attestation), OUTDIR/provenance.sigstore.jsonl,
#       OUTDIR/sbom.sigstore.jsonl and OUTDIR/SHA256SUMS. Every bundle must be
#       an in-toto statement about DIGEST with the expected predicate type.
#       Prints KEY=VALUE lines for $GITHUB_OUTPUT.
#
# Exit code 2 on usage error.
set -Eeuo pipefail

TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
MIGRATIONS_DIR=packages/db/src/migrations
PROVENANCE_TYPE=https://slsa.dev/provenance/v1
SBOM_TYPE=https://spdx.dev/Document/v2.3

usage() {
  sed -n '8,31p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

fail() {
  echo "release: $*" >&2
  exit 1
}

full_commit() {
  git rev-parse --verify --quiet "$1^{commit}" || fail "unknown commit: $1"
}

cmd_check() {
  [[ $# -eq 2 ]] || usage
  local tag=$1 commit
  [[ $tag =~ $TAG_PATTERN ]] \
    || fail "tag $tag does not match $TAG_PATTERN (tag of the paperclip-fleet image lock)"
  commit=$(full_commit "$2")
  git rev-parse --verify --quiet origin/main >/dev/null || fail "origin/main is not fetched"
  git merge-base --is-ancestor "$commit" origin/main \
    || fail "commit $commit is not on main: a release is cut from a reviewed commit of main"
  echo "release: tag $tag, commit $commit on main"
}

upstream_field() {
  git show "$1:upstream-version.json" | jq -er --arg key "$2" '.[$key]'
}

cmd_notes() {
  [[ $# -eq 3 || $# -eq 4 ]] || usage
  local tag=$1 commit digest=$3 since since_label
  : "${RELEASE_URL:?}" "${ATTESTATIONS:?}" "${RELEASE_IMAGE_RUN:?}" "${CI_RUN:?}" \
    "${SECURITY_RUN:?}" "${IMAGE_REPOSITORY:?}"
  : "${SBOM_SHA256:?}" "${SBOM_PACKAGES:?}" "${SBOM_BUNDLE_SHA256:?}" "${PROVENANCE_BUNDLE_SHA256:?}"
  commit=$(full_commit "$2")
  [[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || fail "not a digest: $digest"
  local hash
  for hash in "$SBOM_SHA256" "$SBOM_BUNDLE_SHA256" "$PROVENANCE_BUNDLE_SHA256"; do
    [[ $hash =~ ^[0-9a-f]{64}$ ]] || fail "not a SHA-256: $hash"
  done
  [[ $SBOM_PACKAGES =~ ^[1-9][0-9]*$ ]] || fail "not a package count: $SBOM_PACKAGES"

  local upstream_repository upstream_commit upstream_tag upstream_version
  upstream_repository=$(upstream_field "$commit" repository)
  upstream_commit=$(upstream_field "$commit" commit)
  upstream_tag=$(upstream_field "$commit" tag)
  upstream_version=$(upstream_field "$commit" version)

  if [[ -n ${4:-} ]]; then
    since=$(full_commit "$4")
    since_label="la release précédente \`${since:0:12}\`"
  else
    since=$(full_commit "$upstream_commit")
    since_label="la base upstream \`${since:0:12}\`"
  fi
  git merge-base --is-ancestor "$since" "$commit" || fail "$since is not an ancestor of $commit"

  local migration_count migration_changes db
  migration_count=$(git ls-tree --name-only "$commit" "$MIGRATIONS_DIR/" | grep -c '\.sql$' || true)
  migration_changes=$(git diff --name-status "$since" "$commit" -- "$MIGRATIONS_DIR")
  if [[ -z $migration_changes ]]; then
    db="none (aucune migration ajoutée, modifiée ni supprimée depuis $since_label)"
  else
    db="à classer (none ou additive) dans la PR de promotion ; migrations changées depuis $since_label :"
  fi

  cat <<EOF
# $tag

- Version AgentFleet: $tag
- Tag upstream de base: $upstream_tag
- Commit upstream: $upstream_repository @ \`$upstream_commit\` (version $upstream_version)
- Commit source: $commit
- Digest: $digest
- Image: \`$IMAGE_REPOSITORY@$digest\` (tags \`sha-$commit\` et \`$tag\`)
- SBOM: \`sbom.spdx.json\` (SPDX 2.3, $SBOM_PACKAGES paquets, sha256 \`$SBOM_SHA256\`) ; bundle Sigstore \`sbom.sigstore.jsonl\` (sha256 \`$SBOM_BUNDLE_SHA256\`)
- Provenance: SLSA, bundle Sigstore \`provenance.sigstore.jsonl\` (sha256 \`$PROVENANCE_BUNDLE_SHA256\`)
- Attestation: $ATTESTATIONS
- Release: $RELEASE_URL
- CI: release-image $RELEASE_IMAGE_RUN ; ci $CI_RUN ; security $SECURITY_RUN
- Compatibilité DB: $db
EOF
  if [[ -n $migration_changes ]]; then
    local status path renamed
    while IFS=$'\t' read -r status path renamed; do
      printf "  - %s \`%s\`%s\n" "$status" "$path" "${renamed:+ -> \`$renamed\`}"
    done <<<"$migration_changes"
  fi
  cat <<EOF
- Migrations: $migration_count dans l'image

Pièces jointes : le SBOM et les bundles Sigstore de la provenance et du SBOM,
vérifiables hors ligne (\`gh attestation verify oci://$IMAGE_REPOSITORY@$digest
--bundle <bundle> …\`), et \`SHA256SUMS\`.

Le rollback et le classement final de la compatibilité DB sont écrits dans la
PR de promotion de paperclip-fleet (\`docs/deploy/PROMOTION.md\`), par rapport
à l'image alors déployée. Le déploiement se fait par digest seulement.

## Changements depuis $since_label

EOF
  # Backquotes are Markdown code spans, not shell expansions.
  # shellcheck disable=SC2016
  git log --first-parent --format='- %s (`%h`)' "$since..$commit"
}

# statements JSONL PREDICATE_TYPE HEX — the in-toto statement of each bundle,
# one per line, after checking its envelope, subject and predicate type.
statements() {
  local file=$1 type=$2 hex=$3 line n=0 statement
  [[ -s $file ]] || fail "no attestation bundle in $file"
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -n $line ]] || continue
    n=$((n + 1))
    jq -e '.dsseEnvelope.payloadType == "application/vnd.in-toto+json"' >/dev/null 2>&1 <<<"$line" \
      || fail "$file: bundle $n is not a DSSE envelope of an in-toto statement"
    statement=$(jq -r '.dsseEnvelope.payload' <<<"$line" | base64 -d 2>/dev/null) \
      || fail "$file: bundle $n has no readable payload"
    jq -e --arg type "$type" '.predicateType == $type' >/dev/null 2>&1 <<<"$statement" \
      || fail "$file: bundle $n is not a $type attestation"
    jq -e --arg hex "$hex" 'any(.subject[]?; .digest.sha256 == $hex)' >/dev/null <<<"$statement" \
      || fail "$file: bundle $n is not about sha256:$hex"
    jq -c . <<<"$statement"
  done <"$file"
  ((n > 0)) || fail "no attestation bundle in $file"
}

cmd_assets() {
  [[ $# -eq 4 ]] || usage
  local digest=$1 provenance=$2 sbom=$3 out=$4 hex
  [[ $digest =~ ^sha256:([0-9a-f]{64})$ ]] || fail "not a digest: $digest"
  hex=${BASH_REMATCH[1]}
  local sbom_statements documents packages
  statements "$provenance" "$PROVENANCE_TYPE" "$hex" >/dev/null
  sbom_statements=$(statements "$sbom" "$SBOM_TYPE" "$hex")
  # Several SBOM attestations of one digest must carry the same document.
  documents=$(jq -c '.predicate' <<<"$sbom_statements" | jq -S -c . | sort -u | wc -l)
  ((documents == 1)) || fail "$sbom: $documents different SBOM documents for $digest"
  mkdir -p "$out"
  head -n 1 <<<"$sbom_statements" | jq '.predicate' >"$out/sbom.spdx.json"
  jq -e '.spdxVersion == "SPDX-2.3"' >/dev/null "$out/sbom.spdx.json" || fail "the SBOM is not an SPDX 2.3 document"
  packages=$(jq '.packages | length' "$out/sbom.spdx.json")
  ((packages > 0)) || fail "the SBOM lists no package"
  cp "$provenance" "$out/provenance.sigstore.jsonl"
  cp "$sbom" "$out/sbom.sigstore.jsonl"
  (cd "$out" && sha256sum sbom.spdx.json sbom.sigstore.jsonl provenance.sigstore.jsonl >SHA256SUMS)
  sum() { sha256sum "$out/$1" | cut -d' ' -f1; }
  echo "sbom_sha256=$(sum sbom.spdx.json)"
  echo "sbom_packages=$packages"
  echo "sbom_bundle_sha256=$(sum sbom.sigstore.jsonl)"
  echo "provenance_bundle_sha256=$(sum provenance.sigstore.jsonl)"
  echo "sums_sha256=$(sum SHA256SUMS)"
}

[[ $# -ge 1 ]] || usage
command=$1
shift
case $command in
  check) cmd_check "$@" ;;
  notes) cmd_notes "$@" ;;
  assets) cmd_assets "$@" ;;
  *) usage ;;
esac
