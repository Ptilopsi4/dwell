# 部署

[English](deployment.md) | 简体中文

本文介绍在 Linux 服务器上的生产部署：飞书应用、主机目录布局、systemd unit、bash 沙箱，以及 panel 在网络里的位置。Docker 形态放在最后。配置变量见 [README](../README.zh-CN.md#配置)。

## 1. 飞书应用

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

## 2. 主机目录布局

用专用的非 root 用户运行 dwell。代码、数据、状态分开放：

```
/opt/dwell/
  app/     代码（src/、test/、package.json、node_modules/）
  data/    DWELL_DATA：dwell.sqlite、work/<会话>/
  state/   DWELL_STATE：users.json、sessions.json、message-map.json、approvals.json
  .env     凭证与配置，权限 600
```

```sh
sudo useradd --system --create-home --shell /usr/sbin/nologin dwell
sudo mkdir -p /opt/dwell/{app,data,state}
# 把仓库复制到 /opt/dwell/app，然后：
cd /opt/dwell/app && sudo -u dwell npm ci --omit=dev
sudo cp .env.example /opt/dwell/.env && sudo chmod 600 /opt/dwell/.env
sudo chown -R dwell:dwell /opt/dwell
```

需要 Node ≥ 22.19。node 不在系统 `PATH` 里时，按下面的 unit 设置 `PATH`。

## 3. systemd unit

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

node 路径按实际调整。`Restart=always` 是必需的：存储层失败（`session_failed`）后 dwell 会主动退出，靠它拉起。`PrivateTmp=true` 给服务独立的 `/tmp`，沙箱里 bash 看到的也是这个 `/tmp`，服务停止时 systemd 会清空它。`OOMPolicy=continue` 让 bash 命令超出 `MemoryMax` 时只杀掉该进程，服务继续运行。沙箱在 `NoNewPrivileges` 和 `ProtectSystem=strict` 下可以正常工作。服务器通常是 UTC 时区：在 `.env` 里设置 `DWELL_TZ`（如 `Asia/Shanghai`），定时任务的触发时间与模型看到的日期才会按预期时区解释。

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now dwell
journalctl -u dwell -f
```

启动时要看的日志：

- `[dwell] bash 沙箱已启用（wrapper: …）`：沙箱已启用。否则是 `[dwell] bash 沙箱未启用，回退路径治理：<原因>`
- `[dwell] panel: http://…`：panel 已监听
- `[dwell] 就绪（bot: <名字>）`：已连上飞书，可以使用

## 4. bash 沙箱

沙箱需要 bubblewrap 和非特权 user namespace。dwell 启动时探测两者，缺任何一个就不启用沙箱，照常运行。

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

探针会按自己的环境重写共用的 wrapper `data/bin/sandbox-bash`。配置了 GitHub（第 7 节）时，跑完探针要重启服务，wrapper 才会重新透传 `GH_TOKEN`。

`test/probe-scrub.ts` 检查凭证是否已从 `/proc/<pid>/environ` 清除，用法见文件头注释。

`test/probe-proc.ts` 验证托管后台进程（`dwell.proc`）在沙箱下的真实行为：进程活过 spawn 调用、组击杀能清掉 pidns 内含 `setsid` 孙进程、进程起的 server 能被其他 bash 调用连上、输出落日志。跑法同 `probe-bwrap.ts`（需沙箱已启用）。

## 5. Panel 与网络

panel 没有登录。保护它的是网络，加上服务端的两道检查：

- **请求准入**：POST 只收 JSON，`Origin` 必须同源，`Host` 必须是 IP 字面量或配置过的主机名
- **本机来源拒绝**：来自服务器本机（回环或任一本机接口地址）的请求，除 `/healthz` 外一律 403。bash 跑在同一台机器上，靠这道检查才能阻止 agent 调 panel 批准自己的命令

所以 panel 必须从**另一台机器**打开。常见做法：

- 把 panel 绑定到内网或 VPN 接口：`DWELL_PANEL_HOST=10.8.0.1`、`DWELL_PANEL_PORT=7788`
- 从工作机经这个网络访问（WireGuard、内网等）
- 希望通知带 panel 链接，或用域名而不是 IP 打开 panel 时，设置 `DWELL_PANEL_URL`
- 在服务器本机做健康检查只能访问 `/healthz`，其他路径在本机都返回 403

同机反代或 `ssh -L` 隧道会让所有请求都显示为本机来源，panel 会全部拒绝。`DWELL_PANEL_TRUST_LOCAL=1` 可以为这类部署关掉本机来源检查，代价是 bash 又能访问 panel 及其审批接口。优先选择浏览器从另一台机器直连的部署。

想在服务器上多加一层，可以用防火墙规则禁止服务用户连接 panel 端口，不依赖 dwell 自身的检查：

```sh
iptables -A OUTPUT -m owner --uid-owner dwell -p tcp --dport 7788 -m addrtype --dst-type LOCAL -j REJECT
```

加了这条规则后，探针里沙箱内访问 `/healthz` 的检查也会失败，这是预期行为。

## 6. 更新

dwell 没有构建步骤。更新时先备份，再复制新源码并重启：

```sh
ts=$(date +%Y%m%d-%H%M%S)
sudo cp -a /opt/dwell/app/src /opt/dwell/backup-$ts-src
# 把新的 src/（以及探针用的 test/）复制到 /opt/dwell/app
sudo chown -R dwell:dwell /opt/dwell/app
sudo systemctl restart dwell
curl -s http://<panel 地址>:<端口>/healthz    # 在服务器上：{"ok":true,...,"sandbox":true}
```

`package-lock.json` 有变化时重新执行 `npm ci --omit=dev`。部署前确认 `npm run check` 和 `npm test` 通过。回滚就把备份复制回 `src/` 再重启。重启后运行中的任务会从 checkpoint 续跑。

备份数据：`data/dwell.sqlite`（连同 `-wal`/`-shm` 文件）保存全部会话，`state/` 保存路由和用户。在服务停止时复制两者，或用 `sqlite3 .backup` 备份数据库。

## 7. GitHub（可选）

配置 `GH_TOKEN` 后，bash 里的 `gh` 与 `git` 以一个专用 GitHub 账号完成认证，dwell 以外部贡献者身份工作：fork 上游、push 到 fork、用 `gh pr create` 提 PR，不需要任何仓库的 collaborator 权限。

**账号与 token**

1. 为 dwell 建一个专用账号，邮箱设为运维能收到的地址：token 到期前 GitHub 会发邮件提醒
2. 建 **classic** personal access token，勾 `public_repo` 与 `workflow`，设到期日。fine-grained token 不能向账号不是成员的 public 仓库提 PR；不勾 `workflow` 时，上游一旦改过 `.github/workflows/`，`gh repo sync` 与 push 到 fork 都会失败
3. env 文件加 `GH_TOKEN=<token>`，重启

**commit 签名（可选）**

只有 git 在本地签名的 commit 才显示 Verified：personal access token 经 API 创建的 commit 不签名。用一把只用于签名的 SSH key：

```sh
sudo install -d -o root -g dwell -m 750 /etc/dwell
sudo ssh-keygen -t ed25519 -N "" -C "<account> signing" -f /etc/dwell/git-signing
sudo chown root:dwell /etc/dwell/git-signing /etc/dwell/git-signing.pub
sudo chmod 640 /etc/dwell/git-signing
```

把 `/etc/dwell/git-signing.pub` 添加到账号 Settings → SSH and GPG keys，类型选 **Signing Key**（不是认证 key，不能用来 push），再把下面模板里的签名段写进 `/etc/gitconfig`。key 放在 `/etc` 下是因为沙箱只读挂载 `/etc`，沙箱内的 git 能读到。需要 git 2.34 及以上。

启动时与之后每 24 小时，dwell 用 token 请求 `https://api.github.com/user`：返回 401、缺 `public_repo` 或 `workflow`、14 天内到期时私聊通知管理员。

**宿主配置（systemd）**

安装 `git` 与 `gh`（gh 用 GitHub 官方 apt 源），再写系统级 `/etc/gitconfig`。沙箱只读挂载 `/etc`，且 `HOME` 为工作目录，所以只有系统级 git 配置生效：

```ini
[user]
	name = <account>
	email = <ID>+<account>@users.noreply.github.com
[credential "https://github.com"]
	helper =
	helper = !/usr/bin/gh auth git-credential
[init]
	defaultBranch = main
[url "https://github.com/"]
	insteadOf = git@github.com:
	insteadOf = ssh://git@github.com/
# commit 签名（可选）
[gpg]
	format = ssh
[user]
	signingkey = /etc/dwell/git-signing.pub
[commit]
	gpgsign = true
[tag]
	gpgsign = true
```

`<ID>` 用 `gh api user --jq .id` 取。不配 `user.name`/`user.email` 时沙箱内 commit 会失败。noreply 地址算账号的已验证邮箱，签名后的 commit 显示 Verified。`insteadOf` 把 SSH URL（如 submodule）转成 HTTPS——沙箱内没有 SSH key。`GH_PROMPT_DISABLED`、`GIT_TERMINAL_PROMPT=0`、`GH_PAGER=cat` 以及把 `GH_CONFIG_DIR` 与 `XDG_STATE_HOME` 移出工作目录，dwell 会自行设置。

**构建检查与 CI**

bash 里的命令跑在服务的 cgroup 内，重型构建会和 dwell 抢同一份 `MemoryMax`。unit 加 `OOMPolicy=continue`（见第 3 节模板）：内存超限时内核只杀掉吃内存的进程，systemd 不会停掉整个服务。

系统提示让本地只做轻量检查（formatter、linter、改动包的构建与测试，套 `timeout` 和 `nice`），完整 CI 交给账号 fork 上的 GitHub Actions：push 之后模型用 `gh run` 跟进运行结果。账号的 Actions 保持开启；fork 没有 secrets，fork 的 `GITHUB_TOKEN` 只作用于 fork 本身。只在 `pull_request` 上触发、依赖 secrets 或 self-hosted runner 的 workflow 在 fork 上跑不起来，模型会说明哪些检查没跑。

本地检查用的工具链装在宿主：沙箱只读挂载 `/usr`，模型自己装不了。缓存要放在工作目录之外。以 Go 为例：官方 tarball 装到 `/usr/local/go`，把 `go`/`gofmt` 链接到 `/usr/bin`（在 `DWELL_TOOL_PATH` 内），默认值写进 `/usr/local/go/go.env`（Go 在环境变量之前读它）：

```ini
GOPATH=/tmp/dwell-go/path
GOCACHE=/tmp/dwell-go/cache
GOTOOLCHAIN=local
GOTELEMETRY=off
```

默认代理不可达时在这里加 `GOPROXY`/`GOSUMDB` 镜像。`GOTOOLCHAIN=local` 禁止 `go` 自行下载其他版本工具链。重装 Go 会覆盖 `go.env`，升级后要重写。

**容器**

仓库的 Dockerfile 不含 git 与 gh，需要时自建派生镜像安装并写 `/etc/gitconfig`。容器形态没有 bash 沙箱，`GH_TOKEN` 与全部环境变量对 bash 可见。

**验证**

- 启动日志出现 `[dwell] GH_TOKEN 自检通过`，`/healthz` 为 `"sandbox":true`；沙箱未启用时 bash 继承完整环境
- 在会话里让 dwell 执行 `gh auth status`
- 选一个近期改过 workflow 的上游：fork、`gh repo sync`、push 分支到 fork（commit 作者关联到该账号；配了签名时 `git log --show-signature -1` 显示签名有效、GitHub 显示 Verified）、提 PR；直接 push 上游必须得到 403
- 会话工作目录下没有 `.config/gh` 或 `.local/state/gh`

**风险**

这是「凭证不进 bash 可读面」的唯一例外：`gh` 与 `git` 从环境变量读凭证，`GH_TOKEN` 留在环境里。按「token 可能泄露」对待：

- 任何白名单成员都能让模型打印它，bash 输出在会话与 panel 中可见
- 仓库代码（依赖安装、构建脚本、测试）在模型没加 `env -u GH_TOKEN` 时带着 token 运行，而沙箱不隔离网络
- 仓库、issue 或网页里的内容可能诱导模型把 token 外发

签名私钥同样对 bash 可读。泄露后别人能以该账号身份生成显示 Verified 的 commit，但不能 push 或代表账号操作；在 GitHub 上删掉这把 Signing Key 即作废。

系统提示要求模型不泄露 token 和签名私钥、不带 token 运行仓库代码、把读到的内容当数据而不是指令。这些规则减少误操作，挡不住恶意成员或成功的 prompt injection。边界在账号层：账号名下不放其他资产，scope 只给 `public_repo` + `workflow`，设到期日，泄露即吊销。push 到 fork 或以该账号发出的内容是公开的，无法完全撤回。

## 8. Docker

`docker compose up -d --build` 以非 root 的 `dwell` 用户运行，挂载 `./data` 和 `./state`。这种形态的限制：

- 镜像里没有 bubblewrap，Docker 默认的 seccomp 配置通常也禁止 user namespace，所以 bash 沙箱不启用，隔离靠容器边界
- `docker-compose.yml` 没有发布端口。要用 panel 需加 `ports:`，并绑定到内网接口（例如 `"10.8.0.1:7788:7788"`）
- 容器内 bash 和 panel 共用网络命名空间，本机来源检查照样能挡住 bash。宿主机经发布端口过来的请求，源地址应是 Docker 网桥网关（不属于容器自身地址），因此会被接受。这一点未经测试，依赖它之前先验证
