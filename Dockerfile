# pocket-asr — two images from one file:
#
#   docker build -t pocket-asr .                       default: local recognition with sherpa-onnx (the speech model,
#                                                      about 160 MB, is downloaded into the data volume on first start)
#   docker build --target slim -t pocket-asr:slim .    cloud engines only (needs a config file naming them)
#
#   docker run -d --name pocket-asr --restart unless-stopped -p 8444:8444 -v pocket-asr:/var/lib/pocket-asr pocket-asr
#   docker logs pocket-asr                             → the line to paste into the Pocket App
#
# No domain and no certificate to buy: on first start the gateway makes a self-signed certificate and the App pins it.
# A config file is optional: -v $PWD/asr.json:/etc/pocket-asr/asr.json:ro. Runs as the unprivileged `node` user; the
# only writable place is /var/lib/pocket-asr (certificate, token hashes, model, coordination keys).

FROM node:22-alpine AS slim
WORKDIR /app
COPY package.json models.json LICENSE LICENSE-MIT README.md ./
COPY src/ src/
COPY scripts/ scripts/
RUN mkdir -p /var/lib/pocket-asr && chown node:node /var/lib/pocket-asr
USER node
ENV ASR_DATA_DIR=/var/lib/pocket-asr
VOLUME ["/var/lib/pocket-asr"]
EXPOSE 8444
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD ["node", "src/main.mjs", "--health"]
CMD ["node", "src/main.mjs"]

FROM node:22-bookworm-slim AS local
# bzip2 for the .tar.bz2 archives, ca-certificates for HTTPS downloads
RUN apt-get update && apt-get install -y --no-install-recommends bzip2 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json models.json LICENSE LICENSE-MIT README.md ./
COPY src/ src/
COPY scripts/ scripts/
# The engine program for this image's architecture (linux-x64 / linux-arm64), checked against models.json.
# Behind a proxy: docker build --build-arg HTTPS_PROXY=http://<proxy> -t pocket-asr .
RUN NODE_USE_ENV_PROXY=1 node src/cli.mjs install-engine sherpa-onnx /opt/sherpa \
 && mkdir -p /var/lib/pocket-asr && chown node:node /var/lib/pocket-asr
USER node
ENV ASR_DATA_DIR=/var/lib/pocket-asr
VOLUME ["/var/lib/pocket-asr"]
EXPOSE 8444
# the first start downloads the model before it listens
HEALTHCHECK --interval=30s --timeout=5s --start-period=600s CMD ["node", "src/main.mjs", "--health"]
CMD ["node", "src/main.mjs"]
