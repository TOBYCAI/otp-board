# OTP Board · 验证码转发与看板

> 中文 | [English](./README.en.md)

![GitHub stars](https://img.shields.io/github/stars/TOBYCAI/otp-board?style=flat-square&color=facc15)
![Downloads](https://img.shields.io/github/downloads/TOBYCAI/otp-board/total?style=flat-square&color=14b8a6)
![Downloads@latest](https://img.shields.io/github/downloads/TOBYCAI/otp-board/latest/total?style=flat-square&color=14b8a6)
![License](https://img.shields.io/badge/license-MIT-3b82f6?style=flat-square)
![CI](https://img.shields.io/github/actions/workflow/status/TOBYCAI/otp-board/ci.yml?branch=main&label=ci&style=flat-square)
![type](https://img.shields.io/badge/type-android--node-4d6bfe?style=flat-square)

一款开源的**验证码（OTP）自动转发 + 网页看板**项目。Android 客户端在本地监听短信、
系统通知（微信 / WhatsApp / 邮件等），提取验证码后通过 HTTPS 推送到自建的 Node.js 看板，
在浏览器中集中查看、管理与导出。

> 所有数据仅发送至**你自己配置的服务器**，不依赖任何第三方云服务。

---

## 特性

- 📨 **多来源接入**：短信（SMS/RCS）、WhatsApp、微信、Telegram、邮件等通知。
- 🧠 **智能提取**：Kotlin 与 JavaScript 双端口共享同一套提取规则，准确率高。
- 🔁 **持久投递**：基于 `JobScheduler` 的可靠转发，网络异常自动重试。
- 🛡 **去重**：同一验证码 2 分钟窗口内只转发一次（跨进程 / 重启仍生效）。
- 🖥 **双看板**：网页看板按「短信 / IM」与「邮件」分栏展示，支持删除、清空、CSV 导出。
- 🔐 **鉴权与限流**：摄取接口可选 token；管理接口可选 admin token；按 IP 限流（429）。
- 🧹 **自动清理**：每日 23:59 清理超过保留期的历史验证码。
- ⚙️ **零依赖服务端**：仅用 Node.js 内置模块，无需 `npm install` 任何第三方包。

---

## 仓库结构

```
otp-board/
├── shared/            # 跨端 / 跨语言共用契约与核心（提取规则、负载 schema、JS 核心）
├── android/           # Gradle 多模块：:otp-core 复用库 + :app 薄壳 UI
├── server/            # 零依赖 Node.js 看板服务 + 部署示例（Nginx/systemd/Caddy）
├── docs/              # requirements.md（硬件设备清单）、ARCHITECTURE.md（架构说明）
├── scripts/           # validate-contract.js（CI 校验契约一致性）
└── .github/workflows/ # CI：核心单元测试 + 契约校验
```

详细的代码梳理与“通用化”说明见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

---

## 前期硬件设备与配置要求

搭建与运行本项目涉及**开发机（编译 App）**与**服务端主机（运行看板）**两类环境。
完整清单（CPU / 内存 / 磁盘 / SDK / 真机要求 / 网络与 TLS）见
[`docs/requirements.md`](docs/requirements.md)。

要点速览：

| 环境 | 关键要求 |
| --- | --- |
| 开发机 | JDK 17、Android Studio、SDK Platform 35、开启虚拟化的 ≥16 GB 内存 |
| 真机 | Android 10（API 29）及以上，开启 USB 调试 + 短信 / 通知权限 |
| 服务端 | 任意可联网主机、Node.js **≥ 18**、1 vCPU / 1 GB 即可 |
| 网络 | 服务端暴露 **HTTPS**（域名 + Let's Encrypt，或局域网内 HTTPS） |

---

## 快速开始

### 1. 服务端

```bash
cd server
cp .env.example .env        # 按需设置 INGEST_TOKEN / ADMIN_TOKEN / PORT
node server.js              # 或：npm run dev（热重载）/ pm2 start server.js
```

看板地址：`http://<host>:3000/`（生产环境建议用 Nginx/Caddy 做 TLS 反代，见 `server/deploy/`）。

### 2. Android 客户端

```bash
cd android
./gradlew :app:assembleDebug     # 生成 app-debug.apk
./gradlew :app:installDebug      # 安装到已连接设备
```

- 在 App 中授权短信读取、通知读取权限。
- 通过「扫码配置」扫描服务端二维码，或手动填入 HTTPS 服务器地址（可选 token）。
- 收到验证码后，App 会自动提取并推送到看板。

---

## 数据流

```
短信/通知 → SmsReceiver / NotificationListener
        → OtpExtractor.process()        [shared 提取规则]
        → OtpDeliveryDeduplicator       [去重]
        → OtpForwarder → ForwardJobService（JobScheduler 持久重试）
        → HTTPS POST /otp
        → server.js 分类(短信/邮件) → 持久化 → 看板 / API
```

---

## 许可证

[MIT](LICENSE) © OTP Board contributors
