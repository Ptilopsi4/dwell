# dwell

English | [简体中文](README.zh-CN.md)

A server-resident agent you can reach through Feishu, Telegram, or a web panel.
Conversations and task checkpoints live in SQLite, so interrupted work can resume after a restart.

- Work with files, run commands, search the web, and return files to the conversation.
- Schedule work, delegate to background agents, or keep a managed process running.
- Use approval windows, run budgets, and a single-writer workspace policy to control execution.
- Launch a durable goal with `/goal` and get the result reported back in chat; progress survives compaction and restarts.

dwell runs TypeScript directly on Node.js 26 or later, with no build step.
It uses [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) 1.4.0
and the official Feishu SDK.

## Quick start

Install dependencies and create your local environment file:

```sh
npm ci
cp .env.example .env
```

Fill in the model key in `.env`. The example selects the OpenAI Responses template and
`OPENAI_API_KEY`; other protocols and endpoints use the same
[model connection configuration](docs/configuration.md#model-connections).

For a local panel without connecting either bot:

```sh
DWELL_DATA=./data/preview DWELL_STATE=./state/preview \
DWELL_PANEL_HOST=127.0.0.1 DWELL_PANEL_PORT=7788 DWELL_PANEL_ONLY=1 npm start
```

Open [http://127.0.0.1:7788](http://127.0.0.1:7788).
Tasks use the configured model and can incur API charges.
This mode uses separate preview data, connects neither bot, and has no built-in login.

To use a bot, follow [Feishu or Telegram setup](docs/deployment.md#bot-setup),
configure its credentials and authorized user IDs, then run `npm start`.
Either bot can run alone. Telegram's [first-installation steps](docs/deployment.md#telegram-optional)
explain how to obtain an ID with `/whoami` before creating the permanent user state.
User allowlists seed `state/users.json` only on first start; later changes use the panel or admin commands.

Use separate bot credentials and data/state directories when another instance is already running.
For a persistent Linux service, follow the [systemd deployment guide](docs/deployment.md#2-host-layout),
including service permissions, sandbox checks, updates, and recovery.
The supplied Docker image lacks bubblewrap and refuses its default production startup until
isolation is configured; read [Docker deployment](docs/deployment.md#docker) before starting it.

## Documentation

| I want to… | Guide |
| --- | --- |
| Choose a model, vision connection, or environment setting | [Configuration](docs/configuration.md) |
| Use chats, commands, approvals, attachments, or the panel | [Usage](docs/usage.md) |
| Understand budgets, background work, durable goals, and tools | [Agent runtime](docs/agent.md) |
| Understand trust, credentials, file access, and isolation | [Security](docs/security.md) |
| Install, monitor, update, back up, or restore a service | [Deployment and operations](docs/deployment.md) |
| Connect a dedicated GitHub account | [GitHub integration](docs/github.md) |
| Develop locally or run tests and evaluations | [Development](docs/development.md) |

## Development

```sh
npm run check
npm test
```

See [development and evaluation](docs/development.md) for smoke tests, isolated real-model trials,
and live bot verification. `npm run smoke` uses a real model when a key is configured;
`npm run eval` stays in faux mode unless explicitly given `--real`.
