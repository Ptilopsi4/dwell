# Deployment

English | [简体中文](deployment.zh-CN.md) | [README](../README.md)

Deploy dwell on Linux using a dedicated service user, systemd, and the bash sandbox, or use the [Docker setup](#docker). Configuration variables and model templates are listed in [Configuration](configuration.md). Bot commands and panel features are covered in [Usage](usage.md); optional contributor-account setup is covered in [GitHub integration](github.md).

<a id="1-bot-setup"></a>

## Bot setup

Enable Feishu, Telegram, or both. Telegram-only needs no `LARK_APP_ID` or `LARK_APP_SECRET`. Both entry points use the same model configuration, roles, budgets, and workspace rules.

### Feishu (optional)

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

### Telegram (optional)

1. Create a bot with BotFather and put its token in `TELEGRAM_BOT_TOKEN` in the private environment file. Keep group privacy mode enabled. The host needs outbound HTTPS access to the Bot API; long polling needs no public inbound endpoint.
2. Obtain your user ID before the first start with permanent state. If it is unknown, use the separate bootstrap directories below, start a private chat, send `/whoami`, and stop the temporary process after receiving `tg:<numeric user ID>`. Set `DWELL_ADMINS` to that ID, then start the permanent instance for the first time. An existing `state/users.json` overrides environment seeds; use an existing admin's `/allow tg:123456789 admin` or the trusted panel to update it. Telegram admins and the panel operator must start a private chat before the bot can notify them.
3. For groups, invite the bot and send `/whoami@your_bot` to obtain the raw numeric chat ID, even before the group is enabled. A dwell admin can enable the current group with `/allowchat@your_bot` or its Enable this group button, or send `/allowchat -1001234567890` privately. `/disallowchat` and `/chats` manage the persisted list without restarting. `DWELL_TELEGRAM_CHATS` supplies first-start seeds only; an existing bot record in `$DWELL_STATE/telegram-chats.json` takes precedence, including an empty list. The sender must also be an allowed user. Use `/ask@your_bot text` or reply to this bot; plain mentions do not start tasks.
4. Keep one polling instance per token. Startup refuses a configured webhook and leaves it in place. Resolve the webhook separately before enabling long polling. A 401 authentication failure or 409 polling conflict stops the service with a nonzero exit code; correct the token or stop the competing client before restarting. Transient transport failures retry indefinitely with capped backoff. Do not start a local copy with the production token.

For ID discovery only, run this from a checkout with dependencies installed and the model key and bot token filled in. Stop any other instance using the token first:

```sh
DWELL_DATA=./data/bootstrap DWELL_STATE=./state/bootstrap npm start
```

This does not create the default `state/users.json`. After discovery, stop the process and start the permanent instance without these directory overrides; do not reuse the bootstrap state as permanent state.

Store the token outside agent workspaces. It is captured before environment scrubbing, and transport errors omit token-bearing URLs. Preserve `$DWELL_STATE/telegram/` polling cursors together with the database input/command receipts when backing up or restoring. Inputs have stable request IDs; outgoing delivery can still be uncertain if a network response is lost.

Check the [durable input and recovery rules](agent.md) in the isolated test bot before rollout, including ordered route processing, pending-input cancellation, answer deduplication, pending approval delivery, and legacy inputs without a trustworthy actor.

Before enabling a production token, use a dedicated test bot, isolated data/state directories, and a test group to check private text, directed group commands, replies, attachments, dangerous-command approval, `/new`, and restart recovery. Keep privacy mode enabled during these checks. Automated tests with mocked Bot API responses do not establish live or production acceptance.

<a id="2-host-layout"></a>

## Host layout

Run dwell as a dedicated non-root user. A layout that keeps code, data, and state apart:

```
/opt/dwell/
  app/     code (src/, test/, templates/, package.json, node_modules/)
  data/    DWELL_DATA: dwell.sqlite, work/<conversation>/
  state/   DWELL_STATE: user/session/approval JSON, models.json, telegram/ cursors, private proc-logs/
  .env     credentials and settings, mode 600
```

```sh
sudo useradd --system --create-home --shell /usr/sbin/nologin dwell
sudo mkdir -p /opt/dwell/{app,data,state}
# copy the repository into /opt/dwell/app, then:
cd /opt/dwell/app && sudo -u dwell npm ci --omit=dev
sudo cp .env.example /opt/dwell/.env && sudo chmod 600 /opt/dwell/.env
sudo cp templates/models.openai-responses.json /opt/dwell/state/models.json
sudo chmod 600 /opt/dwell/state/models.json
sudo chown -R dwell:dwell /opt/dwell
```

Node ≥ 26 is required. If node is not on the system `PATH`, set `PATH` in the unit as below.

Edit `/opt/dwell/.env`: set `DWELL_MODELS_FILE=/opt/dwell/state/models.json`, fill `OPENAI_API_KEY` (the template's `apiKeyEnv`), and configure the chosen bot credentials and allowlists. Other [model templates](configuration.md) use the same loader and connection structure. Keep the model file and credentials outside agent workspaces; the JSON contains key variable names only. Startup rejects a selected model file in data, temporary or existing conversation directories, including writable aliases. An explicit missing/invalid configuration also fails startup. Before changing a connection, finish or cancel requests still waiting on a model response, then restart. Request checkpoints keep their original model references; startup preserves them and refuses to resume if the new configuration cannot resolve them. Main and background conversation settings are aligned for subsequent requests. Legacy environment configuration still applies when no model file is selected or present at the default path.

<a id="3-systemd-unit"></a>

## systemd unit

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
OOMPolicy=continue

[Install]
WantedBy=multi-user.target
```

Adjust the node path. `Restart=always` is required: after a storage failure (`session_failed`) dwell exits on purpose and relies on the restart. `PrivateTmp=true` gives the service its own `/tmp`, which is also the `/tmp` that sandboxed bash sees; systemd empties it when the service stops. `MemoryMax` limits the whole unit, so the kernel can select the main Node process as an OOM victim. `OOMPolicy=continue` controls the unit's response after a process is killed; it does not select the victim. If the main process is killed, `Restart=always` restarts dwell, which follows the checkpoint and persisted-budget recovery rules below. See [systemd memory limits](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html#MemoryMax=bytes) and [OOM policy](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html#OOMPolicy=). Size `MemoryMax` for the heaviest workload you expect the model to run: a single Go `compile` process can take ~1GB, so a build inside a 1200M cgroup can trigger repeated OOM kills (the model may retry, but completion is unreliable). Raise `MemoryMax` on beefier machines, or accept that heavy builds belong on the fork's CI. The sandbox works under `NoNewPrivileges` and `ProtectSystem=strict`. Servers usually run in UTC: set `DWELL_TZ` (e.g. `Asia/Shanghai`) in `.env` so scheduled tasks and the date the model sees follow the intended timezone.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now dwell
journalctl -u dwell -f
```

The log lines to look for at startup (dwell logs in Chinese):

- `[dwell] bash 沙箱已启用（wrapper: …）`: the sandbox is on. `required` mode refuses startup on a failed probe; `auto` permits the logged fallback to path checks
- `[dwell] panel: http://…`: the panel is listening
- `[dwell] 就绪（飞书: <name or off>，Telegram: <username or off>）`: configured bots initialized; check `/healthz` for their current connection states

<a id="4-bash-sandbox"></a>

## bash sandbox

The sandbox needs bubblewrap and unprivileged user namespaces. `DWELL_SANDBOX` accepts `required`, `auto`, or `off`; other values fail startup. With `NODE_ENV=production` (including the unit above), the default is `required`: a failed startup probe stops the service before durable tasks resume. `auto` explicitly permits fallback to path checks, and is the default outside production; `off` disables the sandbox. Keep production on `required` unless an operator has configured and accepted another isolation boundary.

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

The probe rewrites the shared wrapper `data/bin/sandbox-bash` from its own environment. With [GitHub integration](github.md) configured, restart the service after running it so the wrapper passes `GH_TOKEN` again.

`test/probe-scrub.ts` checks that credentials are removed from `/proc/<pid>/environ`. Its header comment explains how to run it.

`test/probe-proc.ts` verifies the real behavior of managed background processes (`dwell.proc`) under the sandbox: a process survives its spawn call, a group kill clears the pid namespace including `setsid` grandchildren, a server started by a process is reachable from other bash calls, and output lands in the log. Run it the same way as `probe-bwrap.ts` (sandbox must be enabled).

<a id="5-panel-and-network"></a>

## Panel and network

The panel has no login. Its protection is the network plus two server-side checks:

- **Request admission**: JSON-only POST, same-origin `Origin`, and a `Host` that is an IP literal or a configured name
- **Local-source denial**: requests from the server itself (loopback or any local interface address) get 403, except `/healthz`. bash runs on the same host, so this check is what stops the agent from calling the panel to approve its own commands

So the panel must be opened from **another machine**. A common setup:

- Bind the panel to a private or VPN interface: `DWELL_PANEL_HOST=10.8.0.1`, `DWELL_PANEL_PORT=7788`
- Reach it from your workstation over that network (WireGuard, a private LAN, etc.)
- Set `DWELL_PANEL_URL` if notifications should link to the panel, or if you open it by a domain name instead of an IP
- Health checks from the server itself only work on `/healthz`; every other path returns 403 from the server

The request policy also applies to readiness, runtime, and work-acceptance APIs. See [Security boundaries](security.md) for the policy, [Runtime alerts](#runtime-alerts) for health and telemetry, and [Agent behavior](agent.md) for verification and operator acceptance. Panel features are described in [Usage](usage.md#web-panel).

A reverse proxy or an `ssh -L` tunnel on the same host makes every request look local, and the panel refuses them all. `DWELL_PANEL_TRUST_LOCAL=1` turns the local-source check off for such setups, but then bash can reach the panel and its approval API again. Prefer a setup where the browser connects from another machine.

For extra protection on the server, a firewall rule can stop the service user from connecting to the panel port at all, independent of dwell's own check:

```sh
iptables -A OUTPUT -m owner --uid-owner dwell -p tcp --dport 7788 -m addrtype --dst-type LOCAL -j REJECT
```

With this rule in place, the probe's `/healthz` check from inside the sandbox fails as well; that is expected.

<a id="6-updating"></a>

## Updating

dwell has no build step. Before deploying, make sure `npm run check` and `npm test` pass. Stop the service and every other workspace writer for a matching backup, then copy the new sources and start it. Stopping interrupts managed processes, so arrange for their interruption first. SIGINT/SIGTERM have a 30-second shutdown deadline; allow the service manager at least that long before forced termination.

```sh
ts=$(date +%Y%m%d-%H%M%S)
backup=/opt/dwell/backup-$ts
sudo systemctl stop dwell
# confirm every other workspace writer is stopped; --stopped records this operator acknowledgement
cd /opt/dwell/app
sudo -u dwell npm run backup -- create --data /opt/dwell/data --state /opt/dwell/state \
  --code /opt/dwell/app --models /opt/dwell/state/models.json --env /opt/dwell/.env \
  --output "$backup" --stopped
sudo -u dwell npm run backup -- verify --backup "$backup"
# copy the new release sources and package files, including templates/, into /opt/dwell/app
# run npm ci --omit=dev in /opt/dwell/app when package-lock.json changed
sudo chown -R dwell:dwell /opt/dwell/app
sudo systemctl start dwell
curl -s http://<panel host>:<port>/healthz    # from the server: {"ok":true,...,"sandbox":true}
```

After startup, check health and runtime alerts, confirm the intended model connection, and verify one task and any pending approval continuation through each configured bot or the trusted panel. `/healthz` includes `feishu` and `telegram`; a `failed` connection returns 503. Running tasks resume from checkpoints subject to their persisted budgets. Existing background children without access roles become read-only before resuming; tasks that need shell access or edits must be stopped and started again with `mode: "write"`. Budget limits already attached to a run remain frozen even if the environment defaults change. Execution downtime can exhaust an active run's deadline; approval waiting after a run ends is excluded. Managed processes are reported as interrupted and are not automatically rerun.

The backup CLI copies data, state, runtime source/configuration files and the dependency lockfile (excluding the application's `node_modules`), the selected model JSON, and the optional environment file into a new private directory. Workspace dependencies under `data/work/` are included. It records SHA-256 checksums and permissions in `backup-manifest.json` and checks SQLite integrity on a disposable copy. Links strictly inside `data/work/` are stored as links without following their targets; external target contents need separate backup and may need remapping on restore. A link replacing `data/work/` itself, or links in state, application, and configuration inputs, are refused, as are special files. `--stopped` is an operator acknowledgement, not automatic quiescing or a live snapshot. Output must be a new directory outside code, data, and state. Adjust `--models` for a configuration stored elsewhere, and retain any external service credentials separately.

`data/dwell.sqlite` (with its `-wal`/`-shm` files) holds conversations, run budgets, work records, workspace write leases, and Telegram route/inbox/input/command receipts. `state/` holds routing, users, approval decisions/delivery records, Telegram cursors, private process logs, model configuration, and `runtime-telemetry.json`. The telemetry snapshot retains at most 256 metric series and 200 completed spans without prompts, tool arguments/results, or error text. Protect the entire backup like live credentials. A database-only backup cannot produce a matching JSON/configuration set.

Approval decisions saved before an interruption retry with the same delivery identity at startup and with backoff. Failed state writes preserve the previous pending request and window; replay keeps the original expiry. Older pending records without a budget ID receive a budget on their first continuation. Old Feishu cards without a durable request ID are rejected and need a fresh request or operator handling. These restart rules do not promise exactly-once external effects or machine-power-loss durability.

To rehearse recovery, verify the backup and restore it to a fresh staging directory:

```sh
sudo -u dwell npm run backup -- verify --backup "$backup"
sudo -u dwell npm run backup -- restore --backup "$backup" --output /opt/dwell/restore-$ts
```

Restore verifies checksums and SQLite again, and never replaces or starts production. Files retain private owner-only permissions. In the staging `app/`, run `npm ci --omit=dev`; inspect the restored `.env` and model path and adjust absolute directory references for the recovery layout. Keep bot entry points disconnected while checking the staged copy. To roll back production, stop every writer, retain post-update artifacts, account for external effects, then have the operator replace the matched code/configuration/data/state set and check ownership before starting. The CLI does not perform that replacement.

Process logs live at `$DWELL_STATE/proc-logs/<conversationId>/<taskId>.log`; agents access them through `dwell.proc.logs`, not a workspace path. Allow disk space for up to 50 MiB per log and 7 days of completed logs; startup and task completion remove expired terminal logs. Active logs are retained. Upgrades leave old workspace `.dwell-proc/` files untouched and do not import them or reopen their checkpoint paths. Old running processes are reported as interrupted, with legacy logs unavailable through the new tool.

After a command exits or is stopped, output pipes have a bounded drain period. If descendants keep them open, the task reports incomplete output instead of waiting indefinitely. Without the sandbox, detached descendants can survive process-group termination; bounded capture does not replace PID-namespace or service-manager cleanup.

Attachments remain writable under each workspace's `uploads/`. Workspace roots are registered before tasks resume; replacing a root or upload directory with a link causes uploads to fail. Linux runs the fixed writer through the existing sandbox; without a sandbox these directory checks are not isolation from unrestricted processes sharing the service UID. `node test/probe-uploads.ts` verifies the real writer, stdin bytes, and directory replacement handling in an isolated Linux environment with bubblewrap; set `DWELL_DATA` and `DWELL_STATE` outside `/tmp`, as with the other sandbox probes. Windows rejects attachment uploads instead of falling back to unrestricted host writes.

## Runtime alerts

Runtime faults, including faulted or parked tasks, throwing extension hooks, and session failures, are logged and sent to every admin through their platform's direct messages when that bot is connected. Telegram admins must first start a private chat with the bot. Alerts of the same kind (by type, extension, and task kind) are sent once per 10 minutes; the suppressed count is added to the next alert. If the bot is unavailable, alerts remain in the log.

`session_failed` means the storage layer failed and the process is no longer usable. After a best-effort admin notice, dwell exits so systemd or Docker can restart it. Configure automatic restart. The panel sidebar keeps the 50 most recent alerts, including suppressed ones, in memory (`GET /api/reports`); restarting clears them.

### Health and telemetry

Use `GET /healthz` on the panel port for external health checks. It returns `{ ok, uptimeSec, feishu, telegram, sandbox }`. Each bot state is `off` when disabled or in panel-only mode; `sandbox` reports whether the bash sandbox is enabled. A `failed` bot connection returns 503. This endpoint remains accessible from the server itself.

`GET /api/ready` returns `{ ready }` with 200 after startup or 503 while unavailable or shutting down. `GET /api/runtime` exposes SDK metrics and recent spans. Both follow the trusted-panel policy, including local-source denial. Telemetry stores no prompts, tool arguments, results, or error text. The private `$DWELL_STATE/runtime-telemetry.json` retains at most 256 metric series and 200 completed spans across restarts for bounded diagnosis.

SIGINT/SIGTERM stop input, close the runtime, and flush telemetry within a 30-second shutdown deadline. A stalled shutdown exits nonzero; the service manager must allow this shutdown period.

### Model connection failures

Model authentication, access, account-limit, and configuration errors stop the task; retry-like prose in a remote response does not cause retries. Chat and panel messages name the failure without showing response bodies. Transient failures remain subject to configured retry and run limits, and context overflow retains SDK compaction. Completed work stays available. Operators must resolve access or region restrictions on the connection; dwell does not switch providers automatically.

<a id="7-github-optional"></a>

## Optional GitHub integration

See [GitHub integration](github.md) for the dedicated account and token, host git configuration, optional signing, fork CI, verification, and credential revocation.

<a id="8-docker"></a>

## Docker

The Compose service runs as the non-root `dwell` user, uses `init: true` to reap orphaned children, and mounts `./data` and `./state`. Use `docker run --init` for a standalone container. With models in the state volume, copy a template to `./state/models.json`, set `DWELL_MODELS_FILE=/state/models.json` in `.env`, and fill in the key named by `apiKeyEnv`.

The image sets `NODE_ENV=production` but does not include bubblewrap, so its default `required` sandbox policy refuses startup. Either provide a derived image and container configuration where the sandbox probe passes, or explicitly choose `DWELL_SANDBOX=off` (or `auto` to permit fallback) after configuring an appropriate container boundary. The service does not silently weaken its production policy. Then run `docker compose up -d --build`. Allow at least 30 seconds for shutdown (for example, `docker compose stop -t 35`). Back up stopped volumes and configuration together with the backup CLI from a Node 26 host. Limits of this form:

- With `off`, or a failed probe under `auto`, the container boundary supplies isolation; path and command checks alone do not confine shell access
- `docker-compose.yml` publishes no ports. Add a `ports:` entry to use the panel, and keep it on a private interface (for example `"10.8.0.1:7788:7788"`)
- Inside the container, bash and the panel share the network namespace, so the local-source check still blocks bash. Requests from the host through the published port should arrive from the Docker bridge gateway, which is not a container address, and be accepted. This has not been tested; check it before relying on it
