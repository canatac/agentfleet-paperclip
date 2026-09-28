# CI du fork

Spécification §7.1, §7.2 et §14 ; tickets AF-CI-001a à i
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
| `agentfleet-tests` | tests de [`TEST_STRATEGY.md`](TEST_STRATEGY.md) : unitaires de l'adaptateur Hermes, tests serveur `heartbeat-external-run-id*` et test d'intégration du faux gateway Hermes (PostgreSQL embarqué, API) ; test serveur `heartbeat-task-session-nul` (AF-OBS-006 : paramètres de session de tâche contenant NUL refusés, PostgreSQL embarqué) ; test serveur `heartbeat-session-id-nul` (AF-OBS-007 : identifiant de session contenant NUL traité comme absent, PostgreSQL embarqué). Rapport JSON de Vitest : le job échoue si un test est ignoré, `todo` ou en échec. Le PostgreSQL embarqué ne démarre pas en root et ses tests sont alors ignorés : le runner GitHub tourne sous l'utilisateur `runner` |
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
| `complement` | propre au fork (AF-CI-001g) : ce qu'aucun lot upstream ne sélectionne, recalculé à chaque run. Fichiers de test serveur (`include` de `server/vitest.config.ts`) hors des sélections `general-server` et `serialized`, un fichier par invocation `--pool=forks --isolate` ; projets du `vitest.config.ts` racine qui ne sont ni le serveur ni un projet `general-workspaces` |

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
  décision qui l'approuve (les 4 fichiers Vitest de la liste du
  [`README.md`](README.md)) ;
- `allowedSkips` : tests ignorés acceptés comme exceptions, chacun avec sa
  famille, sa raison et la décision qui l'approuve, identifiés par fichier et
  nom complet exact, ou par fichier et préfixe de nom avec le nombre exact
  attendu. Dans un lot qui exécute le fichier, une exception qui ne correspond
  plus exactement fait échouer le lot : un test qui tourne de nouveau ou un
  nouveau test ignoré impose de relire la politique.

Exceptions approuvées par l'opérateur le 26/09/2026
([décision](https://github.com/canatac/paperclip-fleet/issues/66#issuecomment-5845189866),
[révision pour bubblewrap](https://github.com/canatac/paperclip-fleet/issues/66#issuecomment-5847816395)),
64 tests :

| Famille | Tests | Raison |
|---|---|---|
| `platform` | 2 | ne tourne que hors Linux (Windows, hôte non Linux) |
| `live` | 8 | service externe réel ou ses identifiants (Daytona, CLI Claude, exercice HTTPS) : la CI n'a aucun secret et ne fait aucun appel live |
| `fixture` | 35 | fixtures capturées à la main depuis le runner privé, avec une base dédiée |
| `runnerd` | 7 | binaire Rust `runnerd` non construit en CI ; temporaire, jusqu'à [paperclip-fleet#71](https://github.com/canatac/paperclip-fleet/issues/71) |
| `sdk` | 6 | SDK optionnels non installés par le lockfile (`@sentry/node`, OpenTelemetry SDK) |
| `bench` | 2 | benchmarks optionnels |
| `bwrap` | 4 | tests optionnels du bac à sable `bubblewrap` (`PAPERCLIP_TEST_BWRAP`). Activés en CI, ils ont révélé un bug upstream : la portée `workspace` échoue sur les hôtes « usr-merged » comme Ubuntu 24.04 ([paperclip-fleet#77](https://github.com/canatac/paperclip-fleet/issues/77)). AgentFleet n'utilise pas ce bac à sable, et le code applicatif n'est pas modifié |

Garde-fou de resynchronisation : le script épingle l'empreinte SHA-256 de
`scripts/run-vitest-stable.mjs` et le texte des scripts `test:run:general` et
`test:run:serialized` de `package.json`. Si une montée de version les modifie,
tous les lots échouent jusqu'à ce que le script soit relu et l'empreinte mise à
jour. Le lot `complement` épingle aussi l'`include` de test de
`server/vitest.config.ts`, et exige que les projets du `vitest.config.ts`
racine restent une liste de répertoires.

Contenu du lot `complement` au 26/09/2026 : 3 fichiers serveur
(`server/src/routes/setup-token-route.test.ts`,
`server/src/services/openrouter-models.test.ts`, écartés par le motif de
routes upstream hors de `__tests__`, et
`server/scripts/verify-runner-vendor-dependencies.test.mjs`) et 5 projets
d'adaptateurs absents de `nonServerProjects` (`cursor-cloud`, `cursor-local`,
`gemini-local`, `kimi-local`, `pi-local`). Il a révélé un test `cursor-local`
en échec upstream depuis le 20/06/2026, corrigé dans le test
([paperclip-fleet#83](https://github.com/canatac/paperclip-fleet/issues/83)).

## Paperclip Runner (AF-CI-001f)

L'image de production embarque le runner : le build du serveur compile
`paperclip-runnerd` (Rust, release) et le copie dans
`server/dist/vendor/paperclip-runner/`. Le job `runner` reprend le job
upstream « Verify Paperclip Runner » (`pr-trusted.yml`) :
`pnpm --filter @paperclipai/paperclip-runner check:all`. Il couvre le noyau
d'évaluation, le protocole, les tests TypeScript et Vitest du runner,
`cargo test --release` sur l'espace de travail `runner/`, les parités de
conformité et de rejeu, et `api-authority`. La toolchain vient de
`packages/paperclip-runner/rust-toolchain.toml` (1.97.1), installée par le
`rustup` de l'image du runner.

Aucun test ignoré :

- le banc d'essai opt-in `runnerd-final-output-burst` (3 cas, faux
  fournisseur, assertions de justesse et non de temps) est activé par
  `PAPERCLIP_FINAL_BURST_BENCHMARK=1` ;
- [`scripts/agentfleet/verify-runner-log.mjs`](../../scripts/agentfleet/verify-runner-log.mjs)
  relit le journal de `check:all` et échoue sur tout test Vitest ou node:test
  ignoré, `todo` ou annulé, et sur tout test Rust `#[ignore]`, sauf les deux
  points d'entrée de sous-processus de `codex_provider.rs`. Ce sont leurs
  tests parents qui les exécutent, dans un processus enfant : chacun doit
  apparaître une fois ignoré et une fois réussi.

Pas de cache Rust : le build part de zéro à chaque run (environ 13 minutes
en local sur 4 cœurs, dont 5 de compilation release).

## Lint et format

L'upstream ne déclare ni linter ni formateur : aucun script `lint` ou `format`
à la racine, et le script `lint` de l'adaptateur Hermes appelle ESLint, qui
n'est ni installé ni configuré. La CI ne l'invente pas. Le contrôle le plus
proche est le typecheck strict. Ajouter un linter serait un changement propre
au fork, à décider.

## `security.yml` (AF-CI-001e)

Même déclenchement que `ci.yml`.

| Job | Contrôles |
|---|---|
| `secrets` | [`scripts/agentfleet/check-secrets.sh`](../../scripts/agentfleet/check-secrets.sh) avec gitleaks 8.30.1 (version épinglée, empreinte SHA-256 vérifiée), en quatre étapes décrites ci-dessous |

1. **Arbre suivi à `HEAD`** : règles par défaut de gitleaks
   ([`.gitleaks.toml`](../../.gitleaks.toml)), sans aucune suppression
   globale (ni chemin, ni type de fichier, ni règle). Les correspondances
   relues du contenu upstream qui ne contiennent aucun secret sont listées une
   par une dans [`.gitleaksignore`](../../.gitleaksignore) (fichier, règle,
   ligne), regroupées et commentées : fixtures de test, documentation
   (empreintes, identifiants de jetons révoqués), un message d'erreur, une clé
   volontairement fausse d'un smoke test.
2. **Liste exacte** : sans `.gitleaksignore`, les correspondances sont
   exactement ses entrées. Une entrée qui ne correspond plus à rien (ligne
   déplacée ou supprimée par une resynchronisation) fait échouer le job et
   impose une nouvelle relecture.
3. **Témoin** : un jeton GitHub et une clé privée factices, générés à
   l'exécution dans un nouveau fichier, doivent être signalés alors que
   `.gitleaksignore` est actif.
4. **Historique AgentFleet** : chaque commit depuis le commit upstream de base
   (`upstream-version.json`), scanné depuis un clone miroir pour qu'aucune
   entrée de `.gitleaksignore` ne s'y applique.

Contre-épreuves locales (26/09/2026) : une entrée périmée, un secret commité
dans un nouveau fichier, puis ce même secret supprimé de l'arbre mais resté
dans l'historique AgentFleet font chacun échouer le job, à l'étape attendue.

### Dépendances (AF-CI-001h)

Décision de l'opérateur du 26/09/2026
([paperclip-fleet#73](https://github.com/canatac/paperclip-fleet/issues/73#issuecomment-5845190403)) :
bloquer les vulnérabilités nouvelles, afficher l'audit complet sans bloquer.

| Workflow, job | Contrôles |
|---|---|
| `dependency-review.yml`, `dependency-review` | sur chaque PR, `actions/dependency-review-action` (v5.0.0, épinglée par SHA) : échec si la PR ajoute une dépendance avec une vulnérabilité connue haute ou critique. Les licences sont contrôlées sur tout l'inventaire par ailleurs ([paperclip-fleet#74](https://github.com/canatac/paperclip-fleet/issues/74)) |
| `security.yml`, `dependency-audit` | [`scripts/agentfleet/report-audit.mjs`](../../scripts/agentfleet/report-audit.mjs) : `pnpm audit --prod` sur le lockfile, nombre de vulnérabilités par sévérité et détail des hautes et critiques dans le résumé du job, rapport JSON conservé 14 jours. N'échoue que si l'audit ne peut pas tourner |

État au 26/09/2026 : 0 critique, 11 hautes. `multer` (serveur, 3 avis) est
corrigé dans le fork par un override pnpm (2.4.0,
[paperclip-fleet#76](https://github.com/canatac/paperclip-fleet/issues/76)) ;
les autres, via des adaptateurs autres que Hermes et l'UI, attendent une
resynchronisation upstream.

### Licences (AF-CI-001i)

Décision de l'opérateur du 26/09/2026
([paperclip-fleet#74](https://github.com/canatac/paperclip-fleet/issues/74#issuecomment-5845190747)).
Le job `licenses` lance
[`scripts/agentfleet/verify-licenses.mjs`](../../scripts/agentfleet/verify-licenses.mjs)
après une installation figée : `pnpm licenses list --prod`, puis comparaison
avec [`scripts/agentfleet/license-policy.json`](../../scripts/agentfleet/license-policy.json).

- **Acceptées** : MIT, Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, BSD, 0BSD,
  MIT-0, CC0-1.0, Unlicense, BlueOak-1.0.0, Python-2.0, MPL-2.0,
  LGPL-3.0-or-later (identifiants comparés sans casse ; une expression passe si
  chaque terme `AND`, ou une alternative `OR`, est acceptée).
- **Refusées** : toute autre licence, GPL, AGPL et SSPL comprises.
- **Exceptions revues** (nom, version et licence déclarée) : 10 paquets au
  26/09/2026. Le SDK Claude Agent et le SDK Cursor sont **propriétaires**
  (« All rights reserved », conditions de leur éditeur) et viennent des
  adaptateurs `claude-local` et `cursor-cloud`. `khroma` est MIT sans champ
  `license`. Les quatre binaires `opencode-linux-x64*` n'ont pas de
  métadonnées de licence ; leur paquet parent `opencode-ai` est MIT.
- Une exception qui ne correspond plus à un paquet installé (version changée,
  paquet retiré) fait échouer le job : elle doit être revue de nouveau.

Contre-épreuves locales : une exception retirée, une exception sans paquet et
MPL-2.0 retirée de la liste font chacune échouer le job, sur les paquets
attendus.

## `release-image.yml` (AF-CI-002)

Image Paperclip du fork, construite une seule fois, testée puis attestée
(spécification §7.2 et §7.3 ; contrat :
[`PROMOTION.md` de paperclip-fleet](https://github.com/canatac/paperclip-fleet/blob/main/docs/deploy/PROMOTION.md)).
Les étapes communes sont dans l'action composite
[`.github/actions/agentfleet-image`](../../.github/actions/agentfleet-image/action.yml) :
une pull request exécute exactement ce que `main` exécute avant de publier.

| Job | Déclenchement | Jeton | Étapes |
|---|---|---|---|
| `verify-image` | pull request touchant l'image (`Dockerfile`, `.dockerignore`, le workflow, l'action, le smoke test, l'entrypoint), lancement manuel | lecture seule | build, smoke test, contre-épreuve, SBOM |
| `publish-image` | push sur `main` | `packages`, `id-token`, `attestations` en écriture | les mêmes, puis push par digest, contrôle de la copie du registre, attestations, vérification |

**Build.** Cible `production` du `Dockerfile` upstream, inchangé, pour
`linux/amd64` seulement : le runner auto-hébergé de `conductor-ops` porte le
label `x64` ([job 108100601001](https://github.com/canatac/paperclip-fleet/actions/runs/36144016823/job/108100601001)).
Aucun cache de build, aucun manifeste d'attestation BuildKit
(`--provenance=false --sbom=false`) : l'image est un manifeste unique.
`PAPERCLIP_BUILD_COMMIT` vaut le commit construit. Labels :
`org.opencontainers.image.source`, `revision`, `version` (la version que le
serveur annonce sans tag : `<version de server/package.json>+0.git.<sha7>`),
`created`, `title`, `licenses` ; base upstream d'`upstream-version.json`
(`io.github.canatac.agentfleet.upstream-*`) ; labels de schéma de l'upstream
(`io.github.paperclipai.schema.last-migration`, `migration-count`). La couche
des outils CLI du `Dockerfile` installe des versions `@latest` : le SBOM
enregistre celles qui sont réellement dans l'image.

**Smoke test** ([`image-smoke.sh`](../../scripts/agentfleet/image-smoke.sh)).
Il porte sur l'image construite, lancée comme en production :
- entrypoint et `tini` ;
- PostgreSQL embarqué sur un volume neuf ;
- mode `authenticated`.

Le port est publié sur la boucle locale seulement ; la télémétrie est coupée
et aucun agent n'est configuré.

| Contrôle | Vérifie |
|---|---|
| `image-metadata` | `PAPERCLIP_BUILD_COMMIT`, labels `revision` et `source`, `linux/amd64` ; un échec arrête le smoke |
| `build-stamp` | `server/dist/build-info.json` porte le commit |
| `runtime-tools` | `curl` (healthcheck de compose), `tini`, `gosu` |
| `pid1-reaps-orphans` | `scripts/assert-orphan-reaping.sh` de l'upstream |
| `first-start` | `/api/health` répond `ok` sur un volume neuf (migrations appliquées au premier démarrage) |
| `health-commit` | `/api/health` annonce le commit, comme le vérifie le déploiement |
| `migrations` | nombre de lignes de `drizzle.__drizzle_migrations` = nombre de migrations de l'image = label |
| `agentfleet-code` | code de l'adaptateur Hermes, chargé comme le serveur le charge (`tsx`, résolution depuis `server/`) : identifiant de run Hermes conservé à l'octet près, caractère de contrôle refusé (AF-OBS-002) ; réponse finale absente rejetée en `MISSING_FINAL_RESPONSE` (PC-OBS-HERMES-H3) |
| `graceful-stop` | `docker stop` termine le conteneur avant le délai de grâce (pas de code 137) |
| `restart` | redémarrage sur le même volume, santé `ok`, migrations inchangées |

Deux contre-épreuves :
- à chaque run, la même image annoncée avec un autre commit doit être refusée
  dès `image-metadata` ;
- en local, avec l'`execute.ts` du commit de base upstream, le contrôle
  `agentfleet-code` échoue : la réponse finale absente est acceptée, avec le
  code de sortie 0.

**SBOM.** Il est au format SPDX 2.3, produit par syft v1.52.0. syft est
installé depuis son module Go (`go install …@v1.52.0`, Go 1.26.3 par
`actions/setup-go`) : la base de sommes de contrôle Go (`sum.golang.org`)
vérifie le module et chacune de ses dépendances. Le binaire reçoit la version
et le commit du tag `v1.52.0`, comme le build de release de syft : le SBOM
nomme son outil (`Tool: syft-1.52.0`), ce que l'étape vérifie. Le SBOM ne liste que les
paquets (`SYFT_FILE_METADATA_SELECTION=none`), pour rester sous la limite de
16 Mo d'un prédicat d'attestation.

**Publication (`main`).**

1. L'image testée est poussée telle quelle, sans nouveau build, sous
   `ghcr.io/canatac/agentfleet-paperclip:sha-<commit>` ; le digest est relu
   du push.
2. La copie du registre, relue depuis GHCR, a les mêmes couches (`diff_ids`) et
   la même configuration que l'image testée.
3. Le digest reçoit deux attestations (`actions/attest` v4.2.2), poussées aussi
   dans le registre : la provenance SLSA, puis le SBOM SPDX 2.3. Aucun
   enregistrement de stockage n'est créé : il n'existe que pour les dépôts
   d'organisation.
4. `gh attestation verify` contrôle ces attestations avec les options du
   déploiement (`--signer-workflow …/release-image.yml`,
   `--source-digest <commit>`, `--deny-self-hosted-runners`) : d'abord la
   provenance, puis le prédicat `https://spdx.dev/Document/v2.3`.

L'artefact `agentfleet-image-<commit>` conserve le rapport du smoke, les
métadonnées de l'image et le SBOM : 14 jours pour une pull request, 90 jours
pour `main`. Les tags `v*` et les notes de release relèvent de `release.yml`
(section suivante).

Les jobs de ce workflow ne sont pas des checks obligatoires : `verify-image`
ne tourne que si une pull request touche l'image.

## `release.yml` (AF-CI-003a)

Une release du fork ne construit rien. `release-image.yml` a déjà publié et
attesté l'image de chaque commit de `main` (`sha-<commit>`). Pousser un tag
`v…` sur un commit de `main` la vérifie comme le déploiement la vérifie, donne
à son digest le tag de la release, puis publie la release GitHub
([paperclip-fleet#126](https://github.com/canatac/paperclip-fleet/issues/126)).

| Job | Déclenchement | Jeton | Étapes |
|---|---|---|---|
| `prepare` | tag `v*` poussé ; lancement manuel (dry run) | lecture seule (`contents`, `actions`, `attestations`, `packages`) | contrôles ci-dessous, pièces jointes, notes de release |
| `publish` | tag `v*` poussé seulement | `contents` et `packages` en écriture, `actions` en lecture ; aucun code du dépôt exécuté | tag GHCR du digest, release GitHub avec ses pièces jointes |

`prepare`, dans l'ordre ; le premier échec arrête la release avant toute
écriture :

1. **Tag et commit** ([`release-notes.sh check`](../../scripts/agentfleet/release-notes.sh)).
   - Le tag suit le motif du champ `tag` de l'image-lock de paperclip-fleet :
     `^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`.
   - Le commit visé est atteignable depuis `main`, donc revu et mergé.
2. **Aucune release ne porte déjà ce tag.**
3. **Image du commit.** L'API du registre donne le digest que GHCR sert pour
   `sha-<commit>`, qui doit être un manifeste d'image unique. Sans image, le
   job s'arrête : le push sur `main` doit d'abord l'avoir publiée.
4. **Attestations.** `gh attestation verify` s'exécute avec les options du
   déploiement (`--signer-workflow …/release-image.yml`,
   `--source-digest <commit>`, `--deny-self-hosted-runners`), plus
   `--source-ref refs/heads/main` : provenance SLSA, puis SBOM SPDX 2.3.
5. **Pièces jointes** (AF-CI-003c,
   [paperclip-fleet#142](https://github.com/canatac/paperclip-fleet/issues/142)).
   - `gh attestation download` récupère les bundles Sigstore de la
     provenance et du SBOM du digest vérifié.
   - Ces bundles sont revérifiés (`gh attestation verify --bundle`, mêmes
     options qu'à l'étape 4).
   - `release-notes.sh assets` contrôle que chaque déclaration porte sur ce
     digest, avec le bon type de prédicat, et qu'il n'y a qu'un document SBOM
     (SPDX 2.3, au moins un paquet).
   - Pièces produites : `sbom.spdx.json`, `sbom.sigstore.jsonl`,
     `provenance.sigstore.jsonl`, `SHA256SUMS`. Elles sont conservées 7 jours
     comme artefact du run, pour `publish`. L'artefact de `release-image`
     expire après 90 jours ; une pièce jointe de release, non.
6. **Runs du commit sur `main`.** `release-image`, `ci` et `security` doivent
   avoir un run `push` réussi.
7. **Notes** (`release-notes.sh notes`).
   - Champs de la décision de l'opérateur
     ([paperclip-fleet#127](https://github.com/canatac/paperclip-fleet/issues/127)) :
     `Version AgentFleet`, `Tag upstream de base`, `Commit upstream`,
     `Commit source`, `Digest`, `SBOM` (fichier, nombre de paquets,
     empreintes), `Provenance` (bundle et empreinte).
   - Champs d'une note de release de paperclip-fleet : `Release`,
     `Attestation`, `CI`, `Compatibilité DB`.
   - Aussi : l'image, le nombre de migrations et les PR mergées depuis la
     release précédente (la base upstream d'`upstream-version.json` pour la
     première).
   - `Compatibilité DB` vaut `none` quand aucune migration n'a changé depuis
     cette base. Sinon, la liste des migrations changées est à classer dans
     la PR de promotion, qui écrit aussi le rollback.

`publish` enchaîne les étapes suivantes :

1. Il télécharge les pièces jointes de `prepare` et vérifie leurs empreintes
   SHA-256, une par une, contre celles que `prepare` a calculées.
2. Il relit le manifeste du digest et vérifie que ses octets donnent bien ce
   digest.
3. Il le repose sous le tag de la release, puis contrôle que le tag résout
   vers le même digest.
4. Il crée la release (`--verify-tag`) avec les quatre pièces jointes.

Un tag avec suffixe (`v1.2.3-rc.1`) donne une *pre-release*.

Les tests du script (`scripts/agentfleet/release-notes.test.sh`) tournent
dans `source-integrity`. Ils couvrent un dépôt synthétique (`check`, `notes`,
`assets`, cas refusés) et l'historique réel d'`origin/main`.

Le lancement manuel (`workflow_dispatch`, entrée `tag`) exécute `prepare` sur
la tête de `main` pour un tag qui n'existe pas encore. Il ne tague et ne publie
rien ; les notes apparaissent dans le résumé du run.

Pour publier une release, sur un commit de `main` dont les runs `push` sont
verts :

```sh
git tag -a v<version> <commit> -m v<version>
git push origin v<version>
```

La première release est **`v0.1.0`**, une version propre au fork qui n'encode
pas la version upstream. C'est une décision de l'opérateur du 28/09/2026
([paperclip-fleet#127](https://github.com/canatac/paperclip-fleet/issues/127)).
Le tag n'est poussé qu'après son approbation explicite. Le déploiement se fait
par digest seulement.

## Checks obligatoires sur `main`

À déclarer dans le ruleset `main` du fork, au fil des tickets :

| Check | Ticket |
|---|---|
| `source-integrity`, `typecheck` | AF-CI-001b |
| `agentfleet-tests` | AF-CI-001c |
| `regression` | AF-CI-001d |
| `secrets` | AF-CI-001e |
| `dependency-review` | AF-CI-001h |
| `licenses` | AF-CI-001i |
| `runner` | AF-CI-001f |

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

Scan de secrets, avec gitleaks 8.30.1 :

```sh
scripts/agentfleet/check-secrets.sh /chemin/vers/gitleaks
```

Audit des dépendances (rapport, sans échec sur les vulnérabilités) :

```sh
node scripts/agentfleet/report-audit.mjs
```

Licences (après `pnpm install --frozen-lockfile`) :

```sh
node scripts/agentfleet/verify-licenses.mjs
```
