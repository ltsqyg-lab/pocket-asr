# pocket-asr

English | [简体中文](README.zh-CN.md)

The speech-to-text gateway for [Pocket](https://pocket.pocketcli.net). It puts one small HTTPS API in front of the
recognition engine you choose: a model on your own server, or a cloud service with your own keys. It returns text and
**stores neither the audio nor the text.** Node.js 22 or later, no npm dependencies, AGPL-3.0-only.

## Deploy without a domain (recommended)

You need a server with a public IP and Docker. As with Tailscale's DERP servers, there is no domain and no certificate
to buy or renew: the gateway makes its own self-signed certificate and the app pins it by its fingerprint.

```sh
git clone https://github.com/ltsqyg-lab/pocket-asr && cd pocket-asr
docker build -t pocket-asr .
docker run -d --name pocket-asr --restart unless-stopped -p 8444:8444 -v pocket-asr:/var/lib/pocket-asr pocket-asr
docker logs -f pocket-asr
```

On first start the gateway downloads the speech model (about 160 MB, checked against its SHA-256), makes the
certificate and a token, and prints a line like this:

```
  pocket-asr://203.0.113.7:8444?pin=sha256:3c9f…e41b&token=pXq…7Kd
```

1. In the Pocket app, go to **Settings → Voice transcription → My own gateway** and paste the line.
2. Allow **TCP 8444** in the server's firewall and security group (cloud consoles block it by default).

`pin` is the SHA-256 of the gateway's certificate. The app accepts no other certificate, so nobody in between can
impersonate the gateway. `token` lets your phone in. It is shown **only once** (the data directory keeps only its hash);
for a new one, or one per phone, run `docker exec pocket-asr node src/main.mjs new-token "my iPad"` to print a new line
(see [Operations](#operations)).

The gateway asks Pocket's coordination server which IP its requests come from. If that fails or gives the wrong
address (behind NAT, for example), the line shows `<this-server-public-IP>` and says so. Replace it, or set the address
and restart:

```sh
docker run … -e ASR_PUBLIC_URL=https://203.0.113.7:8444 … pocket-asr
```

If you publish another port (`-p 443:8444`), set that as well: `-e ASR_PUBLIC_URL=https://203.0.113.7:443`.

**Server size.** The default engine runs on the server's CPU and uses about 0.3 GB of disk. Each recognition in
progress takes about 0.5 GB of memory (one at a time with less than 1.8 GB of memory, two otherwise). 1 vCPU and 1 GB
is enough for one person, and a sentence takes a few seconds. For a smaller server, use a cloud engine and the
`slim` image (see [Engines and models](#engines-and-models)).

**Next to pocket-relay.** [pocket-relay](https://github.com/ltsqyg-lab/pocket-relay) uses port 8443 and pocket-asr
8444, so both can run on one server. Open both ports; each prints its own line for the app.

**Without Docker** (Node.js 22 or later; Linux x64 or arm64 with glibc, or macOS):

```sh
git clone https://github.com/ltsqyg-lab/pocket-asr /opt/pocket-asr
sudo useradd --system --create-home --home-dir /var/lib/pocket-asr pocket-asr
sudo -u pocket-asr node /opt/pocket-asr/src/main.mjs       # first start: copy the line, then Ctrl-C
```

The first start also installs the sherpa-onnx program (about 30 MB) into the data directory. To keep the gateway
running, save this as `/etc/systemd/system/pocket-asr.service` and run `systemctl enable --now pocket-asr` (the line is
in `journalctl -u pocket-asr`):

```ini
[Unit]
Description=pocket-asr speech gateway
After=network-online.target
Wants=network-online.target

[Service]
User=pocket-asr
ExecStart=/usr/bin/node /opt/pocket-asr/src/main.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

Run the [Operations](#operations) commands as the same user:
`sudo -u pocket-asr node /opt/pocket-asr/src/main.mjs new-token`. To use another data directory, set
`ASR_DATA_DIR=/path` for both the service and the commands.

## With a domain

**Behind a reverse proxy** (the easiest way when you have a domain). Caddy gets and renews the certificate by itself:

```
asr.example.com {
    reverse_proxy 127.0.0.1:8444
}
```

```sh
docker run -d --name pocket-asr --restart unless-stopped -p 127.0.0.1:8444:8444 -v pocket-asr:/var/lib/pocket-asr \
  -e ASR_TLS=off -e ASR_PUBLIC_URL=https://asr.example.com pocket-asr
```

The gateway then talks plain HTTP to the proxy, and the line has no `pin` (`pocket-asr://asr.example.com:443?token=…`).
The app checks the proxy's certificate the usual way, so renewals keep working. Without Docker, listening on loopback
is enough: put `"listen": {"host": "127.0.0.1"}` and `"publicUrl"` in the config (plain HTTP is the default on
loopback). A path prefix works too: `ASR_PUBLIC_URL=https://example.com/asr`, plus `"basePath": "/asr"` if the proxy
doesn't strip it.

**Certificate files:** `"tls": {"cert": "/etc/letsencrypt/live/asr.example.com/fullchain.pem", "key": "…/privkey.pem"}`
and `"publicUrl": "https://asr.example.com:8444"`. The files are read at start, so restart after a renewal (for
example with certbot's `--deploy-hook "docker restart pocket-asr"`). A certificate from a public CA for a domain name
gets no `pin` in the line. A self-signed certificate, or any certificate for an IP address, does.

## What the gateway keeps and sends

Pocket has four ways to turn voice into text, and this gateway handles two of them:

| Mode | Where the audio goes |
|---|---|
| Pocket cloud | phone → the official gateway (this code, run by Pocket) → a cloud speech service |
| My computer | phone → (end-to-end encrypted) → your computer, which uses the same local engines as this repository (`src/engines/local.mjs`) |
| **My own gateway** | phone → **your** pocket-asr → the engine you configured |
| On this phone | stays on the phone (iOS or Android on-device recognition) |

- Audio and text exist only in memory for one request. Local engines use one temporary file, deleted before the answer.
- One log line per request: time, gateway id, caller (token label or account id), engine, audio seconds, number of
  characters, latency, result code (on errors, also an internal reason or the provider's request id). **Never**
  audio, text, tokens, tickets or proofs. Provider error messages aren't logged either, because some echo parts of
  the key.
- No analytics. The gateway connects only to the engine you configured, the downloads you ask for (and the default
  engine's on first start), and Pocket's coordination server: for this server's public IP when `publicUrl` isn't set
  (`GET /v2/whoami`, which sees only the address the request comes from) and, with ticket auth, for public keys and
  revocations.
- With a cloud engine, that provider receives the audio, under your account.

## Engines and models

**Default: local recognition.** With no `engines` configured, the gateway runs
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) with SenseVoice small (int8; Chinese and English, `zh` / `en` /
`auto`) on the server's own CPU. No keys are needed and the audio never leaves your server. The Docker image contains
the program, and the model is downloaded into the data directory on first start. Without Docker both go there
(`<dataDir>/sherpa-onnx`, `<dataDir>/models/sense-voice-int8`). `ASR_SHERPA_BIN` points at a program you installed
yourself.

**Another engine** needs a config file (`/etc/pocket-asr/asr.json` in the container, or `--config <file>`). The
smallest example is a cloud service with your key in the environment:

```json
{ "engines": [ { "id": "openai", "type": "openai", "apiKey": "env:OPENAI_API_KEY" } ] }
```

```sh
docker build --target slim -t pocket-asr:slim .          # cloud engines only: smaller, no local program
docker run -d --name pocket-asr --restart unless-stopped -p 8444:8444 -v pocket-asr:/var/lib/pocket-asr \
  -v $PWD/asr.json:/etc/pocket-asr/asr.json:ro -e OPENAI_API_KEY=sk-… pocket-asr:slim
```

`"env:NAME"` values are read from the environment and `"file:/path"` values from a file, so secrets stay out of the
config. `"secretsFile": "/path.json"` merges a JSON credentials file into an engine. You can configure several
engines. `"default": {"zh": "<id>", "en": "<id>", "auto": "<id>"}` picks one per language; otherwise the first engine
that supports the language is used.

| `type` | Service | Settings | Languages | Limit |
|---|---|---|---|---|
| `volcano` | Volcano Engine big-model ASR, WebSocket `bigmodel_nostream` | `appId`, `accessToken`, `resourceId`?, `hotWords`?, `url`? | zh, en, auto | 240 s |
| `alibaba` | Alibaba Cloud one-sentence recognition | `accessKeyId`, `accessKeySecret`, `appkey` or `appkeys: {zh, en}`, `region`? (`cn-shanghai`) | per appkey | 60 s |
| `tencent` | Tencent Cloud SentenceRecognition, TC3 signature | `secretId`, `secretKey`, `region`?, `engines`? (`{zh: "16k_zh", en: "16k_en", auto: "16k_zh-PY"}`) | zh, en, auto | 60 s |
| `iflytek` | iFlytek voice dictation WebAPI v2 | `appId`, `apiKey`, `apiSecret`, `languages`? | zh, en | 60 s |
| `openai` | OpenAI (or compatible) `/audio/transcriptions` | `apiKey`, `model`? (`gpt-4o-transcribe`), `baseUrl`? (`https://api.openai.com/v1`) | zh, en, auto | 600 s |
| `deepgram` | Deepgram pre-recorded `/v1/listen` | `apiKey`, `models`? (`nova-3`) | zh, en, auto | 600 s |
| `azure` | Azure AI Speech, REST for short audio | `key`, `region` or `endpoint`, `languages`? | zh, en | 60 s |
| `sherpa-onnx` | local: `sherpa-onnx-offline` with SenseVoice or Paraformer | `bin`, `model` (directory), `threads`? | SenseVoice zh/en/auto, Paraformer zh | 240 s |
| `whisper.cpp` | local: `whisper-cli` | `bin`, `model` (ggml file), `threads`? | zh, en, auto | 240 s |
| `vosk` | local: `vosk-transcriber` or `scripts/vosk-wav.py` | `bin`, `model` (directory), `langs` | as the model | 240 s |

Every engine also takes `maxSeconds` (lower than its limit). **Local engines** run an external program per request
from an argument array, never through a shell. On Windows it goes through `cmd.exe` with every argument quoted,
because a bun-compiled parent stalls for seconds when it starts the program directly. The audio goes to a private
temporary directory (0700) that is deleted before the response, and the program is killed on timeout or when the
client goes away. With `"install": {"model": "<id>"}` on a local engine, a missing model is downloaded on start.
`models.json` lists what can be installed, with each file's size and SHA-256:

| Model | Engine | Size | |
|---|---|---|---|
| `sense-voice-int8` | sherpa-onnx | 155 MB | The default. Best Chinese per CPU second, also English, with punctuation. This is the 2024-07-17 release (the 2025-09-09 one is a Cantonese fine-tune). |
| `paraformer-zh-small` | sherpa-onnx | 74 MB | Mandarin only, no punctuation |
| `whisper-base-q5_1`, `whisper-base`, `whisper-small` | whisper.cpp | 57 / 141 / 465 MB | Multilingual |
| `vosk-small-cn`, `vosk-small-en-us` | vosk | 42 / 39 MB | Smallest, least accurate |

A gateway first started before 2026-10-09 downloaded the 2025-09-09 SenseVoice (the Cantonese fine-tune). To switch to
the 2024-07-17 one, delete `<dataDir>/models/sense-voice-int8` and restart.

```sh
node src/cli.mjs models                                            # what can be installed
node src/cli.mjs install-engine sherpa-onnx ./sherpa               # the program for this platform
node src/cli.mjs install-model paraformer-zh-small ./models/paraformer-zh-small
node src/cli.mjs check asr.json                                    # validate a config; prints what /v1/info will say
node src/cli.mjs transcribe asr.json sample.wav zh                 # one recognition through the configured engines
```

Downloads try Pocket's mirror (`https://pocket.pocketcli.net/dl/asr/`) first, then the upstream URL. If neither is
reachable, use a proxy: `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://<proxy> node src/main.mjs` (Node 22's built-in proxy
support), or `docker build --build-arg HTTPS_PROXY=http://<proxy> …` for the image.

## Configuration

Optional. The file comes from `--config <file>`, else `ASR_CONFIG`, else `/etc/pocket-asr/asr.json` if it exists.
`asr.example.json` shows every section. These environment variables override the file:

| Variable | Setting | Default |
|---|---|---|
| `ASR_DATA_DIR` | `dataDir` | `/var/lib/pocket-asr` |
| `ASR_PORT` | `listen.port` | `8444` |
| `ASR_PUBLIC_URL` | `publicUrl` | asked from the coordination server |
| `ASR_TLS` | `tls`: `auto`, `self` or `off` | `auto` |
| `ASR_COORD_URL` | `coordUrl` | `https://pocket.pocketcli.net` |
| `ASR_DAY_MINUTES`, `ASR_MONTH_MINUTES` | `limits.dayMinutes`, `limits.monthMinutes` | `120`, `1500` |
| `ASR_SHERPA_BIN` | the default engine's program | the image's, else installed into the data directory |

| Key | Default | |
|---|---|---|
| `gatewayId` | `my-asr` | Required with ticket auth (tickets are addressed to `asr:<gatewayId>`). |
| `listen.host`, `listen.port` | `null` (every address), `8444` | |
| `tls` | `"auto"` | `"auto"`: own certificate, except plain HTTP when listening on loopback only (a proxy on this machine). `"self"`: own certificate. `"off"` / `null`: plain HTTP behind your HTTPS proxy. `{"cert", "key"}`: PEM files. |
| `publicUrl` | `null` | `https://<host>[:<port>][/<path>]` that phones use; goes into the line. |
| `coordUrl` | `https://pocket.pocketcli.net` | Where `GET /v2/whoami` is asked. |
| `basePath` | `""` | A prefix such as `/asr` before every path. |
| `timezone` | `Asia/Shanghai` | Where days and months of speech time start. |
| `dataDir` | `/var/lib/pocket-asr` (`main.mjs`) | Certificate, token hashes, connection line, models, coordination keys, revocations and speech time used. |
| `auth.tokens` | `[]` | `[{label, sha256}]`: tokens in the config (hash only, `node src/cli.mjs token`), in addition to the data directory's. |
| `auth.ticket` | off | Pocket tickets, below. |
| `engines`, `default` | local engine | See [Engines and models](#engines-and-models). |
| `limits` | below | |

| Limit | Default | |
|---|---|---|
| `maxBytes` | 8388608 | request body |
| `maxSeconds` | 240 | audio length |
| `perMinute` | 12 | recognitions per caller per minute |
| `concurrentPerCaller` | 2 | requests of one caller at once |
| `concurrent` | 8 (default engine: 1 or 2 by memory) | engine calls at once |
| `uploads` | 16 | request bodies being received at once |
| `silencePeak` | 64 | recordings quieter than this everywhere are answered `empty` without calling an engine (0 = off) |
| `dayMinutes`, `monthMinutes` | 120, 1500 | minutes of audio per caller per day and per month (0 = no cap). A Pocket ticket may set its own. |

**Speech time.** Every recognition that reaches an engine counts its audio length, whatever the result. When a caller's
minutes for the day or the month are used up, the gateway answers `429 quota` with `Retry-After` and a sentence in
Chinese and English, until the next day or month. The figures are kept in `<dataDir>/usage.json` (callers only as
hashes), so a restart doesn't reset them.

**Authentication** takes one of two forms.

- **Tokens:** `Authorization: Bearer <token>`. Only SHA-256 hashes are kept, in `<dataDir>/tokens.json` (written by the
  first start and by `new-token`) and/or in `auth.tokens`. The label appears in logs. If no token and no ticket auth
  is configured, the next start makes a token.
- **Pocket tickets:** `Authorization: PocketTicket <ticket>` plus `X-Pocket-Proof: <b64u(a)>.<b64u(s)>`. Tickets are
  short-lived, signed by Pocket's coordination keys for `aud = asr:<gatewayId>`, and checked offline with the pinned
  public keys (the key set is refreshed from `<coordUrl>/.well-known/pocket/keys.json`; a new key is adopted only when
  a trusted key signed it). The proof is signed by the device's own key and binds the exact request body (SHA-256), a
  timestamp (±5 minutes) and a one-time nonce (remembered for 10 minutes), so a captured request can't be replayed or
  reused for other audio. `accounts` limits which Pocket accounts may use the gateway. Signed revocation documents
  cut off devices that were logged out or removed; they are pushed to `/v1/revocations` and polled from the
  coordination server for the accounts in `accounts`. Protocol: [E2EE.md](protocol/E2EE.md) §12–13 and
  [ASR.md](protocol/ASR.md) §3.

## Operations

With Docker, put `docker exec pocket-asr` in front of each command.

```sh
node src/main.mjs new-token ["label"]     # another token; prints a complete line (the token only there)
node src/main.mjs connect-string          # the line without a token: address and pin
node src/main.mjs tokens                  # token labels
node src/main.mjs revoke-token "label"    # that phone is refused from now on
node src/main.mjs --health                # exit status 0 when the gateway answers (the image's health check)
```

- A running gateway picks up new and revoked tokens within a second, without a restart. Labels are unique; without one
  you get `token-1`, `token-2`, and so on. If you revoke the last token and restart, the gateway makes a new one.
- The line is also in `<dataDir>/connect.txt`, without the token, which is never stored. `docker logs` keeps the first
  start's line, token included, so anyone who can read this server's logs can read it. If that worries you, revoke it
  and make a new one.
- Logs: `docker logs pocket-asr` (or `journalctl -u pocket-asr`), one line per request and nothing of what was said.
- The certificate lives in `<dataDir>/self-cert.pem` and `self-key.pem` and survives restarts and updates, so the pin
  doesn't change. The gateway only makes a new one when it is broken, close to expiring (it is valid for 10 years) or
  made for another public address. Then you paste the new line into the app; the gateway says so when it starts.
- Updating: `git pull && docker build -t pocket-asr . && docker rm -f pocket-asr`, then the same `docker run`. The
  volume keeps the certificate, the tokens and the model, so the app keeps working.

## Development and testing

```sh
npm test            # or node --test: protocol vectors, WAV rules, auth, limits, every adapter against a local fake
                    # of its provider, local engines with fake programs, model downloads, self-hosting end to end
```

`scripts/dev-server.mjs` runs the gateway with an extra `lab-echo` engine (no keys, no model) for testing clients.

**HTTP API** ([ASR.md](protocol/ASR.md) has the full contract):

- `GET /v1/info` (public): service, version (major.minor), gateway id, engines, auth methods and limits.
- `POST /v1/recognize?lang=zh|en|auto&engine=<id>` with a WAV body (PCM, 16 kHz, mono, 16-bit) and
  `Content-Type: audio/wav`. Success is 200 with `ok: true`, `text`, `lang`, `engine`, `seconds` and `ms`; an error
  has `ok: false`, `code` (below) and `message`.
- `POST /v1/revocations`: a revocation document signed by Pocket's coordination keys (ticket auth only).
- `GET /healthz`: `{"ok": true}`.

| Code | HTTP | Meaning |
|---|---|---|
| `bad-audio` | 400 | not a 16 kHz mono 16-bit PCM WAV |
| `too-large` | 413 | body over `limits.maxBytes` |
| `too-long` | 413 | audio longer than the gateway's or the engine's limit (never silently cut) |
| `empty` | 422 | nothing was said (silence, under 0.1 s, or the engine heard nothing) |
| `unauthorized` | 401 | missing or invalid token, ticket or proof |
| `rate` | 429 | this caller is over its per-minute or at-once limit (`Retry-After`) |
| `quota` | 429 | this caller's minutes for the day or month are used up (`Retry-After`; `zh` and `en` say so) |
| `busy` | 503 | the gateway (or the provider) is at capacity (`Retry-After`) |
| `no-engine` | 400 | no engine for this language (or the named engine doesn't do it) |
| `engine-error` | 502 | the engine failed (details only in the operator's log) |
| `engine-timeout` | 504 | no answer within 30 s plus the audio length |

The connection line is `pocket-asr://<host>:<port>[/<path>]?pin=sha256:<hex>&token=<token>`
([ASR.md](protocol/ASR.md) §11).

## License

AGPL-3.0-only (see `LICENSE`). If you run a modified version as a network service, you must offer its source to its
users.

Exceptions: `src/engines/local.mjs` alone is MIT (`LICENSE-MIT`), because the Pocket desktop app embeds it to run local
recognition on your own computer; contributions to that file are accepted under MIT. `src/selfcert.mjs` is shared with
pocket-relay (AGPL-3.0-or-later).
