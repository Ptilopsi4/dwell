# Security boundaries

English | [简体中文](security.zh-CN.md) | [README](../README.md)

From hardest to softest, the layers are container/system isolation, the bash sandbox (a kernel-enforced mount namespace), credential scrubbing, file-tool path checks, panel request admission, and dangerous-command patterns. Run the process as a non-root user; the Dockerfile creates a `dwell` user. Deployment isolation remains the hard boundary.

## Access and shared trust

Global roles use Feishu `ou_...` IDs and Telegram `tg:<numeric user ID>` identities. Telegram private chats require an explicit role. Enabled groups use either strict mode, which also requires that role, or members mode, which admits real users posting in that group. A persisted user block overrides either grant. Member access creates no global role and grants no private-chat or administrative access. Group-only dangerous commands require a dwell admin's approval on the original card; explicit global members keep their existing approval permissions. Rejected users can use Telegram `/whoami` to obtain their ID, but cannot submit tasks. See [Configuration](configuration.md) for persisted policy and [Usage](usage.md) for commands.

Feishu groups and existing Telegram strict-mode threads share their group working directory, and members can join another member's thread by replying in it. Telegram members mode gives each bot/group/topic/sender its own route and working directory. Replies to another member's thread or an old shared thread redirect to the sender's own line. Actor scope remains attached to an isolated line after a mode change or `/new`; `/new` reuses that person's directory. Group messages and bot replies remain visible to the group, and the trusted panel can access all conversations.

Actor-scoped lines and their background children restrict file-tool reads, writes, and directory listings to their working directory, using resolved paths. That restriction persists after group-mode changes and restart. Existing strict-mode and other shared lines retain their current file policy. Separate routes and directories do not provide hard tenant isolation. bash isolation depends on the sandbox, temporary storage is shared, and network access is unrestricted. Use an appropriate host/container boundary before accepting mutually untrusted workloads. Use direct messages for content that must stay out of the group.

New scheduled firings, background inputs and reports, managed-process starts and reports, and approval continuations recheck the durable creator and originating group against current permissions. Revocation does not kill an already running child or process, recall an external operation, or remove stored files and history. dwell does not query live Telegram membership, so leaving a group does not itself revoke access or stop existing work.

## Credentials

Model keys, including custom main/vision `apiKeyEnv` names, Feishu credentials, the Telegram token, and allowlists are read into memory and removed from the process environment. On Linux, the secret values in the original environment block (`/proc/<pid>/environ`) are also overwritten with zeros and checked. If scrubbing fails, dwell refuses to start. Resumed tasks start only after scrubbing, so neither `printenv` nor `cat /proc/$PPID/environ` in bash returns those values. Telegram request errors omit token-bearing URLs.

The server probe [test/probe-scrub.ts](../test/probe-scrub.ts) checks credential scrubbing. Its header explains how to run it.

`GH_TOKEN` is the exception: `gh` and `git` read it from the environment, so it remains readable by bash. Treat it as exposed; the boundary is the dedicated account and revoking the token. Account permissions, signing-key exposure, and revocation are covered in [GitHub integration](github.md).

## bash isolation

The bubblewrap sandbox requires Linux, `bwrap`, and a passing startup self-test. Its enabled state appears as `sandbox` in `/healthz`.

- `DWELL_SANDBOX=required` stops startup before checkpoint recovery if the probe fails. This is the default with `NODE_ENV=production`.
- `auto` explicitly permits running with path checks and command patterns when the sandbox is unavailable. It is the nonproduction default.
- `off` disables the sandbox.

The supplied Docker image sets production mode but omits bwrap, so its default startup fails until the operator configures isolation and the intended mode. Without the sandbox, the working directory is only a convention and bash can `cd` out of it.

When enabled, bash sees only allowlisted mounts:

- `/usr`, `/etc`, the Node installation, and DNS resolver directories are read-only.
- The conversation's working directory and `/tmp` are writable; `/proc` is a private instance.
- State, application files including `.env`, other conversations, `/home`, `/root`, and Docker/systemd sockets are absent.

The environment contains `PATH`, `HOME=<working directory>`, and `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME` under `/tmp/dwell-xdg`, plus configured GitHub variables. Conversations share `/tmp`; systemd `PrivateTmp=yes` separates it from the host's `/tmp`.

The sandbox does not isolate the network. The panel's local-source check blocks direct bash access; restrict other services capable of relaying requests through network policy. See [Deployment](deployment.md) for host isolation, sandbox setup, and the [test/probe-bwrap.ts](../test/probe-bwrap.ts) server probe.

## File tools and uploads

Ordinary lines limit `write` and `edit` to the conversation's working directory and the system temp directory. `read` cannot read the state directory, application directory, database, or `/proc`. Actor-scoped Telegram lines and their children restrict all file-tool access, including writes and directory listings, to their own working directory; other lines retain access to nonprotected system paths. A fixed POSIX helper checks directory identities and holds the final file descriptor for byte access. It rejects multiply linked files and path changes, with one helper-process startup per file operation.

Guarded file access is unavailable on Windows. Rename, removal, and watch are unsupported by this backend. Shell access follows the separate sandbox and command rules.

Attachments use a fixed writer that pins the registered workspace and upload-directory identities and exclusively creates a new file. It refuses links, existing targets, and directory changes. Uploads remain writable. Repeated messages may leave separate attachment files; input submission still deduplicates by message ID. Linux uses the existing bash sandbox; macOS applies the directory checks without a sandbox. Windows refuses attachment uploads while text remains available. See [Usage](usage.md) for media handling and file delivery limits.

## Protected state and command approvals

State files stay outside the agent-writable area. `users.json`, `sessions.json`, `message-map.json`, and `approvals.json` are blocked by file-tool path checks and bash patterns. bash can still get around these checks with globs, symlinks, redirection, and similar variants. Without the sandbox, these checks only slow an attacker down; deployment isolation is the hard boundary.

Dangerous-command patterns cannot cover every variant. Matching commands need approval; access to state files, `.env`, or `/proc/*/environ` is refused, as is `sudo`. The patterns remain in place with the sandbox enabled as defense in depth, confirming intent for commands that match. See [Agent runtime](agent.md) for execution budgets and workspace ownership, and [Usage](usage.md) for approval behavior.

## Panel access

The panel has no built-in login. Protect it with the deployment's network boundary as well as its request checks:

- POST requires `Content-Type: application/json`.
- When `Origin` is present, its host and port must match `Host`. Malformed origins and `Origin: null` are refused.
- `Host` must be an IP literal, the built-in `localhost` name, or a name configured in `DWELL_PANEL_HOST` or `DWELL_PANEL_URL`.

These checks stop cross-site requests through the operator's browser (CSRF) and DNS rebinding reads of the SSE stream.

Requests from the local machine, including loopback and any local interface address, get 403 on everything except `/healthz`. bash runs on the same host; allowing it to call the panel would let the agent approve its own dangerous commands, add admins, or read every conversation. Readiness, runtime metrics, static pages, and SSE are subject to the same local-source denial.

`DWELL_PANEL_ONLY=1` disables both bot connections and permits local panel access for development. `DWELL_PANEL_TRUST_LOCAL=1` permits local access without disabling the bots. A same-host reverse proxy or `ssh -L` tunnel makes requests appear local and needs that explicit trust setting; enabling it also lets bash reach the panel and approval API. Prefer a browser connecting from another machine. See [Configuration](configuration.md) for panel settings, [Development](development.md) for local checks, and [Deployment](deployment.md) for network setup and verification.
