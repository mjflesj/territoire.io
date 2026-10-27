# Territoire.io

Jeu de territoire multijoueur en ligne, style paper.io. Serveur Node.js autoritaire + client HTML5 canvas, communication en WebSocket.

## Lancer en local

```bash
npm install
npm start
```

Puis ouvrir http://localhost:3000 (plusieurs onglets ou appareils du même réseau pour tester le multijoueur).

## Règles

- Sors de ton territoire pour laisser une traînée, reviens dedans pour capturer toute la zone entourée.
- Si quelqu'un touche ta traînée, tu meurs (toi aussi si tu touches la tienne ou le bord de la carte).
- Collision tête contre tête : celui qui est sur son propre territoire gagne, sinon les deux meurent.
- Contrôles : flèches / ZQSD / WASD, ou glisser le doigt sur mobile.

## Configuration (variables d'environnement)

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port HTTP/WebSocket |
| `BOTS` | `8` | Nombre minimum de joueurs ; des bots complètent la partie et laissent leur place aux humains |

Taille de carte et vitesse : constantes `W`, `H` et `TICK_MS` en haut de `server.js`.

## Mettre en ligne

N'importe quel hébergeur Node.js qui accepte les WebSockets fonctionne (Render, Railway, Fly.io, un VPS…). Exemple avec Render :

1. Pousser ce dossier sur un dépôt GitHub.
2. Sur render.com : **New → Web Service**, choisir le dépôt.
3. Build command : `npm install` — Start command : `npm start`.
4. Render fournit une URL `https://…onrender.com` à partager avec tes amis.
