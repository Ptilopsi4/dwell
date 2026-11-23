# Agent runtime

English | [简体中文](agent.zh-CN.md) | [Home](../README.md)

For everyday commands, see [Usage](usage.md). For installation and monitoring, see [Deployment and operations](deployment.md). This guide describes execution, goal tracking, and recovery contracts.

## Conversations and recovery

Feishu, Telegram, and panel inputs pass routing and permission checks before entering a pi-durable conversation. Models and tools share its persistent task runtime. Workspace files, SQLite, and service-private state have separate directory rules; see [Configuration](configuration.md) and [Security](security.md).

Accepted Telegram input is saved in a durable SQLite inbox before the polling cursor advances. Four route workers prepare input concurrently, with each route processed in order. `/cancel` also cancels its pending raw input, including active downloads and vision requests. The route becomes available after preprocessing exits; an upload write already in progress may finish without being rolled back. Cancelled input is not submitted or retried. Redelivery keeps the original request and control target, and outgoing answers are deduplicated by their actual durable answer ID. If approval delivery has no capacity, its decision stays pending for retry. Autonomous reply attribution comes from its own persistent input, including while queued behind another sender. Older pending work without a trustworthy actor identity is stopped and requires a fresh request; the service never substitutes the current sender. A lost send response can still leave delivery uncertain; these records do not guarantee exactly-once outgoing messages or tool effects.

Telegram members-mode routes persist actor scope per bot, chat, forum topic, and sender. Their working directory and actor scope survive `/new`; earlier strict-mode routes are retained without migration. Every input to an actor-scoped line, including panel input, background work, and approval continuation, uses `followUp` while busy. Mixing steering with follow-ups can merge actors into one SDK run, so these lines retain one input mode after later group-policy changes. Their file-tool reads and directory listings, including children's, stay within the resolved working directory after policy changes and restart. Schedules, background agents, and managed processes retain their original sender, entry channel, and group origin. New starts, inputs, reports, and approval continuations recheck that authority; revocation does not automatically terminate running children/processes. Routing and user-facing behavior are described in [Usage](usage.md#conversation-routing-and-commands), and isolation limits in [Security](security.md#access-and-shared-trust).

Feishu autonomous replies from schedules, background agents, and managed processes have a persistent delivery record before their producer finishes announcing the result. Queued replies survive restarts. A queue wait over 30 minutes raises an alert and remains pending. Once card delivery starts, an interruption or failure leaves an uncertain record and an operator alert; the host does not automatically resend it. Startup adopts an active autonomous input if it has no record, covering a restart between submission and announcement; historical completed inputs are not backfilled. Ordinary Feishu inputs and panel notification delivery keep their existing recovery behavior.

Autonomous Feishu delivery runs at most four sends concurrently. New producers wait if 1,000 records are pending or sending, retaining their durable announcement checkpoint. Startup recovery can temporarily exceed that admission limit by one already accepted input per active conversation, so a full queue cannot block startup before execution resumes. The journal retains up to 2,000 terminal records and preserves every pending record.

## Run budgets

Each conversation run has its own persisted budget: by default 32 normal generation request admissions, 128 unique tool admissions, and 15 minutes of execution wall time. Admissions count attempts at the request/tool boundary, including durable model retries and approval-blocked tool calls. Schema-invalid tool calls do not count; the tool total does not measure physical executions. Provider SDK retries are disabled (`maxRetries: 0`). Compaction shares the deadline and can be cancelled at it, but does not consume the 32 normal generation admissions.

Limits are frozen when a budget is created and survive restarts. Execution downtime counts conservatively while an execution phase was active. Approval waiting after the run ends and schedule waiting do not count. Steering an active run does not reset its budget, and approval continuation keeps the original budget. Older pending approvals without a budget ID receive their first budget on continuation. A background child's initial run has its own budget; its result starts a new budget for the parent's follow-up. Reaching a limit stops that run and reports the limit. It does not kill managed `dwell.proc` processes; their lifetime can exceed 15 minutes. `/cancel`, background task stop, and managed process stop retain their separate scopes.

## Shared workspaces

`dwell.task start` defaults to `mode: "read"`. A read task may analyze shared files while a writer works, but has no shell, write/edit, or unsafe tool access; checks also reject disallowed calls from hooks. Choose `mode: "write"` at start for commands or file changes. Its mode stays fixed for the child's lifetime. Dispatch a writable start as the only tool call in that model response; mixed batches are refused.

A writable child holds the persisted workspace write lease throughout its run and approval wait. The parent relinquishes write access for its current run, even if the child finishes before that run ends. The parent may write again in a new run after the result arrives and should re-read affected files. Competing writers, nested paths, and aliases of the same workspace are checked. Stop managed processes using the workspace before handing it off. Older background children without access roles migrate to read mode before resuming. Parent and children still share files; these coordination rules are not a security boundary between tenants.

The shell and managed-process environment place npm/npx caches in the system temporary directory (`/tmp/dwell-xdg/npm-cache` inside the Linux sandbox), keeping them out of the working directory. Explicit project outputs belong in the working directory.

## Waiting for background results

When the parent needs a background result, it calls `dwell.task.wait` by itself. The host ends the current run without another model request; the existing durable report starts the continuation. Telegram, Feishu, and the panel show a waiting notice. Independent parent work can continue before this explicit wait. Waiting does not stop children, and `/cancel` retains its existing scope. `status` inspects tasks; it does not deliver their queued reports.

The wait invocation is `{"name":"dwell.task.wait","arguments":{}}`. It is a separate replay-safe tool; `dwell.task` has no `wait` action. Start and status responses include this invocation, and an accidental `action: "wait"` returns the correction before execution.

## Work records

A durable work goal stores its description, progress, and blockers in SQLite. The user launches it with [`/goal`](usage.md#commands); the record is injected into every model request and survives compaction and restarts. The model saves progress and blockers with `dwell.work` after meaningful steps so a later run resumes from recorded state; the tool neither starts goals nor reports completion. Only the original work creator can change its record, and a goal superseded by a newer `/goal` becomes history that no longer accepts checkpoints. Background children and managed process reports retain their creation-time work attribution when a newer goal starts.

Each work record freezes aggregate limits of 128 generation admissions and 512 tool admissions across its root and assigned background children. Per-run limits still apply. The work ledger reports `usage.scope: "generation_and_tools"`; compaction and vision calls are excluded. Its cost is a recorded-usage estimate when `pricingKnown` is true, or `null` when pricing is unknown.

Ordinary conversations without a goal do not expose `dwell.work` to the model; creating a goal with `/goal` enables it. A conversation retains up to 64 work records; use `/new` in either bot or create a new panel conversation when it is full. Existing records remain available in the old conversation.

## Goals and reporting

Goals are fire-and-forget: `/goal <objective>` creates the durable record and immediately starts a run with the objective as its input. The agent verifies its own work with ordinary tools and commands, under the same approval, budget, and write-lease rules as any other call, and reports the outcome directly in the conversation: what was delivered, where to find it, and what remains open.

The model should checkpoint meaningful progress and current blockers with `dwell.work` so any later run resumes from recorded state after compaction or a restart. Checkpoints record text only: `progress` replaces the stored note, and `blockers` replaces the stored list. A superseded goal keeps its record and budget usage as history; delayed reports and approvals still belong to the work that created them.

The panel shows work records read-only from the conversation menu: each goal's description, progress, blockers, and budget usage, with a status of active or superseded. The trusted panel API exposes the same records through `GET /api/work?id=<conversationId>` and creates a goal through `POST /api/work/goal` with JSON `{ "id": <conversationId>, "workId": "work:...", "requestId": "...", "goal": "<objective>" }`. Both routes use the existing panel request and network policy.

## Tool reference

| Tool | Description | Approval |
|---|---|---|
| `bash` / `read` / `write` / `edit` | Work with files and run commands in the conversation's working directory | Dangerous bash commands need approval |
| `dwell.web.search` / `dwell.web.fetch` | Web search and page reading through the Zhipu Coding Plan remote MCP; usage counts against the plan quota. Enabled whenever `ZAI_CODING_CN_API_KEY` is set, regardless of `DWELL_PROVIDER` | None |
| `dwell.lark.read` | Read Feishu chat history: the 20 most recent messages of the current chat by default; `around` reads the context of one message; `chat` reads another chat. The bot must be in the chat. Reading chats other than the current one is limited to tasks triggered by admins | None |
| `dwell.lark.image` | Describe an image by message id. In groups, images sent without @bot do not enter the context; the model sees `[image]` placeholders in the history and looks at them on demand | None |
| `dwell.send` | Send a file from the working directory to the current Feishu/Telegram chat. Images (png/jpeg/gif/webp) up to 10 MiB are sent as images; larger images and other files up to 30 MiB are sent as documents. Empty files are refused. Source limited to the working directory. Panel tasks get a download in the panel | None |
| `dwell.schedule` | Schedule this conversation to receive an instruction later (one-shot or recurring, e.g. workday digests or reminders). One durable background task per schedule: survives restarts, `/cancel` does not touch it, downtime misses fire once and then follow the cadence. Max 20 per conversation, recurrence at least 10 minutes apart | None |
| `dwell.work` | Persist a durable goal's progress and blockers across compaction and restarts | None |
| `dwell.task.wait` | End this run while awaiting existing background work; a durable report resumes the conversation without model polling | None |
| `dwell.task` | Start named background agents sharing the working directory, with read-only access by default and explicit `mode: "write"` for commands or edits (see [Shared workspaces](#shared-workspaces)). Children cannot use dwell.schedule, dwell.task, or dwell.proc. Results arrive as follow-ups. `/cancel` and context resets do not stop children; `dwell.task stop` aborts and removes one. The panel's "abort current run" leaves the child listed. Max 3 concurrent per conversation, 6 server-wide; dangerous commands use the parent thread's approval | None |
| `dwell.proc` | Run managed background processes in the conversation's sandbox and working directory. Start/status/exit results include a task ID; stdout/stderr are captured by the service in private logs. Exit code and log tail arrive as a follow-up (`notify: false` opts out of normal exit notices). Log storage failure stops the process and is reported even with notifications off. `stop` kills the process tree; `/cancel` and context resets do not. A service restart interrupts processes instead of rerunning commands. Max 5 per conversation, 10 server-wide | Dangerous start commands need approval (same as bash) |
| `dwell.proc.logs` | Read a process log by `taskId`, limited to the calling conversation. Returns the last 50 lines by default, at most 200 lines and 64 KiB. Logs are capped at 50 MiB with a truncation marker; completed logs are retained for 7 days. Use this tool instead of `read` or `tail` | None |

Attachment admission, vision behavior, upload safeguards, platform limits, and response language are described in [Images and files](usage.md#images-and-files).
