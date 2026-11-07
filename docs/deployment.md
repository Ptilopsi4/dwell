# Deployment

English | [简体中文](deployment.zh-CN.md)

This guide covers a production setup on a Linux server: the Feishu app, the host layout, a systemd unit, the bash sandbox, and how to place the panel on the network. The Docker form is described at the end. Configuration variables are listed in the [README](../README.md#configuration).

## 1. Feishu app

dwell uses the long connection (WebSocket) of the official SDK, so the server needs outbound internet access but no public address.

1. In the Feishu developer console, create a **custom app** (long connection only works for custom apps) and enable the **bot** capability.
2. **Events**: choose "receive events through a long connection" and subscribe to `im.message.receive_v1` (receive messages).
3. **Callbacks**: choose "receive callbacks through a long connection" and subscribe to `card.action.trigger` (card interaction). Approval card buttons depend on it.
4. **Permissions** that the features rely on:

   | Scope | Used for |
   |---|---|
   | `im:message`, `im:message:send_as_bot` | Send and update messages |
   | `im:message.p2p_msg:readonly` | Receive direct messages |
   | `im:message.group_at_msg:readonly` | Receive @bot messages in groups |
   | `im:message.group_msg` | Receive all group messages (replies without @, topic groups) and read history for `dwell.lark.read`; needs admin approval |
   | `im:resource` | Download images and files from messages, upload files for `dwell.lark.send` |
   | `cardkit:card:write` | Streaming reply cards |
   | `contact:user.base:readonly` | Show user names |
   | `im:chat:readonly` | Show group names |

   Scope names change over time; check them against the console. When a scope is missing, the Feishu API error names it, and dwell logs the error.
5. Publish a version of the app so the permissions take effect, then add the bot to the groups it should serve.

The events of one app are spread across all connected clients at random. Run exactly one dwell instance per app, and use a separate app for local testing.

## 2. Host layout

Run dwell as a dedicated non-root user. A layout that keeps code, data, and state apart:

```
/opt/dwell/
  app/     code (src/, test/, package.json, node_modules/)
  data/    DWELL_DATA: dwell.sqlite, work/<conversation>/
  state/   DWELL_STATE: users.json, sessions.json, message-map.json, approvals.json
  .env     credentials and settings, mode 600
```

```sh
sudo useradd --system --create-home --shell /usr/sbin/nologin dwell
sudo mkdir -p /opt/dwell/{app,data,state}
# copy the repository into /opt/dwell/app, then:
cd /opt/dwell/app && sudo -u dwell npm ci --omit=dev
sudo cp .env.example /opt/dwell/.env && sudo chmod 600 /opt/dwell/.env
sudo chown -R dwell:dwell /opt/dwell
```

Node ≥ 22.19 is required. If node is not on the system `PATH`, set `PATH` in the unit as below.

## 3. systemd unit

`/etc/systemd/system/dwell.service`:

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

Adjust the node path. `Restart=always` is required: after a storage failure (`session_failed`) dwell exits on purpose and relies on the restart. `PrivateTmp=true` gives the service its own `/tmp`, which is also the `/tmp` that sandboxed bash sees. The sandbox works under `NoNewPrivileges` and `ProtectSystem=strict`. Servers usually run in UTC: set `DWELL_TZ` (e.g. `Asia/Shanghai`) in `.env` so scheduled tasks and the date the model sees follow the intended timezone.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now dwell
journalctl -u dwell -f
```

The log lines to look for at startup (dwell logs in Chinese):

- `[dwell] bash 沙箱已启用（wrapper: …）`: the sandbox is on. Otherwise `[dwell] bash 沙箱未启用，回退路径治理：<reason>`
- `[dwell] panel: http://…`: the panel is listening
- `[dwell] 就绪（bot: <name>）`: connected to Feishu and ready

## 4. bash sandbox

The sandbox needs bubblewrap and unprivileged user namespaces. dwell probes for both at startup and runs without the sandbox when either is missing.

```sh
sudo apt install bubblewrap
sudo -u dwell unshare -Ur true && echo "userns ok"
```

If the `unshare` check fails, the distribution restricts unprivileged user namespaces (on Ubuntu 23.10 and later, AppArmor does this by default). Allowing it is a host-wide security decision; read your distribution's documentation before changing it.

After the service starts, check the sandbox from the inside with the probe, using the same environment as the unit:

```sh
cd /opt/dwell/app
sudo -u dwell env -i PATH=/usr/bin:/bin DWELL_DATA=/opt/dwell/data DWELL_STATE=/opt/dwell/state \
  DWELL_PANEL_PORT=<port> DWELL_PANEL_HOST=<host> node test/probe-bwrap.ts
```

Every line should be `PASS`: the state directory, the application directory, and other conversations' directories are invisible; the working directory is writable; `/usr` is read-only; the environment holds no secrets; DNS works; `/proc/1` is the sandbox's init; and from inside the sandbox the panel answers 403 on `/api/approvals` and 200 on `/healthz`. Pass `DWELL_DATA` and `DWELL_STATE` explicitly; without them the probe falls back to `./data` and creates its test directories inside the application directory.

`test/probe-scrub.ts` checks that credentials are removed from `/proc/<pid>/environ`. Its header comment explains how to run it.

## 5. Panel and network

The panel has no login. Its protection is the network plus two server-side checks:

- **Request admission**: JSON-only POST, same-origin `Origin`, and a `Host` that is an IP literal or a configured name
- **Local-source denial**: requests from the server itself (loopback or any local interface address) get 403, except `/healthz`. bash runs on the same host, so this check is what stops the agent from calling the panel to approve its own commands

So the panel must be opened from **another machine**. A common setup:

- Bind the panel to a private or VPN interface: `DWELL_PANEL_HOST=10.8.0.1`, `DWELL_PANEL_PORT=7788`
- Reach it from your workstation over that network (WireGuard, a private LAN, etc.)
- Set `DWELL_PANEL_URL` if notifications should link to the panel, or if you open it by a domain name instead of an IP
- Health checks from the server itself only work on `/healthz`; every other path returns 403 from the server

A reverse proxy or an `ssh -L` tunnel on the same host makes every request look local, and the panel refuses them all. `DWELL_PANEL_TRUST_LOCAL=1` turns the local-source check off for such setups, but then bash can reach the panel and its approval API again. Prefer a setup where the browser connects from another machine.

For extra protection on the server, a firewall rule can stop the service user from connecting to the panel port at all, independent of dwell's own check:

```sh
iptables -A OUTPUT -m owner --uid-owner dwell -p tcp --dport 7788 -m addrtype --dst-type LOCAL -j REJECT
```

With this rule in place, the probe's `/healthz` check from inside the sandbox fails as well; that is expected.

## 6. Updating

dwell has no build step. To update, back up, copy the new sources, and restart:

```sh
ts=$(date +%Y%m%d-%H%M%S)
sudo cp -a /opt/dwell/app/src /opt/dwell/backup-$ts-src
# copy the new src/ (and test/ for the probes) into /opt/dwell/app
sudo chown -R dwell:dwell /opt/dwell/app
sudo systemctl restart dwell
curl -s http://<panel host>:<port>/healthz    # from the server: {"ok":true,...,"sandbox":true}
```

Run `npm ci --omit=dev` again when `package-lock.json` changed. Before deploying, make sure `npm run check` and `npm test` pass. To roll back, copy the backup over `src/` and restart. Running tasks resume from their checkpoints after the restart.

For backups, `data/dwell.sqlite` (with its `-wal`/`-shm` files) holds all conversations and `state/` holds routing and users. Copy both while the service is stopped, or use `sqlite3 .backup` for the database.

## 7. Docker

`docker compose up -d --build` runs dwell as a non-root `dwell` user with `./data` and `./state` mounted. Limits of this form:

- The image does not include bubblewrap, and Docker's default seccomp profile usually blocks user namespaces, so the bash sandbox is off. The container boundary is the isolation layer
- `docker-compose.yml` publishes no ports. Add a `ports:` entry to use the panel, and keep it on a private interface (for example `"10.8.0.1:7788:7788"`)
- Inside the container, bash and the panel share the network namespace, so the local-source check still blocks bash. Requests from the host through the published port should arrive from the Docker bridge gateway, which is not a container address, and be accepted. This has not been tested; check it before relying on it
