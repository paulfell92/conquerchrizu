# Conquer Chrizu

Browser-RTS im Stil von Age of Empires, kompakt: Gebiete erobern, Basis ausbauen, Zeitalter aufsteigen, Trupps kontern. 1v1 gegen die CPU, Matches dauern rund 4–6 Minuten. Läuft am Handy (quer) und am Desktop, als eine einzige HTML-Datei.

## Starten

```bash
npm install
npm run dev        # Entwicklungsserver
npm run build      # erzeugt dist/index.html (alles in einer Datei, ~160 kB)
npm test           # Simulation, Symmetrie, Bot (27 Tests)
npm run simulate -- --games 40 --a hard --b normal   # Bot gegen Bot, headless
```

URL-Parameter: `?autostart=easy|normal|hard`, `?seed=123`, `?debug=1` (stellt `window.__game` bereit).

## Aufbau

| Ordner | Inhalt |
| --- | --- |
| `src/sim/` | Deterministische Spiellogik (Ganzzahlen, Seed-RNG, A*, Kampf, Eroberung, Wirtschaft, Siegpunkte). Kein DOM. Öffentliche API: `src/sim/index.ts`, Typen: `src/sim/types.ts` |
| `src/content/` | Einheiten, Gebäude, Technologien, Regeln, Karte „Chrizu-Tal“ – Balancing ohne Codeänderung |
| `src/bot/` | CPU-Gegner: Strategie (3–5 s), Operationen (~1 s), Taktik; Persönlichkeiten Rusher/Boomer/Turtle; Stufen Leicht/Normal/Schwer; kein Blick durch den Nebel |
| `src/net/` | `LocalRelay`: alle Befehle laufen mit 100 ms Vorlauf über ein Relay – dieselbe Schnittstelle bekommt später das Online-Relay (Lockstep) |
| `src/client/` | Canvas-2D-Renderer, Touch/Maus-Eingabe, HUD, Menüs |
| `tools/simulate.ts` | Bot-gegen-Bot-Simulation für Balancing (`--override`, `--set`, `--json`) |
| `GAME_SPEC.md` | Spielregeln und UX-Vorgaben |

## Steuerung

- **Touch:** Trupp antippen = wählen, Doppeltipp = alle dieses Typs; Boden = marschieren, Gegner = angreifen, Punkt = einnehmen; eigenes Gebäude oder freien Bauplatz antippen = Menü. Ziehen = Karte bewegen, zwei Finger = Zoom, „Auswahl“ = Rahmen ziehen.
- **Maus/Tastatur:** Linksziehen = Rahmenauswahl, Rechtsklick = bewegen/angreifen, Mausrad = Zoom, 1–9 Trupps, A Armee, S Stopp, R Rückzug, Leertaste Basis, P Pause.

## Nächste Schritte

1. Online-Multiplayer: WebSocket-Relay (z. B. Cloudflare Durable Object), Lobby-Code, Checksummen alle 100 Ticks (`LocalRelay.hashes` existiert schon).
2. Balancing: Rusher ist bei den Bots die stärkste Persönlichkeit (~71 % Siegquote Normal vs. Normal).
3. Längere Matches optional: `tools/balance-suggested.json` ergibt ~15 Min (Normal vs. Normal).
