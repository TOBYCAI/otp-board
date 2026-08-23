# 环境搭建与硬件设备清单（Requirements）

本文说明从零搭建、构建并运行本项目所需的**前期硬件设备**与**软件配置要求**。
项目由两部分组成：Android 客户端（验证码转发 App）与 Node.js 服务端（验证码看板）。
两部分可独立准备，但要让手机把验证码送达看板，两者都需要联网可达。

---

## 一、Android 客户端构建环境（开发机）

用于编译、调试 `android/` 下的 App。

| 项目 | 最低要求 | 推荐配置 | 说明 |
| --- | --- | --- | --- |
| 操作系统 | Windows 10 / macOS 12 / Ubuntu 20.04 | macOS 14+ 或 Windows 11 | 支持 Android Studio |
| CPU | x86_64（Intel/AMD）<br>Apple Silicon（arm64）亦可 | 4 核及以上 | 运行模拟器需 **开启硬件虚拟化**（Intel VT-x / AMD-V） |
| 内存 | 8 GB | **16 GB 及以上** | 模拟器 + IDE + Gradle 同开时占用较大 |
| 磁盘 | 30 GB 可用空间 | 50 GB 以上 SSD | Android SDK ≈ 10 GB，Gradle 缓存、AVD 镜像另计 |
| JDK | JDK 17 | JDK 17（LTS） | AGP 8.x 要求 JDK 17 |
| Android Studio | 最新稳定版（Hedgehog 及以上） | 同上 | 提供 SDK Manager / AVD |
| Gradle | 由仓库内置 wrapper 提供（8.11.1） | 无需单独安装 | 使用 `./gradlew` |

**必须安装的 Android SDK 组件：**
- Android SDK Platform **35**（Android 15，对应 `compileSdk`/`targetSdk`）
- Android SDK Build-Tools（最新 35.x）
- Android SDK Platform-Tools（adb）
- Android Emulator（可选，仅用于无真机时的 UI 调试）

**真机（强烈建议用于功能验证）：**
| 设备 | 要求 | 用途 |
| --- | --- | --- |
| Android 手机 / 平板 | **Android 10（API 29）及以上** | 接收短信、通知侦听、转发验证码 |
| USB 数据线 | 支持数据传输 | 连接电脑开启 USB 调试 |
| SIM 卡（可选） | 可接收短信 | 验证短信验证码路径 |
| 第二台手机或桌面客户端 | 安装微信 / WhatsApp 等 | 验证 IM / 邮件验证码路径 |

> ⚠️ 模拟器**无法接收真实短信 / RCS / 微信 / WhatsApp 消息**，因此短信与通知侦听路径必须在真机上验证。

**真机设置步骤：**
1. 设置 → 关于手机 → 连续点击「版本号」启用开发者选项。
2. 开发者选项 → 开启「USB 调试」「USB 安装」。
3. 连接电脑，`adb devices` 能看到设备即成功。
4. 应用内按提示授予：短信读取权限、通知读取权限（系统设置中开启「OTP」的通知使用权）。
5. **关闭电池优化 / 设为「不受限制」（实测必须）**：不关的话，锁屏或后台一段时间后被系统杀掉，验证码收不到、转发中断。
   路径：`设置 → 应用 → OTP Board → 电池 → 不受限制`（厂商叫法不同：小米「省电策略=无限制」、华为「启动管理=手动管理+允许后台」、三星「深度休眠=排除」）。

---

## 二、服务端运行环境（看板主机）

用于运行 `server/` 下的 Node.js 验证码看板。

| 项目 | 最低要求 | 推荐配置 | 说明 |
| --- | --- | --- | --- |
| 主机 | 任意可联网机器 / VPS / 树莓派 4 | 1 vCPU / 1 GB RAM 云主机 | 仅做轻量 JSON 存储，负载极低 |
| 磁盘 | 5 GB | 10 GB | 消息以 JSON 文件持久化 |
| 操作系统 | 任意支持 Node.js 的系统 | Ubuntu 22.04 / 24.04 LTS | 文档示例基于 Ubuntu |
| Node.js | **>= 18** | 20 LTS | 服务端零依赖，仅需 Node 运行时 |
| 公网 | 一个域名 + 公网 IP（手机跨网络访问时） | 同上 | 本地局域网测试可省略 |
| TLS 证书 | Let's Encrypt（免费） | 同上 | 客户端仅允许 HTTPS，需有效证书 |
| 反向代理 | Nginx 或 Caddy | 二选一 | 负责 TLS 终止与转发到 :3000 |

**如果只在家庭 / 局域网内使用：**
- 可省略公网域名与 TLS，但客户端要求 HTTPS，因此仍需自签名证书或局域网内 HTTPS 反向代理。
- 手机与服务器需在同一网络，或修改 App 的服务器地址为局域网 IP（仍须 https）。

---

## 三、联调所需的最小清单（Checklist）

- [ ] 开发机：JDK 17 + Android Studio + SDK Platform 35 + 开启虚拟化的 16 GB 内存
- [ ] 真机：Android 10+，已开启 USB 调试并授予短信 / 通知权限
- [ ] 真机：**已关闭电池优化（设为不受限制）**，避免锁屏 / 后台被杀导致转发中断
- [ ] 服务端：一台装好 Node.js ≥ 18 的主机（1 vCPU / 1 GB 即可）
- [ ] 网络：服务端暴露 HTTPS（域名 + Let's Encrypt，或局域网内 HTTPS）
- [ ] 在 App 中填入服务端地址（可用 App 的「扫码配置」直接扫服务端二维码）

---

## 四、构建与运行命令速查

```bash
# —— 客户端（android/）——
./gradlew :app:assembleDebug        # 生成调试 APK
./gradlew :app:installDebug         # 安装到已连接设备

# —— 服务端（server/）——
node server.js                      # 直接运行（读 .env）
npm run dev                         # 热重载
# 或 PM2： pm2 start server.js --name otp-board
```

详见根目录 `README.md` 与各模块内说明。
