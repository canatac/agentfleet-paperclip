# Lancement de qualification uniquement

Ces branches servent aux essais autorisés le 20/10/2026, sans modification
des pipelines actifs ni de main :

- `work/ci-performance-qualification-ci-20261020` : CI candidate uniquement ;
- `work/ci-performance-qualification-image-20261020` : image candidate uniquement.

Les noms de branches sont exacts, sans wildcard. Le SHA de comparaison est
fixé à la base revue de la PR #34. Aucune publication d'image, aucune
attestation nouvelle, aucun déploiement. Ne pas fusionner ces déclencheurs de
qualification sur main. Les tests vérifient les branches exactes. Les commandes
applicatives, la sélection des suites et les règles d'échec sont inchangées.
