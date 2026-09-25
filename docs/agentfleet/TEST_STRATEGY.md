# Stratégie de test : lien `externalRunId`

Tickets AF-OBS-002 à AF-OBS-005. Contrat :
[`HERMES_RUN_LINK_CONTRACT.md`](HERMES_RUN_LINK_CONTRACT.md).

## Tests

| Niveau | Fichier | Objet |
|---|---|---|
| unitaire | `packages/adapters/hermes/src/gateway/shared/run-id.test.ts` | `normalizeHermesRunId` : absence, non-chaîne, vide, 256/257 octets, contrôles, surrogates, non-UUID, pas de `trim` |
| unitaire | `packages/adapters/hermes/src/gateway/server/run-id-passthrough.test.ts` | adaptateur : identifiant non rogné, présent après échec, absent si la création n'en renvoie pas |
| unitaire | `server/src/__tests__/heartbeat-external-run-id-resolution.test.ts` | règles de `resolveTerminalExternalRunId` |
| service + base | `server/src/__tests__/heartbeat-external-run-id.test.ts` | écriture terminale : succès, échec, octet pour octet, pas de run Hermes, valeur malformée, autre adaptateur |
| service + base | `server/src/__tests__/heartbeat-external-run-id-concurrency.test.ts` | §5.4 : run terminé par un autre chemin (`cancelRun` réel), idempotence, conflits, absence avant création, non-substitution |
| intégration | `server/src/__tests__/hermes-gateway-external-run-id.integration.test.ts` | §7.2 : vrai adaptateur, faux gateway Hermes, PostgreSQL éphémère, API HTTP |

Le faux gateway (`server/src/__tests__/helpers/fake-hermes-gateway.ts`) est un
serveur HTTP sur `127.0.0.1` qui rejoue un scénario : `POST /v1/runs`, flux
SSE, statut, arrêt. Aucun fournisseur d'inférence n'est appelé, et le test
échoue sur toute requête sortante vers une autre destination. Ces tests vivent
sous `server/src/__tests__` pour être pris par la configuration Vitest du
serveur ; l'arborescence `test/integration/` de la spécification §6.1 n'est pas
créée.

## Cas du tableau §7.2

Preuve : `FAKE_HERMES_RUN_ID = DATABASE_EXTERNAL_RUN_ID = API_EXTERNAL_RUN_ID`
(valeur du faux gateway, colonne `heartbeat_runs.external_run_id`, champ
`externalRunId` de `GET /api/heartbeat-runs/:runId`).

| Cas | Attendu | Test d'intégration |
|---|---|---|
| identifiant normal | persisté et restitué à l'identique | *normal identifier* |
| absent avant création | `null` | *absent before creation* (création refusée, 503) |
| absent après terminal Hermes | décision du contrat : l'identifiant vient de la création du run et reste acquis | *absent after the Hermes terminal event* ; création sans `run_id` : erreur `hermes_gateway_protocol_error`, `null` |
| chaîne vide | rejetée | *empty string* |
| trop longue | rejetée | *too long* (257 octets, `externalRunIdError`) |
| caractères de contrôle | rejetés | *control characters* (`externalRunIdError`) |
| non-UUID valide | accepté | *valid non-UUID identifier* (espaces, `/`, `#`, `é` conservés) |
| run Paperclip différent | aucune substitution | *different Paperclip runs* |
| exécution en échec | identifiant conservé si Hermes l'a fourni | *failed execution* |
| réconciliation répétée | idempotente | *repeated reconciliation* (`reapOrphanedRuns` et écriture ciblée répétés) |

## Exécution locale

Node 24 (le dépôt exige `>=24.11.0`), pnpm 9.15.4 :

```sh
pnpm install --frozen-lockfile --filter "@paperclipai/server..."
cd packages/adapters/hermes && pnpm exec vitest run
cd server && pnpm exec vitest run \
  src/__tests__/heartbeat-external-run-id \
  src/__tests__/hermes-gateway-external-run-id.integration.test.ts
```

Les tests serveur démarrent un PostgreSQL embarqué, qui refuse de s'initialiser
quand le processus tourne en `root` : ils sont alors ignorés (`describe.skip`),
pas en échec. Il faut les lancer sous un utilisateur non root ; la CI du fork
(AF-CI-001) doit vérifier qu'aucun de ces tests n'est ignoré.
