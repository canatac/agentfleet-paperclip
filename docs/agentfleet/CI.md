# CI du fork

Spécification §7.1 et §7.2 ; tickets AF-CI-001a à e
([paperclip-fleet#19](https://github.com/canatac/paperclip-fleet/issues/19)).
Les workflows de l'upstream sont retirés (voir [`README.md`](README.md)) ; le
fork n'exécute que les siens, sur runners GitHub, avec des actions épinglées
par SHA, un jeton en lecture seule et aucun secret.

## `ci.yml` (AF-CI-001b)

Déclenché sur les pull requests vers `main`, sur les push sur `main`, et à la
demande (`workflow_dispatch`, onglet Actions).

| Job | Contrôles |
|---|---|
| `source-integrity` | pnpm de `packageManager` (9.15.4, via `corepack`) et Node 24 ; `pnpm install --frozen-lockfile` ; arbre inchangé après installation ; `upstream-version.json` (upstream officiel, SHA complet, date ISO 8601, commit ancêtre de `HEAD`) ; contrôles de l'upstream : politique de version Node, étape `deps` du Dockerfile, jetons interdits, pas de `git push` dans le code des adaptateurs, frontières de modules, ordre des migrations sur PR |
| `typecheck` | `pnpm typecheck` : typecheck strict de chaque package du monorepo, avec les constructions dont il dépend (SDK de plugins, bundle du runner, `cargo check` du runner Rust) |
| `agentfleet-tests` | tests de [`TEST_STRATEGY.md`](TEST_STRATEGY.md) : unitaires de l'adaptateur Hermes, tests serveur `heartbeat-external-run-id*` et test d'intégration du faux gateway Hermes (PostgreSQL embarqué, API). Rapport JSON de Vitest : le job échoue si un test est ignoré, `todo` ou en échec. Le PostgreSQL embarqué ne démarre pas en root et ses tests sont alors ignorés : le runner GitHub tourne sous l'utilisateur `runner` |

`corepack` remplace `pnpm/action-setup` de l'upstream : pas d'action tierce
à autoriser, et la version vient du champ `packageManager`.

## Lint et format

L'upstream ne déclare ni linter ni formateur : aucun script `lint` ou `format`
à la racine, et le script `lint` de l'adaptateur Hermes appelle ESLint, qui
n'est ni installé ni configuré. La CI ne l'invente pas. Le contrôle le plus
proche est le typecheck strict. Ajouter un linter serait un changement propre
au fork, à décider.

## Checks obligatoires sur `main`

À déclarer dans le ruleset `main` du fork, au fil des tickets :

| Check | Ticket |
|---|---|
| `source-integrity`, `typecheck` | AF-CI-001b |
| `agentfleet-tests` | AF-CI-001c |
| sécurité | AF-CI-001e |
| régression upstream | AF-CI-001d |

## Exécution locale

Node 24, puis :

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm check:node-version && pnpm check:tokens && pnpm check:module-boundaries
pnpm typecheck
```
