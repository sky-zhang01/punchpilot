# PunchPilot

[freee HR](https://www.freee.co.jp/hr/) 智能考勤自动化工具。以 Docker 容器方式自部署，自带 Web 管理面板。

[**English**](README.md) | [**日本語**](README.ja.md)

## 功能特性

- **自动打卡** — 按设定时间自动出退勤，自动跳过周末和节假日（日本/中国）
- **手动触发** — 在面板上一键执行签到、签退、开始休息、结束休息
- **多次休息支持** — 支持每日不限次数的休息周期；面板和日历动态显示每次休息的起止时间
- **实时打卡状态** — 面板展示 freee 的真实打卡时间，进度条实时追踪
- **批量补卡** — 一键补录缺勤日的考勤记录
- **休假申请** — 提交、跟踪、取消有休、特别休假、加班和缺勤申请
- **批量操作** — 批量休假申请、批量取消、批量审批/驳回
- **3 路安全回退策略**：直接 API > 审批申请 > 经确认的网页表单（Playwright）
- **月度策略缓存** — 自动跳过已知失败的方式，每月初重新检测
- **OAuth 授权保护** — 授权过期或被撤销时暂停自动打卡并提示重新授权，避免静默漏打
- **已承认休假保护** — 每次计划打卡前重新确认 freee；优先使用 Public API，Browser-only 模式则读取已登录的网页考勤视图
- **审批工作流** — 提交、跟踪、撤回勤务修正申请；管理者批量审批/驳回
- **假日日历** — 日本国定假日和中国假日（含调休/补班）
- **Web 管理面板** — 日历视图、执行日志、实时状态
- **多语言** — 英语、日语、中文

## 快速开始

```bash
# 克隆仓库
git clone https://github.com/sky-zhang01/punchpilot.git
cd punchpilot

# 创建本地配置文件
cp .env.example .env

# 启动
docker compose up -d

# 打开面板
open http://localhost:8681
```

首次启动时，PunchPilot 会为 `admin` 用户生成高熵一次性密码。不要把它复制进日志，使用以下命令读取后登录，并修改用户名和密码：

```bash
docker compose exec punchpilot cat /app/keystore/initial-admin-password
```

完成首次改密后，bootstrap 文件会自动删除。然后配置：
1. **打卡通道** — 有 API 权限时使用 OAuth API 模式；无 API 权限时使用 Browser 模式并填写 freee 网页凭证
2. **休假保护** — 能获得 OAuth 只读权限时优先使用；Browser-only 模式会从已登录的 freee 网页考勤视图确认休假
3. **排班** — 设置工作时间和自动打卡时间

未配置 OAuth 授权时，Browser 模式会在打卡前通过同一登录会话确认当天考勤。如果无法明确匹配当天记录，或返回的数据结构不受支持，计划打卡会暂停而不会提交。

保存 Browser 凭证后，或把现有 Browser 模式部署升级到 v0.5.0 后，请在设置页执行一次**验证**。PunchPilot 明确确认对应的 freee 员工身份前，计划任务会保持暂停。

## 系统架构

```
┌──────────────┐     ┌────────────────────────────────────┐
│   浏览器      │────▶│         PunchPilot (Docker)        │
│   管理面板    │     │                                    │
└──────────────┘     │  Express API ─── React (Ant Design)│
                     │       │                            │
                     │  ┌────┴────┐    ┌────────────────┐ │
                     │  │ SQLite  │    │  Playwright    │ │
                     │  │ (数据)   │    │ (网页模式)      │ │
                     │  └─────────┘    └────────────────┘ │
                     │       │                            │
                     │  ┌────┴────┐    ┌────────────────┐ │
                     │  │ 调度器   │    │ freee HR API   │ │
                     │  │ (cron)  │    │  (OAuth2)      │ │
                     │  └─────────┘    └────────────────┘ │
                     └────────────────────────────────────┘
```

**技术栈**：Node.js、Express 5、React 19、Ant Design 6、Vite 8、Playwright、SQLite、Docker

## 批量补卡策略

补录缺勤考勤时，PunchPilot 按顺序尝试 3 种安全策略：

| 策略 | 方式 | 速度 | 前提条件 |
|------|------|------|----------|
| 1. 直接写入 | `PUT /work_records` | 即时 | 写入权限 |
| 2. 审批申请 | `POST /approval_requests` | 即时 | 审批路由 |
| 3. 网页表单 | Playwright 浏览器 | 取决于网页响应 | freee 网页登录凭证 |

每月初，PunchPilot 自动检测当前企业适用的最优策略并缓存。历史补卡不会使用逐条打刻 API，因为部分成功后无法回滚。

## 安全性

- **加密存储**：所有凭证（freee 密码、OAuth 令牌）均使用 AES-256-GCM 加密；密钥通过 scrypt 派生
- **密钥隔离**：加密密钥存储在 Docker 命名卷中，与数据绑定挂载物理分离
- **认证加固**：高熵一次性初始密码、bcrypt 密码哈希、首次登录强制改密、CSPRNG 会话、登录频率限制（10次/15分钟）
- **会话存储**：SQLite 中仅保存会话令牌的单向哈希
- **安全头**：CSP（含 form-action、base-uri）、HSTS、X-Frame-Options DENY、X-Content-Type-Options nosniff、Permissions-Policy、COEP、CORP
- **OAuth fail-closed 行为**：授权过期或被撤销时暂停定时任务，并在面板和日志中显示重新授权状态
- **休假保护 fail-closed 行为**：如无法通过 API 或 Browser 模式确认当天考勤记录，则暂停计划任务，避免误打卡
- **静态缓存**：哈希资源（1年不可变）、favicon（1天）、index.html（不缓存）
- **非 root 运行**：拒绝 0 或非法 `PUID`/`PGID`，启动应用前完成降权（默认 1000，TrueNAS 可设为 568）
- **无遥测**：凭证和考勤数据只发送给 freee；节假日模块仅获取公共日历数据
- **浏览器产物**：截图默认关闭；手动启用后仍需登录访问并会自动过期
- **浏览器隔离**：标准 Compose 部署以非 root 运行 Chromium，并启用 namespace/seccomp sandbox
- **依赖来源校验**：发布前检查 npm 注册表签名、lockfile SHA-512 和 7 天发布冷却期；紧急安全例外必须精确、公开且带有效期
- **错误脱敏**：客户端错误不会暴露令牌、密码、凭证表单截图或 freee 页面原文

## 平台支持

PunchPilot 以多架构 Docker 镜像分发。

| 架构 | 平台 | 典型硬件 |
|------|------|----------|
| `linux/amd64` | x86_64 | Intel/AMD 服务器、PC、大多数云主机 |
| `linux/arm64` | aarch64 | Apple M 系列（M1/M2/M3/M4）、AWS Graviton、树莓派 4+ |

> **Windows / macOS**：通过 [Docker Desktop](https://www.docker.com/products/docker-desktop/) 运行同一 Linux 镜像（内部使用轻量级 Linux 虚拟机）。

```bash
# 拉取固定版本镜像
docker pull ghcr.io/sky-zhang01/punchpilot:0.5.0

# Compose 会拉取同一多架构版本
docker compose pull
docker compose up -d

# 生产环境可使用 release notes 中的 manifest digest 严格固定
PUNCHPILOT_IMAGE=ghcr.io/sky-zhang01/punchpilot@sha256:<digest> docker compose up -d
```

## 配置说明

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TZ` | `Asia/Tokyo` | 容器时区 |
| `PORT` | `8681` | 服务端口 |
| `PUID` / `PGID` | `1000` | 运行用户/用户组；标准 TrueNAS Apps 环境将两者设为 `568` |
| `PUNCHPILOT_IMAGE` | `ghcr.io/sky-zhang01/punchpilot:0.5.0` | Compose 使用的公开镜像标签或 release manifest digest |
| `TRUST_PROXY` | 禁用 | 可信反向代理的 IP/CIDR，或 `loopback`、`linklocal`、`uniquelocal`；未设置时忽略转发头 |
| `PUNCHPILOT_PUBLIC_ORIGIN` | 仅 loopback | 非 loopback 访问的规范 HTTPS origin；用于固定写请求校验、Secure cookie、HSTS 和 OAuth callback，不信任请求头 |
| `OAUTH_REDIRECT_URI` | 自动派生 | 可选的 freee 完整 callback URI；须与规范 origin 相同且路径为 `/api/config/oauth-callback` |
| `SHUTDOWN_GRACE_MS` | `510000` | 关停时等待当前调度、浏览器、批处理、账号操作和 HTTP 请求完成的时间 |
| `APP_SECRET` | 在 `keystore` 中生成 | 可选加密密钥，至少 32 字节；持久化后必须与现有 keystore 密钥完全一致，否则拒绝启动 |
| `PUNCHPILOT_INITIAL_ADMIN_PASSWORD` | 未设置 | 可选初始密码，至少 16 字节；容器环境可被检查，优先使用默认文件方式 |
| `PUNCHPILOT_INITIAL_ADMIN_PASSWORD_FILE` | `/app/keystore/initial-admin-password` | 初始秘密文件；缺失时以 `0600` 权限生成，首次改密后删除 |
| `BROWSER_SCREENSHOTS` | `off` | `off`、`errors` 或 `all`；仅在受控排障时启用 |
| `CHROMIUM_SANDBOX` | `false` | 启用 Chromium 内部 sandbox；随附 Compose 使用已审查的 seccomp profile 将其设为 `true` |
| `BROWSER_IDLE_TIMEOUT_MS` | `300000` | Chromium 空闲后关闭的等待时间 |
| `BROWSER_SESSION_TTL_MS` | `28800000` | 仅内存保存的网页会话复用时长，不写入磁盘 |
| `AUTOMATION_QUEUE_TIMEOUT_MS` | `540000` | 串行账号或浏览器任务的最长排队时间；大于单次任务硬超时 |
| `AUTOMATION_OPERATION_TIMEOUT_MS` | `480000` | 单次串行浏览器任务的硬超时；超出 `1..480000` 时拒绝启动 |

随附 Compose 通过固定的 Playwright seccomp profile、最小启动 capabilities 和 `no-new-privileges` 启用 Chromium sandbox。仅使用镜像的平台，只有在容器运行时应用同一 profile 后才能设置 `CHROMIUM_SANDBOX=true`；生产环境不得改用 `seccomp=unconfined` 或 `SYS_ADMIN`。

通过域名或反向代理访问面板时必须设置 `PUNCHPILOT_PUBLIC_ORIGIN`。仅 `localhost`、`127.0.0.1` 和 `[::1]` 可使用明文 HTTP；外部 origin 必须使用 HTTPS。若设置 `OAUTH_REDIRECT_URI`，两者 origin 必须一致。

### Docker 卷

| 路径 | 类型 | 用途 |
|------|------|------|
| `./data` | 绑定挂载 | SQLite 数据库、日志 |
| `./screenshots` | 绑定挂载 | 手动启用且需认证访问的调试截图 |
| `keystore` | 命名卷 | 加密密钥和一次性管理员初始文件（隔离存储） |

## 开发

本地开发需要 Node.js 24 系列中的 24.15 或更高版本以及 npm 12.2.0。仓库内的 `.nvmrc`、package engine 检查、CI 和容器构建会执行同一工具链约束。

```bash
# 安装 CI 和镜像构建器中经过审阅的 npm 版本
npm install --global npm@12.2.0 --ignore-scripts --no-audit --no-fund

# 安装依赖
npm ci --ignore-scripts
npm --prefix client ci --ignore-scripts
npm run audit:release-age

# 启动开发服务器（自动重载）
npm run dev

# 运行测试
npm test

# 运行覆盖率与 E2E smoke
npm run test:coverage
npm --prefix client run test:coverage
npm --prefix client run build
npm run test:e2e

# 构建前端
cd client && npx vite build

# 不拉取公开版本，改为构建本地镜像
cd ..
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## 致谢

本项目受 [@newbdez33](https://github.com/newbdez33) 的 [freee-checkin](https://github.com/newbdez33/freee-checkin) 项目启发并在其基础上构建。原项目提供了基于 Playwright 的 freee 考勤自动化基础。PunchPilot 在此之上扩展了 Web 管理界面、OAuth API 集成、多策略批量补卡和企业级安全特性。

## 许可证

[MIT](LICENSE)
