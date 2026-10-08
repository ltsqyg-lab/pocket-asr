#!/bin/sh
# Lab gateway on https://127.0.0.1:18700 (Pocket's local integration lab).
#
#   scripts/dev.sh start     start (writes .lab/asr/asr-lab.json, log asr.log, pid asr.pid)
#   scripts/dev.sh stop      stop
#   scripts/dev.sh status    health + /v1/info
#   scripts/dev.sh token     print the lab token (Authorization: Bearer <token>)
#
# Auth: Pocket tickets (aud asr:official) checked with the lab coordination keys in .lab/coord-keys.json
# (written by server/lab-v2.mjs; without it a lab key is generated here and said so), plus a static lab token.
# TLS: .lab/ca/asr.crt signed by the lab CA (the coordination lab's CA), else a self-signed one.
# Engine: `lab-echo` (fixed sentence, no keys, no model). ASR_LAB_LOCAL=1 also installs sherpa-onnx + SenseVoice into
# the lab directory (~190 MB; set HTTPS_PROXY for that one command if GitHub needs it) and makes it the default.
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(cd "$HERE/.." && pwd)
LAB=${POCKET_LAB:-$REPO/.lab}
D=$LAB/asr
PORT=${ASR_LAB_PORT:-18700}
mkdir -p "$D" && chmod 700 "$D"

cmd=${1:-start}
case "$cmd" in
  stop)
    if [ -f "$D/asr.pid" ] && kill "$(cat "$D/asr.pid")" 2>/dev/null; then echo "stopped"; else echo "not running"; fi
    rm -f "$D/asr.pid"; exit 0 ;;
  status)
    CA="$LAB/ca/ca.crt"; [ -f "$D/self.crt" ] && CA="$D/self.crt"
    curl -s --noproxy '*' --cacert "$CA" "https://127.0.0.1:$PORT/healthz" && echo && curl -s --noproxy '*' --cacert "$CA" "https://127.0.0.1:$PORT/v1/info" && echo
    exit 0 ;;
  token)
    cat "$D/token.txt"; echo; exit 0 ;;
  start) ;;
  *) echo "usage: $0 start|stop|status|token"; exit 2 ;;
esac

if [ -f "$D/asr.pid" ] && kill -0 "$(cat "$D/asr.pid")" 2>/dev/null; then echo "already running (pid $(cat "$D/asr.pid"))"; exit 0; fi

# --- certificate --------------------------------------------------------------------------------------------------
CERT="$LAB/ca/asr.crt"; KEY="$LAB/ca/asr.key"; CA="$LAB/ca/ca.crt"
if [ ! -f "$CERT" ] && [ -f "$REPO/server/lab-v2.mjs" ]; then node "$REPO/server/lab-v2.mjs" cert asr >/dev/null 2>&1 || true; fi
if [ ! -f "$CERT" ]; then
  CERT="$D/self.crt"; KEY="$D/self.key"; CA="$CERT"
  [ -f "$CERT" ] || openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 -subj /CN=127.0.0.1 \
    -addext subjectAltName=IP:127.0.0.1 -keyout "$KEY" -out "$CERT" >/dev/null 2>&1
  echo "note: no lab CA certificate; using a self-signed one ($CERT)"
fi

# --- token, coordination keys, config ----------------------------------------------------------------------------
LOCAL=${ASR_LAB_LOCAL:-0}
if [ "$LOCAL" = 1 ]; then
  SHERPA=$(NODE_USE_ENV_PROXY=1 node --no-warnings "$HERE/src/cli.mjs" install-engine sherpa-onnx "$D/sherpa" | tail -1)
  NODE_USE_ENV_PROXY=1 node --no-warnings "$HERE/src/cli.mjs" install-model sense-voice-int8 "$D/models/sense-voice-int8" | tail -1 >/dev/null
else SHERPA=""; fi

LAB="$LAB" D="$D" PORT="$PORT" CERT="$CERT" KEY="$KEY" SHERPA="$SHERPA" node --input-type=module -e '
import fs from "node:fs"; import crypto from "node:crypto"; import path from "node:path"
const { LAB, D, PORT, CERT, KEY, SHERPA } = process.env
const tokFile = path.join(D, "token.txt")
if (!fs.existsSync(tokFile)) fs.writeFileSync(tokFile, crypto.randomBytes(24).toString("base64url"), { mode: 0o600 })
const token = fs.readFileSync(tokFile, "utf8").trim()
let pinned, coordUrl
const ck = path.join(LAB, "coord-keys.json"), cl = path.join(LAB, "coord-lab.json")
if (fs.existsSync(ck)) {
  const j = JSON.parse(fs.readFileSync(ck, "utf8")); pinned = Array.isArray(j) ? j : (j.pinnedKeys || j.keys)
  if (fs.existsSync(cl)) coordUrl = JSON.parse(fs.readFileSync(cl, "utf8")).url
} else {
  const kf = path.join(D, "lab-coord-key.json")
  if (!fs.existsSync(kf)) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })
    const jwk = publicKey.export({ format: "jwk" })
    const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url")
    const now = Date.now()
    fs.writeFileSync(kf, JSON.stringify({ privatePkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      pinned: [{ kid: "lab-asr", pub, use: ["keys", "ticket", "revocations"], nbf: now - 60000, exp: now + 30 * 86400000 }] }), { mode: 0o600 })
    console.log("note: .lab/coord-keys.json not found; generated a lab coordination key in " + kf)
  }
  pinned = JSON.parse(fs.readFileSync(kf, "utf8")).pinned
}
const engines = [{ id: "echo", type: "lab-echo" }]
if (SHERPA) engines.unshift({ id: "local", type: "sherpa-onnx", bin: SHERPA, model: path.join(D, "models", "sense-voice-int8"), threads: 2 })
const cfg = {
  gatewayId: "official", listen: { host: "127.0.0.1", port: Number(PORT) }, tls: { cert: CERT, key: KEY }, dataDir: path.join(D, "data"),
  auth: { tokens: [{ label: "lab", sha256: crypto.createHash("sha256").update(token).digest("hex") }],
          ticket: { enabled: true, pinnedKeys: pinned, accounts: ["*"], ...(coordUrl ? { coordUrl } : {}) } },
  engines, default: { zh: engines[0].id, en: engines[0].id, auto: engines[0].id },
  limits: { perMinute: 60, concurrentPerCaller: 2, concurrent: 4 },
}
fs.writeFileSync(path.join(D, "asr-lab.json"), JSON.stringify(cfg, null, 2), { mode: 0o600 })
'

NODE_EXTRA_CA_CERTS="$LAB/ca/ca.crt" nohup node "$HERE/scripts/dev-server.mjs" --config "$D/asr-lab.json" >> "$D/asr.log" 2>&1 &
echo $! > "$D/asr.pid"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s --noproxy '*' --cacert "$CA" "https://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    echo "pocket-asr lab: https://127.0.0.1:$PORT  (pid $(cat "$D/asr.pid"), log $D/asr.log, CA $CA)"
    echo "token: $(cat "$D/token.txt")   (Authorization: Bearer <token>; tickets: aud asr:official)"
    exit 0
  fi
  sleep 0.5
done
echo "did not come up; see $D/asr.log"; tail -5 "$D/asr.log"; exit 1
