<p align="center">
  <img src="client/public/logo-256.png" alt="PunchPilot 标志" width="128" height="128">
</p>

<h1 align="center">PunchPilot</h1>

<h3 align="center">为 <a href="https://www.freee.co.jp/hr/">freee 人事劳务</a>（freee人事労務）自动打卡，运行在你自己的电脑或服务器上。</h3>

<p align="center"><a href="README.md"><b>English</b></a> | <a href="README.ja.md"><b>日本語</b></a></p>

<p align="center"><b>快速跳转：</b> <a href="#快速开始">快速开始</a> · <a href="#punchpilot-不会做的事">PunchPilot 不会做的事</a> · <a href="#常见问题">常见问题</a></p>

如果你的公司用 freee 人事劳务记录考勤，你每个工作日都要上班打卡、开始和结束休息、下班打卡。漏打一次，事后就得提交补卡申请。PunchPilot 按你设定的时间替你打这些卡，并跳过你不上班的日子。它的网页面板还能补漏打的日子、申请休假、提交月度结算；如果你在 freee 中是审批人，还能审批下属的申请。

PunchPilot 是单用户工具：每个人为自己的 freee 账号各自运行一份 PunchPilot。它是独立的开源项目，与 freee 株式会社没有关联。

## 平常的一天

1. 每天零点刚过，PunchPilot 规划当天的上班、开始休息、结束休息和下班时间。每一项可以是固定时刻，也可以在时间窗内随机取一分钟。默认值为：上班 09:50–10:00，开始休息 12:00–12:30，结束休息 13:00–13:30，下班 19:00–20:00。
2. 遇到周末、日本法定节假日、你自己添加的自定义假日，以及 freee 上显示为全天休假、缺勤或公司休息日的日子，PunchPilot 会整天不打卡。如果在 **自动打卡跳过节假日** 中也选择了中国，中国法定节假日同样会跳过，而落在周末的调休补班日会照常打卡。半天或按小时的休假只要没有覆盖全天工时，就不会跳过当天。
3. 每次打卡前，它会再查一次 freee。如果你已经手动打过卡，它什么也不做。如果它无法确认你的状态，就会暂停，而不会凭猜测打卡：仪表盘上会显示暂停，**日志** 里会记录原因。
4. 只有当天工作超过 6 小时，才会安排 60–90 分钟的休息，依据是日本《劳动基准法》第 34 条。
5. 如果到了上班时间 PunchPilot 没在运行，它不会替你打一张迟到的上班卡：只有晚了不超过 5 分钟，才会立即打上班卡；否则跳过当天的自动打卡，需要你自己在 freee 上打卡。5 分钟的限制针对的是计划时间 PunchPilot 没在运行的情形。如果 PunchPilot 正在运行、只是 freee 暂时不可用或被限流，它会在大约一小时内重试这次打卡，每次重试前都先查 freee 的打卡记录，避免重复打卡；如果下一次重试会落在当天下一个计划动作的时间或之后，就提前停止重试。重试期间，仪表盘上这一步可能已经显示为失败；如果最终仍然失败，**日志** 里会记录原因，请自己在 freee 上打卡。

## 常见情况

补卡、各类申请、审批和自定义假日都在 **日历与假日** 页面；**自动打卡** 开关在 **设置 → 调度配置**；**手动触发** 在仪表盘上。补卡和各类申请需要 freee API 连接；申请列表和审批只在公司使用 freee 审批路线时才会出现。

| 你想要… | 这样做 |
|---|---|
| 补上忘记打卡的日子 | **补签到 → 选择所有缺勤**，然后提交。已经有打卡记录或本来就休息的日子会自动跳过。 |
| 按计划请一天假 | **休假申请**：带薪休假（全天、半天或按小时）、特别休假或缺勤。freee 上出现全天休假后，那天会自动跳过。 |
| 临时请病假，或者休假还没批下来 | 在上班时间之前关闭 **自动打卡**，下一个工作日之前记得重新打开。PunchPilot 只跳过 freee 上已经显示的休假。 |
| 去休长假或出差 | 关闭 **自动打卡**，回来后再打开。 |
| 加班到很晚 | 在下班时间窗开始之前关闭 **自动打卡**；下班时在 **手动触发** 里点 **签退**，然后重新打开 **自动打卡**。 |
| 提前下班 | 自己打下班卡即可。PunchPilot 看到这次打卡后，会跳过自动下班打卡。 |
| 申请加班或假日出勤 | **休假申请 → 加班申请**，或 **出勤申请 → 假日出勤**。假日出勤申请始终使用你保存的 freee 网页登录信息提交。 |
| 撤回一个申请 | **查看申请**，在审批前撤回。 |
| 审批下属的申请 | **查看申请 → 待审批**：可以逐条或批量批准、驳回。 |
| 月末结算 | **月度结算申请**。只有公司使用审批路线，或已保存 freee 网页登录信息时，才会显示这个按钮。 |
| 现在就打卡 | **仪表盘 → 手动触发**。 |
| 公司放假那天不打卡 | **假日管理 → 自定义假日**。 |
| 想知道今天为什么没打卡 | 先看仪表盘上的状态说明。节假日、休假和暂停的原因，可以在 **日志** 里的“每日调度检查”记录中找到。 |

freee 要求重新登录时，仪表盘上会出现带 **重新授权** 按钮的提示；在你重新授权之前，自动打卡会一直暂停。

## PunchPilot 不会做的事

- PunchPilot 的服务端只连接 freee 和公开的节假日日历，没有任何遥测。
- 无法确认你的考勤状态、休假，或者当前操作的是哪个 freee 账号时，它不会打卡，而是暂停并告诉你。
- 它不会覆盖 freee 上已有的打卡记录。
- 它不会发送邮件或聊天通知，请自己查看仪表盘和日志。
- 它不替你判断所在公司是否允许自动打卡，请遵守公司的考勤规定。

## 开始之前

- **一个 freee 人事劳务的员工账号。**
- **一个 freee 开发者应用**（Client ID 和 Client Secret）。自动打卡和各类申请都通过 freee API 进行，所以这一项是必需的。在应用里登记回调地址 `http://localhost:8681/api/config/oauth-callback`；如果改了 `PORT`，换成对应的端口；如果使用你自己的 HTTPS 地址，则登记 `https://<你的地址>/api/config/oauth-callback`。
- **可选：你的 freee 网页登录信息**（邮箱、密码和准确的事务所（公司）名称）。假日出勤申请总是用它提交；公司的审批路线无法通过 API 处理时，也会用到它。
- **一台在工作时间内保持开机、不会进入睡眠的电脑**，装有 Docker 和 Docker Compose。会进入睡眠的笔记本电脑会漏打卡。支持 `linux/amd64` 和 64 位 `linux/arm64`。Windows 和 macOS 上的 Docker Desktop 运行的是同一个镜像，但本项目没有对它做测试。

## 快速开始

```bash
git clone https://github.com/sky-zhang01/punchpilot.git
cd punchpilot
cp .env.example .env
docker compose up -d
```

1. 在同一台电脑上打开 <http://localhost:8681>。
2. 读取一次性密码，以 `admin` 登录，然后设置你自己的用户名和密码：

   ```bash
   docker compose exec punchpilot cat /app/keystore/initial-admin-password
   ```

3. 在 **设置 → API 配置（OAuth2）** 中填入 Client ID 和 Client Secret，点击 **保存应用凭据**；然后点击 **使用 freee 授权**，如果你有多个事务所，再选择其中一个。
4. 可选：在 **设置 → freee 网页登录** 中填入 freee 邮箱、密码和准确的事务所名称，保存时会自动验证。
5. 在 **设置 → 调度配置** 中设定打卡时间和节假日选项。
6. 在设置中 **关闭模拟模式**。新安装默认处于模拟模式，只模拟上班、休息和下班打卡。

侧边栏上的 **模拟模式** 标签消失后，PunchPilot 就开始真实打卡了。仪表盘上会显示下一次计划打卡的时间。第一次上班时间过后，请到 freee 上确认这次打卡已经记录下来。

## 从其他设备访问

默认只能在运行 PunchPilot 的那台电脑上通过 `http://localhost:8681` 登录。从其他设备用普通 `http://` 打开时，页面也许能显示，但登录会被有意拒绝。如果想用手机或其他电脑访问：

1. 把 PunchPilot 放到 HTTPS 反向代理后面。
2. 在 `.env` 中设置 `PUNCHPILOT_PUBLIC_ORIGIN`（例如 `https://punchpilot.example.com`）和 `TRUST_PROXY`。`TRUST_PROXY` 填反向代理连接 PunchPilot 时使用的地址。尽量填代理的确切 IP 地址或网段；容器网络也可以用 `loopback`、`linklocal`、`uniquelocal` 这几个命名范围（见 `.env.example`）。它是地址列表，不是开关：填 `true` 这样的值会被拒绝，PunchPilot 将无法启动。
3. 在 freee 应用里登记对应的回调地址。

之后请通过这个 HTTPS 地址登录，`localhost` 将无法再登录。

## 更新、备份与设置

- **更新：** 在 `punchpilot` 文件夹中先运行 `git pull`，再运行 `docker compose up -d`，Compose 会下载新镜像。如果你在 `.env` 中设置了 `PUNCHPILOT_IMAGE`，也要改成新版本。更新前请先看 [CHANGELOG](CHANGELOG.md) 中的升级须知。正在执行的打卡或批量任务会先完成，这可能需要几分钟。
- **备份：** 把 `./data` 文件夹、keystore Docker 卷（通常名为 `punchpilot_keystore`）和你的 `.env` 放在一起备份。没有对应的 keystore，保存的 freee 凭证就无法解密。`./data` 中的其他内容（日志、打卡计划、事务所名称）没有加密，请把备份放在别人看不到的地方。
- **设置：** 常用的选项有 `TZ`（打卡时间按哪个时区计算）、`PORT`、`PUID`/`PGID`（数据文件归属的用户和用户组，部分 NAS 需要改成别的值）、`PUNCHPILOT_PUBLIC_ORIGIN` 和 `TRUST_PROXY`。其他选项的说明见 [`.env.example`](.env.example)。

## 常见问题

**忘记了 PunchPilot 的密码怎么办？** 没有找回密码的功能。连续登录失败 3 次后，登录页上会显示一条恢复出厂设置的命令。它会清除 PunchPilot 的所有数据和设置，但不影响你在 freee 上的记录。运行后，用 `docker compose restart punchpilot` 重新启动，再从快速开始的第 2 步重新设置。

**我的 freee 密码安全吗？** 保存的凭证会在你自己的服务器上加密存储。在标准的 Docker Compose 部署中，自动化浏览器运行在 Chromium 的沙箱里。详情以及如何报告漏洞，请见 [SECURITY.md](SECURITY.md)。

**能不连接 freee 先试用吗？** 可以。保持模拟模式开启，快速开始的第 3、4 步先不填，打卡就只是模拟。注意模拟模式只管打卡：一旦连接了 freee，补卡、休假申请、审批和月度结算都会真实发送到 freee。

## 参与开发

本地开发和测试方法见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 致谢

PunchPilot 起源于 [@newbdez33](https://github.com/newbdez33) 的 [freee-checkin](https://github.com/newbdez33/freee-checkin)，它提供了最初基于浏览器的 freee 考勤自动化。

## 许可证

[MIT](LICENSE)
