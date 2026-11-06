# dwell

English | [简体中文](README.zh-CN.md)

A general-purpose agent that lives on a server. You reach it through a Feishu (Lark) bot or a web panel. Every model call and tool call is checkpointed in SQLite, so after a restart the process picks up where it left off.

```
Feishu  ⇄ SDK Channel (one WebSocket) ─┐
                                       ├→ routing / permissions → pi-durable conversation → model (GLM / DeepSeek)
Browser ⇄ web panel (HTTP + SSE) ──────┘                          └→ tools: bash/read/write/edit, dwell.web.*, dwell.lark.*
```

Built on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable) 1.4.0 and the official Feishu SDK [`@larksuiteoapi/node-sdk`](https://www.npmjs.com/package/@larksuiteoapi/node-sdk).

## Quick start

Requires Node ≥ 22.19. dwell runs the `.ts` sources directly; there is no build step.

```sh
npm install
cp .env.example .env    # Feishu app credentials, model key, allowlist
npm start
```

With Docker:

```sh
docker compose up -d --build    # ./data → /data, ./state → /state
```

For a production setup (Feishu app configuration, systemd, the bash sandbox, network layout for the panel), see [docs/deployment.md](docs/deployment.md).

## Configuration

Everything is configured through environment variables. `.env.example` is a template.

**Model**

| Variable | Description |
|---|---|
| `DWELL_PROVIDER` | `zai-coding-cn` (default) or `deepseek`. After switching, restart; existing conversations move to the new model |
| `ZAI_CODING_CN_API_KEY` | Zhipu GLM Coding Plan key. Required when the provider is zai-coding-cn; the web tools and image understanding also use it |
| `DEEPSEEK_API_KEY` | Required when the provider is deepseek |
| `DWELL_MODEL` | Defaults to `glm-5.3` (zai-coding-cn) or `deepseek-v4-pro` (deepseek; `deepseek-flash` also works) |
| `DWELL_VISION_MODEL` | Image understanding model, default `glm-5.3-flash`; must be in the zai-coding-cn catalog |

**Feishu and users**

| Variable | Description |
|---|---|
| `LARK_APP_ID` / `LARK_APP_SECRET` | Credentials of a Feishu custom app |
| `DWELL_ADMINS` | Admin open_ids, comma-separated |
| `DWELL_ALLOW` | Member open_ids, comma-separated |

`DWELL_ADMINS` and `DWELL_ALLOW` seed `state/users.json` once, when the file does not exist. After that `users.json` is the source of truth; manage it with `/allow`, `/disallow`, or the panel. With an empty allowlist every message is rejected.

**Panel**

| Variable | Description |
|---|---|
| `DWELL_PANEL_PORT` | Panel port (e.g. `7788`). The panel does not start when unset |
| `DWELL_PANEL_HOST` | Interface to bind; all interfaces when unset |
| `DWELL_PANEL_USER` | open_id of the panel operator. Messages and approvals from the panel are recorded under this user; defaults to the first admin |
| `DWELL_PANEL_URL` | External URL of the panel. When set, Feishu notifications link to it |
| `DWELL_PANEL_ONLY` | `1` starts only the panel without connecting to Feishu, for local development (requests from the local machine are accepted in this mode) |
| `DWELL_PANEL_TRUST_LOCAL` | `1` makes the panel accept requests from the local machine. Only for a same-host reverse proxy or an `ssh -L` tunnel; with it on, bash can reach the panel, including the approval API |

**Directories and runtime**

| Variable | Description |
|---|---|
| `DWELL_DATA` | Data directory, default `./data` (`/data` in the container): `dwell.sqlite` and the per-conversation working directories under `work/` |
| `DWELL_STATE` | State directory, default `./state` (`/state` in the container): `users.json`, `sessions.json`, `message-map.json`, `approvals.json`. Must be outside the agent-writable data directory |
| `DWELL_TOOL_PATH` | Narrows the `PATH` of the bash tool (e.g. `/usr/bin:/bin`) so the model cannot see programs that carry credentials |
| `DWELL_SANDBOX` | `off` disables the bash sandbox (see [Security boundaries](#security-boundaries)) |

## Using it in Feishu

### Conversation rules

| Message | Task thread it goes to |
|---|---|
| Direct message | Your personal thread, a continuous conversation |
| @bot in a group | The sender's own thread in that group. One per person; threads run independently and in parallel |
| Reply to a message in a thread (a member's message to the bot, an approval card, a notification, ...) | Joins that thread; no @ needed |
| Message in a topic group | The topic's thread, shared by everyone in the topic; no @ needed |

All threads of a group share the working directory `work/<chat_id>/`. A message sent while a task is running is inserted into the running task as extra input. If the replied-to message cannot be traced to a thread (for example, it is older than the 10,000-message map), direct messages and @bot messages start a new thread and say so.

### Commands

| Command | Effect | Who |
|---|---|---|
| `/new` | Clear the context of this thread | Thread owner, admins |
| `/cancel` | Abort the current task | Thread owner, admins |
| `/status` | List running tasks | Admins |
| `/approve [minutes]` | Open an approval window for dangerous commands (10 minutes by default); if a command is waiting, the model also resumes | Everyone (applies to yourself only) |
| `/deny` | Close your approval window and cancel your pending request; admins close all windows of the thread | Everyone |
| `/allow @someone [admin]` | Add a member or admin | Admins |
| `/disallow @someone` | Remove a user (the last admin cannot be removed) | Admins |
| `/whoami` | Show your open_id | Everyone |
| `/help` | Usage card | Everyone |

Commands are matched exactly against the known command list. `/approve` minutes are clamped to 1–120.

### Approving dangerous commands

A bash command is held when it matches one of these patterns: `rm -rf`, remote `ssh`/`scp`/`rsync`, `curl` with data or a non-GET method, `wget --post`, global package installs (`npm install -g`, `apt install`, `pip install`), `docker`, `systemctl`, `crontab`. `sudo` is refused outright, and so are commands that touch the state files.

When a command is held, the bot posts an approval card. Tapping approve, or replying `/approve`, opens a time window during which that person's dangerous commands in that thread go through. The trigger, the thread owner, and admins can approve. For tasks started from the panel, the approval card goes only to the panel operator in a direct message, never to the group.

## Tools available to the model

| Tool | Description | Approval |
|---|---|---|
| `bash` / `read` / `write` / `edit` | Work with files and run commands in the conversation's working directory | Dangerous bash commands need approval |
| `dwell.web.search` / `dwell.web.fetch` | Web search and page reading through the Zhipu Coding Plan remote MCP; usage counts against the plan quota. Enabled whenever `ZAI_CODING_CN_API_KEY` is set, regardless of `DWELL_PROVIDER` | None |
| `dwell.lark.read` | Read Feishu chat history: the 20 most recent messages of the current chat by default; `around` reads the context of one message; `chat` reads another chat. The bot must be in the chat. Reading chats other than the current one is limited to tasks triggered by admins | None |
| `dwell.lark.image` | Describe an image by message id. In groups, images sent without @bot do not enter the context; the model sees `[image]` placeholders in the history and looks at them on demand | None |
| `dwell.lark.send` | Send a file from the working directory to the current Feishu chat: images (png/jpeg/gif/webp) up to 10MB, other files up to 30MB, no empty files. Current chat only, source limited to the working directory. Panel tasks (no Feishu chat) get a download in the panel instead | None |

Images and files:

- Images are described by `DWELL_VISION_MODEL` and the description goes to the main model; the original is saved under `uploads/` in the working directory. Without a Zhipu key the image is saved but not recognized
- Files are saved under `uploads/`; the model reads them with `read`
- In groups, **images sent without @bot do not enter the context automatically**. The model fetches them with `dwell.lark.image` when someone asks about them
- Stickers cannot be recognized; audio and video are not supported yet

The built-in prompts the model sees (system prompt, tool descriptions, block messages) are in English; the model replies in the language the user writes in.

## Web panel

Open `http://<host>:<DWELL_PANEL_PORT>/` in a browser.

**The panel has no built-in authentication.** The deployment must make sure only a trusted network can reach it (private network, firewall, tunnel, or binding to an internal interface with `DWELL_PANEL_HOST`). Do not expose it to the internet. The server checks every request: POST must be `application/json`, `Origin` must match `Host`, and `Host` must be an IP literal or a configured name (set `DWELL_PANEL_URL` to use a domain). Requests from the local machine are refused (see [Security boundaries](#security-boundaries)), so open the panel from another machine.

- The sidebar groups conversations into My tasks / Direct / Groups / Archived and streams the transcript live (text, tool calls, collapsible reasoning)
- Attach images or files in the input box (paperclip, paste, drag and drop). Images are described by the vision model before they enter the context; for Feishu conversations the attachments are first posted to the original chat
- Tool rows offer downloads for files produced by `dwell.lark.send` or `write` (only inside that conversation's working directory, always as an attachment, never rendered inline)
- The sidebar status dot reflects both the panel's live channel and the Feishu connection (green ok, yellow connecting or reconnecting, red disconnected); the bell at the bottom lists recent runtime alerts, with an unread badge
- Create panel tasks, rename, archive, clear context, abort, approve, and manage users
- A message sent to a Feishu conversation from the panel first appears in the original chat as "From admin", then the bot replies; everyone in the group can see it
- Aborting or clearing a Feishu conversation from the panel posts a notice to the original chat
- Panel tasks can turn on Feishu notifications: the bot messages the operator when a task finishes, fails, or needs approval. Replying to that notification continues the task from Feishu

## Security boundaries

From hardest to softest: container/system isolation → bash sandbox (mount namespace, kernel-enforced) → credential scrubbing → path checks on file tools → panel request admission → dangerous-command patterns.

- Feishu open_id allowlist. Messages from outside the allowlist get a fixed reply
- **Credentials**: model keys, Feishu credentials, and the allowlist are read into memory and then removed from the process environment. On Linux the secret values in the original environment block (`/proc/<pid>/environ`) are also overwritten with zeros and checked; if scrubbing fails, dwell refuses to start (verified on a server with `test/probe-scrub.ts`). Resumed tasks only start after scrubbing, so neither `printenv` nor `cat /proc/$PPID/environ` in bash returns them
- **File tools**: `write`/`edit` can only write the conversation's working directory and the system temp directory; `read` cannot read the state directory, the application directory, the database, or `/proc` (other system paths are readable). `..` escapes and symlinks are judged by the resolved real path
- **Panel request admission**: POST requires `Content-Type: application/json`; when `Origin` is present it must match `Host`; `Host` must be an IP literal or a name configured in `DWELL_PANEL_HOST`/`DWELL_PANEL_URL`. This stops cross-site requests through the operator's browser (CSRF) and DNS rebinding reads of the SSE stream. Requests from the local machine (loopback or any local interface address) get 403 on everything except `/healthz`: bash runs on the same host, and without this check the agent could call the panel to approve its own dangerous commands, add admins, or read every conversation
- **State files are outside the agent-writable area**: `users.json`/`sessions.json`/`message-map.json`/`approvals.json` are blocked both by the file-tool path checks and by the bash patterns. bash can still get around these checks with globs, symlinks, redirection, and similar tricks; without the sandbox they only slow an attacker down, and the hard boundary is deployment isolation (container or system hardening)
- **bash sandbox** (bubblewrap mount namespace): enabled when dwell runs on Linux, finds `bwrap`, and passes its startup self-test (visible as `sandbox` in `/healthz`). bash then sees only an allowlisted set of mounts: `/usr`, `/etc`, the node installation, and the DNS resolver directories read-only; the conversation's working directory and `/tmp` writable; a private `/proc`. The environment is cleared down to `PATH` and `HOME=<working directory>`. The state directory, the application directory (including `.env`), other conversations' working directories, `/home`, `/root`, and the docker/systemd sockets do not exist inside the sandbox, enforced by the kernel. `DWELL_SANDBOX=off` turns it off. When it is not enabled (not Linux, no bwrap, or the self-test failed) dwell falls back to the path checks and command patterns. The Docker image in this repository does not include bwrap (and the default seccomp profile usually blocks user namespaces), so the sandbox is off in the container. Known gaps: `/tmp` is the service's `/tmp`, shared by all conversations (with systemd, `PrivateTmp=yes` keeps it separate from the host's `/tmp`); the sandbox does not isolate the network, so bash requests to the panel are stopped by the panel's local-source check above, and other services on the network that could be tricked into relaying requests are a matter of network design
- The dangerous-command patterns slow attackers down but cannot cover every variant. Matching commands need approval; access to the state files, `.env`, or `/proc/*/environ` is refused; `sudo` is refused. With the sandbox enabled they stay in place as defense in depth, and their role shifts from blocking after the fact to confirming intent
- Run the process as a non-root user (the Dockerfile creates a `dwell` user); the container is the final isolation boundary. Without the sandbox, the working directory is only a convention and bash can `cd` out of it
- **A group chat is a shared trust zone**: members of a group share the working directory, and anyone can join another member's thread by replying in it and see what that thread has handled. Use direct messages for sensitive content

## Runtime alerts

Runtime faults (tasks faulted or parked, extension hooks throwing, session failures, ...) are logged and sent to every admin in a direct message. Alerts of the same kind (by type, extension, and task kind) are sent once per 10 minutes; the number suppressed is added to the next one. Without a Feishu connection they are only logged. `session_failed` (the storage layer failed and the process is no longer usable) makes the process exit after a best-effort notice to admins, leaving the restart to systemd or Docker, so make sure automatic restart is configured.

The 50 most recent alerts, including suppressed ones, are kept in memory and shown in the panel sidebar (`GET /api/reports`; cleared on restart).

For external health checks use `GET /healthz` on the panel port. It returns `{ ok, uptimeSec, feishu, sandbox }`, where `feishu` is the long-connection state (`off` in panel-only mode) and `sandbox` tells whether the bash sandbox is enabled. It returns 503 when `feishu` is `failed`.

## Development

```sh
npm run check    # tsc --noEmit
npm test         # node:test unit tests (test/*.test.ts)
npm run smoke    # smoke test: uses the real model when a key is set, a faux model otherwise
DWELL_PANEL_PORT=7788 DWELL_PANEL_ONLY=1 npm start    # panel only, for local work
```

Feishu spreads the events of one app across all connected clients at random. When debugging locally, do not connect to the same app as a running production instance.

Contribution conventions and code layout are in `AGENTS.md`.
