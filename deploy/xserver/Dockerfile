# kos-xserver image — central shared X server pod for the kOS web desktop.
#
# What runs inside (per configured display :21, :22, ... — see entrypoint.sh):
#   * Xvfb   :N on X11 TCP port 6000+N  (TCP listening is REQUIRED: app pods are
#            remote X clients, so -nolisten tcp must never be passed)
#   * x11vnc on TCP port 5900+N         (streaming leg, kos-server proxies it)
#   * openbox session on :N             (window decorations/window management)
#
# Auth model (single-user kOS instance, in-cluster):
#   * X11-over-TCP inside the cluster is PLAINTEXT by design. Authentication is
#     enforced the X11 way — an MIT-MAGIC-COOKIE-1 per display via xauth —
#     never via xhost. VNC legs run without a RFB password (-nopw); access is
#     gated by network policy + the kos-server RBAC'd allocation path.
#   * The browser-facing leg is always TLS/WSS through kos-server; the browser
#     never talks raw VNC/X11.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      x11vnc \
      xauth \
      openbox \
      supervisor \
      fonts-noto-core \
      xterm \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Static display pool bounds, tunable per-pod (default: displays :21..:25).
ENV XDISPLAY_START=21 \
    XDISPLAY_COUNT=5 \
    XDISPLAY_SIZE=1920x1080x24

# Non-root runtime user (uid/gid 1000). All of Xvfb/x11vnc/openbox bind only
# unprivileged ports, so no root is needed anywhere in this image.
RUN groupadd --gid 1000 kos && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash kos

WORKDIR /kos
# WORKDIR creates the dir as root even under USER kos, so hand it over —
# supervisord and the entrypoint both write here (runtime conf, log, pid,
# unix socket, .Xauthority).
RUN chown -R kos:kos /kos
COPY --chown=kos:kos supervisord.conf /kos/supervisord.conf
COPY --chown=kos:kos entrypoint.sh /usr/local/bin/kos-entrypoint
RUN chmod 0755 /usr/local/bin/kos-entrypoint

USER 1000:1000
ENV HOME=/kos
ENTRYPOINT ["/usr/local/bin/kos-entrypoint"]
