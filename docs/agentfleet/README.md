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

## Workflows hérités de l'upstream

`main` contient les 20 workflows de l'upstream (`.github/workflows/`). Les
Actions ne sont pas activées sur ce fork : aucun ne s'exécute. Plusieurs
publieraient ou appelleraient des services upstream s'ils s'exécutaient :
`release.yml` (push sur `master` et tâche planifiée quotidienne),
`docker.yml` (push sur `master` et tags `v*`), `commitperclip-review.yml`
(`pull_request_target`), `pr.yml` (toute pull request).

Avant d'activer les Actions pour la CI AgentFleet
([paperclip-fleet#19](https://github.com/canatac/paperclip-fleet/issues/19)),
ces workflows doivent être retirés ou neutralisés dans `main`, par une PR
dédiée, pour ne garder que `ci.yml`, `integration.yml`, `release-image.yml` et
`dependency-review.yml` (spécification §6.1).

## Resynchronisation avec l'upstream

Chaque montée de version upstream passe par une PR dédiée qui intègre la
release visée dans `main` et met à jour `upstream-version.json`, sans autre
changement.
