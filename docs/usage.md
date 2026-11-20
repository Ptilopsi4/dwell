# Usage

English | [简体中文](usage.zh-CN.md) | [README](../README.md)

Use dwell through Feishu, Telegram, or the web panel. Bot setup is covered in [Deployment](deployment.md#bot-setup); model connections and user allowlists are covered in [Configuration](configuration.md).

## Commands

Bot commands require user authorization. Telegram `/whoami` also works before authorization so you can obtain your ID. In an unlisted group, directed commands receive a fixed admission notice with the user and chat IDs; they do not start a task.

| Command | Effect | Who |
|---|---|---|
| `/new` | Open a new default task thread while retaining the old thread and history | Thread owner, admins |
| `/goal` | Enable goal mode and detach the current goal while retaining history, old records, and budgets | Thread owner, admins |
| `/cancel` | Abort the current task | Thread owner, admins |
| `/status` | List running tasks | Admins |
| `/approve [minutes]` | Open your approval window for dangerous commands; resume a waiting command | Explicitly authorized users; group-only users require an admin |
| `/deny` | Close your approval window and deny a waiting command; admins close all windows of the thread | Everyone |
| `/allow <user> [admin]` | Clear a block and grant explicit membership or admin access | Admins |
| `/disallow <user>` | Block a user, overriding group grants; the last admin cannot be removed | Admins |
| `/allowgroup` (Telegram) | Let members use the current group; its ID is detected automatically | Admins |
| `/disallowgroup` (Telegram) | Disable the current group; no ID argument needed | Admins |
| `/allowchat [group ID]` (Telegram) | Enable a group for explicitly authorized users; omit its ID in that group | Admins |
| `/disallowchat [group ID]` (Telegram) | Close group input and later delivery; retain existing work | Admins |
| `/chats` (Telegram) | List this bot's enabled groups and access modes | Admins |
| `/whoami` | Show your platform user ID | Everyone |
| `/help` | Show usage guidance | Everyone |
| `/start` (Telegram) | Show startup guidance without calling the model | Authorized users |
| `/ask <task>` (Telegram) | Submit text or attachments; empty `/ask` shows guidance | Authorized users |

Commands match the known command list exactly. Approval windows default to 10 minutes; `/approve` accepts 1–120 minutes. `/deny` with nothing pending does not start a new run. In Feishu, identify users with `@someone` or their `ou_...` ID. In Telegram, use `tg:<numeric user ID>`; usernames are not permission IDs.

`/goal` requires no running or queued input in the current conversation; use `/cancel` first if needed. It enables goal mode (the dwell.work tool and its guidance are absent until you run this) and releases the current goal binding so you can send a new goal after a budget is exhausted. Old work records, budgets, evidence, and approvals remain, and old background-task and process reports still belong to the work that created them. It does not clear chat history. See [Agent behavior](agent.md) for budgets, background work, and verification records.

## Approving dangerous commands

A bash command is held when it matches `rm -rf`, remote `ssh`/`scp`/`rsync`, `curl` with data or a non-GET method, `wget --post`, global package installs (`npm install -g`, `apt install`, `pip install`), `docker`, `systemctl`, or `crontab`. `sudo` and commands that touch state files are refused outright. These checks are part of the [security boundaries](security.md).

When a command is held for an explicitly authorized user, the person who triggered it can send `/approve`; this opens a window only for their dangerous commands in that thread. The trigger, thread owner, and admins can also approve with the original card/button. Sending `/approve` for another person's request only opens your own window and leaves that request pending. Telegram users with group-only access need a dwell admin to approve on the original card; they cannot open a window or approve a request, but can reject their own with `/deny`. Command decisions update the original card when it remains available. Panel tasks send approval requests only to the panel operator in a direct message, never to the group.

The decision is saved before its continuation is submitted. Failed state writes leave the pending request and existing window unchanged. Saved decisions retry delivery at startup and with backoff using the same delivery ID; background continuations return through their reporting task. Replaying a decision keeps the original expiry and cannot extend an expired window. This recovery does not guarantee exactly-once external effects or durability through machine power loss.

Old Feishu approval cards without a durable request ID cannot authorize a continuation. Request a fresh approval or ask the operator to resolve the task.

## Feishu

### Conversation routing

| Message | Task thread it goes to |
|---|---|
| Direct message | Your personal thread, a continuous conversation |
| @bot in a group | Your own thread in that group; one per person, running independently |
| Reply to a message in a thread, including a member's bot input, approval card, or notification | That thread, without needing @bot |
| Message in a topic group | The topic's shared thread, without needing @bot |

All threads of a group share `work/<chat_id>/` and the [workspace writer rules](agent.md). A message sent during a task becomes extra input to the running task. When a reply cannot be traced to a thread, for example because it is older than the 10,000-message map, direct messages and @bot messages start a new thread and display a notice.

Feishu `/new` opens a new default task thread. The original thread, work records, budgets, and message anchors remain; reply to an old message or use the panel to continue that thread. It does not stop existing background work or change the shared working directory. This also provides a fresh thread when the old one reaches its 64-work-record limit. The panel's Clear context action only clears context. Group members share files and can join one another's threads by replying; use direct messages for sensitive content.

## Telegram

### Start a conversation

Start a private chat and send `/whoami` to obtain your `tg:<numeric user ID>`. This works before authorization. Ask an admin to add the ID with `/allow tg:123456789 [admin]`, or use the trusted panel. First-installation environment seeds are described in [Configuration](configuration.md); an existing `state/users.json` takes precedence.

Authorized users can send `/start` or `/help` for guidance. `/ask` without text shows how to submit a task; a photo or document attached to `/ask` still submits that attachment. These guidance replies do not call the model. Telegram's `/` suggestions require a command list registered through BotFather or `setMyCommands`; starting dwell does not register or overwrite the bot menu. Menu visibility does not grant command permission.

Private chats accept text, photos, and documents from explicitly authorized users. Groups must be enabled: allowlist mode requires an explicit user grant, while members mode accepts real users posting in that group unless blocked. Keep group privacy mode enabled. Use a directed command such as `/ask@your_bot summarize this`, or reply to an actual message from this bot. A plain `@your_bot` mention does not start a task. `/whoami@your_bot` also shows the chat ID before the group is enabled. An unlisted group receives setup guidance without creating a conversation, downloading attachments, or calling a model. Channels, messages sent as a group/channel, and messages from bots are ignored.

A dwell admin sends `/allowgroup@your_bot` in the target group to open member access, or presses its Allow group members button. The group ID comes from that message; private use redirects the admin to the target group. The bare `/allowgroup` works only when Telegram actually delivers it. With privacy mode enabled, use the qualified command or send it as a reply to this bot. `/allowchat@your_bot` selects strict allowlist mode instead; its existing private form accepts a negative ID, for example `/allowchat -1001234567890`. Old group records retain allowlist mode until explicitly changed. `/chats` shows the current modes.

Group-only access grants no private-chat or administrative permission and does not add users to the global member list. Dangerous commands follow the [admin approval rule](#approving-dangerous-commands); explicit global members retain their existing approval rules. `/disallow tg:123456789` blocks a user even in member-enabled groups; `/allow` clears that block and grants global access.

`/disallowgroup` disables the current group; `/disallowchat` also accepts an explicit ID. Disabling closes new group input and later delivery operations; a network operation already sent cannot be recalled. Schedules, background agents, managed processes, and approval continuations recheck the creator's current permission against the originating group before starting new work or returning a result. Blocking a creator or revoking their group grant prevents those later operations. Existing work, running children/processes, logs, and history remain, with their original cancellation controls. dwell does not track current Telegram membership or stop work automatically when a member leaves. Commands and buttons recheck the current dwell role; Telegram group administrators do not automatically receive it. Replayed controls do not undo later policy changes.

### Conversation routing and commands

| Message | Task thread it goes to |
|---|---|
| Private message | Your current personal thread |
| `/ask@your_bot text` in a members-mode group or forum topic | Your current thread for that bot, group, and topic, with your own working directory |
| `/ask@your_bot text` in a strict-mode regular group | Your current thread in that group, with a shared group working directory |
| `/ask@your_bot text` in a strict-mode forum topic | The topic's shared thread and group working directory |
| Reply to your own isolated thread's known bot message | That thread, including an old thread retained after `/new` |
| Reply to another member's thread or a legacy shared thread in members mode | Your own current thread, with a redirection notice |
| Reply to a known bot message in an existing strict-mode shared thread | That message's thread |
| Reply to a bot message whose anchor is no longer known | Your current thread, with a fallback notice |

Members-mode threads separate each sender's routes and working directory, including within a forum topic. A thread keeps this actor scope after later group-mode changes. Inputs arriving while it runs wait for a later run, including panel input and background reports. Existing strict-mode shared threads retain their routing, shared directories, and in-run steering. All threads follow the [workspace writer rules](agent.md). Separate directories are not a hard tenant boundary; read access and other limits are described in [Security](security.md#access-and-shared-trust).

Telegram `/new` creates a new default conversation and preserves the old thread and its scope. A new isolated thread reuses your working directory; your old thread stays accessible through replies and the panel. Use bot suffixes for group commands, for example `/cancel@your_bot`, or send the command as a reply to this bot. Dangerous-command requests use inline approval buttons and the [approval permissions](#approving-dangerous-commands) above.

### Reply updates and formatting

While an attachment is downloading or being described, Telegram receives a best-effort typing activity without a model call. Activity pauses for normal message traffic and stops after preparation, cancellation, or shutdown. The client may retain the last activity briefly; an activity failure does not prevent the task from continuing.

The bot updates its processing reply with partial text and the six most recent observed tool calls. Each tool line shows a bounded operation summary, such as a file name or website, its status, and execution time when the receipt provides one. Commands, raw output, diagnostic text, and private model reasoning stay out of this display. Updates are coalesced at one-second intervals in private chats and three-second intervals in groups, subject to Telegram's limits. Short replies may finish before an intermediate update appears.

Completion, background waiting, review readiness, cancellation, or failure replaces the preview with the settled answer and retains the short execution record. Markdown becomes Telegram text entities for bold, italic, strikethrough, links, inline code, and code blocks. Raw HTML stays literal; image syntax becomes a text link without uploading remote media. XML and numeric character references are decoded in ordinary text; other named references such as `&copy;` remain literal.

Long previews stay within one message. Final replies are split after formatting, with entity offsets adjusted for each part. A failed intermediate edit stops previews while final delivery is still attempted. Inputs merged into an existing run share its final reply. A lost send response can leave delivery uncertain; recovery records do not guarantee exactly-once outgoing messages or tool effects. See [Agent behavior](agent.md) for durable input and recovery rules, and [Deployment](deployment.md#bot-setup) for webhook and polling failures.

## Images and files

- Images are saved under the working directory's `uploads/`. The configured vision connection describes them for the main model; disabled vision or a missing vision key saves the image without recognition.
- Files are saved under `uploads/`, where the model can read them. Uploads remain editable.
- Windows currently supports text but refuses attachment uploads. Directory identity checks and exclusive upload creation are covered in [Security](security.md#file-tools-and-uploads).
- Vision can reuse the main connection or use a separate supported API connection (see [Configuration](configuration.md)). An explicit vision model without image support fails startup. Each image request has a 60-second timeout; a failed request preserves the saved image and reports recognition failure.
- In Feishu groups, images sent without @bot do not enter context automatically. The model can look them up with `dwell.lark.image` when asked. Telegram images must come from an admitted private message, a directed group command/caption, or a reply to this bot.
- Stickers are not recognized; audio and video are unsupported.

Telegram photo/document downloads are limited to 20 MiB. `dwell.send` sends files from the current conversation's working directory: supported images (`png`, `jpeg`, `gif`, `webp`) up to 10 MiB go as photos; larger images and other files up to 30 MiB go as documents. Empty files are refused. Panel tasks offer a download in the panel. Feishu history and image tools also remain Feishu-only; Telegram has no arbitrary chat-history lookup.

Built-in model-facing prompts and tool descriptions use English. The model replies in the user's language.

## Web panel

Open `http://<host>:<DWELL_PANEL_PORT>/` from a trusted workstation. The panel has no built-in authentication. Keep it on a trusted network and follow the [security boundaries](security.md) and [panel network setup](deployment.md#panel-and-network), including the local-source restriction.

- The sidebar groups My tasks, Direct messages, Groups, and Archived conversations. The transcript updates live, with streaming text, tool calls, and collapsible thinking.
- Attach images and files with the paperclip, paste, or drag and drop. Images receive a vision description. For Feishu/Telegram conversations, attachments are forwarded to the original chat first.
- Download files produced by `dwell.send` or `write` from tool rows. Downloads must be within the conversation's working directory and at most 30 MiB; they are forced attachments, never executed inline. File sending and panel attachment forwarding use the same guarded workspace reader.
- Status dots reflect the panel stream and bot connections: green for healthy, yellow for connecting/reconnecting, red for disconnected. The bell shows recent runtime alerts and an unread count. The clock lists active schedules across all conversations and lets you cancel them.
- Background child conversations appear under their parents. Open their transcript or abort the current run through the conversation menu.
- Create panel tasks, rename, archive, clear context, abort, approve commands, and manage users. The conversation menu also offers Goal mode with the same behavior as `/goal`.
- Open Work records and acceptance from the conversation menu or a ready notice. Compare goals, criteria, artifact scopes, recorded checks, and delivery notes before confirming acceptance. Failed acceptance leaves an error and a refresh action; changed files require fresh verification.
- Messages sent to a Feishu/Telegram conversation first appear in the original chat as "From admin", then the bot replies. Group members can see them. Aborting or clearing that conversation from the panel also notifies the original chat.
- Enable bot notifications for a panel task to receive direct messages through the operator's configured platform on completion, failure, or approval requests. Reply to a notification to continue the task from that platform.

Review criteria and evidence before accepting work. `ready_for_review` requests review; operator acceptance is separate. Verification records and acceptance behavior are described in [Agent behavior](agent.md), and operational alerts in [Deployment](deployment.md#runtime-alerts).
