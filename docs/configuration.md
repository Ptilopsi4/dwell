# Configuration

English | [简体中文](configuration.zh-CN.md) | [README](../README.md)

Model connections are configured in one JSON file. Credentials and runtime settings use environment variables. `.env.example` selects the OpenAI Responses template and names the key to fill in. `npm start`, `npm run smoke`, and `npm run eval` load `.env` when it exists; `check` and `test` do not.

## Model connections

### Choose a configuration file

`DWELL_MODELS_FILE` selects the model JSON file. The path may be absolute or relative to the process working directory. Its default is `$DWELL_STATE/models.json`. An explicitly selected missing file or any invalid file fails startup.

Copy one of these templates to a private configuration location, then point `DWELL_MODELS_FILE` to that copy:

| Template | Connection |
|---|---|
| [OpenAI Responses](../templates/models.openai-responses.json) | Official OpenAI Responses API, `gpt-6-luna`, `OPENAI_API_KEY` |
| [OpenAI Chat Completions](../templates/models.openai-completions.json) | OpenAI-compatible endpoint; replace the local URL/model and set `LOCAL_MODEL_API_KEY` |
| [Anthropic Messages](../templates/models.anthropic-messages.json) | Anthropic Messages API, `claude-sonnet-4-6`, `ANTHROPIC_API_KEY` |
| [Zhipu Coding Plan](../templates/models.zai.json) | Separate main and vision connections, `ZAI_CODING_CN_API_KEY` |
| [DeepSeek](../templates/models.deepseek.json) | Vision disabled, `DEEPSEEK_API_KEY` |
| [OpenCode Go](../templates/models.opencode-go.json) | DeepSeek V4.1 Flash for text and images, `OPENCODE_GO_API_KEY` |

Each template is a complete editable configuration. dwell loads the selected file without template inheritance, registration, or automatic discovery.

Keep the model file outside agent-writable workspaces. Use the application directory, private state directory, or a read-only configuration directory. Startup rejects a selected file in data, temporary, or existing conversation directories, including writable aliases. The JSON contains credential variable names only; the credentials belong in the environment. See [Security boundaries](security.md).

### Connection structure

`main` is required. An optional `vision` connection uses the same structure:

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

`api` accepts `openai-responses`, `openai-completions`, or `anthropic-messages`. Model IDs may be custom strings. Metadata is supplemented from the SDK catalog only when the API, URL, and ID all match.

Other connections default to text input, `reasoning: false`, `contextWindow: 32768`, `maxTokens: 4096`, and unknown pricing. Set these fields directly when the endpoint supports different limits or capabilities. Advanced overrides include `compat`, non-secret `headers`, and `cost`. The `cost` fields are `input`, `output`, `cacheRead`, and `cacheWrite`, in USD per million tokens. `cost: null` explicitly marks pricing unknown. The SDK's zero placeholders do not imply free usage.

### Vision

Omitting `vision` reuses the main connection only if its resolved `input` includes `image`. Set `vision: null` to disable recognition. An explicit vision connection must declare image support and may use its own endpoint, model, and credential variable. A missing vision key saves images without recognition.

The OpenCode Go template uses the standard Chat Completions adapter. Note that selecting it routes the full conversation content — including file data read by tools — to opencode.ai under a stable per-conversation session identifier; do not use it for sensitive workspaces. The SDK supplies a stable session header for durable conversations, and each independent image description receives a one-shot session ID. The template sets dwell's User-Agent. Go usage remains subject to the subscription's limits and supported coding-agent use; unknown pricing does not mean unlimited or free API usage. See the [official Go guide](https://opencode.ai/docs/console/go/).

### Credentials and connection changes

Set the variable named by each connection's `apiKeyEnv` in `.env` or the service environment. The main model's key is required. The OpenAI template uses `OPENAI_API_KEY`; a custom connection can name another variable, such as `LOCAL_MODEL_API_KEY`.

Keys are resolved only through `apiKeyEnv`. Literal credentials, shell commands, and JavaScript key resolvers are unsupported. Keep credentials out of headers. `ZAI_CODING_CN_API_KEY` also enables Zhipu Coding Plan web search/fetch, independently of the main model connection.

Restart after connection changes. Main and background conversations use the new configuration before execution. Before switching connections, finish or cancel requests still waiting on a model response. Their checkpoints retain the original model references; startup preserves the checkpoints and refuses to resume if the new configuration cannot resolve those references. Real evaluations use the same main connection loader and client factory.

### Legacy environment configuration

When `DWELL_MODELS_FILE` is unset and the default file is absent, existing installations can still use these variables:

| Variable | Values and defaults |
|---|---|
| `DWELL_PROVIDER` | `zai-coding-cn` (default) or `deepseek` |
| `DWELL_MODEL` | Default `glm-5.3` for Zhipu or `deepseek-v4-pro` for DeepSeek |
| `ZAI_CODING_CN_API_KEY` / `DEEPSEEK_API_KEY` | Key for the selected provider |
| `DWELL_VISION_MODEL` | Separate Zhipu vision connection; default `glm-5.3-flash` |

## Bots and user permissions

Configure either bot or both. Telegram-only needs no Feishu credentials. See [Bot setup](deployment.md#bot-setup) for platform configuration.

| Variable | Description |
|---|---|
| `LARK_APP_ID` / `LARK_APP_SECRET` | Optional Feishu custom app credentials; set both to enable Feishu |
| `TELEGRAM_BOT_TOKEN` | Optional BotFather token; enables Telegram long polling |
| `DWELL_TELEGRAM_CHATS` | First-start group seeds, comma-separated raw numeric IDs, such as `-1001234567890` |
| `DWELL_ADMINS` | Admin IDs, comma-separated: Feishu `ou_...`, Telegram `tg:<numeric user ID>` |
| `DWELL_ALLOW` | Member IDs in the same format, comma-separated |

`DWELL_TELEGRAM_CHATS` seeds strict allowlist groups only when the bot has no record in `$DWELL_STATE/telegram-chats.json`. Afterwards that bot's persisted list is authoritative, including an empty list for private chats only. `/allowgroup` opens member access in the current group; `/allowchat` selects explicit-user access. `/disallowgroup`, `/disallowchat`, and `/chats` manage the policy without restarting. Optional `memberChats` records member-enabled groups; old records without it remain strict. Changing the environment does not restore a revoked group. Unreadable or invalid group state prevents startup.

`DWELL_ADMINS` and `DWELL_ALLOW` seed `state/users.json` only when it does not exist. Afterwards that file is authoritative. `/allow tg:123456789 admin` grants a Telegram admin and clears any block; `/disallow tg:123456789` removes explicit roles and persists a block that overrides group access. The panel uses the same operations. Old files without `blocked` load with an empty block list. Invalid or unreadable role state prevents startup without replacing it with environment seeds. Existing Feishu IDs stay unchanged.

An empty global allowlist denies private and strict-group tasks; member-enabled groups use their own scoped grant. Telegram `/whoami` remains available to find the ID to authorize.

## Panel settings

| Variable | Description |
|---|---|
| `DWELL_PANEL_PORT` | Panel port, such as `7788`; the panel does not start when unset |
| `DWELL_PANEL_HOST` | Interface to bind; all interfaces when unset |
| `DWELL_PANEL_USER` | Panel operator ID (`ou_...` or `tg:<numeric user ID>`); defaults to the first admin |
| `DWELL_PANEL_URL` | External panel URL; bot notifications link to it when set |
| `DWELL_PANEL_ONLY` | `1` starts only the panel, without connecting to Feishu or Telegram, for local development |
| `DWELL_PANEL_TRUST_LOCAL` | `1` makes the panel accept requests from the local machine |

Messages and approvals from the panel are recorded under `DWELL_PANEL_USER`. Panel-only mode also accepts requests from the local machine.

Use `DWELL_PANEL_TRUST_LOCAL=1` only for a same-host reverse proxy or an `ssh -L` tunnel. With it enabled, bash can reach the panel, including the approval API. See [Security boundaries](security.md) and [Deployment](deployment.md).

## Storage and runtime

### Directories and shell access

| Variable | Description |
|---|---|
| `DWELL_DATA` | Data directory, default `./data` (`/data` in the container): `dwell.sqlite` and per-conversation working directories under `work/` |
| `DWELL_STATE` | Service-private directory, default `./state` (`/state` in the container): user/session/approval JSON, optional `models.json`, and `proc-logs/` |
| `DWELL_TOOL_PATH` | Narrows the bash tool's `PATH`, such as `/usr/bin:/bin`, so the model cannot see programs that carry credentials |

`DWELL_STATE` must be outside the agent-writable data directory.

`GH_TOKEN` accepts a classic token from a dedicated GitHub account with `public_repo` and `workflow` scopes. When set, bash gets authenticated `gh`/`git` and the model works as an outside contributor. This token remains readable by bash. See [GitHub integration](github.md).

### Timezone and run limits

`DWELL_TZ` is the IANA timezone dwell uses for scheduled-task `at` times and recurrence, and for the date given to the model. It defaults to the process timezone. On a UTC server, set it explicitly, for example to `Asia/Shanghai`.

| Variable | Description |
|---|---|
| `DWELL_RUN_MODEL_LIMIT` | Positive integer, default `32`: normal generation request admissions per run, including durable retries/recovery |
| `DWELL_RUN_TOOL_LIMIT` | Positive integer, default `128`: unique tool admissions per run, including calls blocked for approval |
| `DWELL_RUN_TIMEOUT_MINUTES` | Positive integer, default `30`: execution-phase wall-clock limit per run, in minutes |

### Sandbox mode

`DWELL_SANDBOX` accepts `required`, `auto`, or `off`. It defaults to `required` when `NODE_ENV=production`, otherwise `auto`.

- `required` refuses startup if the sandbox probe fails.
- `auto` permits fallback when the sandbox is unavailable.
- `off` disables the sandbox.

See [Security boundaries](security.md) for the sandbox's limits and deployment requirements.
