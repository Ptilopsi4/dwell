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
   | `im:resource` | Download images and files from messages, upload files for `dwell.send` |
   | `cardkit:card:write` | Streaming reply cards |
   | `contact:user.base:readonly` | Show user names |
   | `im:chat:readonly` | Show group names |

   Scope names change over time; check them against the console. When a scope is missing, the Feishu API error names it, and dwell logs the error.
5. Publish a version of the app so the permissions take effect, then add the bot to the groups it should serve.

The events of one app are spread across all connected clients at random. Run exactly one dwell instance per app, and use a separate app for local testing.

### Telegram (optional)

1. Create a bot with BotFather and put its token in `TELEGRAM_BOT_TOKEN` in the private environment file. Keep group privacy mode enabled. The host needs outbound HTTPS access to the Bot API; long polling needs no public inbound endpoint. When the Bot API is not directly reachable (for example from a mainland-China host), set `TELEGRAM_PROXY` to an http/https/socks5 proxy URL (credentials may be embedded); only Telegram egress uses the proxy — models and other outbound traffic are unaffected, and the value is scrubbed at startup like other credentials.
2. Obtain your user ID before the first start with permanent state. If it is unknown, use the separate bootstrap directories below, start a private chat, send `/whoami`, and stop the temporary process after receiving `tg:<numeric user ID>`. Set `DWELL_ADMINS` to that ID, then start the permanent instance for the first time. An existing `state/users.json` overrides environment seeds; use an existing admin's `/allow tg:123456789 admin` or the trusted panel to update it. Telegram admins and the panel operator must start a private chat before the bot can notify them.
3. For groups, invite the bot and have a dwell admin send `/allowgroup@your_bot` in the target group, or press its Allow group members button. The command detects the group ID and lets its members submit tasks in their own threads and working directories. For strict access limited to explicitly authorized users, use `/allowchat@your_bot` in the group or `/allowchat -1001234567890` privately. `/whoami@your_bot` shows the numeric chat ID even before admission. `/disallowgroup` disables the current group; `/disallowchat` also accepts an ID, and `/chats` lists access modes. `DWELL_TELEGRAM_CHATS` seeds strict groups only; persisted bot records in `$DWELL_STATE/telegram-chats.json` take precedence, including an empty list, and old records retain strict mode. Keep privacy mode enabled and use `/ask@your_bot text` or reply to this bot; plain mentions do not start tasks. Bare commands work only if Telegram delivers them.
4. Keep one polling instance per token. Startup refuses a configured webhook and leaves it in place. Resolve the webhook separately before enabling long polling. A 401 authentication failure or 409 polling conflict stops the service with a nonzero exit code; correct the token or stop the competing client before restarting. Transient transport failures retry indefinitely with capped backoff. Do not start a local copy with the production token.

For ID discovery only, run this from a checkout with dependencies installed and the model key and bot token filled in. Stop any other instance using the token first:

```sh
DWELL_DATA=./data/bootstrap DWELL_STATE=./state/bootstrap npm start
```

This does not create the default `state/users.json`. After discovery, stop the process and start the permanent instance without these directory overrides; do not reuse the bootstrap state as permanent state.

Store the token outside agent workspaces. It is captured before environment scrubbing, and transport errors omit token-bearing URLs. Preserve `$DWELL_STATE/telegram/` polling cursors together with the database input/command receipts when backing up or restoring. Inputs have stable request IDs; outgoing delivery can still be uncertain if a network response is lost.

Check the [durable input and recovery rules](agent.md) in the isolated test bot before rollout, including ordered route processing, pending-input cancellation, answer deduplication, pending approval delivery, and legacy inputs without a trustworthy actor.

Before enabling a production token, use a dedicated test bot, isolated data/state directories, and a test group to check private text, directed commands, attachments, dangerous-command approval, `/new`, and restart recovery. In members mode, check two senders in the same forum topic: their threads and files stay separate, replies to each other's bot messages redirect to their own threads, and replies to their own old threads still work after `/new`. Check strict mode separately, and verify that blocks and disabled groups reject later input and reports while running children/processes remain available for explicit cancellation. Keep privacy mode enabled during these checks. Automated tests with mocked Bot API responses do not establish live or production acceptance.

<a id="2-host-layout"></a>

## Host layout

Run dwell as a dedicated non-root user. Keep the application, dependencies, and private configuration owned by root; the runtime user must not be able to replace them. Only data and state belong to `dwell`:

```
/opt/dwell/
  app/         root:root, not writable by dwell; code and node_modules/
  models.json  root:dwell, mode 640; connection settings, no key values
  .env         root:root, mode 600; credentials and settings, read by systemd
  data/        dwell:dwell, mode 700; DWELL_DATA: dwell.sqlite, work/<conversation>/
  state/       dwell:dwell, mode 700; DWELL_STATE: users/routes/approvals, telegram/, proc-logs/
```

```sh
# Run from a checkout of the release you have checked and tested.
# Install Node >= 26 at a stable, root-owned path first; this example uses /opt/node/bin.
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

Node ≥ 26 is required; there is no application build step. Use the actual absolute Node installation path in every command and in the unit below, including `PATH`. Avoid a Node installation inside an operator's home directory. `git archive HEAD` installs the selected commit and excludes uncommitted files; validate that revision before deploying. Normalize application permissions after installing dependencies so a restrictive operator umask does not leave modules unreadable by `dwell`; apply this only to `app/`, which contains no private environment file. The commands assume a new installation. Keep existing data and state when updating.

Edit the files with `sudoedit`. In `/opt/dwell/.env`, set `DWELL_MODELS_FILE=/opt/dwell/models.json`, fill `OPENAI_API_KEY` (the template's `apiKeyEnv`), and configure the chosen bot credentials and allowlists. Use systemd environment-file syntax (`KEY=value`, without `export` or shell expansion); keep directory and sandbox settings consistent with the unit. systemd reads this root-only file before starting the service as `dwell`; `ExecStart` does not ask Node to read it again. Do not put a second `.env` in `app/` or change the entire `/opt/dwell` tree to runtime ownership.

Other [model templates](configuration.md) use the same loader and connection structure. Keep the model file and credentials outside agent workspaces; the JSON contains key variable names only. Startup rejects a selected model file in data, temporary or existing conversation directories, including writable aliases. An explicit missing/invalid configuration also fails startup. Before changing a connection, finish or cancel requests still waiting on a model response, then restart. Request checkpoints keep their original model references; startup preserves them and refuses to resume if the new configuration cannot resolve them. Main and background conversation settings are aligned for subsequent requests. Legacy environment configuration still applies when no model file is selected or present at the default path.

<a id="3-systemd-unit"></a>

## systemd unit

Create `/etc/systemd/system/dwell.service` with `sudoedit` (root-owned, mode 644):

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

`Restart=always` restarts dwell after storage failures (`session_failed`) and main-process exits; an explicit `systemctl stop` leaves it stopped. `KillMode=mixed` first sends SIGTERM to the main process, giving dwell time to checkpoint and shut down its subprocesses. `TimeoutStopSec=35s` allows the application's 30-second shutdown deadline; systemd force-kills any remaining processes when the main process exits or the stop timeout expires. See [process termination settings](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html). Output and startup failures go to the journal. If repeated failures hit systemd's start limit, fix the reported cause before `systemctl reset-failed dwell` and `systemctl start dwell`. See [service restart and shutdown settings](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html).

`ProtectSystem=strict` makes normal host filesystem paths read-only for the service except its two `ReadWritePaths` and private temporary directories. Root ownership also protects code and configuration when running maintenance commands outside systemd. `PrivateTmp=true` gives the service its own `/tmp`, shared with its sandboxed bash and removed when the service stops. Keep bubblewrap's required namespaces available; restrictive namespace or syscall settings can prevent its startup probe. See [filesystem and environment settings](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html).

`ProtectKernelTunables=yes` masks parts of `/proc` and can prevent unprivileged bubblewrap from mounting its private proc filesystem; it is omitted here. Retain the dedicated user, filesystem restrictions, and required sandbox probe. Check compatibility before enabling additional hardening.

`MemoryMax=1200M` is an example cap on the whole unit's physical-memory accounting, including Node and its child processes. Size it for the host and measured workloads. Swap is separate: adding swap does not raise `MemoryMax`; `MemorySwapMax=` can cap swap use on systems that support it, and does not allocate swap. An OOM kill can target the main process. `OOMPolicy=continue` does not choose the victim; if the main process dies, the restart policy applies. See [memory and swap controls](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html#MemoryMax=bytes). Set `DWELL_TZ` (e.g. `Asia/Shanghai`) in `.env` when tasks should use a timezone different from the server's.

Install and check bubblewrap as described below before starting. Validate the unit on the target host; `verify` checks unit configuration, not the sandbox or bot journey:

```sh
sudo systemd-analyze verify /etc/systemd/system/dwell.service
sudo systemctl daemon-reload
sudo systemctl enable --now dwell
sudo systemctl status dwell --no-pager
sudo journalctl -u dwell -b -n 100 --no-pager
sudo journalctl -u dwell -f
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
sudo -u dwell bwrap --ro-bind / / --unshare-user --unshare-pid --proc /proc /usr/bin/true
```

Treat this as a preliminary check; the service's actual startup probe is decisive. On Ubuntu with AppArmor user-namespace restrictions, a generic `unshare -Ur true` can be denied even when a purpose-built bubblewrap profile permits `bwrap`. If bubblewrap is denied, inspect the kernel/AppArmor denial and use a distribution-supported profile for the installed executable. Ubuntu documents a confined bwrap profile for this case in [Understanding AppArmor user namespace restriction](https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007). Match it to the distribution's AppArmor ABI and review its effect on other applications; do not globally disable AppArmor or user-namespace restrictions to make the probe pass.

After the service starts, check the sandbox with the same Node path and non-secret directory/panel settings as the unit:

```sh
cd /opt/dwell/app
sudo -u dwell env -i PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin DWELL_DATA=/opt/dwell/data DWELL_STATE=/opt/dwell/state \
  DWELL_PANEL_PORT=<port> DWELL_PANEL_HOST=<host> /opt/node/bin/node test/probe-bwrap.ts
```

Every line should be `PASS`: the state directory, the application directory, and other conversations' directories are invisible; the working directory is writable; `/usr` is read-only; the environment holds no secrets; DNS works; `/proc/1` is the sandbox's init; and from inside the sandbox the panel answers 403 on `/api/approvals` and 200 on `/healthz`. Pass `DWELL_DATA` and `DWELL_STATE` explicitly; without them the probe falls back to `./data` and creates its test directories inside the application directory.

The probe runs outside the unit, so also require the service's own startup probe to succeed. It rewrites the shared wrapper `data/bin/sandbox-bash` from its own environment. Restart the service after running it to regenerate the wrapper from service settings, including any [GitHub integration](github.md) environment.

`test/probe-scrub.ts` checks that credentials are removed from `/proc/<pid>/environ`. Its header comment explains how to run it.

`test/probe-proc.ts` verifies the real behavior of managed background processes (`dwell.proc`) under the sandbox: a process survives its spawn call, a group kill clears the pid namespace including `setsid` grandchildren, a server started by a process is reachable from other bash calls, and output lands in the log. Run it the same way as `probe-bwrap.ts` (sandbox must be enabled).

<a id="5-panel-and-network"></a>

## Panel and network

The native service and bubblewrap share the host network namespace. The sandbox restricts filesystem and process visibility; it does not block network access to other localhost services, private addresses, or cloud metadata endpoints. On a shared host, apply a separately reviewed egress policy for the service identity, or use a suitable container/VM boundary before accepting untrusted shell workloads. The panel's checks below protect the panel only.

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

dwell has no build step. Before deploying, make sure `npm run check` and `npm test` pass for the selected revision. Prepare its root-owned application directory, then stop the service and every other workspace writer for a matching backup. Stopping interrupts managed processes, so arrange for their interruption first. SIGINT/SIGTERM have a 30-second shutdown deadline; keep `TimeoutStopSec` at least 35 seconds.

```sh
# Run from the validated release checkout, before entering the installed app directory.
ts=$(date +%Y%m%d-%H%M%S)
next=/opt/dwell/app-next-$ts
backup=/opt/dwell/backup-$ts
sudo install -d -o root -g root -m 755 "$next"
git archive HEAD | sudo tar -x -C "$next"
sudo env PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin /opt/node/bin/npm ci --prefix "$next" --omit=dev
sudo chown -R root:root "$next"
sudo chmod -R u=rwX,go=rX "$next"
sudo systemctl stop dwell
# confirm every other workspace writer is stopped; --stopped records this operator acknowledgement
cd /opt/dwell/app
sudo /opt/node/bin/node src/backup.ts create --data /opt/dwell/data --state /opt/dwell/state \
  --code /opt/dwell/app --models /opt/dwell/models.json --env /opt/dwell/.env \
  --output "$backup" --stopped
sudo /opt/node/bin/node src/backup.ts verify --backup "$backup"
cd /opt/dwell
sudo mv app "app-before-$ts"
sudo mv "$next" app
# If the unit changed, run systemd-analyze verify and systemctl daemon-reload first.
sudo systemctl start dwell
curl -s http://<panel host>:<port>/healthz    # from the server: {"ok":true,...,"sandbox":true}
sudo journalctl -u dwell -b -n 100 --no-pager
```

Stop if any preparation, backup, or verification command fails. The backup command runs as root because `.env` is root-only and the output is under root-owned `/opt/dwell`; it needs read access to every source and write access to the output's parent. It does not need the bot credentials in its environment. Keep the old application directory until the update is accepted; it is not a replacement for the matched backup. Changes to model configuration or `.env` belong to the same update and recovery set.

After startup, check health and runtime alerts, confirm the intended model connection, and verify one task and any pending approval continuation through each configured bot or the trusted panel. `/healthz` includes `feishu` and `telegram`; a `failed` connection returns 503. Running tasks resume from checkpoints subject to their persisted budgets. Existing background children without access roles become read-only before resuming; tasks that need shell access or edits must be stopped and started again with `mode: "write"`. Budget limits already attached to a run remain frozen even if the environment defaults change. Execution downtime can exhaust an active run's deadline; approval waiting after a run ends is excluded. Managed processes are reported as interrupted and are not automatically rerun.

The backup CLI copies data, state, runtime source/configuration files and the dependency lockfile (excluding the application's `node_modules`), the selected model JSON, and the optional environment file into a new private directory. Workspace dependencies under `data/work/` are included. It records SHA-256 checksums and permissions in `backup-manifest.json` and checks SQLite integrity on a disposable copy. Links strictly inside `data/work/` are stored as links without following their targets; external target contents need separate backup and may need remapping on restore. A link replacing `data/work/` itself, or links in state, application, and configuration inputs, are refused, as are special files. `--stopped` is an operator acknowledgement, not automatic quiescing or a live snapshot. Output must be a new directory outside code, data, and state. Adjust `--models` for a configuration stored elsewhere, and retain any external service credentials separately.

`data/dwell.sqlite` (with its `-wal`/`-shm` files) holds conversations, run budgets, work records, workspace write leases, and Telegram route/inbox/input/command receipts. `state/` holds routing, users, approval decisions/delivery records, Telegram cursors, private process logs, and `runtime-telemetry.json`; this host layout keeps model configuration at `/opt/dwell/models.json`. The telemetry snapshot retains at most 256 metric series and 200 completed spans without prompts, tool arguments/results, or error text. Protect the entire backup like live credentials. A database-only backup cannot produce a matching JSON/configuration set.

Approval decisions saved before an interruption retry with the same delivery identity at startup and with backoff. Failed state writes preserve the previous pending request and window; replay keeps the original expiry. Older pending records without a budget ID receive a budget on their first continuation. Old Feishu cards without a durable request ID are rejected and need a fresh request or operator handling. These restart rules do not promise exactly-once external effects or machine-power-loss durability.

Verify the backup and restore it to a fresh staging directory:

```sh
restore=/opt/dwell/restore-$ts
sudo /opt/node/bin/node /opt/dwell/app/src/backup.ts verify --backup "$backup"
sudo /opt/node/bin/node /opt/dwell/app/src/backup.ts restore --backup "$backup" --output "$restore"
```

Restore verifies checksums and SQLite again, and never replaces or starts production. The root-run CLI creates root-owned files and private directories, and strips group/other file permissions. After verification, prepare runtime ownership and dependencies before installing the restored set:

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

Changing ownership or permissions is deployment preparation after manifest verification; it changes the restored file modes recorded by that manifest. Check `.env` and the selected model path. Keep the original absolute conversation workspace paths: persisted conversations and checkpoints can contain them, and the CLI does not rewrite them. Moving data and changing only `DWELL_DATA` is insufficient. Rehearse task recovery on an isolated host with those original paths and bot entry points disconnected; a restored staging directory by itself is only a verified file set. To roll back production, stop every writer, retain post-update artifacts, account for external effects, then have the operator replace the matched code/configuration/data/state set and check ownership before starting. The CLI does not perform that replacement.

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

When migrating an existing Docker instance to systemd, stop the container and every other writer before taking the matching backup of the host-mounted data/state directories, application, model JSON, and `.env`. Keep the container stopped while the native instance uses that bot identity. Docker conversations normally store absolute workspace paths under `/data/work/`; preserve `/data` on the host as a real directory or a deliberately configured bind mount. If the old state path is `/state`, preserve that path too. Set the unit's `DWELL_DATA`, `DWELL_STATE`, and `ReadWritePaths` to the retained paths instead of the new-install `/opt/dwell/data` and `/opt/dwell/state` examples. Restore the ownership boundary above and move the selected model JSON to root-owned `/opt/dwell/models.json`, updating `.env`. Do not use a symlink or merely edit environment variables to relocate persisted conversation workspaces. The backup CLI does not migrate stored paths.
