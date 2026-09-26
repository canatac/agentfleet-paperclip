# agentfleet-paperclip

Fork de [`paperclipai/paperclip`](https://github.com/paperclipai/paperclip)
exécuté par la flotte AgentFleet. Il porte le code Paperclip déployé sur
conductor-ops, le correctif `externalRunId`, la CI et la publication d'image.
L'état désiré et le déploiement vivent dans
[`canatac/paperclip-fleet`](https://github.com/canatac/paperclip-fleet), qui
suit les tickets de ce dépôt (épopée
[paperclip-fleet#5](https://github.com/canatac/paperclip-fleet/issues/5)).

## Branches et remotes

| Branche | Rôle |
|---|---|
| `main` | code AgentFleet : le commit upstream de base, puis uniquement des PR, une par ticket |
| `feat/<ticket>` | branche courte d'un ticket, fusionnée dans `main` par PR |
| `master` | branche par défaut héritée du fork, copie de l'upstream ; non utilisée par AgentFleet |

Remote upstream à configurer dans chaque clone :

```sh
git remote add upstream https://github.com/paperclipai/paperclip
```

Aucune modification ne vit seulement sur la VM : chaque changement réel est un
commit propre de ce dépôt. L'historique local de `/opt/paperclip/upstream`
n'est pas importé ; les changements nécessaires y sont recréés à partir du
commit de base.

## Commit upstream de base

Consigné dans [`upstream-version.json`](../../upstream-version.json) :
`d554c4789ed3930f8a53ac9fdf6503b3187097da`, release upstream `v2026.916.1`
(`@paperclipai/server` et CLI `paperclipai` 0.3.1).

Sources, relevées par l'inventaire de production de `paperclip-fleet`
(runs 36140020535 et 36144016823) :

| Source | Valeur | Retenue |
|---|---|---|
| `PAPERCLIP_BUILD_COMMIT` du conteneur live | valeur présente mais pas un SHA (34 caractères, non affichée) | non : inexploitable |
| Historique de `/opt/paperclip/upstream` | HEAD `4878cdce0898` sur `pc-obs-hermes-run-link-r1` ; deux commits locaux `2065e172f317` et `4878cdce0898` au-dessus de `d554c4789ed3` ; 3 fichiers modifiés et 7 non suivis | oui : parent commun des modifications locales |

Vérifications sur l'upstream public :

- `d554c4789ed3` porte les tags `v2026.916.1` et `beta/v2026.921.0-beta.0` ;
- il n'est pas sur `master` : c'est `v2026.916.0` (`dffc2b3ca1b9`, sur
  `master`) plus le correctif #13562 reporté sur la ligne de release, dont
  l'équivalent sur `master` est `5d9b20ccf05e`. Une resynchronisation future
  avec une release plus récente retrouvera ce correctif.

`syncedAt` est la date de positionnement de `main` sur ce commit.

## Workflows

Les 20 workflows de l'upstream ont été retirés de `main`
([paperclip-fleet#63](https://github.com/canatac/paperclip-fleet/issues/63),
décision de l'opérateur du 25/09/2026). Plusieurs publiaient ou appelaient des
services upstream (`release.yml`, `docker.yml`, `commitperclip-review.yml` en
`pull_request_target`, `pr.yml` sur les runners AWS de l'upstream). Le fork
n'a que ses propres workflows, sur runners GitHub (spécification §6.1 et §7) :
`ci.yml`, `integration.yml`, `release-image.yml`, `dependency-review.yml`
([paperclip-fleet#19](https://github.com/canatac/paperclip-fleet/issues/19)).
Les scripts appelés par les workflows upstream (`scripts/`, `.github/scripts/`)
sont conservés.

### Tests exclus de la régression

Ces tests upstream lisent les fichiers de workflow retirés et vérifient
l'infrastructure de release, de cloud et de CI de l'upstream, que le fork
n'utilise pas. Constat du 25/09/2026, avec et sans les workflows : ils passent
tous quand les workflows sont présents, et échouent sans eux. Ils sont exclus
de la régression du fork
([paperclip-fleet#66](https://github.com/canatac/paperclip-fleet/issues/66)) ;
aucun autre test ne l'est à ce titre. Trois fichiers serveur, qui construisent
le chemin des workflows avec `path.join`, avaient échappé à la mesure du
25/09 : la régression sur runners GitHub les a révélés, et l'opérateur a
décidé le 26/09 de les exclure pour la même raison
([décision](https://github.com/canatac/paperclip-fleet/issues/66#issuecomment-5845189866)).
Leurs assertions sur le `Dockerfile` sont à reprendre dans le job d'image
([paperclip-fleet#20](https://github.com/canatac/paperclip-fleet/issues/20)).
Les fichiers Vitest de cette liste sont exclus par
[`scripts/agentfleet/regression-policy.json`](../../scripts/agentfleet/regression-policy.json).

| Fichier | Lanceur | Échecs sans les workflows |
|---|---|---|
| `.github/scripts/tests/cloud-readiness.test.mjs` | `node --test` | 1 / 18 |
| `.github/scripts/tests/lockfile-refresh-workflows.test.mjs` | `node --test` | 1 / 1 |
| `packages/paperclip-runner/scripts/runner-protocol-eval-workflow-security.test.mjs` | `node --test` | 4 / 4 |
| `scripts/__tests__/e2e-shard.test.mjs` | `node --test` | 6 / 11 |
| `scripts/__tests__/release-verify-workflow.test.mjs` | `node --test` | 11 / 12 |
| `scripts/__tests__/storybook-deploy.test.mjs` | `node --test` | 1 / 20 |
| `scripts/cloud-migrator-artifacts.test.mjs` | `node --test` | 1 / 7 |
| `scripts/preview-artifacts.test.mjs` | `node --test` | 6 / 19 |
| `scripts/release-lib.test.mjs` | `node --test` | ne se charge plus (15 tests) |
| `server/src/__tests__/cloud-image-bundled-plugins.test.ts` | Vitest (serveur) | ne se charge plus (5 tests) |
| `server/src/__tests__/cloud-image-sentry.test.ts` | Vitest (serveur) | ne se charge plus (9 tests) ; ajouté le 26/09 |
| `server/src/__tests__/container-init-reaping.test.ts` | Vitest (serveur) | ne se charge plus (8 tests) ; ajouté le 26/09 |
| `server/src/__tests__/docker-build-stamp.test.ts` | Vitest (serveur) | ne se charge plus (5 tests) ; ajouté le 26/09 |
| `tests/runner-e2e/codex-ci-sandbox.test.ts`, `daytona-image.test.ts`, `workflow-security.test.ts` | Vitest (`tests/runner-e2e`) | 11 / 18 |

## Resynchronisation avec l'upstream

Chaque montée de version upstream passe par une PR dédiée qui intègre la
release visée dans `main` et met à jour `upstream-version.json`, sans autre
changement. Les workflows upstream restent retirés : un workflow ajouté ou
modifié par l'upstream est supprimé dans la même PR, et la liste des tests
exclus ci-dessus est revue, avec
[`scripts/agentfleet/regression-policy.json`](../../scripts/agentfleet/regression-policy.json).
Si le runner de tests upstream change, la régression échoue jusqu'à la relecture
de `scripts/agentfleet/run-regression.mjs` (voir [`CI.md`](CI.md)).
