# AGENTS.md — dwell

服务器常驻通用智能体，通过飞书、Telegram bot 或网页面板使用。底层 pi-durable 每步保存检查点，进程重启后续跑。用户文档见 `README.md`（英）/ `README.zh-CN.md`（中），部署见 `docs/deployment.md` / `docs/deployment.zh-CN.md`。

## 技术栈

- Node ≥ 26，直接运行 `.ts`（type stripping），**无构建步骤**。`tsconfig` 开了 `erasableSyntaxOnly`：不能用 enum、namespace、构造函数参数属性；import 必须带 `.ts` 后缀
- `@earendil-works/pi-durable` / `pi-ai` / `chord` 锁精确版本 `1.4.0`（experimental，API 可能变）。不加 `^`，升级作为单独任务处理
- 飞书：`@larksuiteoapi/node-sdk` 的 Channel 模块（单 WebSocket 收消息和卡片回调，自动重连）。lark-cli 已退出运行时，不要再引入
- Telegram：标准 `fetch` 调用 Bot API，每个 token 只运行一个长轮询实例。保留群隐私模式，群内输入需来自获准群，并通过定向命令或回复本 bot 触发；群准入模式见下方不变量。
- 模型：`models.json` 定义 `main` 与可选 `vision` 连接，通过 `apiKeyEnv` 引用密钥。运行时和评估共用 `src/models.ts`，模板与旧环境变量兼容方式见用户文档。
- 存储：pi-durable SQLite（`$DWELL_DATA/dwell.sqlite`）保存会话与 Telegram 路由、输入和命令回执；`$DWELL_STATE/` 下的 JSON 保存用户、路由投影、审批和轮询游标。
- Panel：单文件 `src/web/panel.html` + vendored Basecoat CSS/JS，没有前端框架和打包

## 目录

```
src/
  index.ts          主程序：装配、消息路由与命令、平台投递、审批、面板桥接、自治回报和后台父子作用域恢复
  telegram.ts       Bot API 传输：消息归一化、长轮询与游标、顺序发送文本、文件和按钮回调
  telegram-entry.ts 持久输入与命令回执、审批按钮权限检查
  telegram-chats.ts 按 bot 保存群准入策略，管理命令重放时不重复执行
  feishu-delivery.ts 自治回报的持久投递、重启恢复与发送结果不确定记录
  harness.ts        Harness.open：storage + provider + registry（CodingTools/dwell/审批/web）+ NodeExecutionEnv；凭证清理；视觉 describer；GitHub 接入（开关、非交互 env、提示词段、token 自检）
  models.ts         共用连接加载与客户端工厂，复用 pi-ai 协议适配器；模型 ID 原样传递，配置模板只存数据
  workspace.ts      持久子代理只读角色与工作区写租约，处理父代理交接与启动恢复
  pipeline.ts       显式区分面板、飞书和 Telegram 目标；群准入、空内容、降级与命令判定均无副作用
  sessions.ts       会话路由、所有者、元数据和消息锚点（上限 10k）；/new 持久切换默认线，保留成员线隔离标记
  users.ts          角色（env 播种，state/users.json 为运行时真相）
  state.ts          状态 JSON 原子写（tmp + rename，promise 链串行）+ DATA_DIR/STATE_DIR/APP_ROOT/DEFAULT_CWD/DWELL_TZ 常量（放这里避免 approval→harness 循环依赖）
  media.ts          入站图片/文件预处理（图片 → 视觉描述，文件 → cwd/uploads）
  uploads.ts        固定上传写入器：注册工作目录身份、独占创建文件；Linux 下进沙箱，Windows 禁用上传
  report.ts         运行告警：onReport → 日志 + 管理员私聊（10 分钟同键节流）；session_failed 不节流，index 侧退出进程交重启
  sandbox.ts        bash 沙箱：bwrap wrapper 生成 + 启动探测（失败不启用，回退路径治理；真实行为由 probe-bwrap.ts 服务器验证）
  smoke.ts          冒烟：有 key 走真模型，无 key 走 faux
  ext/approval.ts   命令与路径拦截、审批窗口和私有决定日志；稳定投递 ID、作用域预算与排队输入归属
  ext/budget.ts     按会话持久记录逻辑运行准入上限与执行时限，审批续跑沿用原额度
  ext/schedule.ts   dwell.schedule 工具 + dwell.schedule-run durable 任务（sleep→触发→周期续睡）；时区/周期纯函数
  ext/background.ts dwell.task 工具 + 锚/Reporter 任务 + 名册 doc（后台子代理，模式同官方 example 23；子会话去掉 schedule/task/proc 三扩展防递归派生）；makeBackgroundDeliverer 审批续跑投递器（输入经 Reporter 投回子会话，结果 followUp 回父线）
  ext/proc.ts       dwell.proc 工具 + dwell.proc-run durable 任务（托管后台进程：宿主直接 spawn 同一沙箱 wrapper，watch 等退出，report followUp 回会话；重启后按 lost 回报）
  ext/web.ts        dwell.web.search / dwell.web.fetch（智谱 Coding Plan Remote MCP，自研薄 client）
  ext/lark.ts       dwell.lark.read / dwell.lark.image（聊天记录与按需识图，SDK rawClient 直调）
  ext/send.ts       dwell.send 文件校验与平台投递（按会话目的地发飞书/Telegram，panel 提供下载）
  feishu/channel.ts Channel 连接 + 用户消息资源下载
  feishu/directory.ts 用户名/群名查询与缓存
  web/server.ts     panel HTTP + SSE（/api/*），无内置鉴权
test/*.test.ts      node:test 单测；test/probe-*.ts 是一次性真链路探针，不在 npm test 内
test/probe-bwrap.ts  bash 沙箱服务器探针（需先 apt install bubblewrap；非 Linux 自动 skip）
test/probe-proc.ts  dwell.proc 服务器探针（沙箱内进程存活/停止清场/网络可达；重启清场属 systemd 行为，部署时手动验证；非 Linux 自动 skip）
eval/              合成任务试验与最终状态判定；faux 仅验证评测器，真实模型模式需显式开启并在隔离 Linux 中运行
templates/         可直接编辑的完整模型连接 JSON，凭证由环境变量提供
docs/               部署文档（中英双语）
.github/            CI workflow + Dependabot
```

## 命令

```sh
npm run check   # tsc --noEmit，改完必跑
npm test        # node:test 单测；主进程验收、guarded 文件栈、shell/管道等 POSIX 专属用例在 Windows 跳过（以 Linux CI 为准），探针需单独执行
npm run smoke   # 无 key 时 faux 模型验证装配链路
npm run eval    # 默认 faux；真实调用需显式 --real，并使用隔离 Linux 环境
DWELL_PANEL_PORT=7788 DWELL_PANEL_ONLY=1 npm start   # 只启动本地面板，不连接任何 bot
```

单测按改动范围跑：`node --test test/lark.test.ts`。

CI：`.github/workflows/ci.yml`（PR / push main，Node 26 跑 check、test、faux smoke）；只做 CI 不做 CD，部署按手动 SOP。Dependabot 忽略 `@earendil-works/*`（精确锁版本，升级单独处理）。

## 工程原则（贯穿全部代码）

- 文件少而平。单文件能说清就不拆模块，不提前建目录
- 配置保持扁平。模型连接经 `models.ts` 复用 pi-ai 协议适配器，模板只存数据；不提前引入插件框架、自定义提供方注册体系或未来功能占位。
- 不过度防御：schema 已校验的参数不再判型；错误处理只包真实会失败的边界（网络、文件 IO、飞书 API）
- 注释只写"为什么"和约束，不写对话过程或决策摇摆
- 新依赖顺序：标准库 > 已有依赖 > 先和维护者确认
- 语言：模型面向的文本（系统提示、section、工具/参数描述、工具返回、hook block、审批续跑输入、视觉 prompt）用英文，回复语言跟随用户；飞书/Telegram/panel 上直接给用户看的文案和运维日志用中文。审批后的续跑输入统一经 `decisionInput()`
- 用户文档中英双语（`README.md`/`README.zh-CN.md`、`docs/*.md`/`docs/*.zh-CN.md`），改一份就同步另一份

## 必须守住的不变量

- **凭证不进入 shell**：先捕获 `TELEGRAM_BOT_TOKEN` 等凭证，再由 `scrubSecretEnv()` 删除环境变量，并覆写 Linux `/proc/self/environ` 中的原值；自检失败则拒绝启动，清理完成后才能恢复任务。模型密钥名来自 `apiKeyEnv`，其他新增凭证需加入 `harness.ts` 的 `SECRET_ENV`。客户端使用已捕获的凭证，不在之后重读环境。Telegram 错误中不得出现带 token 的 URL。专用账号的 `GH_TOKEN` 是例外：保留在环境中并经 `SANDBOX_PASS_ENV` 透传，其他凭证不透传。
- **模型配置在可写工作区之外**：启动时检查所选 JSON 是否位于数据、临时或既有会话目录内，路径治理也保护该文件。同协议的新端点与模型通过配置和模板接入。
- **写权限跟随任务**：后台子代理默认只读，显式可写子任务持有单写者租约；父代理在本轮剩余时间保持只读。等待审批保留租约，审批续跑沿用预算和原发送者。托管进程的生命周期独立于运行时限。
- **文件工具限可写域**：普通会话的 `write`/`edit` 限 cwd 与系统临时目录，`read` 禁状态目录/应用根/sqlite/`/proc`（`ext/approval.ts` 的 `fileToolViolation`，挂 `dwell-path-guard` 扩展）；成员隔离线及其子代理的文件工具读写与目录列表进一步限于本线 cwd。软链与 `..` 逃逸按 `realpath` 后的真实路径判；bash 仍可绕过（减速带，硬边界是部署隔离）
- **panel 请求准入**：POST 强制 JSON Content-Type + Origin 同源 + Host 白名单（IP 字面量或 `DWELL_PANEL_HOST`/`DWELL_PANEL_URL` 配置名），见 `server.ts` 的 `checkPanelRequest`；本机来源除 `/healthz` 外 403（`isLocalSource`，防 bash 自调 panel 自批），仅 `DWELL_PANEL_ONLY=1` / `DWELL_PANEL_TRUST_LOCAL=1` 时关闭
- **状态文件在 agent 可写域之外**：`DWELL_STATE` 与 `DWELL_DATA` 分开（目录权限），STATE_FILES 正则与文件工具路径治理双重拦截（含 approvals.json；均为减速带，bash 可绕，硬边界是部署隔离）。不要把 users/sessions/message-map/approvals 挪进 `data/`
- **`NodeExecutionEnv` 的 cwd 必须是绝对路径**，否则 bash 工具会双拼路径（见 gotchas）
- **幂等**：飞书输入以 `requestId = message_id` 提交，重推不会产生第二次 run。handler 里只做 submit，`wait`/流式放到 handler 之外（飞书 3 秒 ack）
- **bot 身份与恢复**：使用显式投递目标，以及 bot、群聊、消息命名空间；Telegram 角色使用 `tg:<数字用户 ID>`，飞书保留 `ou_...`。输入与命令回执持久化后才推进 Telegram 游标，重投保留原会话与控制目标。出站发送可能结果不确定，不保证恰好一次。`/new` 替换默认飞书或 Telegram 路由，保留旧会话、工作记录和回复锚点；路由创建与重置回执在同一 SQLite 事务提交，替换旧飞书 JSON 路由时一并接管。面板清空上下文仍只重置上下文。
- **群成员准入**：`/allowgroup` 开放当前 Telegram 群，`/allowchat` 保留逐人授权模式；群授权不授予私聊或管理权限，显式封禁优先。群成员线按 bot、群、话题、发送者隔离路由与目录，回复他人或旧共享线时转到自己的线；`actorScoped` 标记跨重启、`/new` 和模式切换保留，文件工具及后台子代理只访问本线目录。仅有群授权的用户需 dwell 管理员点击原卡批准危险命令，已有全局成员沿用原审批规则。
- **运行中输入**：普通任务线用 `whenBusy: "steer"` 插话；成员隔离线及其后台子线统一用 `followUp`，包括面板与审批输入，避免 SDK 将两种模式的不同操作者合并进同一轮。`queued` 状态的提交不开新卡（会和旧卡重复）。新输入、自治工作与审批续跑均按原发送者、入口和父作用域复查权限，撤权不自动终止已运行的子代理或进程。
- **run 归属**：每次 submit 前设置 `runSender` / `runVia`，审批和 /cancel 靠它判定；后台子会话的审批按 `conversationScope` 映射到父线开窗（子会话有自己的 runSender，start 时登记创建者，不随父线新消息漂移），续跑一律经 `makeBackgroundDeliverer` 建 Reporter 投回子会话——不直接 submitAndReply 子会话（会把回复卡锚在子会话上且无回报）
- **面板输入可见**：先把消息与附件转发到原飞书或 Telegram 目标，再作为普通输入提交。
- 状态 JSON 一律经 `writeStateJson` 写
- 进程日志保存在 `DWELL_STATE/proc-logs`，通过 `dwell.proc.logs` 按会话和任务 ID 读取。子进程只接收管道，日志文件句柄由宿主持有。上传先注册工作区，再经 `uploads.ts` 的固定写入器独占创建文件并检查目录身份。

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

配置或真实验证 Telegram 时，按用户文档与部署指南的 Telegram 章节操作。常规本地检查使用模拟接口或仅面板模式；真实测试使用专用测试 bot 和隔离状态，不使用生产 token。删除 webhook 属于单独的运维操作。

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
