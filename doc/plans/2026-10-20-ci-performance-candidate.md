# CI plus rapide — candidat manuel

## État

Préparation isolée à partir de `8224c4620a55e6174c6ac9388f2eaccf7ddcf9c3`.
Les workflows existants, l'action image, le Dockerfile, les scripts de tests,
le lockfile et les règles GitHub ne sont pas modifiés. Les deux workflows
candidats sont manuels, sur VM GitHub, en lecture seule, sans publication,
attestation nouvelle ni déploiement. Aucun lancement distant n'a eu lieu.

## Implémentation

### `ci-candidate.yml`

- Installation pnpm exacte, avec cache du magasin de paquets distinct de la
  CI actuelle. `node_modules` et les verdicts ne sont jamais mis en cache.
- Deux jobs runner isolés : `check:eval-kernel` + `check:protocol`, et
  `check:runner` + `check:api-authority`. L'union est exactement `check:all`.
  Une modification de la composition amont fait échouer le candidat jusqu'à
  révision. La variable du benchmark final-burst est conservée.
- Cache Cargo par plateforme, architecture, lane, compilateur et manifestes.
  La clé exacte comprend aussi les sources Rust et le protocole. Les
  dépendances et artefacts compilés sont réutilisables ; les tests sont
  toujours exécutés. Le typecheck a son propre cache.
- Les logs des deux lanes sont réunis et passés au **vérificateur original**
  `verify-runner-log.mjs`. Les exceptions approuvées pour les sous-processus
  Rust restent exactes. Un job en échec ou annulé ne peut pas devenir vert.
- Huit lots general-server au lieu de cinq, avec le sélecteur amont intact.
  Les cinq lots serialized, les deux lots workspaces-a, workspaces-b et le
  complément restent présents. La politique d'exceptions est inchangée.
- Les tests spécifiques AgentFleet et le typecheck global sont conservés.
  Le contrôle des migrations reçoit un SHA de base explicite pour les essais
  manuels. Aucun choix de tests par chemins n'est introduit à ce stade.

Le plafond de douze lots de régression simultanés laisse de la place aux
contrôles rapides et aux deux jobs runner. Cela reste soumis à la concurrence
disponible sur le compte. Une suite serveur indivisible de plus de dix
minutes peut encore limiter la durée à froid : il n'est pas démontré que la
CI complète atteindra huit minutes. Il faut mesurer ce candidat avant de
promettre une durée ou d'étudier une division plus fine de cette suite.

Les workflows sécurité et dependency-review existants restent nécessaires
lors de la future activation. Le candidat manuel n'est pas leur remplacement.

### `image-candidate.yml`

Le workflow appelle une copie indépendante de l'action image :

- Builder BuildKit isolé et cache de couches local exporté par
  `actions/cache`, dans un espace réservé au candidat. Les commandes Docker
  sont exécutées directement : le dépôt refuse les actions tierces Docker.
  Cette restriction est conservée. Le pic disque et le coût du transfert du
  cache complet font partie de la qualification.
- Image chargée localement avec `--load`, puis même smoke test positif et
  même contre-test du faux commit que dans l'action actuelle.
- Même Syft 1.52.0 compilé avec Go 1.26.3 et la vérification Go habituelle,
  mais ses dépendances et sa compilation sont mises en cache. Le SBOM de
  chaque nouvelle image est toujours généré et vérifié.
- Métadonnées et SBOM conservés comme preuves ; aucun push vers GHCR.

L'installation de Syft depuis une archive binaire n'a pas été retenue :
réutiliser la compilation respecte la méthode de vérification existante.
Le nettoyage initial du disque est conservé tant que le pic de disque réel
n'est pas mesuré. Les caches BuildKit complets peuvent être volumineux ; leur
transfert et leur rétention font partie du benchmark.

## Vérifications effectuées localement

```sh
node --test scripts/agentfleet/performance/*.test.mjs
node scripts/agentfleet/performance/runner-lane.mjs protocol --plan
node scripts/agentfleet/performance/runner-lane.mjs rust --plan
actionlint .github/workflows/ci-candidate.yml .github/workflows/image-candidate.yml
```

Les tests ciblés contrôlent : union exacte des commandes runner, refus d'un
graphe amont modifié, arrêt sur échec/annulation, transmission de l'environnement,
couverture sans doublon des lots serveur avec le vrai sélecteur amont, intégrité
des workflows existants et présence du vérificateur original.

Les checks applicatifs complets `pnpm -r typecheck`, `pnpm test:run` et
`pnpm build`, ainsi que le build/smoke Docker et les tests Rust, n'ont pas été
exécutés dans l'environnement de préparation. Docker, Cargo et les dépendances
du monorepo n'y sont pas installés. Les modifications portent sur les chaînes
candidates et leurs outils, sans changement applicatif. Les tests ciblés ne
remplacent pas l'essai GitHub nécessaire avant de qualifier les performances.

## Qualification après accord

GitHub exige que le fichier du workflow manuel existe sur la branche par
défaut pour permettre son dispatch (documentation officielle :
https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch).
Après accord, publier la branche et intégrer les fichiers additifs par une PR
ordinaire, soumise aux contrôles actuels. La PR ne remplace aucun workflow
existant et ne lance aucun candidat. Après fusion approuvée, les deux fichiers
manuels sont disponibles pour les essais. La publication, l'installation
additive sur main et les essais doivent être autorisés avant exécution.
Aucun push, PR, fusion ni lancement n'a été effectué pendant la préparation.

Sur le **même SHA**, exécuter successivement `ci.yml` et `ci-candidate.yml`,
puis `release-image.yml` en mode manuel (vérification sans publication) et
`image-candidate.yml`. Fournir au candidat CI un `comparison_base` ancêtre
correspondant à la base de la PR simulée. Ne pas mesurer pendant une chaîne
utile au projet : les quotas du compte GitHub restent partagés.

Mesurer un passage à cache froid et trois passages à cache chaud. Comparer
durée totale, attente des jobs, durées Rust/TypeScript, régression la plus
lente, coût des caches, taille de l'image et nombre/statut des tests. Le
candidat doit passer les mêmes contrôles et améliorer la médiane de la chaîne
complète, pas seulement déplacer le travail dans un autre job. Cibles
indicatives : 10–13 minutes pour la CI complète, 6–10 minutes pour la
vérification image à cache chaud. Aucun gain n'est encore mesuré.

Faire aussi un essai négatif contrôlé sur une branche de qualification : un
test échoué doit bloquer le contrôle global. Les tests unitaires locaux
vérifient déjà cette propagation dans les helpers.

## Adoption ultérieure

Après accord et mesures vertes, intégrer les optimisations dans les workflows
actifs en conservant les noms de checks attendus. Pour l'image, remplacer
seulement l'action de build dans **`release-image.yml`** : garder le chemin du
workflow signataire, les permissions, le push de l'image testée, les
attestations et leur vérification. Ne pas publier depuis `image-candidate.yml`.
Cela évite de modifier le contrat de provenance du dépôt de déploiement.

Les empreintes de coexistence dans `scripts/agentfleet/performance/baseline.json`
doivent être révisées explicitement au moment de l'adoption. Le déclencheur
manuel avec `comparison_base` doit être adapté au contexte PR réel avant
d'ajouter les déclencheurs automatiques. Les chaînes existantes ne seront ni
désactivées ni supprimées pendant la qualification.
