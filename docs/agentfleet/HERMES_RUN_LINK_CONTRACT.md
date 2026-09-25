# Contrat `externalRunId` (PC-OBS-HERMES-RUN-LINK)

Ticket : AF-OBS-001
([paperclip-fleet#13](https://github.com/canatac/paperclip-fleet/issues/13)).
Source : spécification AgentFleet §5. Les références de code sont celles du
commit de base `d554c4789ed3` (voir [`README.md`](README.md)).

## Objet

Relier chaque run Paperclip exécuté par l'adaptateur `hermes_gateway` à
l'exécution Hermes qui l'a traité, en base et dans l'API, pour retrouver la
session Hermes d'un run Paperclip.

## Chaîne

```text
Hermes POST /v1/runs → run_id
→ adaptateur hermes_gateway : terminal.runId
→ AdapterExecutionResult.sessionParams.hermesRunId
→ chemin terminal du heartbeat Paperclip
→ heartbeat_runs.external_run_id
→ API Paperclip : run.externalRunId
```

## État au commit de base

| Maillon | Code | État |
|---|---|---|
| Identifiant reçu de Hermes | `extractRunId` (`packages/adapters/hermes/src/gateway/server/execute.ts`) : `run_id`, sinon `runId`, sinon `id` | présent ; **rogné** par `nonEmpty` (`trim`) |
| Réponse de création sans identifiant | même fichier : erreur `hermes_gateway_protocol_error`, « Hermes /v1/runs response did not include run_id. » | présent |
| `sessionParams.hermesRunId` | `mapFinalResultForTest` (terminal) et chemin de délai dépassé | présent sur ces deux sorties |
| Sérialisation de session | `sessionCodec` (`.../gateway/server/index.ts`) : `readString` | présent ; **rogné** (`trim`) |
| Colonne | `heartbeat_runs.external_run_id` (`packages/db/src/schema/heartbeat_runs.ts`), migration `0000` | présente, jamais écrite |
| Écriture terminale | `finalRunPatch` puis `setRunStatusIfRunning` (`server/src/services/heartbeat.ts`) | n'écrit pas `externalRunId` |
| API | `externalRunId` dans `heartbeatRunListColumns` et le type `HeartbeatRun` (`packages/shared/src/types/heartbeat.ts`) ; `NULL` dans la projection résumée | présent, toujours `null` |

Le correctif consiste donc à écrire la colonne dans le chemin terminal existant
et à supprimer le `trim` sur l'identifiant. Aucune migration n'est nécessaire.

## Sémantique

- `externalRunId` est l'identifiant opaque de l'exécution Hermes associée au
  run Paperclip.
- Il n'est jamais dérivé du run ID Paperclip, et le run ID Paperclip ne lui est
  jamais substitué.
- Il est stable pendant la durée de l'exécution Hermes.
- Un UUID ou tout autre identifiant opaque accepté par Hermes est valide.
- Une valeur valide est conservée octet pour octet : ni `trim`, ni changement
  de casse, ni normalisation Unicode.
- Ce n'est pas un secret. Il n'est jamais utilisé comme credential.

## Validation : `normalizeHermesRunId`

Fonction pure (AF-OBS-002) :

```typescript
normalizeHermesRunId(value: unknown): string | null
```

| Entrée | Résultat |
|---|---|
| `undefined` ou `null` | `null` : identifiant absent |
| valeur qui n'est pas une chaîne | erreur de protocole |
| chaîne vide ou composée uniquement d'espaces | erreur de protocole |
| plus de 256 octets UTF-8 | erreur de protocole |
| caractère de contrôle (U+0000 à U+001F, U+007F à U+009F) | erreur de protocole |
| surrogate UTF-16 isolé (Unicode mal formé, impossible à stocker octet pour octet) | erreur de protocole |
| toute autre chaîne, UUID ou non | la même chaîne, inchangée |

L'erreur est une `HermesRunIdError` (code `hermes_run_id_invalid`, motif
`not_a_string`, `blank`, `too_long`, `control_character` ou
`malformed_unicode`), exportée par `@paperclipai/hermes-paperclip-adapter`.

Choix documenté (§5.3 laisse le choix entre erreur et `null` pour une valeur
malformée) : **erreur**. Une valeur malformée est une violation du protocole
Hermes. Elle doit rester distincte d'un identifiant absent, pour que le rejet
soit observable.

La limite de 256 octets est inclusive : 256 octets est valide, 257 ne l'est pas.
Une chaîne avec des espaces en tête ou en fin, mais pas uniquement des espaces,
est valide et conservée telle quelle.

## Politique `null` ou erreur, par branche

| Branche | Identifiant Hermes | Effet sur `external_run_id` |
|---|---|---|
| Échec avant création du run Hermes (connexion, authentification, requête refusée) | aucun | reste `null` |
| Création sans `run_id` dans la réponse | aucun | reste `null` ; le run échoue déjà avec `hermes_gateway_protocol_error` |
| Terminaison réussie | présent | écrit |
| Terminaison en échec, annulation ou délai dépassé après création | présent | écrit |
| Identifiant malformé | rejeté par le normaliseur | **non écrit** ; le rejet est observable sur le run |
| Réconciliation concurrente d'un run déjà terminé | présent | règle de conflit ci-dessous |
| Écriture terminale répétée, même valeur | présent | inchangé (idempotent) |

Toute sortie de l'adaptateur **après** la création du run Hermes porte
`sessionParams.hermesRunId`, y compris sur erreur. AF-OBS-004 le prouve par
test.

Un identifiant malformé ne change pas le statut du run Paperclip : le résultat
métier reste celui que Hermes a rendu. Seule la corrélation est refusée, et ce
refus doit apparaître dans le résultat ou le journal du run. Sa forme exacte
est fixée par AF-OBS-003.

## Persistance

- L'écriture passe par la mise à jour terminale existante (`finalRunPatch`,
  écrit par `setRunStatusIfRunning`, et l'écriture tardive quand la
  réconciliation a déjà terminé le run). Pas d'écriture SQL parallèle.
- `null` n'écrase jamais une valeur présente.
- Même valeur déjà présente : aucune modification.
- **Conflit** : une valeur différente déjà présente pour le même run Paperclip
  n'est pas remplacée. La première valeur non nulle est conservée, et le
  conflit produit une erreur observable (AF-OBS-003, prouvé par AF-OBS-004).

## Séparation des sujets

Ce correctif ne contient que la corrélation. Il ne touche ni au parsing des
réponses Hermes, ni aux codes d'erreur, ni à `diagnosticTranscript`,
`MISSING_FINAL_RESPONSE` ou `RUN_CANCELLED` (correctif H3/R2,
[paperclip-fleet#18](https://github.com/canatac/paperclip-fleet/issues/18)),
ni aux prompts. La seule modification du parsing admise est la suppression du
`trim` sur l'identifiant, exigée par ce contrat.

## Tickets

| Ticket | Objet |
|---|---|
| AF-OBS-001 | ce contrat |
| AF-OBS-002 | `normalizeHermesRunId` et ses tests unitaires |
| AF-OBS-003 | écriture de `external_run_id` dans le chemin terminal |
| AF-OBS-004 | tests de conflit, d'idempotence et de concurrence |
| AF-OBS-005 | test d'intégration : gateway Hermes simulé → base → API |
