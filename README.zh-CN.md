# dwell

[English](README.md) | 简体中文

常驻服务器的通用智能体，可以通过飞书、Telegram 或网页面板使用。
会话和任务检查点保存在 SQLite 中，中断的工作可在进程重启后恢复。

- 读写文件、执行命令、搜索网页，并把产物发回当前会话。
- 安排定时任务、交给后台子代理，或启动托管进程。
- 用审批窗口、运行预算和工作区单写者规则约束执行。
- 验证声明的产物，提交评审，再由操作者记录验收。

需要 Node.js 26 或以上，直接运行 TypeScript，无构建步骤。
基于 [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) 1.4.0
和飞书官方 SDK。

## 快速开始

安装依赖，创建本地环境文件：

```sh
npm ci
cp .env.example .env
```

在 `.env` 中填写模型密钥。示例默认选择 OpenAI Responses 模板和
`OPENAI_API_KEY`；其他协议或服务地址使用相同的[模型连接配置](docs/configuration.zh-CN.md#模型连接)。

本地只使用网页面板，不连接两个机器人：

```sh
DWELL_DATA=./data/preview DWELL_STATE=./state/preview \
DWELL_PANEL_HOST=127.0.0.1 DWELL_PANEL_PORT=7788 DWELL_PANEL_ONLY=1 npm start
```

打开 [http://127.0.0.1:7788](http://127.0.0.1:7788)。
任务会调用配置的模型，可能产生 API 费用。
这个模式使用独立的预览数据，不连接机器人；面板没有内置登录。

使用机器人时，先按[飞书或 Telegram 配置](docs/deployment.zh-CN.md#bot-配置)准备凭证和获准用户 ID，
再运行 `npm start`。两个机器人可以独立启用；Telegram [首次接入步骤](docs/deployment.zh-CN.md#telegram可选)
说明了如何先用 `/whoami` 查询 ID，再创建正式的用户状态。
用户白名单仅在首次启动时写入 `state/users.json`，之后通过面板或管理员命令修改。

已有实例运行时，使用独立的机器人凭证和数据、状态目录。
Linux 常驻服务见 [systemd 部署指南](docs/deployment.zh-CN.md#2-主机目录布局)，
包含服务权限、沙箱检查、更新和恢复步骤。
仓库 Docker 镜像未安装 bubblewrap，默认生产模式会拒绝启动；
运行前先阅读 [Docker 部署](docs/deployment.zh-CN.md#docker)，配置所需隔离。

## 文档导航

| 我想要…… | 文档 |
| --- | --- |
| 选择模型、视觉连接或环境变量 | [配置](docs/configuration.zh-CN.md) |
| 使用聊天、命令、审批、附件或面板 | [使用指南](docs/usage.zh-CN.md) |
| 理解预算、后台任务、验证契约和工具 | [代理运行机制](docs/agent.zh-CN.md) |
| 理解互信范围、凭证、文件访问和隔离 | [安全边界](docs/security.zh-CN.md) |
| 安装、监控、更新、备份和恢复服务 | [部署与运维](docs/deployment.zh-CN.md) |
| 接入专用 GitHub 账号 | [GitHub 接入](docs/github.zh-CN.md) |
| 本地开发、运行测试与评测 | [开发](docs/development.zh-CN.md) |

## 开发

```sh
npm run check
npm test
```

冒烟、隔离环境中的真实模型评测和机器人联调见[开发与评测](docs/development.zh-CN.md)。
`npm run smoke` 在配置密钥时会调用真实模型；
`npm run eval` 默认使用模拟模型，只有显式传入 `--real` 才会调用真实模型。
