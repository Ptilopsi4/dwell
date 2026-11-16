# 安全边界

[English](security.md) | 简体中文 | [README](../README.zh-CN.md)

各层从硬到软依次为容器/系统隔离、bash 沙箱（内核强制的 mount namespace）、凭证擦除、文件工具路径检查、panel 请求准入和危险命令正则。进程应以非 root 用户运行；Dockerfile 已创建 `dwell` 用户。部署隔离是硬边界。

## 准入与互信域

用户白名单使用飞书 `ou_...` ID 和 Telegram `tg:<数字用户 ID>` 身份。Telegram 群还需通过 `DWELL_TELEGRAM_CHATS`。未授权用户可以用 Telegram `/whoami` 查询自己的 ID，但不能提交任务。白名单配置见[配置](configuration.zh-CN.md)，聊天命令见[使用指南](usage.zh-CN.md)。

群聊是互信域。同群成员共享工作目录，也能通过回复加入他人的任务线，看到该线处理过的内容。敏感内容请用私聊。

## 凭证

模型 key（包括主模型、视觉配置中自定义的 `apiKeyEnv` 名称）、飞书凭证、Telegram token 和白名单读入内存后，会从进程环境中删除。Linux 下还会把启动时原始环境区（`/proc/<pid>/environ`）中的密钥值覆写为 0 并自检；擦除失败则拒绝启动。续跑任务在擦除完成后才恢复调度，bash 中的 `printenv` 和 `cat /proc/$PPID/environ` 都拿不到这些值。Telegram 请求错误会省略含 token 的 URL。

服务器探针 [test/probe-scrub.ts](../test/probe-scrub.ts) 检查凭证擦除，运行方法见文件头注释。

`GH_TOKEN` 是例外：`gh` 与 `git` 从环境变量读取凭证，因此 bash 仍能读取它。应按已暴露对待；边界是专用账号与吊销 token。账号权限、签名密钥暴露和吊销方法见 [GitHub 接入](github.zh-CN.md)。

## bash 隔离

bubblewrap 沙箱要求 Linux、`bwrap` 和启动自检通过。`/healthz` 的 `sandbox` 字段显示是否已启用。

- `DWELL_SANDBOX=required` 在探测失败时拒绝启动，且不会恢复 checkpoint；`NODE_ENV=production` 时默认采用此模式。
- `auto` 明确允许沙箱不可用时以路径检查和危险命令正则运行，是非生产环境默认值。
- `off` 关闭沙箱。

仓库镜像设了 production，但没有安装 bwrap，因此运维配置隔离与预期模式前，默认启动会失败。沙箱未启用时，工作目录只是路径约定，bash 能 `cd` 出去。

启用后，bash 只能看到白名单挂载：

- `/usr`、`/etc`、Node 安装目录与 DNS 解析目录只读。
- 会话工作目录与 `/tmp` 可写；`/proc` 为沙箱私有实例。
- 状态、应用文件（包括 `.env`）、其他会话、`/home`、`/root` 和 Docker/systemd socket 均不可见。

环境只含 `PATH`、`HOME=<工作目录>` 和指向 `/tmp/dwell-xdg` 的 `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME`，另加已配置的 GitHub 变量。各会话共享 `/tmp`；systemd 的 `PrivateTmp=yes` 将其与宿主 `/tmp` 隔开。

沙箱不隔离网络。panel 的本机来源检查阻止 bash 直连；其他可代发请求的服务需通过网络策略限制。主机隔离、沙箱配置和服务器探针 [test/probe-bwrap.ts](../test/probe-bwrap.ts) 的用法见[部署](deployment.zh-CN.md)。

## 文件工具与上传

`write` 与 `edit` 只能写会话工作目录和系统临时目录。`read` 禁读状态目录、应用目录、数据库和 `/proc`；其他系统路径可读。固定 POSIX 辅助进程核对目录身份，并持有最终文件描述符进行字节读写；硬链接文件和路径变化会被拒绝。每次文件操作增加一次辅助进程启动开销。

Windows 不提供受保护的文件访问。此后端不支持 rename、remove 或 watch。shell 另按沙箱和命令规则处理。

附件使用固定 writer，绑定已注册的工作区和上传目录身份，以独占方式创建新文件，拒绝链接、已有目标与目录变化。上传文件仍可写。重复消息可能留下不同附件文件；输入提交仍按消息 ID 去重。Linux 使用现有 bash 沙箱，macOS 执行同样的目录检查但没有沙箱。Windows 拒绝附件上传，文本功能仍可用。媒体处理和文件投递限制见[使用指南](usage.zh-CN.md)。

## 状态保护与命令审批

状态文件放在 agent 可写域之外。`users.json`、`sessions.json`、`message-map.json` 和 `approvals.json` 由文件工具路径检查与 bash 正则双重拦截。bash 仍可用通配符、软链、重定向等变体绕过这些检查；沙箱未启用时，这些检查只能拖慢攻击，硬边界是部署隔离。

危险命令正则无法覆盖所有变体。命中危险模式的命令需审批；访问状态文件、`.env` 或 `/proc/*/environ`，以及使用 `sudo`，均直接拒绝。沙箱启用后仍保留正则作为纵深防御，用于确认命中命令的意图。执行预算与工作区归属见 [Agent 运行机制](agent.zh-CN.md)，审批行为见[使用指南](usage.zh-CN.md)。

## Panel 访问

panel 没有内置登录。部署侧网络边界与以下请求检查共同保护它：

- POST 强制 `Content-Type: application/json`。
- 有 `Origin` 时，其主机名和端口必须与 `Host` 匹配；格式错误的 Origin 和 `Origin: null` 会被拒绝。
- `Host` 只接受 IP 字面量、内置的 `localhost` 名称，或 `DWELL_PANEL_HOST`/`DWELL_PANEL_URL` 配置的主机名。

这些检查防止跨站请求借操作者的浏览器访问内网 panel（CSRF），也防止 DNS rebinding 读取 SSE。

本机来源（回环与本机任一接口地址）的请求，除 `/healthz` 外一律返回 403。bash 与 panel 同机；允许它调用 panel，就可能让 agent 自批危险命令、添加管理员或读取所有会话。就绪状态、运行指标、静态页面和 SSE 都受同样的本机来源拒绝约束。

`DWELL_PANEL_ONLY=1` 关闭两个 bot 连接，并允许本机访问 panel，供开发使用。`DWELL_PANEL_TRUST_LOCAL=1` 允许本机访问，但不关闭 bot。同机反代或 `ssh -L` 隧道会让请求显示为本机来源，需要显式设置这项信任；开启后 bash 也能访问 panel 和审批 API。优先让浏览器从另一台机器连接。panel 设置见[配置](configuration.zh-CN.md)，本地检查见[开发](development.zh-CN.md)，网络部署与验证见[部署](deployment.zh-CN.md)。
