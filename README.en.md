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

### 1. Server

```bash
cd server
cp .env.example .env        # set INGEST_TOKEN / ADMIN_TOKEN / PORT as needed
node server.js              # or: npm run dev / pm2 start server.js
```

Dashboard: `http://<host>:3000/` (use Nginx/Caddy for TLS in production, see `server/deploy/`).

### 2. Android client

```bash
cd android
./gradlew :app:assembleDebug     # build app-debug.apk
./gradlew :app:installDebug      # install to a connected device
```

- Grant SMS-read and notification-listener permissions in the app.
- Scan the server QR code ("扫码配置") or paste the HTTPS server URL (optional token).
- Incoming codes are extracted and pushed to the dashboard automatically.

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
