# PunchPilot

[freee HR](https://www.freee.co.jp/hr/) 智能考勤自动化工具。以 Docker 容器方式自部署，自带 Web 管理面板。

[**English**](README.md) | [**日本語**](README.ja.md)

## 功能特性

- **自动打卡** — 按设定时间自动出退勤，自动跳过周末和节假日（日本/中国）
- **批量补卡** — 一键补录缺勤日的考勤记录
- **4 级智能回退策略**：直接 API > 审批申请 > 打刻 > 网页表单（Playwright）
- **月度策略缓存** — 自动跳过已知失败的方式，每月初重新检测
- **审批工作流** — 提交、跟踪、撤回勤务修正申请
- **Web 管理面板** — 日历视图、执行日志、实时状态

## 快速开始

```bash
# 克隆仓库
git clone https://github.com/sky-zhang01/punchpilot.git
cd punchpilot

# 配置
cp .env.example .env
# 编辑 .env — 至少设置 GUI_PASSWORD

# 启动
docker compose up -d

# 打开面板
open http://localhost:8681
```

首次登录使用 `.env` 中设置的密码，然后配置：
1. **OAuth 凭证** — 在 freee 开发者平台创建应用，获取 Client ID 和 Secret
2. **授权** — 授权 PunchPilot 访问你的 freee HR 账户
3. **排班** — 设置工作时间和自动打卡时间

## 系统架构

```
┌──────────────┐     ┌──────────────────────────────────┐
│   浏览器      │────▶│         PunchPilot (Docker)       │
│   管理面板    │     │                                    │
└──────────────┘     │  Express API ─── React (Ant Design)│
                     │       │                            │
                     │  ┌────┴────┐    ┌───────────────┐ │
                     │  │ SQLite  │    │  Playwright    │ │
                     │  │ (数据)  │    │  (网页回退)    │ │
                     │  └─────────┘    └───────────────┘ │
                     │       │                            │
                     │  ┌────┴────┐    ┌───────────────┐ │
                     │  │ 调度器  │    │ freee HR API   │ │
                     │  │ (cron)  │    │  (OAuth2)      │ │
                     │  └─────────┘    └───────────────┘ │
                     └──────────────────────────────────┘
```

**技术栈**：Node.js、Express、React、Ant Design、Playwright、SQLite、Docker

## 批量补卡策略

补录缺勤考勤时，PunchPilot 按顺序尝试 4 种策略：

| 策略 | 方式 | 速度 | 前提条件 |
|------|------|------|----------|
| 1. 直接写入 | `PUT /work_records` | 即时 | 写入权限 |
| 2. 审批申请 | `POST /approval_requests` | 即时 | 审批路由 |
| 3. 打刻记录 | `POST /time_clocks` | 逐条 | 基本权限 |
| 4. 网页表单 | Playwright 浏览器 | ~20秒/条 | freee 网页登录凭证 |

每月初，PunchPilot 自动检测当前企业适用的最优策略并缓存。失败的策略在当月内自动跳过。

## 安全性

- **加密存储**：所有凭证（freee 密码、OAuth 令牌）均使用 AES-256-GCM 加密
- **密钥隔离**：加密密钥存储在 Docker 命名卷中，与数据绑定挂载物理分离
- **非 root 运行**：容器以非特权用户 `ppuser` 运行
- **无外部调用**：所有数据仅在你和 freee 服务器之间传输

## 配置说明

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `GUI_PASSWORD` | （必填） | Web 管理面板登录密码 |
| `TZ` | `Asia/Tokyo` | 容器时区 |
| `PORT` | `8681` | 服务端口 |

### Docker 卷

| 路径 | 类型 | 用途 |
|------|------|------|
| `./data` | 绑定挂载 | SQLite 数据库、日志 |
| `./screenshots` | 绑定挂载 | 调试截图 |
| `keystore` | 命名卷 | 加密密钥（隔离存储） |

## 开发

```bash
# 安装依赖
npm install && cd client && npm install && cd ..

# 启动开发服务器（自动重载）
npm run dev

# 运行测试
npm test

# 构建前端
cd client && npx vite build
```

## Kubernetes

Kubernetes 部署清单位于 `k8s/` 目录。详见 YAML 文件中的 namespace、PVC、secret 和 deployment 配置。

## 致谢

本项目受 [@newbdez33](https://github.com/newbdez33) 的 [freee-checkin](https://github.com/newbdez33/freee-checkin) 项目启发并在其基础上构建。原项目提供了基于 Playwright 的 freee 考勤自动化基础。PunchPilot 在此之上扩展了 Web 管理界面、OAuth API 集成、多策略批量补卡和企业级安全特性。

## 许可证

[MIT](LICENSE)
