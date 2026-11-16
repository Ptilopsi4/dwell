# 部署

[English](deployment.md) | 简体中文 | [README](../README.zh-CN.md)

在 Linux 上使用专用服务用户、systemd 与 bash 沙箱部署 dwell，也可采用 [Docker 方式](#docker)。配置变量与模型模板见[配置](configuration.zh-CN.md)，bot 命令与 panel 功能见[使用指南](usage.zh-CN.md)，专用贡献者账号设置见 [GitHub 接入](github.zh-CN.md)。

<a id="1-bot-配置"></a>

## Bot 配置

可以启用飞书、Telegram 或两者。只用 Telegram 时不需要 `LARK_APP_ID`、`LARK_APP_SECRET`。两个入口复用相同的模型配置、角色、预算与工作区规则。

### 飞书（可选）

dwell 使用官方 SDK 的长连接（WebSocket），服务器需要能访问公网，但不需要公网地址。

1. 在飞书开发者后台创建**企业自建应用**（长连接只支持自建应用），开启**机器人**能力。
2. **事件订阅**：选「使用长连接接收事件」，订阅 `im.message.receive_v1`（接收消息）。
3. **回调订阅**：选「使用长连接接收回调」，订阅 `card.action.trigger`（卡片回传交互）。审批卡按钮依赖它。
4. 各功能依赖的**权限**：

   | 权限 | 用途 |
   |---|---|
   | `im:message`、`im:message:send_as_bot` | 发送与更新消息 |
   | `im:message.p2p_msg:readonly` | 接收私聊消息 |
   | `im:message.group_at_msg:readonly` | 接收群里 @bot 的消息 |
   | `im:message.group_msg` | 接收群内全部消息（不 @ 的回复、话题群）以及 `dwell.lark.read` 读历史；需要管理员审批 |
   | `im:resource` | 下载消息里的图片和文件，`dwell.lark.send` 上传文件 |
   | `cardkit:card:write` | 流式回复卡片 |
   | `contact:user.base:readonly` | 显示用户名 |
   | `im:chat:readonly` | 显示群名 |

   权限名会随平台调整，以后台为准。缺权限时飞书 API 的报错会写明缺哪一项，dwell 会把报错记进日志。
5. 发布应用版本让权限生效，再把 bot 拉进需要服务的群。

同一个应用的事件会在所有已连接的客户端之间随机分流。每个应用只跑一个 dwell 实例，本地测试用另一个应用。

### Telegram（可选）

1. 用 BotFather 创建 bot，将 token 写入私有环境文件的 `TELEGRAM_BOT_TOKEN`，保持群隐私模式开启。主机需要通过 HTTPS 出站访问 Bot API，长轮询不需要公开的入站端点。
2. 在首次使用正式状态目录前取得用户 ID。尚不知道 ID 时，用下方独立的 bootstrap 目录临时启动，私聊 bot 发送 `/whoami`，收到 `tg:<数字用户 ID>` 后停止临时进程。把该 ID 填入 `DWELL_ADMINS`，再首次启动正式实例。已有 `state/users.json` 时修改环境变量不会更新用户，此时用现有管理员的 `/allow tg:123456789 admin` 或受信任的 panel 添加。Telegram 管理员和 panel 操作者需先私聊启动 bot，才能收到通知。
3. 群聊需邀请 bot 入群，并将原始数字群 ID 以逗号分隔写入 `DWELL_TELEGRAM_CHATS`，例如 `-1001234567890`；为空时只允许私聊。发送者仍需用户权限。修改群列表后重启。群中用 `/ask@your_bot 内容` 或回复这个 bot 的消息，单独 @ 不会发起任务；在已允许的群里用 `/whoami@your_bot` 核对群 ID。
4. 每个 token 只运行一个轮询实例。启动时若已有 webhook 则拒绝启动并保留 webhook，启用长轮询前需单独处理它。认证失败 401 或轮询冲突 409 会使服务以非零退出码停止，需先修正 token 或停止竞争客户端再启动。临时传输故障持续重试，退避间隔有上限。本地副本不要使用生产 token。

仅用于查询 ID 的临时启动，在已安装依赖并填好模型 key、bot token 的仓库目录执行；同一个 token 的其他实例必须先停止：

```sh
DWELL_DATA=./data/bootstrap DWELL_STATE=./state/bootstrap npm start
```

该命令不会创建默认 `state/users.json`。查询后停止进程，去掉这两个目录覆盖再启动正式实例；不要把正式实例指向 bootstrap 目录。

token 放在 agent 工作区之外，先捕获再擦除环境；传输错误省略含 token 的 URL。备份或恢复时，`$DWELL_STATE/telegram/` 轮询游标需与数据库中的输入/命令回执保持配套。输入有稳定请求 ID；网络响应丢失时，出站投递结果仍可能不确定。

上线前用隔离测试 bot 验证[持久化输入与恢复规则](agent.zh-CN.md)，包括路由内顺序、待处理输入取消、答案去重、待投递审批，以及缺少可信操作者的旧输入处理。

启用生产 token 前，使用独立测试 bot、隔离的数据/状态目录和测试群，检查私聊文本、带后缀的群命令、回复、附件、危险命令审批、`/new` 与重启恢复。检查期间保持隐私模式开启。mock Bot API 的自动测试不代表真实链路或生产验收通过。

<a id="2-主机目录布局"></a>

## 主机目录布局

用专用的非 root 用户运行 dwell。代码、数据、状态分开放：

```
/opt/dwell/
  app/     代码（src/、test/、templates/、package.json、node_modules/）
  data/    DWELL_DATA：dwell.sqlite、work/<会话>/
  state/   DWELL_STATE：用户、会话、审批 JSON、models.json、telegram/ 游标与私有 proc-logs/
  .env     凭证与配置，权限 600
```

```sh
sudo useradd --system --create-home --shell /usr/sbin/nologin dwell
sudo mkdir -p /opt/dwell/{app,data,state}
# 把仓库复制到 /opt/dwell/app，然后：
cd /opt/dwell/app && sudo -u dwell npm ci --omit=dev
sudo cp .env.example /opt/dwell/.env && sudo chmod 600 /opt/dwell/.env
sudo cp templates/models.openai-responses.json /opt/dwell/state/models.json
sudo chmod 600 /opt/dwell/state/models.json
sudo chown -R dwell:dwell /opt/dwell
```

需要 Node ≥ 26。node 不在系统 `PATH` 里时，按下面的 unit 设置 `PATH`。

编辑 `/opt/dwell/.env`：设置 `DWELL_MODELS_FILE=/opt/dwell/state/models.json`，填写 `OPENAI_API_KEY`（模板的 `apiKeyEnv`），以及所选 bot 的凭证和白名单。其他[模型模板](configuration.zh-CN.md)复用同一加载器与连接结构。模型文件与凭证放在 agent 工作区之外，JSON 只保存密钥变量名。启动时拒绝位于数据、临时或已有会话目录中的配置，包括可写目录内的软链入口；显式配置缺失或无效也会使启动失败。修改连接前，先完成或取消仍在等待模型响应的请求，再重启。请求 checkpoint 保留原模型引用；如果新配置无法解析旧引用，启动会保留 checkpoint 并拒绝续跑。后续请求的主会话和后台会话设置会统一对齐。未选择模型文件且默认路径下也没有文件时，仍兼容旧环境变量配置。

<a id="3-systemd-unit"></a>

## systemd unit

`/etc/systemd/system/dwell.service`：

```ini
[Unit]
Description=dwell agent
After=network-online.target
Wants=network-online.target

[Service]
User=dwell
Group=dwell
WorkingDirectory=/opt/dwell/app
EnvironmentFile=/opt/dwell/.env
Environment=PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin
Environment=DWELL_DATA=/opt/dwell/data
Environment=DWELL_STATE=/opt/dwell/state
Environment=NODE_ENV=production
ExecStart=/opt/node/bin/node src/index.ts
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/dwell
PrivateTmp=true
MemoryMax=1200M
OOMPolicy=continue

[Install]
WantedBy=multi-user.target
```

node 路径按实际调整。`Restart=always` 是必需的：存储层失败（`session_failed`）后 dwell 会主动退出，靠它拉起。`PrivateTmp=true` 给服务独立的 `/tmp`，沙箱里 bash 看到的也是这个 `/tmp`，服务停止时 systemd 会清空它。`MemoryMax` 限制整个 unit 的总内存，内核也可能选择主 Node 进程作为 OOM 目标。`OOMPolicy=continue` 控制进程被杀后 unit 的处理方式，不能指定被杀的进程。主进程若被杀，`Restart=always` 会重新启动 dwell，再按下文的检查点和已持久化预算规则恢复任务。详见 [systemd 内存限制](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html#MemoryMax=bytes)和 [OOM 策略](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html#OOMPolicy=)。`MemoryMax` 要按预期让模型跑的最重负载预留：单个 Go `compile` 进程可吃 ~1GB，1200M 的 cgroup 里跑构建可能反复触发 OOM（模型可能重试，但完成情况不可靠）；机器宽裕就调高 `MemoryMax`，或接受重型构建归属 fork 上的 CI。沙箱在 `NoNewPrivileges` 和 `ProtectSystem=strict` 下可以正常工作。服务器通常是 UTC 时区：在 `.env` 里设置 `DWELL_TZ`（如 `Asia/Shanghai`），定时任务的触发时间与模型看到的日期才会按预期时区解释。

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now dwell
journalctl -u dwell -f
```

启动时要看的日志：

- `[dwell] bash 沙箱已启用（wrapper: …）`：沙箱已启用。`required` 模式在探测失败时拒绝启动；`auto` 允许日志中提示的路径治理回退
- `[dwell] panel: http://…`：panel 已监听
- `[dwell] 就绪（飞书: <名字或 off>，Telegram: <用户名或 off>）`：所选 bot 已初始化；当前连接状态查看 `/healthz`

<a id="4-bash-沙箱"></a>

## bash 沙箱

沙箱需要 bubblewrap 和非特权 user namespace。`DWELL_SANDBOX` 只接受 `required`、`auto` 或 `off`，其他值使启动失败。`NODE_ENV=production`（包括上面的 unit）默认采用 `required`：启动探测失败就停止服务，不恢复 durable 任务。`auto` 明确允许回退到路径检查，是非生产环境的默认值；`off` 关闭沙箱。生产应保留 `required`，除非运维已配置并接受其他隔离边界。

```sh
sudo apt install bubblewrap
sudo -u dwell unshare -Ur true && echo "userns ok"
```

`unshare` 检查失败说明发行版限制了非特权 user namespace（Ubuntu 23.10 起 AppArmor 默认如此）。放开它是影响整台主机的安全决定，改之前先读发行版的文档。

服务启动后，用探针从沙箱内部检查，环境变量与 unit 保持一致：

```sh
cd /opt/dwell/app
sudo -u dwell env -i PATH=/usr/bin:/bin DWELL_DATA=/opt/dwell/data DWELL_STATE=/opt/dwell/state \
  DWELL_PANEL_PORT=<端口> DWELL_PANEL_HOST=<地址> node test/probe-bwrap.ts
```

每一行都应是 `PASS`：状态目录、应用目录、其他会话目录不可见；工作目录可写；`/usr` 只读；环境里没有密钥；DNS 正常；`/proc/1` 是沙箱的 init；沙箱内访问 panel 时 `/api/approvals` 返回 403、`/healthz` 返回 200。`DWELL_DATA` 和 `DWELL_STATE` 必须显式传入，否则探针回退到 `./data`，会把测试目录建进应用目录。

探针会按自己的环境重写共用的 wrapper `data/bin/sandbox-bash`。配置了 [GitHub 接入](github.zh-CN.md)时，跑完探针要重启服务，wrapper 才会重新透传 `GH_TOKEN`。

`test/probe-scrub.ts` 检查凭证是否已从 `/proc/<pid>/environ` 清除，用法见文件头注释。

`test/probe-proc.ts` 验证托管后台进程（`dwell.proc`）在沙箱下的真实行为：进程活过 spawn 调用、组击杀能清掉 pidns 内含 `setsid` 孙进程、进程起的 server 能被其他 bash 调用连上、输出落日志。跑法同 `probe-bwrap.ts`（需沙箱已启用）。

<a id="5-panel-与网络"></a>

## Panel 与网络

panel 没有登录。保护它的是网络，加上服务端的两道检查：

- **请求准入**：POST 只收 JSON，`Origin` 必须同源，`Host` 必须是 IP 字面量或配置过的主机名
- **本机来源拒绝**：来自服务器本机（回环或任一本机接口地址）的请求，除 `/healthz` 外一律 403。bash 跑在同一台机器上，靠这道检查才能阻止 agent 调 panel 批准自己的命令

所以 panel 必须从**另一台机器**打开。常见做法：

- 把 panel 绑定到内网或 VPN 接口：`DWELL_PANEL_HOST=10.8.0.1`、`DWELL_PANEL_PORT=7788`
- 从工作机经这个网络访问（WireGuard、内网等）
- 希望通知带 panel 链接，或用域名而不是 IP 打开 panel 时，设置 `DWELL_PANEL_URL`
- 在服务器本机做健康检查只能访问 `/healthz`，其他路径在本机都返回 403

请求策略同样适用于就绪、运行观测和工作验收 API。策略见[安全边界](security.zh-CN.md)，健康与观测接口见[运行告警](#运行告警)，验证与操作者验收见 [Agent 行为](agent.zh-CN.md)，panel 功能见[使用指南](usage.zh-CN.md#web-panel)。

同机反代或 `ssh -L` 隧道会让所有请求都显示为本机来源，panel 会全部拒绝。`DWELL_PANEL_TRUST_LOCAL=1` 可以为这类部署关掉本机来源检查，代价是 bash 又能访问 panel 及其审批接口。优先选择浏览器从另一台机器直连的部署。

想在服务器上多加一层，可以用防火墙规则禁止服务用户连接 panel 端口，不依赖 dwell 自身的检查：

```sh
iptables -A OUTPUT -m owner --uid-owner dwell -p tcp --dport 7788 -m addrtype --dst-type LOCAL -j REJECT
```

加了这条规则后，探针里沙箱内访问 `/healthz` 的检查也会失败，这是预期行为。

<a id="6-更新"></a>

## 更新

dwell 没有构建步骤。部署前确认 `npm run check` 和 `npm test` 通过。先停止服务及所有其他工作区写入者，取得配套备份，再复制新源码、启动服务。停服务会中断托管进程，需先安排好这些进程的中断。SIGINT/SIGTERM 关闭期限为 30 秒，服务管理器应至少等待这么久再强杀。

```sh
ts=$(date +%Y%m%d-%H%M%S)
backup=/opt/dwell/backup-$ts
sudo systemctl stop dwell
# 确认其他工作区写入者均已停止；--stopped 记录运维对此的确认
cd /opt/dwell/app
sudo -u dwell npm run backup -- create --data /opt/dwell/data --state /opt/dwell/state \
  --code /opt/dwell/app --models /opt/dwell/state/models.json --env /opt/dwell/.env \
  --output "$backup" --stopped
sudo -u dwell npm run backup -- verify --backup "$backup"
# 把新版本源码与 package 文件（含 templates/）复制到 /opt/dwell/app
# package-lock.json 有变化时，在 /opt/dwell/app 执行 npm ci --omit=dev
sudo chown -R dwell:dwell /opt/dwell/app
sudo systemctl start dwell
curl -s http://<panel 地址>:<端口>/healthz    # 在服务器上：{"ok":true,...,"sandbox":true}
```

启动后查看健康状态与运行告警，确认模型连接符合预期，再经各个已配置的 bot 或可信 panel 验证一个任务及已有的待审续跑。`/healthz` 包含 `feishu`、`telegram`，连接为 `failed` 时返回 503。运行任务会从 checkpoint 恢复，并继续受持久化预算约束。旧后台子会话没有访问角色时，恢复前变为只读；需要 shell 或编辑的任务须停止后以 `mode: "write"` 重新启动。已经绑定 run 的预算限额保持冻结，不随环境默认值变化；执行阶段的停机时间可能耗尽期限，run 结束后的审批等待不计。托管进程按中断报告，不自动重跑。

备份 CLI 将数据、状态、运行源码/配置文件和依赖锁文件（不含应用的 `node_modules`）、选定的模型 JSON，以及可选的环境文件复制到一个新私有目录；`data/work/` 下的工作区依赖仍会备份。`backup-manifest.json` 保存 SHA-256 校验和与权限，SQLite 完整性在临时副本中检查。只允许保留 `data/work/` 内部的软链接本身，不跟随目标；外部目标内容需单独备份，恢复时需核对或重映射。`data/work/` 本身被替换成软链，或状态、应用和配置中出现软链，以及任何特殊文件，都会被拒绝。`--stopped` 是运维确认，不会自动停写，也不提供在线快照。输出必须是代码、数据、状态目录之外的新目录。模型配置放在别处时调整 `--models`，外部服务凭证需另行保留。

`data/dwell.sqlite`（连同 `-wal`/`-shm` 文件）保存会话、运行预算、工作记录、工作区写租约与 Telegram 路由/inbox/输入/命令回执。`state/` 保存路由、用户、审批决定/投递记录、Telegram 游标、私有进程日志、模型配置和 `runtime-telemetry.json`。观测快照最多保留 256 个指标序列与 200 个已结束 span，不含 prompt、工具参数/结果或错误正文。整个备份应按线上凭证保护；只备份数据库不能得到配套的 JSON/配置。

中断前已保存的审批决定会在启动时及退避重试中使用同一投递身份；状态保存失败保留原待审请求与窗口，重放不延长原到期时间。旧待审记录没有预算 ID 时，首次续跑创建预算。旧飞书卡缺少持久化请求 ID 时会被拒绝，需重新请求或由运维处理。这些重启恢复规则不承诺外部副作用恰好执行一次，也不承诺机器断电后的持久性。

演练恢复时，先验证备份，再恢复到新的暂存目录：

```sh
sudo -u dwell npm run backup -- verify --backup "$backup"
sudo -u dwell npm run backup -- restore --backup "$backup" --output /opt/dwell/restore-$ts
```

恢复会再次检查校验和与 SQLite，不替换或启动生产服务；文件保持仅属主可用的私有权限。在暂存目录的 `app/` 中运行 `npm ci --omit=dev`，检查恢复出的 `.env` 和模型路径，并按恢复布局调整绝对目录引用。检查暂存副本时保持 bot 入口断开。生产回滚需先停全部写入者、保留升级后的产物、核对外部副作用，再由运维替换配套的代码/配置/数据/状态并检查属主，最后启动。CLI 不执行生产替换。

进程日志位于 `$DWELL_STATE/proc-logs/<conversationId>/<taskId>.log`；agent 通过 `dwell.proc.logs` 读取，不使用工作区路径。按每份日志最多 50 MiB、已结束日志保留 7 天预留磁盘容量；启动和任务结束时清理过期终态日志，活跃日志保留。升级保留旧工作区的 `.dwell-proc/` 文件，不导入，也不重新打开旧 checkpoint 中的日志路径。旧运行进程按中断回报，新工具不能读取旧格式日志。

命令退出或停止后，输出管道只等待有限时间排空。若后代进程继续持有管道，任务报告输出不完整，不会无限等待。没有沙箱时，脱离原进程组的后代仍可能存活；有界输出收尾不能替代 PID namespace 或服务管理器的进程清理。

附件仍保存在各工作区可写的 `uploads/` 下。任务恢复前登记工作区根身份；根目录或上传目录被替换成链接时上传失败。Linux 的固定写入器经过现有沙箱；没有沙箱时，目录检查不能隔离同 UID 的不受约束进程。在独立 Linux 环境安装 bubblewrap 后，运行 `node test/probe-uploads.ts` 验证真实写入器、stdin 字节及目录替换处理；和其他沙箱探针一样，将 `DWELL_DATA`、`DWELL_STATE` 显式设在 `/tmp` 之外。Windows 拒绝附件上传，不回退到不受约束的宿主写入。

## 运行告警

任务 faulted/parked、扩展 hook 抛错、Session 失败等运行故障会记入日志，并在相应 bot 连接时，通过管理员所属平台私聊通知。Telegram 管理员需先私聊启动 bot。同类告警（按类型、扩展、任务类型）10 分钟内只发送第一条，被抑制的数量并入下一条。bot 不可用时，告警保留在日志中。

`session_failed` 表示存储层失败，进程已不可用。尽力通知管理员后，dwell 会退出，由 systemd 或 Docker 重启，部署时需配置自动重启。panel 侧栏在内存中保留最近 50 条告警，包含被抑制的条目（`GET /api/reports`），重启即清。

### 健康与观测

外部探活使用 panel 端口的 `GET /healthz`，返回 `{ ok, uptimeSec, feishu, telegram, sandbox }`。未启用或 panel-only 时，对应 bot 状态为 `off`；`sandbox` 表示 bash 沙箱是否启用。任一 bot 连接为 `failed` 时返回 503。服务器本机仍可访问此接口。

`GET /api/ready` 在启动完成后返回 200 与 `{ ready }`，不可用或关闭期间返回 503；`GET /api/runtime` 提供 SDK 指标与最近的 span。两者沿用可信 panel 策略，包括本机来源拒绝。观测不保存 prompt、工具参数、工具结果或错误正文。私有文件 `$DWELL_STATE/runtime-telemetry.json` 跨重启最多保留 256 个指标序列和 200 个已结束 span，用于有界排查。

SIGINT/SIGTERM 会停止输入、关闭运行时并刷盘观测数据，关闭期限为 30 秒，超时以非零退出码结束。服务管理器必须预留这段关闭时间。

### 模型连接故障

模型认证、访问、账户限额和配置错误会停止任务，不会因远端正文出现重试措辞就继续重试。聊天与 panel 给出具体原因，不显示响应体。临时故障仍受配置的重试与运行限额约束，上下文溢出保留 SDK 压缩行为。已完成工作继续保留。访问或地域限制需由运维处理连接，dwell 不会自动切换提供方。

<a id="7-github可选"></a>

## 可选 GitHub 接入

专用账号与 token、宿主 git 配置、可选签名、fork CI、验证和凭证吊销见 [GitHub 接入](github.zh-CN.md)。

<a id="8-docker"></a>

## Docker

Compose 服务以非 root 的 `dwell` 用户运行，通过 `init: true` 回收孤儿子进程，并挂载 `./data` 和 `./state`。单独启动容器时用 `docker run --init`。模型设置放在状态卷时，把模板复制到 `./state/models.json`，在 `.env` 里设 `DWELL_MODELS_FILE=/state/models.json`，填写 `apiKeyEnv` 指定的 key。

镜像设置了 `NODE_ENV=production`，但不包含 bubblewrap，因此默认 `required` 策略拒绝启动。可以提供派生镜像及容器配置使沙箱探测通过；也可以在配置妥当的容器边界后，明确选择 `DWELL_SANDBOX=off`，或用 `auto` 允许回退。服务不会静默降低生产策略。完成后运行 `docker compose up -d --build`；关闭时至少等 30 秒（例如 `docker compose stop -t 35`）。停止服务后，在 Node 26 宿主机上用备份 CLI 一起备份两个卷和配置。这种形态的限制：

- `off` 或 `auto` 探测失败时，隔离靠容器边界；路径与命令检查本身不能限制 shell 的访问范围
- `docker-compose.yml` 没有发布端口。要用 panel 需加 `ports:`，并绑定到内网接口（例如 `"10.8.0.1:7788:7788"`）
- 容器内 bash 和 panel 共用网络命名空间，本机来源检查照样能挡住 bash。宿主机经发布端口过来的请求，源地址应是 Docker 网桥网关（不属于容器自身地址），因此会被接受。这一点未经测试，依赖它之前先验证
