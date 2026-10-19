# Live-test for the X-Desktop feature with a heavyweight client: firefox
# exec-launched against the kos-xserver display pool by kos-server
# (`kos.dev/x-app: "firefox"`).
#
# Build/push (by a machine with docker):
#   docker build -t ghcr.io/gbozo/firefox-test:dev deploy/firefox-test
#   docker push ghcr.io/gbozo/firefox-test:dev
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        firefox-esr ca-certificates fonts-noto-core libgl1 mesa-utils \
    && rm -rf /var/lib/apt/lists/*

# kos-server launches the annotated command via exec; the pod itself just idles.
CMD ["sleep", "infinity"]
