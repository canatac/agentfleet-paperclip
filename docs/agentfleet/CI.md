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
| `agentfleet-tests` | tests de [`TEST_STRATEGY.md`](TEST_STRATEGY.md) : unitaires de l'adaptateur Hermes, tests serveur `heartbeat-external-run-id*` et test d'intégration du faux gateway Hermes (PostgreSQL embarqué, API). Rapport JSON de Vitest : le job échoue si un test est ignoré, `todo` ou en échec. Le PostgreSQL embarqué ne démarre pas en root et ses tests sont alors ignorés : le runner GitHub tourne sous l'utilisateur `runner` |

`corepack` remplace `pnpm/action-setup` de l'upstream : pas d'action tierce
à autoriser, et la version vient du champ `packageManager`.

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

L'audit des dépendances suit dans
[paperclip-fleet#73](https://github.com/canatac/paperclip-fleet/issues/73).

## Checks obligatoires sur `main`

À déclarer dans le ruleset `main` du fork, au fil des tickets :

| Check | Ticket |
|---|---|
| `source-integrity`, `typecheck` | AF-CI-001b |
| `agentfleet-tests` | AF-CI-001c |
| `secrets` | AF-CI-001e |
| `licenses` | AF-CI-001i |
| régression upstream | AF-CI-001d |

## Exécution locale

Node 24, puis :

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm check:node-version && pnpm check:tokens && pnpm check:module-boundaries
pnpm typecheck
```

Scan de secrets, avec gitleaks 8.30.1 :

```sh
scripts/agentfleet/check-secrets.sh /chemin/vers/gitleaks
```

Licences (après `pnpm install --frozen-lockfile`) :

```sh
node scripts/agentfleet/verify-licenses.mjs
```
