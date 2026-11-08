# dwell

[English](README.md) | 简体中文

常驻服务器的通用 agent。通过飞书 bot 和 Web panel 两个入口使用，对话和工具调用每步都在 SQLite 里 checkpoint，进程重启后从断点续跑。

```
飞书 ⇄ SDK Channel（单 WebSocket）─┐
                                   ├→ 会话路由 / 权限 → pi-durable conversation → 模型（GLM / DeepSeek）
浏览器 ⇄ Web panel（HTTP + SSE）───┘                         └→ 工具：bash/read/write/edit、dwell.web.*、dwell.lark.*
```

基于 [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable) 1.4.0 和飞书官方 SDK [`@larksuiteoapi/node-sdk`](https://www.npmjs.com/package/@larksuiteoapi/node-sdk)。

## 快速开始

需要 Node ≥ 22.19（直接运行 `.ts`，没有构建步骤）。

```sh
npm install
cp .env.example .env    # 填飞书应用凭证、模型 key、白名单
npm start
```

容器部署：

```sh
docker compose up -d --build    # ./data → /data，./state → /state
```

生产部署（飞书应用配置、systemd、bash 沙箱、panel 的网络布局）见 [docs/deployment.zh-CN.md](docs/deployment.zh-CN.md)。

## 配置

全部通过环境变量配置，`.env.example` 有模板。

**模型**

| 变量 | 说明 |
|---|---|
| `DWELL_PROVIDER` | `zai-coding-cn`（默认）或 `deepseek`。切换后重启，已有会话自动改用新模型 |
| `ZAI_CODING_CN_API_KEY` | 智谱 GLM Coding Plan key。provider 为 zai-coding-cn 时必填；web 工具和图片理解也用它 |
| `DEEPSEEK_API_KEY` | provider 为 deepseek 时必填 |
| `DWELL_MODEL` | 默认 `glm-5.3`（zai-coding-cn）/ `deepseek-v4-pro`（deepseek，另有 `deepseek-flash`） |
| `DWELL_VISION_MODEL` | 图片理解模型，默认 `glm-5.3-flash`，必须在 zai-coding-cn catalog 内 |

**飞书与用户**

| 变量 | 说明 |
|---|---|
| `LARK_APP_ID` / `LARK_APP_SECRET` | 飞书自建应用凭证 |
| `DWELL_ADMINS` | 管理员 open_id，逗号分隔 |
| `DWELL_ALLOW` | 成员 open_id，逗号分隔 |
| `DWELL_TZ` | dwell 解释「本地时间」的 IANA 时区：定时任务的 `at` 时间与周期、注入给模型的日期。缺省取进程时区——服务器为 UTC 时需显式设如 `Asia/Shanghai` |

`DWELL_ADMINS` 和 `DWELL_ALLOW` 只在 `state/users.json` 不存在时播种一次，之后以 `users.json` 为准，用 `/allow`、`/disallow` 或 panel 维护。白名单为空时拒绝所有消息。

**Panel**

| 变量 | 说明 |
|---|---|
| `DWELL_PANEL_PORT` | panel 端口（如 `7788`），不设则不启动 panel |
| `DWELL_PANEL_HOST` | 绑定的网络接口，缺省监听全部 |
| `DWELL_PANEL_USER` | panel 操作者的 open_id，panel 发出的消息和审批记在这个人名下；缺省取第一个管理员 |
| `DWELL_PANEL_URL` | panel 的外部访问地址，设置后飞书通知附带跳转链接 |
| `DWELL_PANEL_ONLY` | 设为 `1` 时只启动 panel、不连飞书，用于本地开发（此模式接受本机来源的请求） |
| `DWELL_PANEL_TRUST_LOCAL` | 设为 `1` 时 panel 接受本机来源的请求，仅用于同机反代或 `ssh -L` 隧道访问；开启后 bash 能直连 panel（含审批接口） |

**目录与运行环境**

| 变量 | 说明 |
|---|---|
| `DWELL_DATA` | 数据目录，默认 `./data`（容器内 `/data`）：`dwell.sqlite` 和各会话工作目录 `work/` |
| `DWELL_STATE` | 状态目录，默认 `./state`（容器内 `/state`）：`users.json`、`sessions.json`、`message-map.json`、`approvals.json`。必须放在 agent 可写的数据目录之外 |
| `DWELL_TOOL_PATH` | 设置后收窄 bash 工具的 `PATH`（如 `/usr/bin:/bin`），让模型看不到服务器上带凭证的程序 |
| `DWELL_SANDBOX` | 设为 `off` 关闭 bash 沙箱（见[安全边界](#安全边界)） |

## 飞书使用

### 对话规则

| 消息形态 | 进入的任务线 |
|---|---|
| 私聊 | 个人任务线，连续对话 |
| 群聊 @bot | 发送者在该群的独立任务线，每人一条，互不干扰、可并行 |
| 回复任务线里的某条消息（成员发给 bot 的消息、审批卡、通知等） | 加入那条任务线，不需要 @ |
| 话题群里发言 | 该话题的任务线，话题内共享上下文，不需要 @ |

同一个群的所有任务线共享工作目录 `work/<chat_id>/`。任务运行中再发消息会作为补充插入当前任务。被回复的消息查不到所属任务线时（例如超出最近 1 万条的记录上限），私聊和 @bot 的消息会转到新任务线并提示。

### 命令

| 命令 | 作用 | 谁能用 |
|---|---|---|
| `/new` | 清空本任务线上下文 | 线主、管理员 |
| `/cancel` | 中止当前任务 | 线主、管理员 |
| `/status` | 查看运行中的任务 | 管理员 |
| `/approve [分钟]` | 开启危险命令批准窗口（默认 10 分钟）；有待审命令时同时让模型继续 | 所有人（只对自己生效） |
| `/deny` | 关闭自己的批准窗口并取消待审请求；管理员关闭整条任务线的 | 所有人 |
| `/allow @某人 [admin]` | 添加成员或管理员 | 管理员 |
| `/disallow @某人` | 移除用户（不能移除最后一名管理员） | 管理员 |
| `/whoami` | 显示自己的 open_id | 所有人 |
| `/help` | 使用说明卡片 | 所有人 |

命令按已知命令表精确匹配；`/approve` 的分钟数限制在 1–120。

### 危险命令审批

bash 命令命中下列模式时会被拦截：`rm -rf`、`ssh`/`scp`/`rsync` 远程、带数据或非 GET 的 `curl`、`wget --post`、全局安装包（`npm install -g`、`apt install`、`pip install`）、`docker`/`systemctl`/`crontab`。`sudo` 直接拒绝。访问状态文件的命令也会被拒绝。

拦截后 bot 发审批卡片，点批准或回复 `/approve` 开启时间窗口，窗口内同一人在该任务线的危险命令放行。能审批的人：触发者本人、线主、管理员。panel 发起的任务审批卡只私发给 panel 操作者，不发到群里。

## 模型可用的工具

| 工具 | 说明 | 审批 |
|---|---|---|
| `bash` / `read` / `write` / `edit` | 在会话工作目录内操作文件和执行命令 | bash 危险命令需审批 |
| `dwell.web.search` / `dwell.web.fetch` | 全网搜索、读取网页正文。走智谱 Coding Plan Remote MCP，计入套餐额度。设置了 `ZAI_CODING_CN_API_KEY` 就会启用，与 `DWELL_PROVIDER` 无关 | 免审 |
| `dwell.lark.read` | 读飞书聊天记录：默认当前会话最近 20 条；`around` 读某条消息前后文；`chat` 读指定会话。bot 必须在目标会话内；读当前会话之外的会话仅管理员触发的任务可用 | 免审 |
| `dwell.lark.image` | 按消息 id 拉取图片描述：群里不 @ 发的图不进上下文，模型读历史看到 `[image]` 占位后按需回看 | 免审 |
| `dwell.lark.send` | 把会话工作目录内的文件发到当前会话的飞书聊天：图片（png/jpeg/gif/webp）≤ 10MB，其余文件 ≤ 30MB，不允许空文件。只发当前会话，来源限本会话工作目录；panel 任务（无飞书聊天）在 panel 提供下载 | 免审 |
| `dwell.schedule` | 给当前会话定一个定时触发（单次或周期，如工作日早报、延时提醒）。每个 schedule 是一个 durable 后台任务：重启不丢，`/cancel` 不影响，停机错过的多次只补一次后照周期继续。每会话上限 20 个，周期最短 10 分钟 | 免审 |
| `dwell.task` | 把自包含长任务派给命名的后台子代理：当前对话不被占住，子代理跑完把结果作为 followUp 报回。子代理与父会话共享工作目录和工具（去掉 dwell.schedule / dwell.task / dwell.proc），由 background 锚任务持有，`/cancel` 与清空上下文都不会停它。`dwell.task stop` 中止并移除该子代理；panel 的「中止当前运行」只中止当前 run（子代理仍在名单里）。每会话并发上限 3 个、全局 6 个；其危险命令按父线的审批窗口拦截 | 免审 |
| `dwell.proc` | 托管后台进程（dev server、watcher、长爬虫等需活过单次 bash 调用的进程）：同一沙箱与工作目录，输出落 `.dwell-proc/<name>.log`，退出码与日志尾以 followUp 报回（`notify: false` 可关）。`dwell.proc stop` 杀进程树；`/cancel` 与清空上下文不影响。进程与服务同生命周期：dwell 重启即终止并告知会话。每会话上限 5 个、全局 10 个；`start` 与 bash 同一条危险命令审批 | 危险命令需审批（同 bash） |

图片和文件：

- 图片由 `DWELL_VISION_MODEL` 生成文字描述后交给主模型，原图存到工作目录 `uploads/`。没有智谱 key 时只存图，不做识别
- 文件存到 `uploads/`，模型用 `read` 读取
- 群聊里**不 @ bot 发的图不会自动进入上下文**：用户问及时，模型通过 `dwell.lark.image` 按需回看
- 表情包不支持识别，音视频暂不支持

模型面向的内置提示词（系统提示、工具描述、拦截说明）是英文，模型按用户使用的语言回复。

## Web panel

浏览器访问 `http://<host>:<DWELL_PANEL_PORT>/`。

**panel 没有内置鉴权。** 必须由部署侧保证只有可信网络能访问（私网、防火墙、隧道，或用 `DWELL_PANEL_HOST` 绑定到内网接口），不要暴露到公网。服务端做了请求准入：POST 强制 JSON Content-Type、Origin 同源、Host 限 IP 或配置名（用域名访问需配 `DWELL_PANEL_URL`）。本机来源的请求会被拒绝（见[安全边界](#安全边界)），所以要从另一台机器访问 panel。

- 侧栏按「我的任务 / 私聊 / 群聊 / 已归档」分组，实时显示 transcript（流式文本、工具调用、思考过程可折叠）
- 输入框可附加图片/文件（回形针、粘贴、拖入），图片由视觉模型描述后进入上下文，飞书会话里附件会先发到原聊天
- 工具行可下载 `dwell.lark.send` / `write` 产出的文件（限该会话工作目录内，强制附件下载不内联执行）
- 侧栏状态点同时反映 panel 实时通道与飞书长连接（绿正常、黄连接中/重连中、红断开）；底部铃铛查看最近的运行告警，角标为未读数；时钟按钮列出全部会话的活跃定时任务并可取消
- 后台任务子会话在侧栏单独分组展示（挂在父会话名下），点开可看 transcript，会话菜单里可中止其当前运行
- 可以新建 panel 任务、重命名、归档、清空上下文、中止、审批、管理用户
- 向飞书会话发消息时，消息先以「From admin」形式出现在原聊天里，再由 bot 回复，群成员都看得到
- 在 panel 里中止或清空飞书会话，原聊天会收到通知
- panel 任务可以开启飞书通知：完成、失败或需要审批时 bot 私聊操作者；直接回复这条通知就能在飞书里继续该任务

## 安全边界

层次从硬到软：容器/系统隔离 → bash 沙箱（mount namespace，内核强制）→ 凭证擦除 → 文件工具路径治理 → 请求准入 → bash 危险命令正则。

- 飞书 open_id 白名单准入，白名单外的消息回复固定提示
- **凭证**：模型 key、飞书凭证、白名单读入内存后从进程环境删除；Linux 下还会把启动时原始环境区（`/proc/<pid>/environ`）里的密钥值覆写为 0 并自检，擦不干净拒绝启动（`test/probe-scrub.ts` 服务器上验证）。续跑任务在擦除完成后才恢复调度，bash 里 `printenv` 和 `cat /proc/$PPID/environ` 都拿不到
- **文件工具**：`write`/`edit` 只能写本会话工作目录与系统临时目录；`read` 不能读状态目录、应用目录、数据库和 `/proc`（其余系统路径可读）。相对路径 `..` 逃逸与符号链接都按归一化后的真实路径判定
- **panel 请求准入**：POST 强制 `Content-Type: application/json`；有 `Origin` 时必须与 `Host` 同源；`Host` 只接受 IP 字面量或 `DWELL_PANEL_HOST`/`DWELL_PANEL_URL` 配置的主机名。防跨站 CSRF 借浏览器打内网 panel，也防 DNS rebinding 读 SSE。本机来源（回环与本机任一接口地址）的请求除 `/healthz` 外一律 403：bash 与 panel 同机，否则 agent 可以自己调 panel 批准危险命令、加管理员、读全部会话
- **状态文件在 agent 可写域之外**：`users.json`/`sessions.json`/`message-map.json`/`approvals.json` 由文件工具路径治理与 bash 正则双重拦截。bash 仍可用通配符、软链、重定向等变体绕过这些检查；沙箱未启用时它们是减速带，硬边界是部署隔离（容器/系统加固）
- **bash 沙箱**（bubblewrap mount namespace）：Linux 上探测到 `bwrap` 且启动自检通过时启用（`/healthz` 的 `sandbox` 字段可见）。启用时 bash 只能看到白名单挂载：`/usr`、`/etc`、node 安装目录与 DNS 解析目录只读，会话工作目录与 `/tmp` 可写，`/proc` 为沙箱私有实例；环境变量清空后仅保留 `PATH` 与 `HOME=<工作目录>`。状态目录、应用目录（含 `.env`）、其他会话的工作目录、`/home`、`/root`、docker/systemd socket 在沙箱内不存在，内核级强制。`DWELL_SANDBOX=off` 可强制关闭；未启用（非 Linux、未装 bwrap 或自检失败）时回退到路径治理 + 危险命令正则。仓库的 Docker 镜像未装 bwrap（默认 seccomp 也通常禁止 userns），容器形态下沙箱不启用。已知残留：`/tmp` 是服务进程的 `/tmp`，所有会话共享（systemd 下开 `PrivateTmp=yes` 可与宿主 `/tmp` 隔开）；沙箱不隔离网络，bash 到 panel 的请求靠上面的本机来源拒绝挡住，网段内其他可被诱导代发请求的服务属于网络设计问题
- bash 危险命令正则是减速带而非硬墙（变体无限）：命中危险模式需审批，访问状态文件、`.env`、`/proc/*/environ` 直接拒绝；`sudo` 直接拒绝。沙箱启用后它们仍保留（纵深防御），角色从事后封堵变为行为确认闸
- 进程应以非 root 运行（Dockerfile 已创建 `dwell` 用户），容器是最终隔离边界；沙箱未启用时工作目录只是路径约定，bash 能 `cd` 出去
- **群聊是互信域**：同群成员共享工作目录，且能通过回复加入他人的任务线，看到该线处理过的内容。敏感内容请用私聊

## 运行告警

运行期故障（任务 faulted/parked、扩展 hook 抛错、Session 失败等）会记入日志并私聊全部管理员；同类告警（按类型 + 扩展 + 任务类型）10 分钟内只发第一条，被抑制的条数并入下一条。飞书未连接时只记日志。`session_failed`（存储层失败，进程已不可用）会在尽力通知管理员后退出进程，交给 systemd/docker 重启，部署时需确认配置了自动重启。

全部告警（含被抑制未私聊的）保留最近 50 条在内存中，panel 侧栏可查看（`GET /api/reports`，重启即清）。

外部探活用 `GET /healthz`（panel 端口）：返回 `{ ok, uptimeSec, feishu, sandbox }`，`feishu` 为长连接状态（panel-only 时为 `off`），`sandbox` 表示 bash 沙箱是否启用；`feishu` 为 `failed` 时返回 503。

## 开发

```sh
npm run check    # tsc --noEmit
npm test         # node:test 单测（test/*.test.ts）
npm run smoke    # 冒烟：有模型 key 时走真模型，没有时用 faux 模型验证装配链路
DWELL_PANEL_PORT=7788 DWELL_PANEL_ONLY=1 npm start    # 本地只起 panel
```

同一个飞书应用的长连接会在多个客户端之间随机分流消息，本机调试不要和线上实例同时连同一个应用。

贡献约定和代码结构见 `AGENTS.md`。
