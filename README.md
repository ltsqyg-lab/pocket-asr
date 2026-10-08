# pocket-asr

Speech-recognition gateway for [Pocket](https://pocket.pocketcli.net). One small HTTP API in front of the engine you
choose — cloud services with your own keys, or a model running on your own machine. It returns text and nothing else:
**no audio and no text is stored or logged.** Node.js 22+, no npm dependencies. License: AGPL-3.0-only.

[中文说明在后面](#中文说明)

Pocket offers four voice modes; this gateway serves two of them:

| Mode | Where the audio goes |
|---|---|
| Pocket cloud | phone → the official gateway (this code, run by Pocket) → Volcano Engine. Not end-to-end encrypted. |
| My computer | phone → (end-to-end encrypted) → your computer, recognised there by the same local engines this repo uses (`src/engines/local.mjs`). |
| **My own gateway** | phone → **your** pocket-asr → the engine you configured. |
| On this phone | stays on the phone (iOS / Android on-device recognition). |

## Quick start

```sh
node src/cli.mjs token "my phone"            # prints a token (once) and the config entry with its SHA-256
cp asr.example.json asr.json                  # edit: paste the sha256, pick engines
node src/cli.mjs install-engine sherpa-onnx ./sherpa              # local engine for this platform (verified download)
node src/cli.mjs install-model sense-voice-int8 ./models/sense-voice-int8
node src/cli.mjs check asr.json               # validates everything, prints what /v1/info will say
node src/server.mjs --config asr.json
```

Then in the Pocket App: **Settings → Voice → My own gateway**, enter the HTTPS URL and the token, tap **Test**.
Put TLS in front (Caddy, nginx, a load balancer) or set `"tls": {"cert", "key"}` in the config — the App only talks
HTTPS.

Docker:

```sh
docker build --target local -t pocket-asr:local .     # or --target slim for cloud engines only
docker run -d -p 8080:8080 -v $PWD/asr.json:/config/asr.json:ro -v asr-data:/data -v asr-models:/models pocket-asr:local
```

With `"install": {"model": "sense-voice-int8"}` on a local engine, the model is downloaded and verified on first start.

## HTTP API

`GET /v1/info` (public)

```json
{ "service": "pocket-asr", "version": "1.0.0", "gatewayId": "my-asr",
  "engines": [ { "id": "local", "kind": "local", "langs": ["zh", "en", "auto"], "maxSeconds": 240, "default": true, "defaultFor": ["zh", "en", "auto"] } ],
  "auth": ["token"], "limits": { "maxBytes": 8388608, "maxSeconds": 240 } }
```

`POST /v1/recognize?lang=zh|en|auto&engine=<id>` — body: a WAV file (PCM, 16 kHz, mono, 16-bit), `Content-Type: audio/wav`.

```json
200 { "ok": true, "text": "把 README 翻译成英文", "lang": "zh", "engine": "local", "seconds": 3.2, "ms": 910 }
4xx/5xx { "ok": false, "code": "…", "message": "…" }
```

| code | HTTP | meaning |
|---|---|---|
| `bad-audio` | 400 | not a 16 kHz mono 16-bit PCM WAV |
| `too-large` | 413 | body over `limits.maxBytes` |
| `too-long` | 413 | audio longer than the gateway's or the engine's limit (never silently cut) |
| `empty` | 422 | nothing was said (silence, under 0.1 s, or the engine heard nothing) |
| `unauthorized` | 401 | missing or invalid token / ticket / proof |
| `rate` | 429 | this caller is over its per-minute or at-once limit (`Retry-After`) |
| `busy` | 503 | the gateway (or the provider) is at capacity (`Retry-After`) |
| `no-engine` | 400 | no engine for this language (or the named engine doesn't do it) |
| `engine-error` | 502 | the engine failed (details only in the operator's log) |
| `engine-timeout` | 504 | no answer within 30 s + the audio length |

`POST /v1/revocations` — a revocation document signed by Pocket's coordination keys (ticket auth only).
`GET /healthz` — `{"ok": true}`.

## Authentication

* **Tokens** — `Authorization: Bearer <token>`. The config holds only the SHA-256 of each token and a label (the label
  appears in logs). `node src/cli.mjs token` makes one.
* **Pocket tickets** — `Authorization: PocketTicket <ticket>` plus `X-Pocket-Proof: <b64u(a)>.<b64u(s)>`. Tickets are
  short-lived, signed by Pocket's coordination keys for `aud = asr:<gatewayId>`, and checked offline with the pinned
  public keys (the key set is refreshed from `<coordUrl>/.well-known/pocket/keys.json` and adopted only when signed by
  a key already trusted). The proof is signed by the device's own key and binds the exact request body (SHA-256), a
  timestamp (±5 minutes) and a one-time nonce (remembered 10 minutes), so a captured request can't be replayed or
  reused for other audio. `accounts` limits which Pocket accounts may use the gateway. Tickets of a device that was
  logged out or removed are cut off by signed revocation documents (pushed to `/v1/revocations`, and polled from the
  coordination server for the accounts listed in `accounts`). Protocol: `protocol/E2EE.md` §12–13 and
  `protocol/ASR.md` §3.

## Engines

Cloud engines use **your** account and keys. Values like `"env:NAME"` are read from the environment and
`"file:/path"` from a file, so secrets never sit in the config; `"secretsFile": "/path.json"` merges a JSON credentials
file into an engine.

| `type` | Service | Settings | Languages | Limit |
|---|---|---|---|---|
| `volcano` | Volcano Engine (火山引擎) big-model ASR, WebSocket `bigmodel_nostream` | `appId`, `accessToken`, `resourceId`?, `hotWords`?, `url`? | zh, en, auto | 240 s |
| `alibaba` | Alibaba Cloud (阿里云) one-sentence recognition | `accessKeyId`, `accessKeySecret`, `appkey` or `appkeys: {zh, en}`, `region`? (`cn-shanghai`) | per appkey | 60 s |
| `tencent` | Tencent Cloud (腾讯云) SentenceRecognition, TC3 signature | `secretId`, `secretKey`, `region`?, `engines`? (`{zh: "16k_zh", en: "16k_en", auto: "16k_zh-PY"}`) | zh, en, auto | 60 s |
| `iflytek` | iFlytek (讯飞) voice dictation WebAPI v2 | `appId`, `apiKey`, `apiSecret`, `languages`? | zh, en | 60 s |
| `openai` | OpenAI (or compatible) `/audio/transcriptions` | `apiKey`, `model`? (`gpt-4o-transcribe`), `baseUrl`? (`https://api.openai.com/v1`) | zh, en, auto | 600 s |
| `deepgram` | Deepgram pre-recorded `/v1/listen` | `apiKey`, `models`? (`nova-3`) | zh, en, auto | 600 s |
| `azure` | Azure AI Speech, REST for short audio | `key`, `region` or `endpoint`, `languages`? | zh, en | 60 s |
| `sherpa-onnx` | local: `sherpa-onnx-offline` with SenseVoice or Paraformer | `bin`, `model` (directory), `threads`? | SenseVoice zh/en/auto, Paraformer zh | 240 s |
| `whisper.cpp` | local: `whisper-cli` | `bin`, `model` (ggml file), `threads`? | zh, en, auto | 240 s |
| `vosk` | local: `vosk-transcriber` or `scripts/vosk-wav.py` | `bin`, `model` (directory), `langs` | as the model | 240 s |

Every engine also takes `maxSeconds` (lower than its limit). `"default": {"zh": "<id>", "en": "<id>", "auto": "<id>"}`
picks the engine when a request names none; otherwise the first engine that speaks the language answers.

**Local engines** run as an external program per request (an argument array, never a shell); the audio is written to
a private temporary directory (0700) that is deleted before the response, and the program is killed on timeout or
when the client goes away. `models.json` lists the programs and models this gateway can install, each with its size
and SHA-256:

| model | engine | size | |
|---|---|---|---|
| `sense-voice-int8` | sherpa-onnx | 158 MB | recommended: best Chinese per CPU second, also English |
| `paraformer-zh-small` | sherpa-onnx | 74 MB | Mandarin only, no punctuation |
| `whisper-base-q5_1`, `whisper-base`, `whisper-small` | whisper.cpp | 57 / 141 / 465 MB | multilingual |
| `vosk-small-cn`, `vosk-small-en-us` | vosk | 42 / 39 MB | smallest, least accurate |

Behind a proxy, run the install commands with `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=…` (Node 22's built-in proxy support).

## Configuration

See `asr.example.json`. Top-level keys: `gatewayId` (ticket audience `asr:<gatewayId>`), `listen {host, port}`,
`tls` (`null` or `{cert, key}`), `basePath` (optional prefix such as `/asr`), `dataDir` (keeps adopted keys and
revocations across restarts), `auth {tokens, ticket}`, `engines`, `default`, and `limits`:

| limit | default | |
|---|---|---|
| `maxBytes` | 8388608 | request body |
| `maxSeconds` | 240 | audio length |
| `perMinute` | 12 | recognitions per caller per minute |
| `concurrentPerCaller` | 2 | requests of one caller at once |
| `concurrent` | 8 | engine calls at once |
| `uploads` | 16 | request bodies being received at once |
| `silencePeak` | 64 | recordings quieter than this everywhere are answered `empty` without calling an engine (0 = off) |

## Privacy

* Audio and text exist only in memory for one request; local engines use one temporary file deleted before the answer.
* One log line per request: time, gateway id, caller (token label or account id), engine, audio seconds, number of
  characters, latency, result code (+ an internal reason or a provider's request id on errors). **Never** audio, text,
  tokens, tickets or proofs; provider error messages are not logged (some echo key fragments).
* No analytics; no network calls other than the configured engine, the model download you ask for, and (ticket auth
  only) the coordination server's public keys and revocation feed.
* Cloud providers receive the audio; the provider is named in the App's voice settings.

## Development

```sh
npm test            # node --test: protocol vectors, WAV rules, auth, limits, every adapter against a local fake of
                    # its provider, local engines with fake programs, model downloads
```

`scripts/dev-server.mjs` runs the gateway with an extra `lab-echo` engine (no keys, no model) for client testing.

## License

AGPL-3.0-only — see `LICENSE`. If you run a modified version as a network service, you must offer its source to
its users.

Exception: `src/engines/local.mjs` alone is MIT (`LICENSE-MIT`), because the Pocket desktop app embeds it to run local
recognition on your own computer. Contributions to that file are accepted under MIT.

---

## 中文说明

pocket-asr 是 Pocket 的语音识别网关:手机把录音发过来,它交给你选的识别引擎,只回文字;**不保存录音,日志里没有识别出的字**。
Node.js 22 以上,不依赖任何 npm 包,AGPL-3.0 许可;只有 `src/engines/local.mjs` 一个文件是 MIT(`LICENSE-MIT`)——Pocket 电脑端原样内嵌它在你自己的电脑上做本机识别。

**自建步骤**

1. `node src/cli.mjs token "我的手机"`:生成一个令牌(只显示一次)和配置里要填的 SHA-256。
2. 复制 `asr.example.json` 为 `asr.json`,填上 SHA-256,选引擎:
   - 本机模型(推荐,不花钱、录音不出你的机器):`node src/cli.mjs install-engine sherpa-onnx ./sherpa` +
     `node src/cli.mjs install-model sense-voice-int8 ./models/sense-voice-int8`(中英文都行,158 MB);
   - 或者云端:火山引擎、阿里云、腾讯云、讯飞、OpenAI、Deepgram、Azure,用你自己的账号和 Key
     (配置里写 `"env:变量名"`,Key 不进文件)。
3. `node src/cli.mjs check asr.json` 检查配置,`node src/server.mjs --config asr.json` 启动;前面套一层 HTTPS(Caddy / nginx),
   或者在配置里写 `tls`。也可以用 Docker:`docker build --target local -t pocket-asr:local .`。
4. 手机 Pocket App:**设置 → 语音 → 自建语音网关**,填 HTTPS 地址和令牌,点「测试」。

**安全**:令牌在配置里只存哈希;也可以改用 Pocket 账号的票据(`auth.ticket`,`accounts` 写你自己的账号 ID),票据由 Pocket
协调服务器签发、网关离线校验,每次请求的签名绑定这段录音、时间和一次性随机数,抓到请求也没法重放或换录音。
每个调用方每分钟、同时的请求数都有上限。

**隐私**:录音和文字只在这一次请求的内存里;本机引擎用的临时文件在回答之前删掉;日志只有时间、调用方、引擎、秒数、
字数、耗时和结果码。选云端引擎时,录音会交给那家服务商。

**在国内下载模型**:GitHub 连不上时,官方会把模型镜像到 `https://pocket.pocketcli.net/dl/asr/`(安装命令先试镜像);
走代理时给那一条命令加 `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=…`。
