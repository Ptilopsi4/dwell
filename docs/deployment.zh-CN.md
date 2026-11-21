# 部署

[English](deployment.md) | 简体中文 | [README](../README.zh-CN.md)

在 Linux 上使用专用服务用户、systemd 与 bash 沙箱部署 dwell，也可采用 [Docker 方式](#docker)。配置变量与模型模板见[配置](configuration.zh-CN.md)，机器人命令与面板功能见[使用指南](usage.zh-CN.md)，专用贡献者账号设置见 [GitHub 接入](github.zh-CN.md)。

<a id="1-bot-配置"></a>
<a id="bot-配置"></a>

## 机器人配置

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
   | `im:message.group_at_msg:readonly` | 接收群里 @机器人 的消息 |
   | `im:message.group_msg` | 接收群内全部消息（不 @ 的回复、话题群）以及 `dwell.lark.read` 读历史；需要管理员审批 |
   | `im:resource` | 下载消息里的图片和文件，`dwell.send` 上传文件 |
   | `cardkit:card:write` | 流式回复卡片 |
   | `contact:user.base:readonly` | 显示用户名 |
   | `im:chat:readonly` | 显示群名 |

   权限名会随平台调整，以后台为准。缺权限时飞书 API 的报错会写明缺哪一项，dwell 会把报错记进日志。
5. 发布应用版本让权限生效，再把机器人拉进需要服务的群。

同一个应用的事件会在所有已连接的客户端之间随机分流。每个应用只跑一个 dwell 实例，本地测试用另一个应用。

### Telegram（可选）

1. 用 BotFather 创建机器人，将令牌写入私有环境文件的 `TELEGRAM_BOT_TOKEN`，保持群隐私模式开启。主机需要通过 HTTPS 出站访问 Bot API，长轮询不需要公开的入站端点。若 Bot API 不能直连（如境内主机），可设置 `TELEGRAM_PROXY` 为一个 http/https/socks5 代理 URL（可内嵌凭证）；仅 Telegram 出站流量经代理，模型与其他出站不受影响，凭证同样在启动擦除名单内。
2. 在首次使用正式状态目录前取得用户 ID。尚不知道 ID 时，用下方独立的 `bootstrap` 目录临时启动，私聊机器人发送 `/whoami`，收到 `tg:<数字用户 ID>` 后停止临时进程。把该 ID 填入 `DWELL_ADMINS`，再首次启动正式实例。已有 `state/users.json` 时修改环境变量不会更新用户，此时用现有管理员的 `/allow tg:123456789 admin` 或受信任的面板添加。Telegram 管理员和面板操作者需先私聊启动机器人，才能收到通知。
3. 群聊需先邀请机器人入群，再由 dwell 管理员在目标群发送 `/allowgroup@your_bot` 或点击「允许本群成员使用」。命令自动识别群 ID，成员随后可使用各自的任务线与工作目录。若只允许显式授权用户使用，在群里发送 `/allowchat@your_bot`，或私聊发送 `/allowchat -1001234567890`。群尚未启用时，`/whoami@your_bot` 也能查询数字群 ID。`/disallowgroup` 停用当前群，`/disallowchat` 也接受 ID，`/chats` 显示开放模式。`DWELL_TELEGRAM_CHATS` 只播种逐人授权群；`$DWELL_STATE/telegram-chats.json` 已有当前机器人记录时以文件为准，包括空名单，历史记录保持逐人授权模式。保持隐私模式开启，群中用 `/ask@your_bot 内容` 或回复这个机器人的消息，单独 @ 不会发起任务；简写命令只有在 Telegram 实际投递时才生效。
4. 每个令牌只运行一个轮询实例。启动时若已有 webhook 则拒绝启动并保留 webhook，启用长轮询前需单独处理它。认证失败 401 或轮询冲突 409 会使服务以非零退出码停止，需先修正令牌或停止竞争客户端再启动。临时传输故障持续重试，退避间隔有上限。本地副本不要使用生产令牌。

仅用于查询 ID 的临时启动，在已安装依赖并填好模型密钥、机器人令牌的仓库目录执行；同一个令牌的其他实例必须先停止：

```sh
DWELL_DATA=./data/bootstrap DWELL_STATE=./state/bootstrap npm start
```

该命令不会创建默认 `state/users.json`。查询后停止进程，去掉这两个目录覆盖再启动正式实例；不要把正式实例指向 `bootstrap` 目录。

令牌放在代理工作区之外，先捕获再擦除环境；传输错误省略含令牌的 URL。备份或恢复时，`$DWELL_STATE/telegram/` 轮询游标需与数据库中的输入/命令回执保持配套。输入有稳定请求 ID；网络响应丢失时，出站投递结果仍可能不确定。

上线前用隔离测试机器人验证[持久化输入与恢复规则](agent.zh-CN.md)，包括路由内顺序、待处理输入取消、答案去重、待投递审批，以及缺少可信操作者的旧输入处理。

启用生产令牌前，使用独立测试机器人、隔离的数据/状态目录和测试群，检查私聊文本、带后缀的群命令、附件、危险命令审批、`/new` 与重启恢复。群成员模式下，让两位用户在同一论坛话题中操作，确认任务线与文件分别保存、回复他人的机器人消息会回到自己的线，且 `/new` 后仍可回复自己的旧线。另行检查逐人授权模式，并确认封禁和停用群会拒绝后续输入与回报，而运行中的子代理或进程仍需显式取消。检查期间保持隐私模式开启。模拟 Bot API 的自动测试不代表真实链路或生产验收通过。

<a id="2-主机目录布局"></a>

## 主机目录布局

使用专用非 root 用户运行 dwell。应用、依赖与私有配置归 root 所有，运行用户不能替换它们；只有数据和状态目录归 `dwell` 所有：

```
/opt/dwell/
  app/         root:root，dwell 不可写；代码与 node_modules/
  models.json  root:dwell，权限 640；连接设置，不含密钥值
  .env         root:root，权限 600；凭证与设置，由 systemd 读取
  data/        dwell:dwell，权限 700；DWELL_DATA：dwell.sqlite、work/<会话>/
  state/       dwell:dwell，权限 700；DWELL_STATE：用户/路由/审批、telegram/、proc-logs/
```

```sh
# 在已经检查、测试的发布版本 checkout 中执行。
# 先把 Node >= 26 安装到固定且归 root 所有的路径；本例使用 /opt/node/bin。
/opt/node/bin/node --version
sudo useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin dwell
sudo install -d -o root -g root -m 755 /opt/dwell /opt/dwell/app
sudo install -d -o dwell -g dwell -m 700 /opt/dwell/data /opt/dwell/state
git archive HEAD | sudo tar -x -C /opt/dwell/app
sudo env PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin /opt/node/bin/npm ci --prefix /opt/dwell/app --omit=dev
sudo chown -R root:root /opt/dwell/app
sudo chmod -R u=rwX,go=rX /opt/dwell/app
sudo install -o root -g root -m 600 /opt/dwell/app/.env.example /opt/dwell/.env
sudo install -o root -g dwell -m 640 /opt/dwell/app/templates/models.openai-responses.json /opt/dwell/models.json
sudo -u dwell /opt/node/bin/node --version
```

需要 Node ≥ 26，应用没有构建步骤。所有命令和下方服务单元都要使用实际 Node 安装位置的绝对路径，包括 `PATH`；不要使用运维用户家目录中的 Node。`git archive HEAD` 安装选定提交，不包含未提交文件，部署前应验证该版本。安装依赖后统一应用权限，避免运维用户的严格 umask 导致 `dwell` 无法读取模块；这一步只用于不含私有环境文件的 `app/`。以上命令用于首次安装，更新时保留已有数据和状态。

用 `sudoedit` 编辑配置。在 `/opt/dwell/.env` 中设置 `DWELL_MODELS_FILE=/opt/dwell/models.json`，填写 `OPENAI_API_KEY`（模板的 `apiKeyEnv`），以及所选机器人的凭证和白名单。使用 systemd 环境文件语法（`KEY=value`，不加 `export`，不使用 shell 展开），目录与沙箱设置应和服务单元一致。systemd 在以 `dwell` 身份启动服务前读取这个仅 root 可读的文件，`ExecStart` 不让 Node 再读一次。不要在 `app/` 中放第二份 `.env`，也不要把整个 `/opt/dwell` 改为运行用户所有。

其他[模型模板](configuration.zh-CN.md)复用同一加载器与连接结构。模型文件与凭证放在代理工作区之外，JSON 只保存密钥变量名。启动时拒绝位于数据、临时或已有会话目录中的配置，包括可写目录内的软链入口；显式配置缺失或无效也会使启动失败。修改连接前，先完成或取消仍在等待模型响应的请求，再重启。请求检查点保留原模型引用；如果新配置无法解析旧引用，启动会保留检查点并拒绝续跑。后续请求的主会话和后台会话设置会统一对齐。未选择模型文件且默认路径下也没有文件时，仍兼容旧环境变量配置。

<a id="3-systemd-unit"></a>
<a id="systemd-unit"></a>

## systemd 服务单元

用 `sudoedit` 创建 `/etc/systemd/system/dwell.service`（root 所有，权限 644）：

```ini
[Unit]
Description=dwell agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dwell
Group=dwell
WorkingDirectory=/opt/dwell/app
EnvironmentFile=/opt/dwell/.env
Environment=PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin
Environment=DWELL_DATA=/opt/dwell/data
Environment=DWELL_STATE=/opt/dwell/state
Environment=NODE_ENV=production
Environment=DWELL_SANDBOX=required
ExecStart=/opt/node/bin/node src/index.ts
Restart=always
RestartSec=5
TimeoutStopSec=35s
KillMode=mixed
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/dwell/data /opt/dwell/state
ProtectHome=true
PrivateTmp=true
StandardOutput=journal
StandardError=journal
MemoryMax=1200M
OOMPolicy=continue

[Install]
WantedBy=multi-user.target
```

`Restart=always` 在存储失败（`session_failed`）和主进程退出后拉起 dwell；显式执行 `systemctl stop` 后保持停止。`KillMode=mixed` 先只向主进程发送 SIGTERM，让 dwell 有时间保存检查点并关闭子进程。`TimeoutStopSec=35s` 为应用的 30 秒退出期限留出余量；主进程退出或停止超时后，systemd 强杀剩余进程。详见[进程终止配置](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html)。输出和启动错误进入 systemd 日志。反复失败触发 systemd 启动频率限制时，先修复日志里的原因，再执行 `systemctl reset-failed dwell` 和 `systemctl start dwell`。详见[服务重启与停止配置](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)。

`ProtectSystem=strict` 将普通宿主文件系统路径设为只读，两个 `ReadWritePaths` 和私有临时目录除外。root 所有权也能保护 systemd 之外维护命令所访问的代码和配置。`PrivateTmp=true` 给服务独立的 `/tmp`，沙箱里的 bash 也使用它，服务停止后清理。保留 bubblewrap 所需的命名空间；额外的命名空间或系统调用限制可能使启动探测失败。详见[文件系统与环境配置](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)。

`ProtectKernelTunables=yes` 会遮蔽部分 `/proc`，可能导致非特权 bubblewrap 无法挂载自己的 proc 文件系统，因此本例不启用它。保留专用用户、文件系统限制和必需的沙箱探测；增加此选项前应验证它们能否一起工作。

`MemoryMax=1200M` 是整个服务单元物理内存记账上限的示例值，包含 Node 和子进程，要按主机容量与实测负载调整。交换空间单独计算：增加交换空间不会提高 `MemoryMax`；支持的系统可用 `MemorySwapMax=` 限制交换空间用量，该设置不会创建交换空间。内存不足（OOM）可能杀死主进程，`OOMPolicy=continue` 不能选择被杀的进程；主进程退出后按重启策略处理。详见[内存与交换空间限制](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html#MemoryMax=bytes)。任务需要使用不同于服务器的时区时，在 `.env` 设置 `DWELL_TZ`（如 `Asia/Shanghai`）。

启动前先按下文安装并检查 bubblewrap。在目标主机验证服务单元；`verify` 检查服务单元配置，不能代替沙箱和机器人流程验证：

```sh
sudo systemd-analyze verify /etc/systemd/system/dwell.service
sudo systemctl daemon-reload
sudo systemctl enable --now dwell
sudo systemctl status dwell --no-pager
sudo journalctl -u dwell -b -n 100 --no-pager
sudo journalctl -u dwell -f
```

启动时要看的日志：

- `[dwell] bash 沙箱已启用（wrapper: …）`：沙箱已启用。`required` 模式在探测失败时拒绝启动；`auto` 允许日志中提示的路径治理回退
- `[dwell] panel: http://…`：面板已监听
- `[dwell] 就绪（飞书: <名字或 off>，Telegram: <用户名或 off>）`：所选机器人已初始化；当前连接状态查看 `/healthz`

<a id="4-bash-沙箱"></a>

## bash 沙箱

沙箱需要 bubblewrap 和非特权用户命名空间。`DWELL_SANDBOX` 只接受 `required`、`auto` 或 `off`，其他值使启动失败。`NODE_ENV=production`（包括上面的服务单元）默认采用 `required`：启动探测失败就停止服务，不恢复持久化任务。`auto` 明确允许回退到路径检查，是非生产环境的默认值；`off` 关闭沙箱。生产应保留 `required`，除非运维已配置并接受其他隔离边界。

```sh
sudo apt install bubblewrap
sudo -u dwell bwrap --ro-bind / / --unshare-user --unshare-pid --proc /proc /usr/bin/true
```

这只是初步检查，最终以服务实际的启动探测为准。Ubuntu 启用 AppArmor 用户命名空间限制时，通用的 `unshare -Ur true` 可能被拒绝，而专用 bubblewrap 策略仍可允许 `bwrap` 运行。bubblewrap 被拒绝时，先检查内核/AppArmor 拒绝日志，再为实际安装的可执行文件采用发行版支持的策略。Ubuntu 的 [AppArmor 用户命名空间限制说明](https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007)介绍了适用于该情形的受限 bwrap 策略。策略应匹配发行版的 AppArmor ABI，并审核对其他应用的影响；不要为通过探针而全局关闭 AppArmor 或用户命名空间限制。

服务启动后，用和服务单元相同的 Node 路径及不含密钥的目录、面板设置运行探针：

```sh
cd /opt/dwell/app
sudo -u dwell env -i PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin DWELL_DATA=/opt/dwell/data DWELL_STATE=/opt/dwell/state \
  DWELL_PANEL_PORT=<端口> DWELL_PANEL_HOST=<地址> /opt/node/bin/node test/probe-bwrap.ts
```

每一行都应是 `PASS`：状态目录、应用目录、其他会话目录不可见；工作目录可写；`/usr` 只读；环境里没有密钥；DNS 正常；`/proc/1` 是沙箱的初始进程；沙箱内访问面板时 `/api/approvals` 返回 403、`/healthz` 返回 200。`DWELL_DATA` 和 `DWELL_STATE` 必须显式传入，否则探针回退到 `./data`，会把测试目录建进应用目录。

探针在服务单元之外运行，服务自身的启动探测也必须通过。探针会根据自身环境重写共享包装脚本 `data/bin/sandbox-bash`；运行后重启服务，按服务设置重新生成包装脚本，包括 [GitHub 接入](github.zh-CN.md)的环境。

`test/probe-scrub.ts` 检查凭证是否已从 `/proc/<pid>/environ` 清除，用法见文件头注释。

`test/probe-proc.ts` 验证托管后台进程（`dwell.proc`）在沙箱下的真实行为：进程在创建调用结束后仍存活、终止进程组能清掉 PID 命名空间内包括 `setsid` 孙进程在内的进程、进程启动的服务能被其他 bash 调用连上、输出写入日志。运行方法同 `probe-bwrap.ts`（需沙箱已启用）。

<a id="5-panel-与网络"></a>
<a id="panel-与网络"></a>

## 面板与网络

原生服务与 bubblewrap 共用宿主网络命名空间。沙箱限制文件系统和进程可见性，不阻止访问其他本机服务、私网地址或云元数据端点。共享主机在接受不可信 shell 任务前，需要另行审核并配置针对服务身份的出站策略，或使用合适的容器/虚拟机边界。下述面板检查只保护面板。

面板没有登录。保护它的是网络，加上服务端的两道检查：

- **请求准入**：POST 只收 JSON，`Origin` 必须同源，`Host` 必须是 IP 字面量或配置过的主机名
- **本机来源拒绝**：来自服务器本机（回环或任一本机接口地址）的请求，除 `/healthz` 外一律 403。bash 跑在同一台机器上，靠这道检查才能阻止代理调用面板批准自己的命令

所以面板必须从**另一台机器**打开。常见做法：

- 把面板绑定到内网或 VPN 接口：`DWELL_PANEL_HOST=10.8.0.1`、`DWELL_PANEL_PORT=7788`
- 从工作机经这个网络访问（WireGuard、内网等）
- 希望通知带面板链接，或用域名而不是 IP 打开面板时，设置 `DWELL_PANEL_URL`
- 在服务器本机做健康检查只能访问 `/healthz`，其他路径在本机都返回 403

请求策略同样适用于就绪、运行观测和工作验收 API。策略见[安全边界](security.zh-CN.md)，健康与观测接口见[运行告警](#运行告警)，验证与操作者验收见[代理运行机制](agent.zh-CN.md)，面板功能见[使用指南](usage.zh-CN.md#web-panel)。

同机反代或 `ssh -L` 隧道会让所有请求都显示为本机来源，面板会全部拒绝。`DWELL_PANEL_TRUST_LOCAL=1` 可以为这类部署关掉本机来源检查，代价是 bash 又能访问面板及其审批接口。优先选择浏览器从另一台机器直连的部署。

想在服务器上多加一层，可以用防火墙规则禁止服务用户连接面板端口，不依赖 dwell 自身的检查：

```sh
iptables -A OUTPUT -m owner --uid-owner dwell -p tcp --dport 7788 -m addrtype --dst-type LOCAL -j REJECT
```

加了这条规则后，探针里沙箱内访问 `/healthz` 的检查也会失败，这是预期行为。

<a id="6-更新"></a>

## 更新

dwell 没有构建步骤。部署前确认选定版本的 `npm run check` 和 `npm test` 通过。先准备归 root 所有的新应用目录，再停止服务及所有其他工作区写入者，取得配套备份。停服务会中断托管进程，需先安排好这些进程的中断。SIGINT/SIGTERM 关闭期限为 30 秒，`TimeoutStopSec` 至少保留 35 秒。

```sh
# 在进入已安装的应用目录前，从验证过的发布版本 checkout 中执行。
ts=$(date +%Y%m%d-%H%M%S)
next=/opt/dwell/app-next-$ts
backup=/opt/dwell/backup-$ts
sudo install -d -o root -g root -m 755 "$next"
git archive HEAD | sudo tar -x -C "$next"
sudo env PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin /opt/node/bin/npm ci --prefix "$next" --omit=dev
sudo chown -R root:root "$next"
sudo chmod -R u=rwX,go=rX "$next"
sudo systemctl stop dwell
# 确认其他工作区写入者均已停止；--stopped 记录运维对此的确认
cd /opt/dwell/app
sudo /opt/node/bin/node src/backup.ts create --data /opt/dwell/data --state /opt/dwell/state \
  --code /opt/dwell/app --models /opt/dwell/models.json --env /opt/dwell/.env \
  --output "$backup" --stopped
sudo /opt/node/bin/node src/backup.ts verify --backup "$backup"
cd /opt/dwell
sudo mv app "app-before-$ts"
sudo mv "$next" app
# unit 有变化时，先运行 systemd-analyze verify 和 systemctl daemon-reload。
sudo systemctl start dwell
curl -s http://<panel 地址>:<端口>/healthz    # 在服务器上：{"ok":true,...,"sandbox":true}
sudo journalctl -u dwell -b -n 100 --no-pager
```

任一准备、备份或验证命令失败都应停止操作。备份以 root 运行，因为 `.env` 仅 root 可读，输出位于 root 所有的 `/opt/dwell` 下；执行者需要读取全部输入，并能写入输出目录的父目录。命令不需要在环境中加载机器人凭证。更新验收前保留旧应用目录，它不能代替配套备份。模型配置或 `.env` 的改动也属于同一更新和恢复集合。

启动后查看健康状态与运行告警，确认模型连接符合预期，再经各个已配置的机器人或可信面板验证一个任务及已有的待审续跑。`/healthz` 包含 `feishu`、`telegram`，连接为 `failed` 时返回 503。运行任务会从检查点恢复，并继续受持久化预算约束。旧后台子会话没有访问角色时，恢复前变为只读；需要 shell 或编辑的任务须停止后以 `mode: "write"` 重新启动。已经绑定到执行轮次的预算限额保持冻结，不随环境默认值变化；执行阶段的停机时间可能耗尽期限，该轮结束后的审批等待不计。托管进程按中断报告，不自动重跑。

备份 CLI 将数据、状态、运行源码/配置文件和依赖锁文件（不含应用的 `node_modules`）、选定的模型 JSON，以及可选的环境文件复制到一个新私有目录；`data/work/` 下的工作区依赖仍会备份。`backup-manifest.json` 保存 SHA-256 校验和与权限，SQLite 完整性在临时副本中检查。只允许保留 `data/work/` 内部的软链接本身，不跟随目标；外部目标内容需单独备份，恢复时需核对或重映射。`data/work/` 本身被替换成软链，或状态、应用和配置中出现软链，以及任何特殊文件，都会被拒绝。`--stopped` 是运维确认，不会自动停写，也不提供在线快照。输出必须是代码、数据、状态目录之外的新目录。模型配置放在别处时调整 `--models`，外部服务凭证需另行保留。

`data/dwell.sqlite`（连同 `-wal`/`-shm` 文件）保存会话、运行预算、工作记录、工作区写租约与 Telegram 路由、收件队列、输入及命令回执。`state/` 保存路由、用户、审批决定/投递记录、Telegram 游标、私有进程日志和 `runtime-telemetry.json`；本机目录布局将模型配置放在 `/opt/dwell/models.json`。观测快照最多保留 256 个指标序列与 200 个已结束的追踪片段，不含提示词、工具参数/结果或错误正文。整个备份应按线上凭证保护；只备份数据库不能得到配套的 JSON/配置。

中断前已保存的审批决定会在启动时及退避重试中使用同一投递身份；状态保存失败保留原待审请求与窗口，重放不延长原到期时间。旧待审记录没有预算 ID 时，首次续跑创建预算。旧飞书卡缺少持久化请求 ID 时会被拒绝，需重新请求或由运维处理。这些重启恢复规则不承诺外部副作用恰好执行一次，也不承诺机器断电后的持久性。

先验证备份，再恢复到新的暂存目录：

```sh
restore=/opt/dwell/restore-$ts
sudo /opt/node/bin/node /opt/dwell/app/src/backup.ts verify --backup "$backup"
sudo /opt/node/bin/node /opt/dwell/app/src/backup.ts restore --backup "$backup" --output "$restore"
```

恢复会再次检查校验和与 SQLite，不替换或启动生产服务。以 root 运行 CLI 后，文件与私有目录归 root 所有，文件的组和其他用户权限会被去除。验证后先准备运行所需的属主与依赖，再安装恢复出的集合：

```sh
sudo chown -R root:root "$restore/app"
sudo env PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin /opt/node/bin/npm ci --prefix "$restore/app" --omit=dev
sudo chmod -R u=rwX,go=rX "$restore/app"
sudo chown -hR dwell:dwell "$restore/data" "$restore/state"
sudo chown root:dwell "$restore/models.json"
sudo chmod 640 "$restore/models.json"
sudo chown root:root "$restore/.env"
sudo chmod 600 "$restore/.env"
```

调整属主和权限是清单验证后的部署准备，会改变清单记录的恢复文件权限。检查 `.env` 和选定模型路径。保留原有会话工作区的绝对路径：持久化会话与检查点可能含有这些路径，CLI 不会重写；移动数据后只改 `DWELL_DATA` 不够。任务恢复演练应在隔离主机保留原路径，并保持机器人入口断开；暂存目录本身只代表已验证的文件集合。生产回滚需先停全部写入者、保留升级后的产物、核对外部副作用，再由运维替换配套的代码/配置/数据/状态并检查属主，最后启动。CLI 不执行生产替换。

进程日志位于 `$DWELL_STATE/proc-logs/<conversationId>/<taskId>.log`；代理通过 `dwell.proc.logs` 读取，不使用工作区路径。按每份日志最多 50 MiB、已结束日志保留 7 天预留磁盘容量；启动和任务结束时清理过期终态日志，活跃日志保留。升级保留旧工作区的 `.dwell-proc/` 文件，不导入，也不重新打开旧检查点中的日志路径。旧运行进程按中断回报，新工具不能读取旧格式日志。

命令退出或停止后，输出管道只等待有限时间排空。若后代进程继续持有管道，任务报告输出不完整，不会无限等待。没有沙箱时，脱离原进程组的后代仍可能存活；有界输出收尾不能替代 PID namespace 或服务管理器的进程清理。

附件仍保存在各工作区可写的 `uploads/` 下。任务恢复前登记工作区根身份；根目录或上传目录被替换成链接时上传失败。Linux 的固定写入器经过现有沙箱；没有沙箱时，目录检查不能隔离同 UID 的不受约束进程。在独立 Linux 环境安装 bubblewrap 后，运行 `node test/probe-uploads.ts` 验证真实写入器、stdin 字节及目录替换处理；和其他沙箱探针一样，将 `DWELL_DATA`、`DWELL_STATE` 显式设在 `/tmp` 之外。Windows 拒绝附件上传，不回退到不受约束的宿主写入。

## 运行告警

任务故障或挂起（`faulted`/`parked`）、扩展钩子抛错、会话失败等运行故障会记入日志，并在相应机器人连接时，通过管理员所属平台私聊通知。Telegram 管理员需先私聊启动机器人。同类告警（按类型、扩展、任务类型）10 分钟内只发送第一条，被抑制的数量并入下一条。机器人不可用时，告警保留在日志中。

`session_failed` 表示存储层失败，进程已不可用。尽力通知管理员后，dwell 会退出，由 systemd 或 Docker 重启，部署时需配置自动重启。面板侧栏在内存中保留最近 50 条告警，包含被抑制的条目（`GET /api/reports`），重启即清。

### 健康与观测

外部探活使用面板端口的 `GET /healthz`，返回 `{ ok, uptimeSec, feishu, telegram, sandbox }`。未启用或仅面板模式时，对应机器人状态为 `off`；`sandbox` 表示 bash 沙箱是否启用。任一机器人连接为 `failed` 时返回 503。服务器本机仍可访问此接口。

`GET /api/ready` 在启动完成后返回 200 与 `{ ready }`，不可用或关闭期间返回 503；`GET /api/runtime` 提供 SDK 指标与最近的追踪片段。两者沿用可信面板策略，包括本机来源拒绝。观测不保存提示词、工具参数、工具结果或错误正文。私有文件 `$DWELL_STATE/runtime-telemetry.json` 跨重启最多保留 256 个指标序列和 200 个已结束追踪片段，用于有界排查。

SIGINT/SIGTERM 会停止输入、关闭运行时并刷盘观测数据，关闭期限为 30 秒，超时以非零退出码结束。服务管理器必须预留这段关闭时间。

### 模型连接故障

模型认证、访问、账户限额和配置错误会停止任务，不会因远端正文出现重试措辞就继续重试。聊天与面板给出具体原因，不显示响应体。临时故障仍受配置的重试与运行限额约束，上下文溢出保留 SDK 压缩行为。已完成工作继续保留。访问或地域限制需由运维处理连接，dwell 不会自动切换提供方。

<a id="7-github可选"></a>

## 可选 GitHub 接入

专用账号与令牌、宿主 git 配置、可选签名、分叉仓库的 CI、验证和凭证吊销见 [GitHub 接入](github.zh-CN.md)。

<a id="8-docker"></a>

## Docker

Compose 服务以非 root 的 `dwell` 用户运行，通过 `init: true` 回收孤儿子进程，并挂载 `./data` 和 `./state`。单独启动容器时用 `docker run --init`。模型设置放在状态卷时，把模板复制到 `./state/models.json`，在 `.env` 里设 `DWELL_MODELS_FILE=/state/models.json`，填写 `apiKeyEnv` 指定的密钥。

镜像设置了 `NODE_ENV=production`，但不包含 bubblewrap，因此默认 `required` 策略拒绝启动。可以提供派生镜像及容器配置使沙箱探测通过；也可以在配置妥当的容器边界后，明确选择 `DWELL_SANDBOX=off`，或用 `auto` 允许回退。服务不会静默降低生产策略。完成后运行 `docker compose up -d --build`；关闭时至少等 30 秒（例如 `docker compose stop -t 35`）。停止服务后，在 Node 26 宿主机上用备份 CLI 一起备份两个卷和配置。这种形态的限制：

- `off` 或 `auto` 探测失败时，隔离靠容器边界；路径与命令检查本身不能限制 shell 的访问范围
- `docker-compose.yml` 没有发布端口。要用面板需加 `ports:`，并绑定到内网接口（例如 `"10.8.0.1:7788:7788"`）
- 容器内 bash 和面板共用网络命名空间，本机来源检查照样能挡住 bash。宿主机经发布端口过来的请求，源地址应是 Docker 网桥网关（不属于容器自身地址），因此会被接受。这一点未经测试，依赖它之前先验证

已有 Docker 实例迁移到 systemd 时，先停止容器和所有其他写入者，再为宿主挂载的数据/状态目录、应用、模型 JSON 与 `.env` 取得配套备份。原生实例使用同一机器人身份期间，容器保持停止。Docker 会话通常保存 `/data/work/` 下的绝对工作区路径，宿主需保留 `/data` 实体目录，或使用经过明确配置的绑定挂载；原状态路径是 `/state` 时也保留它。服务单元的 `DWELL_DATA`、`DWELL_STATE` 与 `ReadWritePaths` 使用这些保留路径，替代首次安装示例中的 `/opt/dwell/data` 和 `/opt/dwell/state`。按上文恢复属主边界，将选定模型 JSON 放到 root 所有的 `/opt/dwell/models.json`，并更新 `.env`。不要用软链接或只改环境变量来移动已有会话工作区；备份 CLI 不迁移持久化路径。
