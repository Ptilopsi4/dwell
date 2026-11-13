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

Node ≥ 26 is required. If node is not on the system `PATH`, set `PATH` in the unit as below.

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
OOMPolicy=continue

[Install]
WantedBy=multi-user.target
```

Adjust the node path. `Restart=always` is required: after a storage failure (`session_failed`) dwell exits on purpose and relies on the restart. `PrivateTmp=true` gives the service its own `/tmp`, which is also the `/tmp` that sandboxed bash sees; systemd empties it when the service stops. `OOMPolicy=continue` keeps the service running when a bash command exceeds `MemoryMax`: only the offending process is killed. Size `MemoryMax` for the heaviest workload you expect the model to run: a single Go `compile` process can take ~1GB, so a build inside a 1200M cgroup gets its workers killed repeatedly (the model then retries and may eventually pass, but unreliably). Raise `MemoryMax` on beefier machines, or accept that heavy builds belong on the fork's CI. The sandbox works under `NoNewPrivileges` and `ProtectSystem=strict`. Servers usually run in UTC: set `DWELL_TZ` (e.g. `Asia/Shanghai`) in `.env` so scheduled tasks and the date the model sees follow the intended timezone.

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

The probe rewrites the shared wrapper `data/bin/sandbox-bash` from its own environment. With GitHub configured (section 7), restart the service after running it so the wrapper passes `GH_TOKEN` again.

`test/probe-scrub.ts` checks that credentials are removed from `/proc/<pid>/environ`. Its header comment explains how to run it.

`test/probe-proc.ts` verifies the real behavior of managed background processes (`dwell.proc`) under the sandbox: a process survives its spawn call, a group kill clears the pid namespace including `setsid` grandchildren, a server started by a process is reachable from other bash calls, and output lands in the log. Run it the same way as `probe-bwrap.ts` (sandbox must be enabled).

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

## 7. GitHub (optional)

With `GH_TOKEN` set, bash gets `gh` and `git` authenticated under a dedicated GitHub account, and dwell works as an outside contributor: fork the upstream, push to the fork, open a PR with `gh pr create`. It never needs collaborator access to anyone's repository.

**Account and token**

1. Create a dedicated account for dwell. Set its email to an address the operators read: GitHub mails a warning before a token expires
2. Create a **classic** personal access token with the `public_repo` and `workflow` scopes, and set an expiration date. Fine-grained tokens cannot open PRs on public repositories the account is not a member of. Without `workflow`, `gh repo sync` and pushes to the fork fail as soon as the upstream has changed anything under `.github/workflows/`
3. Add `GH_TOKEN=<token>` to the env file and restart

At startup and every 24 hours dwell checks the token against `https://api.github.com/user` and sends admins a direct message on a 401, a missing `public_repo` or `workflow` scope, or an expiry within 14 days.

**Host setup (systemd)**

Install `git` and `gh` (from GitHub's official apt repository), then write the system-wide `/etc/gitconfig`. The sandbox mounts `/etc` read-only and sets `HOME` to the working directory, so only system-level git configuration applies:

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
```

`<ID>` comes from `gh api user --jq .id`. Without `user.name`/`user.email`, commits inside the sandbox fail. The `insteadOf` rules turn SSH URLs (for example in submodules) into HTTPS, since the sandbox has no SSH key. dwell sets the non-interactive variables for `gh`/`git` itself.

**Commit signing (optional)**

GitHub shows commits as Verified only when git signs them locally; commits a personal access token creates through the API are not signed. Create an SSH key that only signs (git 2.34 or later):

```sh
sudo install -d -o root -g dwell -m 750 /etc/dwell
sudo ssh-keygen -t ed25519 -N "" -C "<account> signing" -f /etc/dwell/git-signing
sudo chown root:dwell /etc/dwell/git-signing /etc/dwell/git-signing.pub
sudo chmod 640 /etc/dwell/git-signing
```

Add `/etc/dwell/git-signing.pub` to the account under Settings → SSH and GPG keys as a **Signing Key** (it cannot push), and append to `/etc/gitconfig`:

```ini
[gpg]
	format = ssh
[user]
	signingkey = /etc/dwell/git-signing.pub
[commit]
	gpgsign = true
[tag]
	gpgsign = true
```

The key lives under `/etc` so that git inside the sandbox can read it. The noreply address counts as a verified email of the account, so signed commits show as Verified.

**Build checks and CI**

The system prompt keeps local checks light (formatters, linters, builds and tests of the touched packages, under `timeout` and `nice`) because bash shares the service's memory; `OOMPolicy=continue` in the unit (section 3) keeps an oversized build from stopping dwell. Full CI runs on GitHub Actions on the account's fork, which the model follows with `gh run`. Keep Actions enabled on the account: forks have no secrets, and the fork's `GITHUB_TOKEN` only reaches the fork. Workflows that run only on `pull_request` or need secrets or self-hosted runners do not run on the fork; the model then says which checks it could not run.

Toolchains for local checks go on the host, since the sandbox mounts `/usr` read-only. Keep their caches out of the working directory. For Go, install the official tarball to `/usr/local/go`, link `go`/`gofmt` into `/usr/bin` (inside `DWELL_TOOL_PATH`), and set defaults in `/usr/local/go/go.env`:

```ini
GOPATH=/tmp/dwell-go/path
GOCACHE=/tmp/dwell-go/cache
GOTOOLCHAIN=local
```

Add `GOPROXY`/`GOSUMDB` mirrors there when the default proxy is unreachable. `GOTOOLCHAIN=local` stops `go` from downloading other toolchains. Reinstalling Go overwrites `go.env`.

**Container**

The repository's Dockerfile does not include git or gh. Build a derived image that installs them and writes `/etc/gitconfig`. The container has no bash sandbox, so bash sees `GH_TOKEN` and the whole environment.

**Verify**

- The startup log shows `[dwell] GH_TOKEN 自检通过`, and `/healthz` reports `"sandbox":true`. If the sandbox is off, bash inherits the full environment
- Ask dwell to run `gh auth status` in a conversation
- Pick an upstream that changed its workflows recently: fork it, `gh repo sync`, push a branch to the fork, open a PR. The commit author links to the account, and with signing configured GitHub shows Verified. A direct push to the upstream must get a 403
- No `.config` or `.local` appears in the conversation's working directory

**Risks**

`GH_TOKEN` is the one exception to "credentials stay out of what bash can read": `gh` and `git` read it from the environment. Treat it as exposed:

- Any allowlisted member can ask the model to print it, and bash output is visible in the conversation and the panel
- Repository code (dependency installs, build scripts, tests) runs with the token unless the model prefixes it with `env -u GH_TOKEN`, and the sandbox does not isolate the network
- Content the model reads can try to trick it into sending the token out

The signing key is readable by bash the same way. A leaked signing key lets someone make commits that show as Verified for the account, but not push or act as it; deleting the Signing Key on GitHub ends that.

The system prompt tells the model never to reveal either secret and to run repository code without the token. That reduces mistakes; it does not stop a malicious member or a successful prompt injection. The boundary is the account: give it nothing else, keep the scopes to `public_repo` + `workflow`, set an expiration, and revoke the token if it leaks. Anything pushed to the fork or posted under the account is public.

## 8. Docker

`docker compose up -d --build` runs dwell as a non-root `dwell` user with `./data` and `./state` mounted. Limits of this form:

- The image does not include bubblewrap, and Docker's default seccomp profile usually blocks user namespaces, so the bash sandbox is off. The container boundary is the isolation layer
- `docker-compose.yml` publishes no ports. Add a `ports:` entry to use the panel, and keep it on a private interface (for example `"10.8.0.1:7788:7788"`)
- Inside the container, bash and the panel share the network namespace, so the local-source check still blocks bash. Requests from the host through the published port should arrive from the Docker bridge gateway, which is not a container address, and be accepted. This has not been tested; check it before relying on it
