# Development and evaluation

English | [简体中文](development.zh-CN.md) | [README](../README.md)

dwell runs TypeScript directly on Node.js 26 or later, with no build step. Contribution conventions and code layout are in [AGENTS.md](../AGENTS.md).

Related guides: [Configuration](configuration.md), [Usage](usage.md), [Agent runtime](agent.md), [Security boundaries](security.md), [Deployment](deployment.md), and [GitHub integration](github.md).

## Commands

```sh
npm run check    # tsc --noEmit
npm test         # node:test unit tests (test/*.test.ts), at most two test files at a time
npm run smoke    # uses the real model when a key is set, a faux model otherwise
DWELL_DATA=./data/preview DWELL_STATE=./state/preview \
DWELL_PANEL_HOST=127.0.0.1 DWELL_PANEL_PORT=7788 DWELL_PANEL_ONLY=1 npm start
npm run eval     # synthetic faux trials; ignores host model configuration and credentials
```

For a focused unit-test run, pass the affected file directly, for example `node --test test/lark.test.ts`.

## Offline checks and local panel

Type checking, unit tests, and the default faux evaluation do not require model calls. `npm run eval` stays in faux mode unless explicitly given `--real`; a key in `.env` does not switch it to a real model.

`npm run smoke` loads the configured model and uses it when a key is present, so it can incur API charges. Without a key, it uses a faux model to check assembly. `npm start`, `npm run smoke`, and `npm run eval` load `.env` when it exists; `check` and `test` do not.

The panel-only command above starts neither bot and permits access from the local machine. Open [http://127.0.0.1:7788](http://127.0.0.1:7788). Panel tasks use the configured model and can incur charges. The panel has no built-in login; see [Security boundaries](security.md) before changing its access settings.

## Faux evaluation

The evaluator has 14 synthetic cases covering file/data tasks, clarification, untrusted instructions, approval decisions, background synthesis, managed processes, and schedule cancellation. Invoice repair, ledger reconciliation, retry-policy clarification with work recovery, and a background release audit include hidden final-state checks. One trial per case produces 15 records because approval has approve and deny variants.

The default faux mode is always `purpose: "evaluator_verification"`. To select a subset:

```sh
npm run eval -- --cases csv-reconciliation,node-bugfix --trials 1
```

The four cases with hidden final-state checks use version 4 guidance for the fire-and-forget goal flow: goals are host-created, agents checkpoint progress and blockers with `dwell.work`, verify with their own commands, and report the result in chat. The release case also requires explicit background waiting. The v4 update preserves the earlier fixtures, hidden assertions, and final output rules. Manifests record `caseVersion` and `comparabilityNote`; guidance and execution contracts differ across versions, so scores across versions are not a controlled comparison.

`node-bugfix` uses version 2. Its task specifies a fixed Node verification command; grading requires a successful result from that command after the edit, linked to the actual tool call. The final-code assertions remain unchanged. Earlier versions checked only for a bash proposal, so their scores are not directly comparable.

## Real-model requirements and limits

Real trials require a dedicated Linux environment with working bubblewrap and a dedicated output directory outside the application and shared sandbox mounts, including `/usr`, `/etc`, and `/tmp`. macOS refuses real mode and does not fall back to an unsandboxed run. Use synthetic fixtures only, without Feishu, Telegram, or GitHub credentials or external real data.

After preparing that environment, select the same `models.json` and key as the main runtime, then run:

```sh
npm run eval -- --real --cases csv-reconciliation,node-bugfix --trials 1 --out /eval-results
```

`--real` requires explicit `--cases`, `--trials`, and `--out`. Each trial gets separate workspace, state, database, and home directories. The child receives only an allowlisted environment and its selected model key; production state and other credentials are excluded.

Defaults are a 120-second trial deadline, 32 request admissions, and 128 tool admissions. `--deadline-ms`, `--max-requests`, and `--max-tools` set bounded overrides.

A real evaluation stops the remaining batch on a deterministic connection failure such as authentication, permissions, region, account quota, or configuration. Completed records and skipped counts remain visible. Aborted trials also retain final work state without replacing their original failure.

## Cost ceiling and result evidence

`--max-cost-usd <amount>` sets an aggregate conservative cost ceiling for a real run and requires known configured or catalog pricing. Every provider call reserves a worst-case allowance before dispatch, including compaction and background children. Reported usage settles the reservation; missing usage retains the bound. The evaluator may stop before the planned trial count when the next reservation would exceed the ceiling. This is a local admission estimate, not a provider billing guarantee.

The parent grades final files and behavior after the child exits, including preserving inputs and checking the Node fix independently. A zero exit code alone cannot pass a trial; irrelevant clarification and wrong files fail the graders. Clarification replies and approval decisions are declared scripted assistance.

Each trial saves `manifest.json`, `transcript.json`, `tasks.json`, `usage.json`, `evidence.json`, `workspace-snapshot.json`, logs, and `result.json`. The run's `results.json` collects the results. `cost.estimatedCostUsd` is estimated from recorded usage and configured or catalog prices, with `pricingKnown` recorded. Unknown pricing produces `null`, and `actualBill` remains `null`.

Faux passes verify the evaluator and tool wiring. Synthetic real results apply to the selected cases and declared assistance; they do not establish production performance.

## Live bot isolation

Feishu spreads the events of one app across all connected clients at random. When debugging locally, do not connect to the same app as a running production instance.

Use panel-only mode and mocked Telegram tests for routine local work. For a live Telegram check, create a dedicated test bot with a separate token, data/state directories, user allowlist, and test group. Check private text, `/ask@test_bot`, a reply to the bot, `/whoami`, an attachment, approval, and restart recovery there. Keep its polling instance separate from production. Passing unit tests does not establish live Telegram or production acceptance. Bot setup and live verification procedures are in [Deployment](deployment.md).

## CI

[.github/workflows/ci.yml](../.github/workflows/ci.yml) runs `check`, `test`, and a faux-model `smoke` on Node 26 for every PR and every push to `main`. Deployment stays manual; follow [Deployment](deployment.md) for operating a service.
