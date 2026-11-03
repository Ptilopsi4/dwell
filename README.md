# dwell

服务器常驻通用 agent：飞书 bot 进出，pi-durable 每步 checkpoint，重启续跑。

- 方案与决策记录：`.pi/PLAN.md`
- 架构：飞书官方 SDK Channel（单 WebSocket 收发）→ 会话路由/权限 → pi-durable conversation（多用户多线）→ GLM（zai-coding-cn）→ 流式卡片回复

## 环境变量

| 变量 | 说明 |
|---|---|
| `DWELL_PROVIDER` | 模型来源：`zai-coding-cn`（默认）/ `deepseek`。切换后重启，已有会话自动改用新模型 |
| `ZAI_CODING_CN_API_KEY` | 智谱 Coding Plan 凭证（`DWELL_PROVIDER=zai-coding-cn` 时必填） |
| `DEEPSEEK_API_KEY` | DeepSeek 凭证（`DWELL_PROVIDER=deepseek` 时必填） |
| `DWELL_ALLOW` | 飞书 open_id 白名单，逗号分隔（不设则拒绝所有消息） |
| `DWELL_MODEL` | 模型 id，默认 `glm-5.3`（zai-coding-cn）/ `deepseek-v4-pro`（deepseek，另有 `deepseek-flash`） |
| `DWELL_DATA` | 数据目录（sqlite/sessions/会话工作目录），默认 `./data`，容器内 `/data` |

## Web 工具

`dwell.web.search`（全网搜索）与 `dwell.web.fetch`（读网页正文）：智谱 GLM Coding Plan Remote MCP，计入套餐额度。只要设置了 `ZAI_CODING_CN_API_KEY` 就会注册（与 `DWELL_PROVIDER` 解耦，主模型切 deepseek 时仍可用）；只读免审批，回答自带来源 URL。

## Web 工具

`dwell.web.search`（全网搜索）与 `dwell.web.fetch`（读网页正文）：智谱 GLM Coding Plan Remote MCP，计入套餐额度。只要设置了 `ZAI_CODING_CN_API_KEY` 就会注册（与 `DWELL_PROVIDER` 解耦，主模型切 deepseek 时仍可用）；只读免审批，回答自带来源 URL。

## 多模态输入

飞书发图：glm-5.3 无视觉，图片由 `DWELL_VISION_MODEL`（默认 glm-5.3-flash，走套餐）单发单答生成描述，描述文本进主上下文，原图留档 `uploads/`。发文件：直接落盘 `uploads/` 并告知模型路径（read 可读）。音视频暂不支持。无 ZAI key 时图片仅留档。

## 飞书历史读取

`dwell.lark.read`：模型可读飞书聊天记录——默认当前会话最近 20 条（零参数），或 `around`（消息 id）定位某条前后文，或 `chat` 指定会话。返回正序消息（发送者/时间/消息 id）。跨线引用「上面那个问题」、回顾群聊场景适用。只读免审批，bot 必须在目标会话内。

## 飞书命令

`/new` 新对话 / `/status` 任务状态 / `/cancel` 中止 / `/approve [分钟]` 批准危险命令 / `/deny` 拒绝

## 开发

```sh
npm install
npm run check     # 类型检查
npm test          # 单测
npm run smoke     # 冒烟（无 key 时 faux 模型验证链路）
npm start         # 常驻运行
```

## 部署

```sh
cp .env.example .env   # 填 key 与白名单
docker compose up -d --build
```

## 多用户与安全边界

- 角色：`DWELL_ADMINS`（管理员）/ `DWELL_ALLOW`（成员）播种，运行时用 `/allow <open_id> [admin]`、`/disallow <open_id>` 热更新（持久化到 `data/users.json`，重启不丢）
- 会话路由：私聊=个人线；群聊平消息=每人独立任务线（互不污染、并行）；回复某条消息=参与该任务线；话题群=话题即任务
- **群聊是互信域**：共享工作目录（`work/<chat_id>/`）+ 回复可参与任务线意味着参与者可访问该线上处理过的内容。敏感内容请用私聊
- 权限：`/new` `/cancel` `/status` 管理员（或线主）；审批=触发者/线主/管理员；白名单外回复固定提示
- 安全：敏感凭证启动后从进程环境移除（bash 工具 `printenv` 拿不到）；状态文件在 agent 可写域之外

## Web panel

- 访问：`http://<服务器IP>:7788/?token=<DWELL_PANEL_TOKEN>`（监听 0.0.0.0，配合内网穿透使用，勿暴露公网）。首次访问后 token 换成 HttpOnly cookie（30 天）并从地址栏移除，之后直接访问 `http://<服务器IP>:7788/` 即可
- 功能：会话侧栏（我的任务/私聊/群分组/归档）、实时 transcript（SSE 增量，含生成中文本预览与工具调用折叠）、审批、用户管理；给飞书会话发消息会转发到原对话（From admin），panel 任务可开飞书通知（回复通知即续接）；窄屏侧栏为抽屉
- 主题：未手动切换时跟随系统，◐/◑ 手动切换后记忆
- 配置：`DWELL_PANEL_PORT` + `DWELL_PANEL_TOKEN`（缺一不启动）；本地开发 `DWELL_PANEL_ONLY=1` 只起 panel 不连飞书
