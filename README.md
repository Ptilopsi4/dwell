# dwell

服务器常驻通用 agent：飞书 bot 进出，pi-durable 每步 checkpoint，重启续跑。

- 方案与决策记录：`.pi/PLAN.md`
- 架构：`lark-cli event consume`（NDJSON 子进程）→ 白名单/命令 → pi-durable conversation（每 chat 独立 cwd）→ DeepSeek → `lark-cli im` 回复

## 环境变量

| 变量 | 说明 |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek 凭证（必填） |
| `DWELL_ALLOW` | 飞书 open_id 白名单，逗号分隔（不设则拒绝所有消息） |
| `DWELL_MODEL` | 模型 id，默认 `glm-5.3` |
| `DWELL_DATA` | 数据目录（sqlite/sessions/会话工作目录），默认 `./data`，容器内 `/data` |

## 飞书命令

`-new` 新对话 / `-status` 任务状态 / `-cancel` 中止当前任务

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
# 首次：容器内完成 lark-cli 登录（凭证挂 volume 持久化）
```
