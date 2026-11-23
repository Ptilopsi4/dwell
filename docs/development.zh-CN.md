# 开发与评测

[English](development.md) | 简体中文 | [README](../README.zh-CN.md)

dwell 在 Node.js 26 或更新版本上直接运行 TypeScript，没有构建步骤。贡献约定和代码结构见 [AGENTS.md](../AGENTS.md)。

相关指南：[配置](configuration.zh-CN.md)、[使用指南](usage.zh-CN.md)、[Agent 运行机制](agent.zh-CN.md)、[安全边界](security.zh-CN.md)、[部署](deployment.zh-CN.md)、[GitHub 接入](github.zh-CN.md)。

## 命令

```sh
npm run check    # tsc --noEmit
npm test         # node:test 单测（test/*.test.ts），最多同时运行两个测试文件
npm run smoke    # 有模型 key 时走真模型，没有时用 faux 模型
DWELL_DATA=./data/preview DWELL_STATE=./state/preview \
DWELL_PANEL_HOST=127.0.0.1 DWELL_PANEL_PORT=7788 DWELL_PANEL_ONLY=1 npm start
npm run eval     # 合成 faux 评测；忽略宿主模型配置与凭证
```

只检查受影响的单测时，可以直接传入文件，例如 `node --test test/lark.test.ts`。

## 离线检查与本地 panel

类型检查、单测与默认 faux 评测不需要调用模型。除非显式传入 `--real`，`npm run eval` 始终使用 faux 模式；`.env` 中有 key 也不会切到真模型。

`npm run smoke` 加载配置的模型，有 key 时会调用它，因此可能产生 API 费用；没有 key 时使用 faux 模型验证装配链路。`npm start`、`npm run smoke` 和 `npm run eval` 会在 `.env` 存在时加载它，`check` 和 `test` 不会。

上面的 panel-only 命令不连接任何 bot，并允许本机访问。打开 [http://127.0.0.1:7788](http://127.0.0.1:7788)。panel 任务使用配置的模型，可能产生费用。panel 没有内置登录；调整访问设置前请阅读[安全边界](security.zh-CN.md)。

## Faux 评测

评测器包含 14 个合成 case，覆盖文件与数据任务、澄清、不可信指令、审批决定、后台汇总、托管进程和定时任务取消。发票修复、账本对账、含工作记录恢复的重试策略澄清、后台发布审计均含隐藏终态检查。全部 case 各运行一次时，共生成 15 份记录，因为审批 case 分别运行批准和拒绝两个变体。

默认 faux 模式始终标为 `purpose: "evaluator_verification"`。可以选择子集：

```sh
npm run eval -- --cases csv-reconciliation,node-bugfix --trials 1
```

这四项含隐藏终态检查的 case 使用 v4 指导，对应一发即忘的 goal 流程：目标由宿主直建，Agent 用 `dwell.work` checkpoint 保存进度与阻塞项、自行验证并在会话里报告结果；发布核查还必须显式等待后台结果。v4 保留旧版本的 fixture、隐藏断言和最终产物规则。manifest 记录 `caseVersion` 与 `comparabilityNote`；不同版本的指导和执行契约有变化，跨版本分数不能作为受控对比。

`node-bugfix` 使用 v2。任务给出固定的 Node 验证命令；评分要求编辑后执行该命令，取得与实际工具调用关联的成功回执。最终代码断言保持不变。旧版本只检查是否提出过 bash 调用，其分数不能与 v2 直接比较。

## 真实模型评测的要求与限制

真实评测需要独立 Linux 环境、可用的 bubblewrap，以及位于应用与沙箱公共挂载之外的专用输出目录；不能放在 `/usr`、`/etc`、`/tmp` 等位置。macOS 会拒绝 real 模式，不会回退到无沙箱执行。只用合成 fixture，不带飞书、Telegram 或 GitHub 凭证，也不使用外部真实数据。

准备好环境后，选择与主程序相同的 `models.json` 和 key，再运行：

```sh
npm run eval -- --real --cases csv-reconciliation,node-bugfix --trials 1 --out /eval-results
```

`--real` 必须显式指定 `--cases`、`--trials` 和 `--out`。每次试验都有独立的工作区、状态、数据库与 home 目录；子进程仅接收白名单环境和选定模型 key，不带生产状态或其他凭证。

默认单次期限为 120 秒、请求准入 32 次、工具准入 128 次。`--deadline-ms`、`--max-requests` 和 `--max-tools` 可在限定范围内调整。

真实评测遇到认证、权限、地域、账户额度或配置等确定性连接故障时，会停止后续批次，保留已完成记录及跳过数量。中止的试验也保存最终工作状态，不覆盖原始失败原因。

## 费用上限与结果证据

`--max-cost-usd <amount>` 为一次真实评测设置聚合保守费用上限，要求配置或目录中有已知价格。每次 provider 调用发出前先预留最坏情况额度，包含上下文压缩与后台子会话。已报告用量用于结算预留，缺少用量时保留原上界；下一次预留会超限时，评测可能在计划 trial 数完成前停止。这是本地准入估算，不保证 provider 的实际账单金额。

子进程退出后，父进程按最终文件和行为评分，包括输入文件保留情况，并独立验证 Node 修复。退出码为 0 本身不能通过；无关澄清、错误文件也会失败。澄清答复与审批决定作为预先声明的脚本协助记录。

每次试验保存 `manifest.json`、`transcript.json`、`tasks.json`、`usage.json`、`evidence.json`、`workspace-snapshot.json`、日志和 `result.json`，整轮的 `results.json` 汇总结果。`cost.estimatedCostUsd` 按记录用量和配置/catalog 价格估算，并记录 `pricingKnown`；价格未知时为 `null`，`actualBill` 始终为 `null`。

faux 通过只验证评测器与工具装配。合成真实结果限于所选 case 和声明的协助，不代表生产表现。

## 真实 bot 隔离

同一个飞书应用的事件会在所有已连接客户端之间随机分流。本机调试不要和线上实例同时连接同一个应用。

日常本地开发使用 panel-only 和 mock Telegram 单测。需要真实 Telegram 检查时，创建独立测试 bot，使用单独的 token、数据/状态目录、用户白名单与测试群。在测试 bot 上检查私聊文本、`/ask@test_bot`、回复 bot、`/whoami`、附件、审批与重启恢复，轮询实例与生产分开。单测通过不代表真实 Telegram 或生产验收通过。bot 配置与真实验证步骤见[部署](deployment.zh-CN.md)。

## CI

[.github/workflows/ci.yml](../.github/workflows/ci.yml) 在每个 PR 和 push 到 `main` 时，于 Node 26 上运行 `check`、`test` 和 faux 模型 `smoke`。部署仍为手动；服务运维见[部署](deployment.zh-CN.md)。
