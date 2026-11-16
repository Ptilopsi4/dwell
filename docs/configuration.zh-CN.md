# 配置

[English](configuration.md) | 简体中文 | [README](../README.zh-CN.md)

模型连接放在一份 JSON 文件里，凭证与运行参数通过环境变量配置。`.env.example` 默认选择 OpenAI Responses 模板，并列出需要填写的 key。`npm start`、`npm run smoke` 和 `npm run eval` 会加载存在的 `.env`；`check` 和 `test` 不加载。

## 模型连接

### 选择配置文件

`DWELL_MODELS_FILE` 指定模型 JSON 文件，可用绝对路径，也可相对进程工作目录，默认 `$DWELL_STATE/models.json`。显式指定的文件不存在，或文件内容无效时，启动失败。

从下面选择一份模板，复制到私有配置位置，再把 `DWELL_MODELS_FILE` 指向副本：

| 模板 | 连接 |
|---|---|
| [OpenAI Responses](../templates/models.openai-responses.json) | OpenAI 官方 Responses API，`gpt-6-luna`，`OPENAI_API_KEY` |
| [OpenAI Chat Completions](../templates/models.openai-completions.json) | 兼容 OpenAI 的端点；替换本地 URL、模型 ID，并设置 `LOCAL_MODEL_API_KEY` |
| [Anthropic Messages](../templates/models.anthropic-messages.json) | Anthropic Messages API，`claude-sonnet-4-6`，`ANTHROPIC_API_KEY` |
| [智谱 Coding Plan](../templates/models.zai.json) | 主模型与视觉连接独立，`ZAI_CODING_CN_API_KEY` |
| [DeepSeek](../templates/models.deepseek.json) | 关闭视觉，`DEEPSEEK_API_KEY` |
| [OpenCode Go](../templates/models.opencode-go.json) | DeepSeek V4.1 Flash 文本与图片，`OPENCODE_GO_API_KEY` |

每份模板都是完整、可编辑的配置。dwell 只加载选定文件，不做模板继承、注册或自动发现。

模型文件必须放在 agent 可写工作区之外，可以使用应用目录、私有状态目录或只读配置目录。启动时拒绝位于数据、临时或已有会话目录中的配置，包括可写目录内的软链入口。JSON 只保存凭证变量名，凭证值放在环境中。安全限制见[安全边界](security.zh-CN.md)。

### 连接结构

`main` 必填，可选的 `vision` 使用相同连接结构：

```json
{
  "main": {
    "api": "openai-responses",
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-6-luna",
    "apiKeyEnv": "OPENAI_API_KEY",
    "input": ["text", "image"]
  }
}
```

`api` 支持 `openai-responses`、`openai-completions` 和 `anthropic-messages`。模型 ID 可填自定义字符串。只有 API、URL、ID 全部匹配时才从 SDK catalog 补齐元数据。

其他连接默认仅文本、`reasoning: false`、`contextWindow: 32768`、`maxTokens: 4096`，价格未知。端点的能力或限制不同时，直接设置这些字段。高级覆盖可用 `compat`、不含凭证的 `headers` 和 `cost`。`cost` 的字段是 `input`、`output`、`cacheRead`、`cacheWrite`，单位为美元/百万 token。`cost: null` 显式表示价格未知，SDK 的零值占位不代表免费。

### 视觉

省略 `vision` 时，只有主连接解析后的 `input` 包含 `image` 才复用主模型。`vision: null` 关闭识图。显式视觉连接必须声明图片能力，可以使用独立的端点、模型与凭证变量。缺少视觉 key 时保留图片、不做识别。

OpenCode Go 模板复用标准 Chat Completions adapter。SDK 为持久会话添加稳定的会话头，每次独立图片描述也有自己的单次会话 ID；模板设置 dwell 的 User-Agent。Go 仍受套餐额度与 coding agent 使用范围约束，价格未知不代表 API 无限或免费。参见[官方 Go 指南](https://opencode.ai/docs/console/go/)。

### 凭证与连接变更

在 `.env` 或服务环境中设置各连接 `apiKeyEnv` 指定的变量值，主模型的 key 必填。OpenAI 模板使用 `OPENAI_API_KEY`；自定义连接可以指定其他变量名，例如 `LOCAL_MODEL_API_KEY`。

凭证只通过 `apiKeyEnv` 引用，不支持字面量密钥、shell 命令或 JavaScript 密钥解析，也不要把凭证放进 headers。`ZAI_CODING_CN_API_KEY` 另用于启用智谱 Coding Plan 网页搜索与读取，与主模型连接无关。

修改连接后重启，主会话与后台会话都会在执行前使用新配置。切换连接前，先完成或取消仍在等待模型响应的请求。这些请求的 checkpoint 保留原模型引用；如果新配置无法解析旧引用，启动会保留 checkpoint 并拒绝续跑。真实评测复用主模型的同一加载器与客户端工厂。

### 旧环境变量兼容

未设置 `DWELL_MODELS_FILE` 且默认文件不存在时，已有安装仍可使用以下变量：

| 变量 | 取值与默认值 |
|---|---|
| `DWELL_PROVIDER` | `zai-coding-cn`（默认）或 `deepseek` |
| `DWELL_MODEL` | 智谱默认 `glm-5.3`，DeepSeek 默认 `deepseek-v4-pro` |
| `ZAI_CODING_CN_API_KEY` / `DEEPSEEK_API_KEY` | 所选提供方的 key |
| `DWELL_VISION_MODEL` | 独立的智谱视觉连接，默认 `glm-5.3-flash` |

## Bot 与用户权限

可以单独启用任一个 bot，也可以同时启用。只用 Telegram 时不需要飞书凭证。平台配置见 [Bot 配置](deployment.zh-CN.md#bot-配置)。

| 变量 | 说明 |
|---|---|
| `LARK_APP_ID` / `LARK_APP_SECRET` | 可选的飞书自建应用凭证，同时设置两项以启用飞书 |
| `TELEGRAM_BOT_TOKEN` | 可选的 BotFather token，设置后启用 Telegram 长轮询 |
| `DWELL_TELEGRAM_CHATS` | 首次启动的群种子，逗号分隔的原始数字 ID，如 `-1001234567890` |
| `DWELL_ADMINS` | 管理员 ID，逗号分隔：飞书用 `ou_...`，Telegram 用 `tg:<数字用户 ID>` |
| `DWELL_ALLOW` | 成员 ID，格式同上，逗号分隔 |

仅当 `$DWELL_STATE/telegram-chats.json` 尚无当前 bot 的记录时，才导入 `DWELL_TELEGRAM_CHATS`。之后以该 bot 的持久名单为准，空名单表示只允许私聊。管理员用 `/allowchat`、`/disallowchat`、`/chats` 即时管理，无需重启；修改环境变量不会恢复已停用的群。群状态不可读或格式无效时拒绝启动。允许的群仍需用户权限。

`DWELL_ADMINS` 和 `DWELL_ALLOW` 只在 `state/users.json` 不存在时播种一次，之后以 `users.json` 为准，用 `/allow`、`/disallow` 或 panel 维护。例如 `/allow tg:123456789 admin` 添加 Telegram 管理员，`/disallow tg:123456789` 移除该用户。已有飞书 ID 保持原样。

用户白名单为空时拒绝执行任务；Telegram `/whoami` 仍可查询待授权的 ID。

## Panel 设置

| 变量 | 说明 |
|---|---|
| `DWELL_PANEL_PORT` | panel 端口，如 `7788`；不设则不启动 panel |
| `DWELL_PANEL_HOST` | 绑定的网络接口，缺省监听全部 |
| `DWELL_PANEL_USER` | panel 操作者 ID（`ou_...` 或 `tg:<数字用户 ID>`），缺省取第一个管理员 |
| `DWELL_PANEL_URL` | panel 的外部访问地址，设置后 bot 通知附带跳转链接 |
| `DWELL_PANEL_ONLY` | 设为 `1` 时只启动 panel、不连飞书或 Telegram，用于本地开发 |
| `DWELL_PANEL_TRUST_LOCAL` | 设为 `1` 时 panel 接受本机来源的请求 |

panel 发出的消息和审批记在 `DWELL_PANEL_USER` 名下。panel-only 模式同样接受本机来源的请求。

`DWELL_PANEL_TRUST_LOCAL=1` 仅用于同机反代或 `ssh -L` 隧道访问。开启后 bash 能直连 panel，包括审批接口。详见[安全边界](security.zh-CN.md)和[部署](deployment.zh-CN.md)。

## 存储与运行环境

### 目录与 shell 访问

| 变量 | 说明 |
|---|---|
| `DWELL_DATA` | 数据目录，默认 `./data`（容器内 `/data`）：`dwell.sqlite` 和各会话工作目录 `work/` |
| `DWELL_STATE` | 服务私有目录，默认 `./state`（容器内 `/state`）：用户、会话、审批 JSON，可选的 `models.json` 与 `proc-logs/` |
| `DWELL_TOOL_PATH` | 设置后收窄 bash 工具的 `PATH`，如 `/usr/bin:/bin`，让模型看不到服务器上带凭证的程序 |

`DWELL_STATE` 必须放在 agent 可写的数据目录之外。

`GH_TOKEN` 使用专用 GitHub 账号的 classic token，权限为 `public_repo` 与 `workflow`。设置后 bash 里 `gh`/`git` 已认证，模型以外部贡献者身份工作。这个 token 对 bash 可读。详见 [GitHub 接入](github.zh-CN.md)。

### 时区与运行限额

`DWELL_TZ` 是 dwell 解释定时任务 `at` 时间与周期、注入给模型日期时使用的 IANA 时区。缺省取进程时区；服务器为 UTC 时需显式设置，例如 `Asia/Shanghai`。

| 变量 | 说明 |
|---|---|
| `DWELL_RUN_MODEL_LIMIT` | 正整数，默认 `32`：每个 run 的普通生成请求准入数，包含 durable 重试与恢复 |
| `DWELL_RUN_TOOL_LIMIT` | 正整数，默认 `128`：每个 run 的唯一工具准入数，包含被审批拦截的调用 |
| `DWELL_RUN_TIMEOUT_MINUTES` | 正整数，默认 `15`：每个 run 执行阶段的墙钟时间上限，单位分钟 |

### 沙箱模式

`DWELL_SANDBOX` 支持 `required`、`auto` 或 `off`。`NODE_ENV=production` 时默认 `required`，否则默认 `auto`。

- `required` 在沙箱探测失败时拒绝启动。
- `auto` 允许沙箱不可用时回退。
- `off` 关闭沙箱。

沙箱的限制与部署要求见[安全边界](security.zh-CN.md)。
