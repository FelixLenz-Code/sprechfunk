# 📻 Sprechfunk

Selbst-gehostete **Push-to-Talk** Sprach- & Text-Chat-App als installierbare **PWA**.
Läuft überall als App (Android, iOS, Desktop), spricht per großer Sprechtaste, unterstützt
Einzel- und Gruppengespräche – bandbreitenschonend und hinter deinem Reverse Proxy verschlüsselt.

> **Proof of Concept.** Funktional vollständig, aber vor Produktivbetrieb bitte die
> [Sicherheitshinweise](#-sicherheit) lesen.

## ✨ Funktionen

- 🎙️ **Push-to-Talk** – große Taste (halten zum Sprechen) oder Leertaste; Live-Übertragung an alle in der Unterhaltung
- 💬 **Text-Chat** in denselben Unterhaltungen
- 📨 **Sprachnachrichten** – aufgenommenes PTT wird gespeichert und kann später abgespielt werden (auch für Offline-Nutzer)
- 👥 **Einzel- & Gruppengespräche** mit Kontaktliste
- 🟢 **Online-Status** & „spricht gerade"-Anzeige
- 🎚️ **Qualität/Bandbreite einstellbar** (8–64 kbit/s Opus) – sparsam bis hochwertig
- 🔐 **Sichere Anmeldung** (Argon2id), **erster Nutzer = Admin**
- 🛡️ **Admin** kann Registrierung neuer Nutzer deaktivieren und Nutzer verwalten
- 📱 **PWA** – installierbar, offline-fähige Oberfläche
- 🔒 Sprachnachrichten werden **verschlüsselt gespeichert** (AES-256-GCM at rest)

## 🏗️ Architektur

| Schicht | Technik |
|--------|---------|
| Frontend | React + Vite, PWA (vite-plugin-pwa) |
| Backend | Node.js / TypeScript, Fastify, WebSocket |
| Audio | Opus/WebM-Chunks über WSS → Server-Relay → MediaSource-Wiedergabe |
| Datenbank | SQLite (better-sqlite3) |
| Auth | JWT (Bearer) + Argon2id |
| Auslieferung | Ein Container, TLS terminiert am Reverse Proxy |

Ein einzelner Prozess liefert die PWA **und** die API/WebSocket auf einem Port aus. TLS/WSS übernimmt
dein Reverse Proxy. Es wird **kein** STUN/TURN benötigt – der Audio-Verkehr läuft über die normale
WebSocket-Verbindung.

## 🚀 Installation auf dem Server (Ein-Befehl)

Voraussetzung: Docker mit Compose-Plugin und ein Reverse Proxy (Caddy/Nginx/Traefik) für HTTPS.

```bash
# 1. Repo holen
git clone https://github.com/FelixLenz-Code/sprechfunk.git && cd sprechfunk

# 2. Secrets erzeugen und Umgebung anlegen
cp .env.example .env
sed -i "s|change-me-please-openssl-rand-hex-32|$(openssl rand -hex 32)|" .env
sed -i "s|change-me-too-openssl-rand-hex-32|$(openssl rand -hex 32)|" .env

# 3. Starten (zieht das von GitHub Actions gebaute Image aus der GHCR)
docker compose up -d
```

Danach lauscht die App auf `127.0.0.1:8080`. Setze in `.env` noch `PUBLIC_ORIGIN` auf deine Domain
(z. B. `https://talk.example.com`).

### Reverse Proxy (Beispiel: Caddy)

WebSockets müssen durchgereicht werden – Caddy macht das automatisch:

```caddyfile
talk.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

<details>
<summary>Nginx-Beispiel</summary>

```nginx
server {
    listen 443 ssl http2;
    server_name talk.example.com;
    # ssl_certificate ... ;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
    }
}
```
</details>

> **Wichtig:** Mikrofonzugriff (`getUserMedia`) funktioniert nur über **HTTPS** (oder `localhost`).
> Für die PWA/Push-to-Talk ist ein gültiges TLS-Zertifikat also Pflicht.

### Updaten

```bash
docker compose pull && docker compose up -d
```

## 🧑‍💻 Lokale Entwicklung

```bash
npm install
npm run dev
```

- Backend: http://localhost:8080
- Frontend (Vite, mit Hot-Reload & Proxy): http://localhost:5173

Weitere Skripte:

```bash
npm run build      # Client + Server bauen
npm run typecheck  # TypeScript prüfen
```

Lokal mit Docker bauen statt Image ziehen: in `docker-compose.yml` die `image:`-Zeile durch `build: .` ersetzen.

## ⚙️ Konfiguration (Umgebungsvariablen)

| Variable | Beschreibung | Default |
|----------|-------------|---------|
| `PORT` | interner Port | `8080` |
| `DATA_DIR` | Ablage für SQLite-DB & Audio-Blobs | `/app/data` |
| `JWT_SECRET` | Signatur der Sitzungstoken (**pflicht in Prod**) | – |
| `MEDIA_ENCRYPTION_KEY` | Schlüssel für Audio-Verschlüsselung at rest (**pflicht in Prod**) | – |
| `PUBLIC_ORIGIN` | öffentliche URL der App | `http://localhost:8080` |

Beide Secrets mit `openssl rand -hex 32` erzeugen.

## 🔒 Sicherheit

- **Transportverschlüsselung** via HTTPS/WSS am Reverse Proxy (End-to-End zwischen Browser und Server).
- **Passwörter**: Argon2id-Hashing.
- **Sprachnachrichten**: at rest mit AES-256-GCM verschlüsselt.
- **Registrierung**: vom Admin abschaltbar; erster registrierter Account wird Admin.

**Bewusste PoC-Grenzen:**
- Keine Ende-zu-Ende-Verschlüsselung – der Server sieht/routet Audio (für Gruppen-Relay).
- SQLite-Datei selbst ist nicht verschlüsselt (nur Audio-Blobs). Für „E2E" oder verschlüsselte DB
  siehe Roadmap.
- Live-Audio nutzt MediaSource (`audio/webm;codecs=opus`) – am besten in Chromium/Firefox; Safari
  fällt auf „nach Ende abspielen" zurück.

## 📄 Lizenz

MIT
