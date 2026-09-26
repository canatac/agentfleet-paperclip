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
| `regression (<lot>)` | un lot des suites de régression upstream (section suivante) |
| `regression` | réussit si et seulement si tous les lots ont réussi : c'est le check à rendre obligatoire |

`corepack` remplace `pnpm/action-setup` de l'upstream : pas d'action tierce
à autoriser, et la version vient du champ `packageManager`.

## Régression upstream (AF-CI-001d)

Les lots sont ceux du workflow de PR upstream (`pr-trusted.yml` au commit de
base, jobs « General tests » et « Verify serialized server suites »), sur
runners GitHub :

| Lot | Contenu |
|---|---|
| `general-server:1/5` à `5/5` | suites serveur hors routes, réparties par durée enregistrée (`scripts/general-server-shard-durations.json`), un processus Vitest par lot, `--no-file-parallelism --maxWorkers=1` |
| `general-workspaces-a:1/2`, `2/2` | projets `@paperclipai/ui` et `paperclipai` (CLI), découpés par `--shard` de Vitest |
| `general-workspaces-b` | les 12 autres projets de `nonServerProjects` (shared, db, adapter-utils, adaptateurs locaux, plugins…) |
| `serialized:1/5` à `5/5` | suites de routes et d'autorisation, une invocation Vitest par fichier, `--pool=forks --isolate` |

[`scripts/agentfleet/run-regression.mjs`](../../scripts/agentfleet/run-regression.mjs)
exécute un lot :

1. la sélection des suites est celle du runner upstream, inchangé :
   `scripts/run-vitest-stable.mjs --dry-run` ;
2. chaque invocation Vitest reprend les arguments du runner upstream et son
   isolation (`PAPERCLIP_HOME`, `PAPERCLIP_CONFIG`, `PAPERCLIP_INSTANCE_ID`,
   `TMPDIR` propres à l'invocation), et ajoute un rapport JSON ;
3. le lot échoue sur tout test ou fichier en échec, et sur tout test ignoré ou
   `todo` qui n'est pas une exception approuvée.

Contrairement au runner upstream, qui s'arrête à la première invocation en
échec, le lot exécute toutes ses invocations puis fait le bilan : un run
montre tous les échecs à la fois. Le résumé du job liste les tests ignorés, et
les rapports JSON sont conservés 14 jours (artefacts `regression-reports-*`).

[`scripts/agentfleet/regression-policy.json`](../../scripts/agentfleet/regression-policy.json)
porte :

- `excludedFiles` : fichiers upstream non exécutés, chacun avec sa raison et la
  décision qui l'approuve (aujourd'hui le seul fichier Vitest de la liste du
  [`README.md`](README.md)) ;
- `allowedSkips` : tests ignorés acceptés comme exceptions, identifiés par
  fichier et nom complet exact, chacun avec sa raison et la décision qui
  l'approuve.

Garde-fou de resynchronisation : le script épingle l'empreinte SHA-256 de
`scripts/run-vitest-stable.mjs` et le texte des scripts `test:run:general` et
`test:run:serialized` de `package.json`. Si une montée de version les modifie,
tous les lots échouent jusqu'à ce que le script soit relu et l'empreinte mise à
jour.

Hors de ces lots, suivis à part :

- vérification du Paperclip Runner (`check:all`, tests Rust) :
  [paperclip-fleet#71](https://github.com/canatac/paperclip-fleet/issues/71) ;
- tests qu'aucun lot upstream n'exécute (2 fichiers serveur hors sélection,
  5 projets d'adaptateurs absents de `nonServerProjects`) :
  [paperclip-fleet#72](https://github.com/canatac/paperclip-fleet/issues/72).

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
| `regression` | AF-CI-001d |
| sécurité | AF-CI-001e |

## Exécution locale

Node 24, puis :

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm check:node-version && pnpm check:tokens && pnpm check:module-boundaries
pnpm typecheck
```

Un lot de régression, sous un utilisateur non root (le PostgreSQL embarqué
refuse root) :

```sh
node scripts/agentfleet/run-regression.mjs --lot serialized:1/5 --plan
node scripts/agentfleet/run-regression.mjs --lot serialized:1/5 --report-dir /tmp/regression
```
