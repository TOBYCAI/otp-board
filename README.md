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

本项目分两部分，**服务端（Server）** 与 **安卓客户端（Android）** 各自独立安装、互不影响：

- 想搭建看板 / 转发接收端 → 看下面 **服务端** 部分。
- 想在手机上收验证码并转发 → 看下面 **安卓客户端** 部分。

---

### 服务端（Server）

**方式一：一键安装（推荐，零配置）**

在要跑服务端的机器上执行一行命令，自动装好并启动看板：

```bash
curl -fsSL https://raw.githubusercontent.com/TOBYCAI/otp-board/main/server/install.sh | bash
```

- 脚本**自包含**：`server.js`、`shared/js/otp-core.js`、`package.json` 全部内嵌其中，运行时不依赖 GitHub、不联网拉取任何东西，下载这一个文件就能跑。
- **交互式向导**：在终端里直接运行 `bash install.sh` 时，会逐项询问安装目录、HTTP 端口、推送 Token、管理 Token、验证码保留天数、限流与开机自启方式，最后打印配置让你确认（y/n）后再安装——还原了原版 `otp31.sh` 的引导式体验。
- **非终端自动跳过**：通过 `curl | bash` 管道运行时无交互，自动采用默认值并随机生成 `INGEST_TOKEN` / `ADMIN_TOKEN`，仍可一键无人值守部署。
- 可选第一个参数指定目录：`bash install.sh /opt/otp-board`（默认装到 `~/otp-board-server`）。
- 看板启动后访问 `http://<host>:3000/`（生产建议用 Nginx/Caddy 做 HTTPS 反代，见 `server/deploy/`）。

**方式二：下载 Release 源码包自己跑（适合审计 / 改代码）**

1. 打开 [Releases](https://github.com/TOBYCAI/otp-board/releases) 页面，下载 `Source code (zip)`。
2. 解压后进入其中的 `server/` 目录，直接运行：

   ```bash
   cd otp-board/server
   cp .env.example .env        # 按需修改端口 / token
   node server.js              # 或：pm2 start server.js
   ```

这种方式不需要 `curl | bash`，所有文件都在本地，方便审计与二次开发。服务端**零第三方依赖**，无需 `npm install`。

---

### 安卓客户端（Android）

不用装 Android Studio、不用编译——去 [Releases](https://github.com/TOBYCAI/otp-board/releases) 页面下载 **`app-release.apk`**（每个版本都会自动构建并附在 Release 里），传到手机安装即可。

> APK 由 GitHub Actions 在打 tag 时自动构建（见 `.github/workflows/build-apk.yml`），使用 Debug 签名，可正常安装到真机使用（非 Play 商店分发版）。如需自有签名，克隆仓库后自行 `./gradlew :app:assembleRelease` 即可。

**安卓源码也随仓库一并开源**：完整 `android/` 工程（Kotlin + Gradle）就在仓库里，可以自行修改、重新构建。克隆仓库后改代码再编译：

```bash
cd android
./gradlew :app:assembleDebug      # 调试版：app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:assembleRelease    # 发布版：app/build/outputs/apk/release/app-release.apk
```

（本地编译需要 JDK 17 + Android SDK 35；不想装环境的话直接用上面的 Release APK 即可。）

安装后：

- 授权短信读取、通知读取（监听微信 / WhatsApp / 邮件等通知）。
- **关闭电池优化（设为「不受限制 / 允许后台）**：这是实测必须的一步——不关的话，锁屏或后台一段时间后会
  被系统杀掉，导致验证码收不到、转发中断。路径一般在
  `设置 → 应用 → OTP Board → 电池 → 不受限制`（各厂商叫法不同，如小米「省电策略=无限制」、
  华为「启动管理=手动管理并允许后台」、三星「深度休眠=排除」）。
- 「扫码配置」扫描服务端二维码，或手动填 HTTPS 地址（可选 token）。
- 收到验证码，App 自动提取并推送到看板。

---

### 只想自己从源码构建？

```bash
# 服务端
cd server && cp .env.example .env && node server.js

# 安卓（需 JDK 17 + Android SDK 35）
cd android
./gradlew :app:assembleDebug      # 产物：app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:assembleRelease    # 产物：app/build/outputs/apk/release/app-release.apk
```

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

[MIT](LICENSE) © TOBYCAI
