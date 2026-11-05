# Deployment – Conquer Chrizu online

Online-1v1 läuft per Lockstep: über das Netz gehen nur Befehle, ein dünnes Relay bündelt sie alle 100 ms (1 Runde = 2 Ticks). Das Spiel selbst ist eine statische Seite (GitHub Pages), das Relay läuft separat (Cloudflare oder Node).

> Die claude.ai-Artifact-Version kann **nicht** online spielen (ihre Sandbox blockiert WebSockets). Online-Spiele laufen über die GitHub-Pages-Version.

## 1. GitHub Pages

1. GitHub → Repo → **Settings → Pages → Source: „GitHub Actions“**.
2. Jeder Push auf `main` startet `.github/workflows/pages.yml`: `npm ci`, `npm test`, `npm run build` (Basis-Pfad `/<repo-name>/`), Deploy von `dist/`.
3. URL: `https://paulfell92.github.io/conquerchrizu/`

## 2. Relay

### Variante A: Cloudflare (Worker + Durable Object, Free-Plan reicht)

```bash
cd server/cloudflare
npx wrangler login
npx wrangler deploy
```

Wrangler zeigt die URL, z. B. `https://conquerchrizu-relay.<name>.workers.dev`. Daraus `wss://conquerchrizu-relay.<name>.workers.dev` machen und eintragen unter
**GitHub → Settings → Secrets and variables → Actions → Variables → New repository variable**: Name `RELAY_URL`, Wert die wss-URL. Danach den Workflow neu starten (Actions → „Deploy GitHub Pages“ → Run workflow) oder einen Commit pushen.

Logs live: `npx wrangler tail` (im Ordner `server/cloudflare`). Desyncs erscheinen als `DESYNC at tick …`.

### Variante B: Node (Render, Fly.io, VPS)

```bash
npm ci
PORT=8787 npm run relay
```

- Render: „Web Service“, Build `npm ci`, Start `npm run relay` (Render setzt `PORT`).
- Fly.io / VPS: dasselbe; TLS über den Anbieter bzw. einen Reverse-Proxy (Caddy/nginx), damit die Seite `wss://` nutzen kann (GitHub Pages ist https, `ws://` wird vom Browser blockiert).
- Status: `GET /health`.

Die URL ebenso als Repo-Variable `RELAY_URL` eintragen.

## 3. Lokal testen

```bash
npm run relay      # Terminal 1: ws://localhost:8787
npm run dev        # Terminal 2
```

Zwei Browserfenster öffnen: `http://localhost:5173/?relay=ws://localhost:8787` (im Dev-Modus ist `ws://localhost:8787` ohnehin Standard). Fenster 1 erstellt die Lobby, Fenster 2 gibt den 5-stelligen Code ein. Am Handy im selben WLAN: `http://<PC-IP>:5173/?relay=ws://<PC-IP>:8787` (Vite mit `npm run dev -- --host` starten).

`?relay=wss://…` überschreibt die eingebaute Relay-URL auch auf der Pages-Version.

## Verhalten

- Lobby-Code: 5 Zeichen ohne verwechselbare Zeichen (kein I, L, O, 0, 1).
- Verbindungsabbruch: Spiel pausiert bis zu 60 s („Gegner getrennt“); der Client verbindet sich automatisch neu und holt die komplette Rundenhistorie. Kommt der Spieler nicht zurück, gibt er automatisch auf.
- Checksumme alle 100 Ticks; bei Abweichung bekommen beide eine Desync-Meldung, das Relay loggt den Tick.
- Nach Spielende schließt der Raum nach 60 s.
