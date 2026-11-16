# Agent runtime

English | [简体中文](agent.zh-CN.md) | [Home](../README.md)

For everyday commands, see [Usage](usage.md). For installation and monitoring, see [Deployment and operations](deployment.md). This guide describes execution, verification, and recovery contracts.

## Conversations and recovery

Feishu, Telegram, and panel inputs pass routing and permission checks before entering a pi-durable conversation. Models and tools share its persistent task runtime. Workspace files, SQLite, and service-private state have separate directory rules; see [Configuration](configuration.md) and [Security](security.md).

Accepted Telegram input is saved in a durable SQLite inbox before the polling cursor advances. Four route workers prepare input concurrently, with each route processed in order. `/cancel` also cancels its pending raw input, including active downloads and vision requests. The route becomes available after preprocessing exits; an upload write already in progress may finish without being rolled back. Cancelled input is not submitted or retried. Redelivery keeps the original request and control target, and outgoing answers are deduplicated by their actual durable answer ID. If approval delivery has no capacity, its decision stays pending for retry. Older pending work without a trustworthy actor identity is stopped and requires a fresh request; the service never substitutes the current sender. A lost send response can still leave delivery uncertain; these records do not guarantee exactly-once outgoing messages or tool effects.

## Run budgets

Each conversation run has its own persisted budget: by default 32 normal generation request admissions, 128 unique tool admissions, and 15 minutes of execution wall time. Admissions count attempts at the request/tool boundary, including durable model retries and approval-blocked tool calls. Schema-invalid tool calls do not count; the tool total does not measure physical executions. Provider SDK retries are disabled (`maxRetries: 0`). Compaction shares the deadline and can be cancelled at it, but does not consume the 32 normal generation admissions.

Limits are frozen when a budget is created and survive restarts. Execution downtime counts conservatively while an execution phase was active. Approval waiting after the run ends and schedule waiting do not count. Steering an active run does not reset its budget, and approval continuation keeps the original budget. Older pending approvals without a budget ID receive their first budget on continuation. A background child's initial run has its own budget; its result starts a new budget for the parent's follow-up. Reaching a limit stops that run and reports the limit. It does not kill managed `dwell.proc` processes; their lifetime can exceed 15 minutes. `/cancel`, background task stop, and managed process stop retain their separate scopes.

## Shared workspaces

`dwell.task start` defaults to `mode: "read"`. A read task may analyze shared files while a writer works, but has no shell, write/edit, or unsafe tool access; checks also reject disallowed calls from hooks. Choose `mode: "write"` at start for commands or file changes. Its mode stays fixed for the child's lifetime. Dispatch a writable start as the only tool call in that model response; mixed batches are refused.

A writable child holds the persisted workspace write lease throughout its run and approval wait. The parent relinquishes write access for its current run, even if the child finishes before that run ends. The parent may write again in a new run after the result arrives and should re-read affected files. Competing writers, nested paths, and aliases of the same workspace are checked. Stop managed processes using the workspace before handing it off. Older background children without access roles migrate to read mode before resuming. Parent and children still share files; these coordination rules are not a security boundary between tenants.

The shell and managed-process environment place npm/npx caches in the system temporary directory (`/tmp/dwell-xdg/npm-cache` inside the Linux sandbox), keeping them out of the working directory. Explicit project outputs remain subject to the task's artifact contract.

## Waiting for background results

When the parent needs a background result, it calls `dwell.task.wait` by itself. The host ends the current run without another model request; the existing durable report starts the continuation. Telegram, Feishu, and the panel show a waiting notice. Independent parent work can continue before this explicit wait. Waiting does not stop children, and `/cancel` retains its existing scope. `status` inspects tasks; it does not deliver their queued reports.

The wait invocation is `{"name":"dwell.task.wait","arguments":{}}`. It is a separate replay-safe tool; `dwell.task` has no `wait` action. Start and status responses include this invocation, and an accidental `action: "wait"` returns the correction before execution.

## Work records

For work spanning runs, `dwell.work` stores the goal, acceptance criteria, progress, blockers, evidence IDs, and review note in SQLite. The model starts a record before substantive work, checkpoints before clarification or other waits, and requests `ready_for_review` after checking the criteria. Evidence IDs must refer to successful tool results from that work's task tree; a successful tool result alone does not establish acceptance. Only the original work creator can change its record. Accepted records cannot be edited through the model tool. Background children and managed process reports retain their creation-time work attribution when a newer goal starts.

Each work record freezes aggregate limits of 128 generation admissions and 512 tool admissions across its root and assigned background children. Per-run limits still apply. The work ledger reports `usage.scope: "generation_and_tools"`; compaction and vision calls are excluded. Its cost is a recorded-usage estimate when `pricingKnown` is true, or `null` when pricing is unknown.

Use [`/newgoal`](usage.md#commands) to detach the current goal and begin another work record while retaining old records and conversation history. A conversation retains up to 64 work records; use `/new` in either bot or create a new panel conversation when it is full. Existing records remain available in the old conversation.

## Verification and acceptance

### Declare final artifacts

For code or file work, declare a verification contract at `start`. It contains exact `checks: [{name, command}]`, required workspace-relative `artifacts`, and optional `allowedChanges` for tasks with strict output rules. For example, `artifacts: ["job", "job/result.json"]` with `allowedChanges: ["job/result.json"]` checks the containing directory for unexpected changes and requires the result file. Directories are recursive; scopes are limited to 1024 entries, 16 MiB of content, and 64 directory levels. Choose a narrow scope instead of scanning a whole clone or dependency tree.

Artifacts describe the required final state. For a temporary file that will be deleted, include a containing directory that will remain in `artifacts` and its exact path in `allowedChanges`; do not require that temporary file to exist at completion. If `job/disposable` will be removed, declare `job` as the directory scope. An incorrect artifact scope cannot be repaired with `revise`. The model should checkpoint the blocker and explain it, then the operator can use `/newgoal` to declare a corrected goal while preserving the old record and history. `dwell.work` rejects unknown parameters so a request cannot appear successful after a field was ignored.

### Run checks

`dwell.work verify` executes the declared checks through the existing bash tool, including approval, budget, and write-lease checks. A host receipt records successful exit codes and a SHA256 manifest of the resulting files. `ready` and operator acceptance recheck those hashes without running commands; changed or missing files require another verification. Interrupted verification commands are not replayed automatically. Records without a contract remain explicitly unverified and retain compatible review behavior. A receipt proves command results against file versions; the checks still need to cover the actual requirements and target runtime. Ordinary chat does not require a work record.

Failed checks return the governed bash result's diagnostics and combined stdout/stderr to the model through the work failure record. Diagnostics retain at most 2,000 characters and output retains its last 4,000 characters, with truncation notices. Approval blocks and timeouts retain their available diagnostic reason. The runtime does not recover partial output omitted by the tool after a timeout. Successful checks do not attach command output.

### Revise checks

If a declared check is incorrect, `dwell.work` with `action: "revise"`, replacement `checks`, and a nonempty `reason` updates that work's commands. The goal, acceptance criteria, original file baseline, artifact scope, allowed changes, owner, and budgets stay fixed. Revision history retains the previous checks, receipt, attempt, actor, and reason; the current receipt is invalidated and verification must run again. Only the creator in the root conversation can revise an unaccepted work. History retains up to 32 revisions and rejects further revisions without dropping older entries. A revision cannot reset an exhausted budget. Model context includes a compact history summary; the panel work API retains the full history.

### Request review

Successful verification preserves unresolved blockers. Once blockers are explicitly resolved through a checkpoint and the work remains eligible, the result includes a directly usable `ready nextCall`; supplementary evidence entry IDs are optional. `ready` must be a sole, direct model tool call. On success the host ends that run and delivers a review notice through Telegram, Feishu, or the panel, without another model request. The notice includes a bounded summary of the declared goal, artifact scope, recorded checks, and agent review note, frozen in that ready receipt. Later goals or check revisions do not rewrite it. Work without a contract shows an explicit unverified notice. Neither notice records operator acceptance.

The panel displays a host review notice only after its tool receipt is matched to the actual answer and task; model text cannot create that notice.

### Record acceptance

Open Work records and acceptance from the panel conversation menu or the review notice. It shows current and historical work, criteria, artifact scopes, checks, delivery notes, and acceptance records. Confirm acceptance after inspecting the output; if changes are needed, continue the conversation with the requested corrections.

The trusted panel API exposes the same records through `GET /api/work?id=<conversationId>` and records acceptance with `POST /api/work/accept` and JSON `{ "id": <conversationId>, "workId": "work:..." }`. The model has no accept action. Both routes use the existing panel request and network policy.

Operator acceptance rereads declared artifacts through the guarded file environment without executing verification commands.

## Tool reference

| Tool | Description | Approval |
|---|---|---|
| `bash` / `read` / `write` / `edit` | Work with files and run commands in the conversation's working directory | Dangerous bash commands need approval |
| `dwell.web.search` / `dwell.web.fetch` | Web search and page reading through the Zhipu Coding Plan remote MCP; usage counts against the plan quota. Enabled whenever `ZAI_CODING_CN_API_KEY` is set, regardless of `DWELL_PROVIDER` | None |
| `dwell.lark.read` | Read Feishu chat history: the 20 most recent messages of the current chat by default; `around` reads the context of one message; `chat` reads another chat. The bot must be in the chat. Reading chats other than the current one is limited to tasks triggered by admins | None |
| `dwell.lark.image` | Describe an image by message id. In groups, images sent without @bot do not enter the context; the model sees `[image]` placeholders in the history and looks at them on demand | None |
| `dwell.send` | Send a file from the working directory to the current Feishu/Telegram chat. Images (png/jpeg/gif/webp) up to 10 MiB are sent as images; larger images and other files up to 30 MiB are sent as documents. Empty files are refused. Source limited to the working directory. Panel tasks get a download in the panel | None |
| `dwell.lark.send` | Legacy Feishu name for the same file sender; use `dwell.send` in Telegram | None |
| `dwell.schedule` | Schedule this conversation to receive an instruction later (one-shot or recurring, e.g. workday digests or reminders). One durable background task per schedule: survives restarts, `/cancel` does not touch it, downtime misses fire once and then follow the cadence. Max 20 per conversation, recurrence at least 10 minutes apart | None |
| `dwell.work` | Preserve a goal and verification history; `revise` corrects checks, `verify` binds results to files, `ready` ends the run for review | Dangerous verification commands need approval through bash |
| `dwell.task.wait` | End this run while awaiting existing background work; a durable report resumes the conversation without model polling | None |
| `dwell.task` | Start named background agents sharing the working directory, with read-only access by default and explicit `mode: "write"` for commands or edits (see [Shared workspaces](#shared-workspaces)). Children cannot use dwell.schedule, dwell.task, or dwell.proc. Results arrive as follow-ups. `/cancel` and context resets do not stop children; `dwell.task stop` aborts and removes one. The panel's "abort current run" leaves the child listed. Max 3 concurrent per conversation, 6 server-wide; dangerous commands use the parent thread's approval | None |
| `dwell.proc` | Run managed background processes in the conversation's sandbox and working directory. Start/status/exit results include a task ID; stdout/stderr are captured by the service in private logs. Exit code and log tail arrive as a follow-up (`notify: false` opts out of normal exit notices). Log storage failure stops the process and is reported even with notifications off. `stop` kills the process tree; `/cancel` and context resets do not. A service restart interrupts processes instead of rerunning commands. Max 5 per conversation, 10 server-wide | Dangerous start commands need approval (same as bash) |
| `dwell.proc.logs` | Read a process log by `taskId`, limited to the calling conversation. Returns the last 50 lines by default, at most 200 lines and 64 KiB. Logs are capped at 50 MiB with a truncation marker; completed logs are retained for 7 days. Use this tool instead of `read` or `tail` | None |

Attachment admission, vision behavior, upload safeguards, platform limits, and response language are described in [Images and files](usage.md#images-and-files).
