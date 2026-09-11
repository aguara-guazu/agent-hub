#!/usr/bin/env bash
# Instala Agent Hub en /Applications a partir del bundle que genera `npm run package`.
#
#   make install-app            # empaqueta e instala
#   SKIP_PACKAGE=1 make install-app   # reutiliza desktop/out sin volver a empaquetar
#
# Cierra sólo la app de escritorio en ejecución; los puentes headless que tienen
# abiertos los CLIs (Claude Code, Codex, Gemini, Kiro) siguen vivos hasta que cada
# sesión termine. Si había un ítem de inicio de sesión apuntando a otra copia, lo
# reemplaza por la copia instalada.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Agent Hub"
ARCH="${AGENTHUB_ARCH:-arm64}"
BUNDLE="$ROOT/desktop/out/${APP_NAME}-darwin-${ARCH}/${APP_NAME}.app"
INSTALL_DIR="${AGENTHUB_INSTALL_DIR:-/Applications}"
TARGET="$INSTALL_DIR/${APP_NAME}.app"

log() { printf '%s\n' "$*" >&2; }

[[ "$(uname -s)" == "Darwin" ]] || { log "este instalador es sólo para macOS"; exit 1; }

if [[ "${SKIP_PACKAGE:-0}" != "1" ]]; then
  log "== Empaquetando (npm run package -- darwin)"
  (cd "$ROOT" && npm run package -- darwin)
fi
[[ -d "$BUNDLE" ]] || { log "no existe el bundle $BUNDLE"; exit 1; }

# 1. Cerrar la app de escritorio (proceso principal, sin argumentos). Los gateways
#    headless llevan --agenthub-headless y no se tocan.
main_pids() { pgrep -f "/Contents/MacOS/${APP_NAME}\$" || true; }
pids="$(main_pids)"
if [[ -n "$pids" ]]; then
  log "== Cerrando Agent Hub en ejecución (pid $pids)"
  kill -TERM $pids 2>/dev/null || true
  for _ in $(seq 1 60); do
    [[ -z "$(main_pids)" ]] && break
    sleep 0.5
  done
  if [[ -n "$(main_pids)" ]]; then
    log "   no terminó a tiempo; forzando"
    kill -KILL $(main_pids) 2>/dev/null || true
    sleep 1
  fi
fi

# 2. Reemplazar el bundle instalado. Sólo se borra si es un Agent Hub.
if [[ -e "$TARGET" ]]; then
  if [[ -f "$TARGET/Contents/Resources/app/package.json" ]] \
     && grep -q '"name": *"agent-hub"' "$TARGET/Contents/Resources/app/package.json"; then
    log "== Reemplazando $TARGET"
    rm -rf "$TARGET"
  else
    log "$TARGET existe y no parece ser Agent Hub; no se toca"
    exit 1
  fi
else
  log "== Instalando en $TARGET"
fi
mkdir -p "$INSTALL_DIR"
ditto "$BUNDLE" "$TARGET"

# 3. Ítem de inicio de sesión: si apuntaba a otra copia, apuntarlo a la instalada.
#    La casilla «Iniciar al ingresar» del menú de la barra sigue siendo el control.
stale="$(osascript -e 'tell application "System Events" to get path of every login item whose name is "Agent Hub"' 2>/dev/null || true)"
if [[ -n "$stale" && "$stale" != "$TARGET" ]]; then
  log "== Actualizando el ítem de inicio de sesión ($stale -> $TARGET)"
  osascript >/dev/null <<APPLESCRIPT
tell application "System Events"
  delete (every login item whose name is "Agent Hub")
  make login item at end with properties {path:"$TARGET", hidden:false}
end tell
APPLESCRIPT
fi

# 4. Abrir la app instalada.
log "== Abriendo $TARGET"
open "$TARGET"
log "Listo. Agent Hub vive en la barra de menú; no aparece en el Dock."
