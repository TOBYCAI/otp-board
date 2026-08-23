# OTP Board · OTP Forwarder & Dashboard

> English | [中文](./README.md)

![GitHub stars](https://img.shields.io/github/stars/TOBYCAI/otp-board?style=flat-square&color=facc15)
![Downloads](https://img.shields.io/github/downloads/TOBYCAI/otp-board/total?style=flat-square&color=14b8a6)
![Downloads@latest](https://img.shields.io/github/downloads/TOBYCAI/otp-board/latest/total?style=flat-square&color=14b8a6)
![License](https://img.shields.io/badge/license-MIT-3b82f6?style=flat-square)
![CI](https://img.shields.io/github/actions/workflow/status/TOBYCAI/otp-board/ci.yml?branch=main&label=ci&style=flat-square)
![type](https://img.shields.io/badge/type-android--node-4d6bfe?style=flat-square)

An open-source **one-time-passcode (OTP) auto-forwarding + web dashboard** project.
The Android client listens locally for SMS and system notifications (WeChat, WhatsApp,
email, …), extracts the code, and pushes it over HTTPS to your self-hosted Node.js
dashboard for centralized viewing, management, and export.

> All data is sent only to **the server you configure** — no third-party cloud required.

---

## Features

- 📨 **Multi-source ingestion**: SMS/RCS, WhatsApp, WeChat, Telegram, email notifications.
- 🧠 **Smart extraction**: Kotlin and JavaScript share one extraction rule set, port-for-port.
- 🔁 **Durable delivery**: `JobScheduler`-based forwarding with automatic retries.
- 🛡 **De-duplication**: a code is forwarded at most once per 2-minute window (survives restart).
- 🖥 **Two boards**: dashboard splits into "SMS / IM" and "Email", with delete / clear / CSV export.
- 🔐 **Auth & rate limit**: optional ingest token, optional admin token, per-IP throttling (429).
- 🧹 **Auto cleanup**: codes older than the retention window are pruned daily at 23:59.
- ⚙️ **Zero-dependency server**: only Node.js built-ins — no third-party `npm install` needed.

---

## Repository layout

```
otp-board/
├── shared/            # Cross-platform / cross-language contract & core (rules, schema, JS core)
├── android/           # Gradle multi-module: :otp-core reusable lib + :app thin UI
├── server/            # Zero-dep Node.js dashboard + deploy examples (Nginx/systemd/Caddy)
├── docs/              # requirements.md (hardware list), ARCHITECTURE.md
├── scripts/           # validate-contract.js (CI contract check)
└── .github/workflows/ # CI: core unit tests + contract validation
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the refactor rationale.

---

## Hardware & setup requirements

Bringing this project up involves two environments: a **dev machine** (build the app) and a
**server host** (run the dashboard). The full checklist (CPU / RAM / disk / SDK / physical
device / network & TLS) is in [`docs/requirements.md`](docs/requirements.md).

Quick summary:

| Environment | Key requirement |
| --- | --- |
| Dev machine | JDK 17, Android Studio, SDK Platform 35, ≥16 GB RAM w/ virtualization |
| Physical device | Android 10 (API 29)+, USB debugging + SMS / notification permission |
| Server | Any internet-reachable host, Node.js **≥ 18**, 1 vCPU / 1 GB is enough |
| Network | Server exposed over **HTTPS** (domain + Let's Encrypt, or LAN HTTPS) |

---

## Quick start

Two kinds of users, pick one path — **no fork, no build required**.

### Option A: Server one-click install (recommended, zero-config)

```bash
curl -fsSL https://raw.githubusercontent.com/TOBYCAI/otp-board/main/server/install.sh | bash
```

- The script is **self-contained**: `server.js`, `shared/js/otp-core.js` and `package.json` are embedded in it — no runtime GitHub fetch, no network dependency. Just download this one file and run.
- It will: check Node.js ≥ 18 → generate random `INGEST_TOKEN` / `ADMIN_TOKEN` into `.env` → start the service via pm2 (or nohup fallback). Pass a directory as the first argument (`bash install.sh /opt/otp-board`).
- Dashboard: `http://<host>:3000/` (use Nginx/Caddy for TLS in production, see `server/deploy/`).

### Option B: Download the Release source zip (audit / hack on it)

1. Go to [Releases](https://github.com/TOBYCAI/otp-board/releases) and download `Source code (zip)`.
2. Extract, then run the server directly:

   ```bash
   cd otp-board-server/server
   cp .env.example .env        # adjust port / tokens
   node server.js              # or: pm2 start server.js
   ```

No `curl | bash`, everything is local — easy to audit or modify. The server has **zero third-party dependencies**, no `npm install` needed.

### Option C: Android client (just install the APK)

No Android Studio, no build: go to [Releases](https://github.com/TOBYCAI/otp-board/releases) and download **`app-release.apk`** (attached automatically to every release), transfer it to your phone and install.

> The APK is built automatically by GitHub Actions on each tag (see `.github/workflows/build-apk.yml`), signed with the debug key — installs and runs fine on real devices (not a Play-Store distributable). For your own signing, clone and run `./gradlew :app:assembleRelease`.

After install:

- Grant SMS-read and notification-listener permissions (for WeChat / WhatsApp / email, etc.).
- Scan the server QR code ("扫码配置") or paste the HTTPS URL (optional token).
- Incoming codes are extracted and pushed to the dashboard automatically.

---

### Want to build from source?

```bash
# Server
cd server && cp .env.example .env && node server.js

# Android (needs JDK 17 + Android SDK 35)
cd android
./gradlew :app:assembleDebug      # output: app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:assembleRelease    # output: app/build/outputs/apk/release/app-release.apk
```

---

## Data flow

```
SMS/notification → SmsReceiver / NotificationListener
        → OtpExtractor.process()        [shared rules]
        → OtpDeliveryDeduplicator       [de-dup]
        → OtpForwarder → ForwardJobService (JobScheduler retries)
        → HTTPS POST /otp
        → server.js classify(SMS/Email) → persist → dashboard / API
```

---

## License

[MIT](LICENSE) © OTP Board contributors
