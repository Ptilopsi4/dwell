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

[Install]
WantedBy=multi-user.target
```

node 路径按实际调整。`Restart=always` 是必需的：存储层失败（`session_failed`）后 dwell 会主动退出，靠它拉起。`PrivateTmp=true` 给服务独立的 `/tmp`，沙箱里 bash 看到的也是这个 `/tmp`。沙箱在 `NoNewPrivileges` 和 `ProtectSystem=strict` 下可以正常工作。

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

`test/probe-scrub.ts` 检查凭证是否已从 `/proc/<pid>/environ` 清除，用法见文件头注释。

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

## 7. Docker

`docker compose up -d --build` 以非 root 的 `dwell` 用户运行，挂载 `./data` 和 `./state`。这种形态的限制：

- 镜像里没有 bubblewrap，Docker 默认的 seccomp 配置通常也禁止 user namespace，所以 bash 沙箱不启用，隔离靠容器边界
- `docker-compose.yml` 没有发布端口。要用 panel 需加 `ports:`，并绑定到内网接口（例如 `"10.8.0.1:7788:7788"`）
- 容器内 bash 和 panel 共用网络命名空间，本机来源检查照样能挡住 bash。宿主机经发布端口过来的请求，源地址应是 Docker 网桥网关（不属于容器自身地址），因此会被接受。这一点未经测试，依赖它之前先验证
