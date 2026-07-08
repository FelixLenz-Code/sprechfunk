#!/usr/bin/env bash
#
# Sprechfunk installer / updater
# ------------------------------
# Installs or updates the self-hosted Sprechfunk server via Docker.
# Safe to run repeatedly: an existing installation is updated in place and
# secrets in .env are preserved.
#
# One-liner:
#   curl -fsSL https://raw.githubusercontent.com/FelixLenz-Code/sprechfunk/main/install.sh | bash
#
# With options (note the `-s --` to pass args through a pipe):
#   curl -fsSL .../install.sh | bash -s -- --domain talk.example.com --dir /opt/sprechfunk
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults (override via flags or environment variables)
# ---------------------------------------------------------------------------
IMAGE="${SPRECHFUNK_IMAGE:-ghcr.io/felixlenz-code/sprechfunk}"
TAG="${SPRECHFUNK_TAG:-latest}"
DIR="${SPRECHFUNK_DIR:-/opt/sprechfunk}"
HOST_PORT="${SPRECHFUNK_PORT:-8080}"
BIND_ADDR="${SPRECHFUNK_BIND:-127.0.0.1}"
PUBLIC_ORIGIN="${SPRECHFUNK_ORIGIN:-}"
DO_START=1
INSTALL_DOCKER=0

RAW_BASE="https://raw.githubusercontent.com/FelixLenz-Code/sprechfunk/main"

# ---------------------------------------------------------------------------
# Pretty output
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  C_BLUE=$'\033[1;34m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'
  C_RED=$'\033[1;31m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_DIM=""; C_RESET=""
fi
info()  { printf '%s==>%s %s\n' "$C_BLUE"  "$C_RESET" "$*"; }
ok()    { printf '%s ✓%s  %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn()  { printf '%s ! %s  %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()   { printf '%s ✗ %s  %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

trap 'die "Installation abgebrochen (Zeile $LINENO). Siehe Meldungen oben."' ERR

usage() {
  cat <<EOF
Sprechfunk Installer / Updater

Verwendung: install.sh [Optionen]

Optionen:
  --domain <host>     Öffentliche URL, z. B. talk.example.com (setzt PUBLIC_ORIGIN=https://<host>)
  --dir <pfad>        Installationsverzeichnis (Default: $DIR)
  --port <port>       Host-Port, an den gebunden wird (Default: $HOST_PORT)
  --bind <addr>       Bind-Adresse (Default: $BIND_ADDR; 0.0.0.0 = alle Interfaces)
  --tag <tag>         Image-Tag (Default: $TAG)
  --install-docker    Docker automatisch installieren, falls es fehlt (get.docker.com)
  --no-start          Nur einrichten/aktualisieren, Container nicht starten
  -h, --help          Diese Hilfe anzeigen

Umgebungsvariablen: SPRECHFUNK_DIR, SPRECHFUNK_PORT, SPRECHFUNK_BIND,
                    SPRECHFUNK_ORIGIN, SPRECHFUNK_TAG, SPRECHFUNK_IMAGE
EOF
}

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) PUBLIC_ORIGIN="$2"; shift 2 ;;
    --dir)    DIR="$2"; shift 2 ;;
    --port)   HOST_PORT="$2"; shift 2 ;;
    --bind)   BIND_ADDR="$2"; shift 2 ;;
    --tag)    TAG="$2"; shift 2 ;;
    --install-docker) INSTALL_DOCKER=1; shift ;;
    --no-start) DO_START=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unbekannte Option: $1 (--help für Hilfe)" ;;
  esac
done

# Normalise a bare hostname into a https:// origin.
if [ -n "$PUBLIC_ORIGIN" ] && [[ "$PUBLIC_ORIGIN" != http://* && "$PUBLIC_ORIGIN" != https://* ]]; then
  PUBLIC_ORIGIN="https://$PUBLIC_ORIGIN"
fi

# ---------------------------------------------------------------------------
# Privilege helper: use sudo where needed
# ---------------------------------------------------------------------------
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  fi
fi
# Filesystem privilege — only elevated when the target dir isn't user-writable.
# Resolved in ensure_dir() below.
FS_SUDO=""

# ---------------------------------------------------------------------------
# Detect / install Docker + Compose
# ---------------------------------------------------------------------------
install_docker() {
  info "Installiere Docker über das offizielle Skript (get.docker.com) …"
  command -v curl >/dev/null 2>&1 || die "curl wird benötigt, um Docker zu installieren."
  curl -fsSL https://get.docker.com | $SUDO sh
  $SUDO systemctl enable --now docker 2>/dev/null || true
}

ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    if [ "$INSTALL_DOCKER" -eq 1 ]; then
      install_docker
    elif [ -r /dev/tty ]; then
      printf '%sDocker ist nicht installiert. Jetzt automatisch installieren? [j/N]%s ' "$C_YELLOW" "$C_RESET" > /dev/tty
      read -r ans < /dev/tty || ans=""
      case "$ans" in [jJyY]*) install_docker ;; *) die "Docker wird benötigt. Installiere es und starte erneut (oder --install-docker)." ;; esac
    else
      die "Docker ist nicht installiert. Installiere Docker oder rufe den Installer mit --install-docker auf."
    fi
  fi

  # Determine whether we can talk to the docker daemon; fall back to sudo.
  if docker info >/dev/null 2>&1; then
    DOCKER="docker"
  elif [ -n "$SUDO" ] && $SUDO docker info >/dev/null 2>&1; then
    DOCKER="$SUDO docker"
  else
    die "Docker-Daemon nicht erreichbar. Läuft Docker? Ist dein Nutzer in der 'docker'-Gruppe?"
  fi

  # Compose v2 (plugin) preferred, fall back to legacy docker-compose.
  if $DOCKER compose version >/dev/null 2>&1; then
    COMPOSE="$DOCKER compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="${SUDO:+$SUDO }docker-compose"
  else
    die "Docker Compose fehlt. Installiere das 'docker compose'-Plugin."
  fi
  ok "Docker bereit ($($DOCKER --version | cut -d, -f1))."
}

# ---------------------------------------------------------------------------
# Filesystem helpers (work with or without sudo / root ownership)
# ---------------------------------------------------------------------------
# Create the install dir, deciding whether filesystem ops need sudo.
ensure_dir() {
  if mkdir -p "$DIR" 2>/dev/null && [ -w "$DIR" ]; then
    FS_SUDO=""
  elif [ -n "$SUDO" ]; then
    FS_SUDO="$SUDO"
    $FS_SUDO mkdir -p "$DIR"
  else
    die "Kann $DIR nicht anlegen (keine Rechte, kein sudo)."
  fi
}

write_file()  { if [ -n "$FS_SUDO" ]; then $FS_SUDO tee "$1" >/dev/null; else cat > "$1"; fi; }
read_file()   { $FS_SUDO cat "$1" 2>/dev/null || true; }
file_exists() { $FS_SUDO test -f "$1"; }

get_env_var() { # $1 = key ; prints current value from $DIR/.env (empty if absent)
  read_file "$DIR/.env" | grep -E "^$1=" | head -n1 | cut -d= -f2- || true
}

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif [ -r /dev/urandom ]; then
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  else
    die "Weder openssl noch /dev/urandom verfügbar, um Secrets zu erzeugen."
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
printf '%s\n' "${C_BLUE}📻 Sprechfunk Installer${C_RESET}"

ensure_docker
ensure_dir

# Decide install vs update
MODE="Installation"
if file_exists "$DIR/.env"; then
  MODE="Update"
fi
info "$MODE in $DIR"

# --- Secrets: preserve on update, generate on fresh install ---
JWT_SECRET="$(get_env_var JWT_SECRET)"
MEDIA_ENCRYPTION_KEY="$(get_env_var MEDIA_ENCRYPTION_KEY)"
SECRET_STATE="beibehalten"
if [ -z "$JWT_SECRET" ] || [ -z "$MEDIA_ENCRYPTION_KEY" ]; then SECRET_STATE="neu erzeugt"; fi
[ -n "$JWT_SECRET" ]           || JWT_SECRET="$(gen_secret)"
[ -n "$MEDIA_ENCRYPTION_KEY" ] || MEDIA_ENCRYPTION_KEY="$(gen_secret)"

# --- PUBLIC_ORIGIN: keep existing unless a new one was provided ---
EXISTING_ORIGIN="$(get_env_var PUBLIC_ORIGIN)"
if [ -z "$PUBLIC_ORIGIN" ]; then
  if [ -n "$EXISTING_ORIGIN" ]; then
    PUBLIC_ORIGIN="$EXISTING_ORIGIN"
  elif [ -r /dev/tty ]; then
    printf '%sÖffentliche URL (z. B. https://talk.example.com) [Enter = http://localhost:%s]:%s ' \
      "$C_YELLOW" "$HOST_PORT" "$C_RESET" > /dev/tty
    read -r PUBLIC_ORIGIN < /dev/tty || PUBLIC_ORIGIN=""
    if [ -n "$PUBLIC_ORIGIN" ] && [[ "$PUBLIC_ORIGIN" != http* ]]; then PUBLIC_ORIGIN="https://$PUBLIC_ORIGIN"; fi
  fi
  [ -n "$PUBLIC_ORIGIN" ] || PUBLIC_ORIGIN="http://localhost:${HOST_PORT}"
fi

# --- Write .env (secrets kept, other values refreshed) ---
umask 077
write_file "$DIR/.env" <<EOF
# Sprechfunk configuration — generated by install.sh
# Secrets are preserved across updates. Do NOT commit this file.
IMAGE=${IMAGE}:${TAG}
HOST_PORT=${HOST_PORT}
BIND_ADDR=${BIND_ADDR}
PUBLIC_ORIGIN=${PUBLIC_ORIGIN}
JWT_SECRET=${JWT_SECRET}
MEDIA_ENCRYPTION_KEY=${MEDIA_ENCRYPTION_KEY}
EOF
$FS_SUDO chmod 600 "$DIR/.env"
ok ".env geschrieben (Secrets ${SECRET_STATE})."

# --- Write docker-compose.yml (always refreshed to match this installer) ---
write_file "$DIR/docker-compose.yml" <<'EOF'
services:
  sprechfunk:
    image: ${IMAGE:-ghcr.io/felixlenz-code/sprechfunk:latest}
    container_name: sprechfunk
    restart: unless-stopped
    environment:
      PORT: 8080
      DATA_DIR: /app/data
      PUBLIC_ORIGIN: ${PUBLIC_ORIGIN:-http://localhost:8080}
      JWT_SECRET: ${JWT_SECRET:?JWT_SECRET missing in .env}
      MEDIA_ENCRYPTION_KEY: ${MEDIA_ENCRYPTION_KEY:?MEDIA_ENCRYPTION_KEY missing in .env}
    volumes:
      - sprechfunk-data:/app/data
    ports:
      - "${BIND_ADDR:-127.0.0.1}:${HOST_PORT:-8080}:8080"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

volumes:
  sprechfunk-data:
EOF
ok "docker-compose.yml geschrieben."

# Validate compose config early for a clear error.
( cd "$DIR" && $COMPOSE config -q ) || die "docker-compose.yml ist ungültig."

if [ "$DO_START" -eq 0 ]; then
  ok "Einrichtung fertig (Start übersprungen wegen --no-start)."
  info "Starten mit:  cd $DIR && $COMPOSE up -d"
  exit 0
fi

# --- Pull image & (re)start ---
info "Ziehe Image ${IMAGE}:${TAG} …"
( cd "$DIR" && $COMPOSE pull ) || die "Image konnte nicht geladen werden."

info "Starte Container …"
( cd "$DIR" && $COMPOSE up -d )

# --- Health check ---
info "Warte auf Health-Check …"
HEALTH_URL="http://127.0.0.1:${HOST_PORT}/healthz"
healthy=0
for _ in $(seq 1 30); do
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then healthy=1; break; fi
  else
    if $DOCKER exec sprechfunk node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      healthy=1; break
    fi
  fi
  sleep 1
done

echo
if [ "$healthy" -eq 1 ]; then
  ok "$MODE erfolgreich — Sprechfunk läuft."
else
  warn "Container gestartet, aber Health-Check kam nicht durch. Logs prüfen:"
  warn "  cd $DIR && $COMPOSE logs -f"
fi

cat <<EOF

${C_GREEN}Fertig!${C_RESET}
  Verzeichnis:  $DIR
  Lauscht auf:  ${BIND_ADDR}:${HOST_PORT}  ->  Container-Port 8080
  Öffentl. URL: ${PUBLIC_ORIGIN}

${C_DIM}Nächste Schritte:${C_RESET}
  • Reverse Proxy (Caddy/Nginx/Traefik) auf ${BIND_ADDR}:${HOST_PORT} zeigen lassen und TLS terminieren.
    ${C_DIM}Mikrofon/PTT funktioniert nur über HTTPS (oder localhost).${C_RESET}
  • Der erste registrierte Nutzer wird automatisch Admin.

${C_DIM}Verwaltung:${C_RESET}
  Logs:        cd $DIR && $COMPOSE logs -f
  Neustart:    cd $DIR && $COMPOSE restart
  Update:      diesen Installer erneut ausführen (Secrets bleiben erhalten)
  Stoppen:     cd $DIR && $COMPOSE down
EOF
