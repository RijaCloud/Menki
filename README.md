# Menki local

Assistant personnel Windows dans le navigateur, relié au compte ChatGPT par le
Codex App Server officiel. Le service garde les conversations, tickets, travaux
et décisions dans SQLite sous `%LOCALAPPDATA%\Menki`.

## Ouvrir

Double-cliquer sur **Ouvrir Menki.cmd**, ou ouvrir http://127.0.0.1:4317 si le
service tourne déjà. Le lanceur démarre le service en arrière-plan. Fermer
l'onglet laisse les travaux continuer. Windows doit rester éveillé et connecté.

Le raccourci de démarrage créé par `scripts/install-startup.ps1` est propre au
compte Windows courant. Le supprimer du dossier Démarrage désactive cette option.

## Utilisation

- Le chat global connaît les projets. Chaque projet et chaque ticket possède
  aussi son fil Codex persistant.
- Demander une réalisation crée un ticket et l'envoie au spécialiste. Les
  tickets de développement passent ensuite par un reviewer indépendant.
- Ouvrir **Tickets** pour voir le travail, sa priorité, ses résultats et ses
  vérifications. Un retour dans le chat du ticket garde la branche existante.
- **Terminer** marque un résultat vérifié comme terminé. **Arrêter** conserve
  les fichiers et le fil.
- Le bouton microphone enregistre au plus 25 secondes. Le texte reconnu est
  modifiable avant envoi. Le bouton haut-parleur et les préférences contrôlent
  la lecture. Les notifications se demandent depuis les préférences.
- Ajouter un projet exige ses dossiers locaux et un accord explicite pour
  lecture, écriture, vérifications et recherche Web. Les modifications de code
  vont dans un worktree sous une branche `codex/menki-…`.

## Fonctionnement

Le serveur TypeScript/Fastify écoute seulement sur la boucle locale. React
affiche le chat et les événements SSE. La file est persistante, avec deux
agents maximum et une seule vérification à la fois.

Chaque travail lance Codex officiel 0.170.0 et un connecteur MCP limité à son
identifiant. Les outils natifs de commande et les plugins personnels sont
désactivés pour ce runtime. Les outils de fichiers vérifient les dossiers,
liens et noms protégés à chaque opération. Les tests de projet utilisent le
confinement Windows officiel et les permissions Node sur les fichiers.

Le processus autonome reçoit son environnement Windows normal et ne reprend
pas les variables de lancement privées de Codex Desktop. L'authentification est
gérée par Codex hors des projets.

Le confinement Windows peut autoriser les connexions de boucle locale. L'API
Menki exige donc une session initialisée par son lanceur avec un secret du profil
Windows, inaccessible aux scripts de projet. Ouvrir la page publique seule ne
délivre aucune session. Le navigateur conserve cette session après les
redémarrages du service.

Les previews HTML ont chacune une origine locale distincte
`http://<ticket>.localhost:4318/`, avec des règles qui empêchent les appels à
l'API Menki et les connexions externes. Leur stockage navigateur est isolé par
ticket. Le service API vérifie l'hôte, l'origine, le site appelant et la session.

Une interruption de Windows ou du service classe les travaux actifs comme
interrompus. Une reprise est demandée explicitement et réutilise le fil et les
fichiers. Les messages disposent d'une clé d'idempotence pour les retries.

La dictée et la synthèse utilisent System.Speech en français ou anglais.
Le traitement est local et les fichiers audio temporaires sont supprimés après
la réponse. La reconnaissance native peut demander de corriger le texte.

### Voix naturelle ElevenLabs

Dans **Réglages → Voix de Menki**, choisir ElevenLabs, coller sa clé API puis
enregistrer sans activer l'envoi. **Charger mes voix** récupère les voix du
compte (permission de lecture des voix), ou renseigner directement un Voice ID.
Choisir la voix, autoriser l'envoi du texte puis enregistrer. La clé doit permettre
la synthèse vocale. Seul le texte demandé en lecture est transmis à ElevenLabs :
la dictée reste Windows. L'audio consomme le quota du compte ElevenLabs.

Le connecteur utilise l'API officielle et `eleven_multilingual_v2`. Liens,
Markdown, chemins et blocs de code sont nettoyés avant toute lecture, y compris
avec Windows. Au-delà de 3 000 caractères, la voix renvoie à la suite à l'écran.
Les cinq derniers audios sont réutilisés en mémoire jusqu'au redémarrage ou au
changement de réglages. Aucun retry facturable n'est déclenché automatiquement.
Charger un historique ne relance pas sa lecture automatique.

La clé est chiffrée par Windows DPAPI pour l'utilisateur courant dans
`%LOCALAPPDATA%\Menki\voice-credentials.dpapi`. Elle ne rejoint ni SQLite, ni
les dossiers des projets, ni les sauvegardes. Après restauration sur un autre
PC, elle doit être saisie à nouveau. Le bouton de coupure arrête la lecture et
annule une requête en cours ; un audio déjà généré peut avoir consommé du quota.
En cas de quota épuisé ou d'erreur, l'application affiche le problème sans
basculer silencieusement sur un autre fournisseur.

La voix OpenAI/ChatGPT n'est pas branchée à ce stade. Une intégration vocale
OpenAI utilise l'API et sa facturation distincte, pas la connexion Codex existante.

### Conversation vocale

Avec ElevenLabs configuré, cliquer **Parler avec Menki** et autoriser le micro
dans le navigateur. Une phrase suivie d'environ 1,3 seconde de silence est
transcrite localement par Windows puis envoyée automatiquement dans le fil
courant. Le texte et la réponse sont conservés comme les autres messages.
Menki répond avec ElevenLabs puis rouvre le micro, sans clic sur Envoyer.
Les réponses sont demandées courtes pour l'oral.

L'interface affiche écoute, transcription, réflexion et lecture. Le micro est
fermé pendant la transcription, le travail et la lecture pour éviter les boucles
d'écho. C'est une conversation par tours, pas une liaison audio en duplex :
attendre la fin de la réponse avant de parler. La qualité de transcription reste
celle du moteur français installé dans Windows.

**Quitter l'oral** coupe le micro et l'audio ; dire « Arrête la conversation »
termine aussi l'écoute. Les tickets déjà lancés continuent côté service.
Changer de fil, masquer l'onglet, perdre la connexion ou fermer la page arrête
l'écoute ; elle ne reprend jamais toute seule. Après une minute sans parole,
le micro se ferme. Une phrase est limitée à 30 secondes.

Les messages vocaux et retours sur ticket ont un identifiant durable. Une erreur
réseau n'entraîne aucun nouvel envoi automatique : vérifier le fil avant de
réessayer. Les permissions et validations d'actions sensibles restent inchangées.
L'audio microphone temporaire est supprimé après transcription. Les réponses
vocales utilisent le quota ElevenLabs déjà configuré.

## Sauvegarde et restauration

Les préférences permettent une sauvegarde vérifiée. Elle comprend la base,
les documents et les dossiers pilotes gérés par Menki. Les dossiers externes
accordés aux projets restent à leur emplacement et doivent avoir leur propre
sauvegarde. Les credentials Codex ne sont pas copiés.

`npm run backup:verify` vérifie les empreintes et l'intégrité SQLite, puis
restaure une copie isolée sous le profil Menki. Pour restaurer réellement, arrêter
Menki, vérifier le manifeste, conserver la base actuelle et remettre la base et
les dossiers sauvegardés à leurs emplacements. Les identifiants de fils restent
liés aux sessions conservées par Codex sur ce PC.

## Développer

Node 24. `npm ci`, `npm run build`, `npm run check`, `npm test`.
Les dépendances sont verrouillées dans package-lock.json. Les schémas officiels
du CLI peuvent être régénérés avec `codex app-server generate-json-schema`.

Le service utilise le port 4317, les previews 4318. Le serveur Vite de travail
utilise 4319. Les journaux sont dans le profil Menki.

## État du pilote

Les deux espaces initiaux sont **Atelier code** et **Espace personnel**.
Ils sont indépendants des anciens projets et des services sur les VPS.

Les demandes d'installation, SSH/SFTP ou d'envoi externe créent une autorisation
lisible. Elles nécessitent encore un connecteur dédié pour être exécutées.
L'interface l'indique lors de l'accord. Les tests, modifications dans le projet,
recherches Web et documents fonctionnent directement.

La mémoire est constituée de décisions sourcées, éditables depuis l'interface.
La planification multi-agents, les rôles et la revue utilisent de vraies sessions
Codex. Aucune réponse d'agent ni aucun résultat de test n'est simulé.
