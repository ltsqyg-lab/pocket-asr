# pocket-asr — two images from one file:
#
#   docker build --target slim  -t pocket-asr:slim  .    cloud engines only
#   docker build --target local -t pocket-asr:local .    + sherpa-onnx; the configured model is downloaded on first start
#
#   docker run -d -p 8080:8080 -v $PWD/asr.json:/config/asr.json:ro -v asr-data:/data -v asr-models:/models pocket-asr:local
#
# Put TLS in front (Caddy, nginx, a cloud load balancer) or set "tls" in the config. Runs as the unprivileged `node`
# user; the only writable places are /data (keys and revocations state) and /models.

FROM node:22-alpine AS slim
WORKDIR /app
COPY package.json models.json LICENSE README.md ./
COPY src/ src/
COPY scripts/ scripts/
RUN mkdir -p /data /models && chown node:node /data /models
USER node
ENV ASR_CONFIG=/config/asr.json \
    ASR_HEALTH_URL=http://127.0.0.1:8080/healthz
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
  CMD node -e "fetch(process.env.ASR_HEALTH_URL).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "src/server.mjs"]

FROM node:22-bookworm-slim AS local
# bzip2 for the .tar.bz2 models, ca-certificates for HTTPS downloads
RUN apt-get update && apt-get install -y --no-install-recommends bzip2 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json models.json LICENSE README.md ./
COPY src/ src/
COPY scripts/ scripts/
# The engine program for this image's architecture (linux-x64 / linux-arm64), checked against models.json.
RUN node src/cli.mjs install-engine sherpa-onnx /opt/sherpa \
 && mkdir -p /data /models && chown node:node /data /models
USER node
ENV ASR_CONFIG=/config/asr.json \
    ASR_HEALTH_URL=http://127.0.0.1:8080/healthz
VOLUME ["/models", "/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=600s \
  CMD node -e "fetch(process.env.ASR_HEALTH_URL).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "src/server.mjs"]
