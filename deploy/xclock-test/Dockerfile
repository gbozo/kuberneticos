# Minimal GUI test image for the X-Desktop live verification: a pod running
# xclock (needed so it can be exec-launched against the kos-xserver display
# pool by kos-server: `kos.dev/x-app: "xclock"`).
#
# Build/push (by a machine with docker):
#   docker build -t ghcr.io/gbozo/xclock-test:dev deploy/xclock-test
#   docker push ghcr.io/gbozo/xclock-test:dev
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        x11-apps x11-common libx11-data libgl1 libglx-mesa0 libglapi-mesa \
        mesa-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# kos-server launches the annotated command via exec; the pod itself just idles.
CMD ["sleep", "infinity"]
