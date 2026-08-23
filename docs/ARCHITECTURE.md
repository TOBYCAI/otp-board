# 架构说明（Architecture）

## 1. 原始项目结构

原始 `OTP/` 仓库包含三套并行演进的客户端版本与多版服务端脚本：

```
OTP/
├── Android/
│   ├── v1/  单 BroadcastReceiver，内联 OtpExtractor + 手写 JSON
│   ├── v2/  抽出 OtpExtractor / ServerConfig，但逻辑仍内联在 App 内
│   └── v3/  重构为 OtpForwarder + ForwardJobService + OtpDeliveryDeduplicator
│             —— 提取、去重、投递职责清晰分离（本次重构的蓝本）
└── Server/
    ├── v1/  约 570 行，单文件 Node 看板
    ├── v2/  增加 token、邮件
    └── v3/  膨胀到 1600+ 行（内嵌 server.js + 反代 / SSL / systemd 部署）
```

**重复与可复用点（提取依据）：**
- `OtpExtractor` 在 v1/v2/v3 中实际是**字节级相同**的提取逻辑。
- `ServerConfig`（服务器地址 / token / 已保存列表）三版一致。
- JSON 负载构造、`supportedPackages` 通知来源表、去重逻辑在多处重复。
- 服务端三版逻辑相同，只是被部署代码包裹得越来越臃肿。

---

## 2. 重构后的结构

```
otp-board/
├── shared/                 # 跨语言 / 跨端共用契约与核心逻辑（本次“通用化”的核心）
│   ├── proto/
│   │   └── otp-payload.schema.json   # 客户端↔服务端负载契约（单一事实来源）
│   ├── otp-rules.json                 # 白名单 / 黑名单 / 运营商 / 品牌等“数据化”规则
│   └── js/
│       ├── otp-core.js                # OtpExtractor 的忠实 JS 移植（服务端复用）
│       └── otp-core.test.js           # 与 Kotlin 端口行为对齐的单元测试
│
├── android/                # 拆分后的 Android 工程（Gradle 多模块）
│   ├── otp-core/           # 复用库模块（com.example.otpforward.core）
│   │   └── OtpExtractor / OtpPayload / OtpDeliveryDeduplicator
│   │       / ServerConfig / OtpForwarder / ForwardJobService
│   └── app/                # 薄壳：UI 与平台接入（com.example.otpforward）
│       └── OTPApplication / MainActivity / SmsReceiver
│           / NotificationListener / ScanActivity
│           / NotificationContentSelector / AmbientGlowView
│
├── server/                 # 合并、精简后的 Node.js 服务端（零依赖）
│   ├── server.js           # 摄取 + 双看板（短信/IM 与邮件）+ 管理 API
│   ├── package.json
│   ├── .env.example
│   └── deploy/             # Nginx / systemd / Caddy 示例与部署脚本
│
├── docs/                   # requirements.md（硬件清单）、本文件
├── scripts/
│   └── validate-contract.js# CI 中校验 schema / rules / 核心端口一致性
└── .github/workflows/ci.yml
```

---

## 3. “通用化”做了什么

1. **提取共用核心逻辑到 `:otp-core` 库模块**
   - 原先散落在 v1/v2/v3 的 `OtpExtractor`、`ServerConfig`、去重、投递，统一收口到
     `com.example.otpforward.core`，App 仅做 UI 与平台接入。
   - `ForwardJobService` 的投递逻辑也移入 core，App 的 Manifest 通过全限定名引用。

2. **跨语言共用同一套提取规则（shared/）**
   - `shared/js/otp-core.js` 是 Android `OtpExtractor` 的**忠实 JS 移植**，
     服务端可据此对原始 `content` 做服务器端提取，规则两端一致。
   - `shared/proto/otp-payload.schema.json` 定义了唯一负载契约，
     `OtpPayload` 类型与 `server.js` 摄取逻辑都遵循它。
   - `shared/otp-rules.json` 把原先硬编码在代码里的白/黑名单、运营商表外置为数据，
     便于在不改代码的情况下调整提取策略。

3. **服务端合并精简**
   - v3 的 1600+ 行（含部署）收敛为单文件、零依赖的 `server.js`，
     部署相关（反代 / SSL / systemd）拆到 `deploy/` 示例文件，职责分离。
   - 保留全部关键能力：token 鉴权、短信/邮件双看板、管理面板、删除/清空/CSV 导出、
     每日 23:59 自动清理、按 IP 限流（429）。

---

## 4. 数据流

```
短信/通知 → SmsReceiver / NotificationListener
        ↓  OtpExtractor.process(content, hint)        [otp-core]
   Map{otp, platform, time}
        ↓  OtpDeliveryDeduplicator.claim()            [去重，2 分钟窗口]
   OtpForwarder.enqueue(source, ...)                 [otp-core]
        ↓  ForwardJobService（JobScheduler，持久重试）
   HTTPS POST /otp  {otp, source, platform, time, token?}
        ↓  server.js  → 分类(SMS/Email)  →  持久化(JSON)
   看板 (/) 或 API (/api/messages, /api/export.csv, /api/clear)
```

> 关键点：提取器**不感知来源渠道**（不写死 `source`），`source` 由调用方（短信广播 / 通知侦听）
> 决定。这正是它能复用于任意摄取路径、并能跨语言（Kotlin / JS）保持一致的原因。
