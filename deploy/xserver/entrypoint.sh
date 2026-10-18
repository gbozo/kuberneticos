#!/bin/bash
# kos-xserver entrypoint.
#
# Bootstraps the static display pool (:XDISPLAY_START .. +XDISPLAY_COUNT-1,
# default :21..:25):
#
#   1. Builds /kos/.Xauthority with ONE freshly generated MIT-MAGIC-COOKIE-1
#      per display (xauth add :N). Xvfb is started with -auth on that file, so
#      X11 clients must present a matching cookie — this is the only X11 auth
#      mechanism (never xhost +). kos-server later exec's `xauth add` to mint
#      per-session cookies for app pods; the cookie never leaves the cluster.
#   2. Appends one supervisord program block per display (Xvfb + openbox +
#      x11vnc) to a runtime conf derived from the base template.
#   3. exec's supervisord in the foreground (-n) to run the whole pool.
#
# Security posture: X11-over-TCP in-cluster is plaintext; auth is via the
# per-display xauth cookie, NOT a VNC password; the browser leg is TLS/WSS
# via kos-server.
set -euo pipefail

XDISPLAY_START="${XDISPLAY_START:-21}"
XDISPLAY_COUNT="${XDISPLAY_COUNT:-5}"
XDISPLAY_SIZE="${XDISPLAY_SIZE:-1920x1080x24}"

XAUTH_FILE="/kos/.Xauthority"
BASE_CONF="/kos/supervisord.conf"
RUNTIME_CONF="/kos/supervisord-runtime.conf"

XDISPLAY_END=$((XDISPLAY_START + XDISPLAY_COUNT - 1))

echo "kos-xserver: static display pool :${XDISPLAY_START}..:${XDISPLAY_END}"

cp "$BASE_CONF" "$RUNTIME_CONF"
rm -f "$XAUTH_FILE"
touch "$XAUTH_FILE"
chmod 0600 "$XAUTH_FILE"

for n in $(seq "$XDISPLAY_START" "$XDISPLAY_END"); do
  vnc_port=$((5900 + n))

  # 1) Per-display xauth cookie (16 random bytes, hex — same cookie shape
  #    kos-server mints for app pods).
  cookie="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  xauth -f "$XAUTH_FILE" add ":${n}" MIT-MAGIC-COOKIE-1 "$cookie"

  # 2) Supervisord program blocks for display :n. Xvfb MUST NOT get
  #    -nolisten tcp: remote app pods are X11 TCP clients. x11vnc runs with
  #    -nopw (auth is xauth-side, not RFB-side).
  {
    echo ""
    echo "[program:xvfb-${n}]"
    echo "command=Xvfb :${n} -listen tcp -auth ${XAUTH_FILE} -screen 0 ${XDISPLAY_SIZE}"
    echo "autorestart=true"
    echo ""
    echo "[program:openbox-${n}]"
    echo "environment=DISPLAY=\":${n}\",XAUTHORITY=\"${XAUTH_FILE}\""
    echo "command=openbox --display :${n}"
    echo "autorestart=true"
    echo ""
    echo "[program:vnc-${n}]"
    echo "environment=XAUTHORITY=\"${XAUTH_FILE}\""
    echo "command=x11vnc -display :${n} -rfbport ${vnc_port} -listen 0.0.0.0 -forever -shared -nopw"
    echo "autorestart=true"
  } >>"$RUNTIME_CONF"
done

echo "kos-xserver: runtime conf ready -> ${RUNTIME_CONF}"

export XAUTHORITY="$XAUTH_FILE"
exec supervisord -n -c "$RUNTIME_CONF"
