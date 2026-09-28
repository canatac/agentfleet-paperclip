#!/usr/bin/env bash
# Checks and notes of a release of the fork, run by release.yml (AF-CI-003a,
# paperclip-fleet#126). Documented in docs/agentfleet/CI.md. Git only: the
# registry and the GitHub API are queried by the workflow, which passes the
# results in the environment.
#
#   release-notes.sh check TAG COMMIT
#       TAG has the format of the tag field of the paperclip-fleet image lock
#       (schemas/image-lock.schema.json) and COMMIT is reachable from
#       origin/main. Exit code 1 otherwise.
#
#   release-notes.sh notes TAG COMMIT DIGEST [SINCE]
#       Release notes on stdout, with the fields of a paperclip-fleet release
#       note (docs/deploy/PROMOTION.md). SINCE is the commit of the previous
#       release; without it, the upstream base commit of upstream-version.json.
#       Environment: RELEASE_URL, ATTESTATIONS (summary of the verification),
#       RELEASE_IMAGE_RUN, CI_RUN, SECURITY_RUN (run URLs), IMAGE_REPOSITORY.
#
# Exit code 2 on usage error.
set -Eeuo pipefail

TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
MIGRATIONS_DIR=packages/db/src/migrations

usage() {
  sed -n '7,17p' "$0" | sed 's/^# \{0,1\}//' >&2
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
  commit=$(full_commit "$2")
  [[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || fail "not a digest: $digest"

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

- Release: $RELEASE_URL
- Commit source: $commit
- Digest: $digest
- Image: \`$IMAGE_REPOSITORY@$digest\` (tags \`sha-$commit\` et \`$tag\`)
- Attestation: $ATTESTATIONS
- CI: release-image $RELEASE_IMAGE_RUN ; ci $CI_RUN ; security $SECURITY_RUN
- Upstream: $upstream_repository @ \`$upstream_commit\` ($upstream_tag, $upstream_version)
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

Le rollback et le classement final de la compatibilité DB sont écrits dans la
PR de promotion de paperclip-fleet (\`docs/deploy/PROMOTION.md\`), par rapport
à l'image alors déployée. Le déploiement se fait par digest seulement.

## Changements depuis $since_label

EOF
  # Backquotes are Markdown code spans, not shell expansions.
  # shellcheck disable=SC2016
  git log --first-parent --format='- %s (`%h`)' "$since..$commit"
}

[[ $# -ge 1 ]] || usage
command=$1
shift
case $command in
  check) cmd_check "$@" ;;
  notes) cmd_notes "$@" ;;
  *) usage ;;
esac
