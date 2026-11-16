# AGENTS.md — dwell

Server-resident general-purpose agent with Feishu, Telegram, and web panel entry points. pi-durable checkpoints each step for restart recovery. User docs: `README.md` / `README.zh-CN.md`; deployment: `docs/deployment.md` / `docs/deployment.zh-CN.md`.

## 技术栈

- Node ≥ 26，直接运行 `.ts`（type stripping），**无构建步骤**。`tsconfig` 开了 `erasableSyntaxOnly`：不能用 enum、namespace、构造函数参数属性；import 必须带 `.ts` 后缀
- `@earendil-works/pi-durable` / `pi-ai` / `chord` 锁精确版本 `1.4.0`（experimental，API 可能变）。不加 `^`，升级作为单独任务处理
- 飞书：`@larksuiteoapi/node-sdk` 的 Channel 模块（单 WebSocket 收消息和卡片回调，自动重连）。lark-cli 已退出运行时，不要再引入
- Telegram: Bot API through standard `fetch`, one long-polling instance per token. Keep group privacy enabled; group input requires an allowed chat and a directed command or reply to this bot.
- Models: `models.json` defines `main` and optional `vision` connections; credentials use `apiKeyEnv` references. Runtime and eval share `src/models.ts`. Templates and legacy environment compatibility are documented in the READMEs.
- Storage: pi-durable SQLite (`$DWELL_DATA/dwell.sqlite`), including Telegram route/input/command receipts; JSON state under `$DWELL_STATE/` holds users, routing projections, approvals, and Telegram polling cursors.
- Panel：单文件 `src/web/panel.html` + vendored Basecoat CSS/JS，没有前端框架和打包

## 目录

```
src/
  index.ts          Bot assembly, shared message routing/commands, platform delivery, approvals, panel bridge, autonomous replies and scope recovery
  telegram.ts       Bot API transport: normalization, long polling/cursors, ordered plain-text sends, files and inline callbacks
  telegram-entry.ts Durable input/command receipts and approval callback authority checks
  harness.ts        Harness.open：storage + provider + registry（CodingTools/dwell/审批/web）+ NodeExecutionEnv；凭证清理；视觉 describer；GitHub 接入（开关、非交互 env、提示词段、token 自检）
  models.ts         Shared connection loader/client factory; pi-ai protocol adapters and configuration templates, with opaque model IDs
  workspace.ts      Persistent read-only child roles and workspace write leases, including parent handoff and startup reconciliation
  pipeline.ts       Explicit panel/Feishu/Telegram destinations; pure group admission, empty-content, fallback and command decisions
  sessions.ts       Conversation routes/owners/metadata and message anchors (10k); durable bot default-route replacement for /new
  users.ts          角色（env 播种，state/users.json 为运行时真相）
  state.ts          状态 JSON 原子写（tmp + rename，promise 链串行）+ DATA_DIR/STATE_DIR/APP_ROOT/DEFAULT_CWD/DWELL_TZ 常量（放这里避免 approval→harness 循环依赖）
  media.ts          入站图片/文件预处理（图片 → 视觉描述，文件 → cwd/uploads）
  uploads.ts        Fixed upload writer: registered workspace identities, exclusive file creation, sandboxed on Linux; Windows uploads are disabled
  report.ts         运行告警：onReport → 日志 + 管理员私聊（10 分钟同键节流）；session_failed 不节流，index 侧退出进程交重启
  sandbox.ts        bash 沙箱：bwrap wrapper 生成 + 启动探测（失败不启用，回退路径治理；真实行为由 probe-bwrap.ts 服务器验证）
  smoke.ts          冒烟：有 key 走真模型，无 key 走 faux
  ext/approval.ts   Command/path guards, approval windows and private decision journal; stable target delivery IDs, scoped budgets and queued-run attribution
  ext/budget.ts     Persistent per-conversation logical-run admission limits and execution watchdog; approval continuations retain their allowance
  ext/schedule.ts   dwell.schedule 工具 + dwell.schedule-run durable 任务（sleep→触发→周期续睡）；时区/周期纯函数
  ext/background.ts dwell.task 工具 + 锚/Reporter 任务 + 名册 doc（后台子代理，模式同官方 example 23；子会话去掉 schedule/task/proc 三扩展防递归派生）；makeBackgroundDeliverer 审批续跑投递器（输入经 Reporter 投回子会话，结果 followUp 回父线）
  ext/proc.ts       dwell.proc 工具 + dwell.proc-run durable 任务（托管后台进程：宿主直接 spawn 同一沙箱 wrapper，watch 等退出，report followUp 回会话；重启后按 lost 回报）
  ext/web.ts        dwell.web.search / dwell.web.fetch（智谱 Coding Plan Remote MCP，自研薄 client）
  ext/lark.ts       dwell.lark.read / dwell.lark.image（聊天记录与按需识图，SDK rawClient 直调）/ dwell.lark.send（cwd 内文件发回当前会话）
  ext/send.ts       dwell.send file validation and platform dispatch; legacy dwell.lark.send shares validation and remains Feishu-only
  feishu/channel.ts Channel 连接 + 用户消息资源下载
  feishu/directory.ts 用户名/群名查询与缓存
  web/server.ts     panel HTTP + SSE（/api/*），无内置鉴权
test/*.test.ts      node:test 单测；test/probe-*.ts 是一次性真链路探针，不在 npm test 内
test/probe-bwrap.ts  bash 沙箱服务器探针（需先 apt install bubblewrap；非 Linux 自动 skip）
test/probe-proc.ts  dwell.proc 服务器探针（沙箱内进程存活/停止清场/网络可达；重启清场属 systemd 行为，部署时手动验证；非 Linux 自动 skip）
eval/              Synthetic task trials and final-state graders; faux verifies the evaluator, explicit real mode evaluates models in isolated Linux
templates/         Complete editable model connection JSON; credentials are supplied through environment variables
docs/               部署文档（中英双语）
.github/            CI workflow + Dependabot
```

## 命令

```sh
npm run check   # tsc --noEmit，改完必跑
npm test        # node --test "test/*.test.ts"; platform-specific upload/shell cases may skip; probes are separate
npm run smoke   # 无 key 时 faux 模型验证装配链路
npm run eval    # faux task outcomes; real calls require explicit --real and an isolated Linux environment
DWELL_PANEL_PORT=7788 DWELL_PANEL_ONLY=1 npm start   # Local panel; neither bot connects
```

单测按改动范围跑：`node --test test/lark.test.ts`。

CI：`.github/workflows/ci.yml`（PR / push main，Node 26 跑 check、test、faux smoke）；只做 CI 不做 CD，部署按手动 SOP。Dependabot 忽略 `@earendil-works/*`（精确锁版本，升级单独处理）。

## 工程原则（贯穿全部代码）

- 文件少而平。单文件能说清就不拆模块，不提前建目录
- Keep configuration flat. Model connections reuse pi-ai protocol adapters through `models.ts`; templates contain data. Avoid custom plugin or provider-registry frameworks and placeholders for future features.
- 不过度防御：schema 已校验的参数不再判型；错误处理只包真实会失败的边界（网络、文件 IO、飞书 API）
- 注释只写"为什么"和约束，不写对话过程或决策摇摆
- 新依赖顺序：标准库 > 已有依赖 > 先和维护者确认
- 语言：模型面向的文本（系统提示、section、工具/参数描述、工具返回、hook block、审批续跑输入、视觉 prompt）用英文，回复语言跟随用户；飞书/Telegram/panel 上直接给用户看的文案和运维日志用中文。审批后的续跑输入统一经 `decisionInput()`
- 用户文档中英双语（`README.md`/`README.zh-CN.md`、`docs/*.md`/`docs/*.zh-CN.md`），改一份就同步另一份

## 必须守住的不变量

- **Credentials stay outside shell access**: capture secrets, including `TELEGRAM_BOT_TOKEN`, before `scrubSecretEnv()` removes environment values and overwrites their Linux `/proc/self/environ` entries; a failed self-check prevents startup. Resume only after scrubbing. Model key names come from `apiKeyEnv`; add other new secrets to `harness.ts`'s `SECRET_ENV`. Pass captured credentials to clients instead of reading the environment later. Telegram errors must omit token-bearing URLs. `GH_TOKEN` is the dedicated-account exception: it remains outside the scrub list and passes through `SANDBOX_PASS_ENV`; other credentials do not.
- **Model configuration stays outside writable workspaces**: startup checks the selected JSON against data, temporary and existing conversation directories, and path guards protect the selected file. Add same-protocol endpoints and models through configuration and templates.
- **Workspace write access follows the task**: background agents default to read-only. An explicit writable child holds the single-writer lease; its parent stays read-only for the rest of that run. Approval waits retain the lease, and approval continuations retain their budget and original sender. Managed process lifetimes remain separate from run deadlines.
- **文件工具限可写域**：`write`/`edit` 限会话 cwd 与系统临时目录，`read` 禁状态目录/应用根/sqlite/`/proc`（`ext/approval.ts` 的 `fileToolViolation`，挂 `dwell-path-guard` 扩展）。软链与 `..` 逃逸按 `realpath` 后的真实路径判；bash 仍可绕过（减速带，硬边界是部署隔离）
- **panel 请求准入**：POST 强制 JSON Content-Type + Origin 同源 + Host 白名单（IP 字面量或 `DWELL_PANEL_HOST`/`DWELL_PANEL_URL` 配置名），见 `server.ts` 的 `checkPanelRequest`；本机来源除 `/healthz` 外 403（`isLocalSource`，防 bash 自调 panel 自批），仅 `DWELL_PANEL_ONLY=1` / `DWELL_PANEL_TRUST_LOCAL=1` 时关闭
- **状态文件在 agent 可写域之外**：`DWELL_STATE` 与 `DWELL_DATA` 分开（目录权限），STATE_FILES 正则与文件工具路径治理双重拦截（含 approvals.json；均为减速带，bash 可绕，硬边界是部署隔离）。不要把 users/sessions/message-map/approvals 挪进 `data/`
- **`NodeExecutionEnv` 的 cwd 必须是绝对路径**，否则 bash 工具会双拼路径（见 gotchas）
- **幂等**：飞书输入以 `requestId = message_id` 提交，重推不会产生第二次 run。handler 里只做 submit，`wait`/流式放到 handler 之外（飞书 3 秒 ack）
- **Bot identity and recovery**: use explicit destinations and bot/chat/message namespaces; user roles use `tg:<numeric user ID>` while Feishu `ou_...` IDs stay unchanged. Persist the Telegram input/command receipt before advancing the polling cursor; redelivery must retain its original conversation and control target. Outgoing delivery can be uncertain and has no exactly-once guarantee. `/new` replaces the default Feishu or Telegram route while preserving the old conversation, work records and reply anchors. Route creation and reset receipts commit together in SQLite; legacy Feishu JSON routes are adopted when replaced. The panel's clear-context action remains a context reset.
- **运行中插话**用 `whenBusy: "steer"`；`queued` 状态的提交不开新卡（会和旧卡重复）
- **run 归属**：每次 submit 前设置 `runSender` / `runVia`，审批和 /cancel 靠它判定；后台子会话的审批按 `conversationScope` 映射到父线开窗（子会话有自己的 runSender，start 时登记创建者，不随父线新消息漂移），续跑一律经 `makeBackgroundDeliverer` 建 Reporter 投回子会话——不直接 submitAndReply 子会话（会把回复卡锚在子会话上且无回报）
- **Panel input stays visible**: forward messages and attachments to the original Feishu/Telegram destination before submitting them as ordinary input.
- 状态 JSON 一律经 `writeStateJson` 写
- Process logs stay under `DWELL_STATE/proc-logs`, addressed by conversation/task ID through `dwell.proc.logs`. Children receive pipes; only the host owns log file handles. Upload writes use the fixed writer in `uploads.ts` after workspace registration, with exclusive creation and directory identity checks

## 新增工具约定

- 命名空间 `dwell.*`；`defineExtension` + `defineTool` + TypeBox schema
- 只读工具 `replay: "safe"`，有副作用的保持默认 `unsafe`
- 飞书类工具 `executionMode: "sequential"`（rate limit）
- 依赖运行时对象（channel、sessions）时用 getter 延迟绑定，参考 `makeLarkExtension`
- 治理：只读免审；bash 危险模式走 `ext/approval.ts`。新增危险模式改 `DANGEROUS`/`rmRecursiveMatch`/`STATE_FILES` 并补 `test/approval.test.ts`
- 定时/后台任务：durable task 一律 `background: true`（不占 idle、/cancel 不穿越）；自治 run（无用户消息触发）统一经 `onAutonomousRun` 开卡，归属先 `attribute` 再 submit；requestId 幂等是重启不重发的唯一保障
- 自研工具执行命令一律用 `env.exec` 的字符串形式（经 shellPath 进沙箱）；禁用字符串数组形式——数组直接 spawn 程序不经 shellPath，绕开 bash 沙箱。例外 dwell.proc：它要的是活过单次调用的进程，`env.exec` 会阻塞到退出，故直接 spawn，shell 与 bash 工具同一选择（`resolveSpawnShell`），沙箱语义不变
- 对外 HTTP 用 `fetch` + `AbortSignal.timeout`，单测 mock `fetch`（参考 `test/web.test.ts`）

## 飞书侧注意

- 同一 app 的长连接是全局的，多客户端会随机分流消息。**本机不要连 Channel**：模型层用 smoke / panel-only 验证，飞书层只在服务器验证
- 用户消息里的图片/文件必须走 `downloadMessageResource`（messages/:id/resources/:key），不能用 SDK 自带的 `downloadResource`
- 需要按钮回调的卡片用 Card V2 + `behaviors: [{ type: "callback", value }]`
- SDK 报错是 axios 外壳，真实 code/msg 在 `e.response.data`
- `message.list` 用 Asc 排序加 `start_time` 时必须显式传 `end_time`

For Telegram setup or live verification, follow the Telegram sections in the READMEs and deployment docs. Routine local checks use mocks or panel-only mode. Live tests use a dedicated test bot and isolated state, never the production token; webhook removal is a separate operator action.

## 本地工作文件（`.pi/`，整体 gitignored）

维护者本地的方案、进度与部署记录放在 `.pi/`，不进仓库。存在时按以下约定使用：

- `PLAN.md`：架构决策。涉及公共接口、路由/权限模型、新模块、新工具时先写一节，维护者确认后再落地，并在"决策记录"追加一条
- `TODO.md`：多步任务进度，完成即勾选
- `gotchas.md`：踩坑库。构建或运行报错先 grep 这里；同类问题返工 ≥2 次解决后补一条（症状 → 根因 → 解法）
- `DEPLOYMENT.md`：实际生产环境的档案。服务器地址等部署细节只写这里，不写进代码注释、测试、README、`docs/` 或本文件

## 部署

通用部署步骤见 `docs/deployment.md`；仓库里的 `Dockerfile` / `docker-compose.yml` 是通用容器形态。具体生产环境的 SOP 见本地 `.pi/DEPLOYMENT.md`。部署前先备份；SSH 到生产服务器需要维护者显式同意。

## Git

- 默认在分支上开发，经 PR 合入 main；未经允许不 push
- Conventional Commits，原子提交
- 改代码用 edit 工具，不要用 sed/python 批量替换（匹配失败不会报错）
