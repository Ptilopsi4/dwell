# GitHub 接入

[English](github.md) | 简体中文 | [README](../README.zh-CN.md)

配置 `GH_TOKEN` 后，bash 中的 `gh` 与 `git` 使用专用 GitHub 账号认证。dwell 以外部贡献者身份工作：fork 上游、push 到 fork，再用 `gh pr create` 提 PR，无需上游仓库的 collaborator 权限。先按[部署指南](deployment.zh-CN.md)配置宿主与沙箱；变量见[配置](configuration.zh-CN.md)。

## 账号与 token

1. 为 dwell 建立专用账号，邮箱使用运维能收到的地址，GitHub 会发送 token 到期提醒。
2. 建立 **classic** personal access token，勾选 `public_repo` 与 `workflow`，设置到期日。fine-grained token 不能向账号不是成员的 public 仓库提 PR。缺少 `workflow` 时，上游改动包含 `.github/workflows/` 就会导致 `gh repo sync` 和 push 到 fork 失败。
3. 在私有环境文件中加入 `GH_TOKEN=<token>`，重启 dwell。

启动时与之后每 24 小时，dwell 会通过 `https://api.github.com/user` 检查 token。返回 401、缺少 `public_repo` 或 `workflow`、14 天内到期时，会私聊通知管理员。

## 宿主配置

安装 `git` 和 `gh`（gh 使用 GitHub 官方 apt 源），再写入系统级 `/etc/gitconfig`。沙箱只读挂载 `/etc`，`HOME` 为工作目录，因此只有系统级 git 配置生效：

```ini
[user]
	name = <account>
	email = <ID>+<account>@users.noreply.github.com
[credential "https://github.com"]
	helper =
	helper = !/usr/bin/gh auth git-credential
[init]
	defaultBranch = main
[url "https://github.com/"]
	insteadOf = git@github.com:
	insteadOf = ssh://git@github.com/
```

用 `gh api user --jq .id` 获取 `<ID>`。缺少 `user.name` 或 `user.email` 会导致沙箱内 commit 失败。`insteadOf` 把 submodule 等 SSH URL 转换为 HTTPS，因为沙箱没有 SSH key。`gh` 与 `git` 的非交互环境变量由 dwell 设置。

## commit 签名

git 在本地签名的 commit 才会在 GitHub 显示 Verified；通过 personal access token 调用 API 创建的 commit 不签名。需要签名时，可建立仅用于签名的 SSH key，要求 git 2.34 及以上：

```sh
sudo install -d -o root -g dwell -m 750 /etc/dwell
sudo ssh-keygen -t ed25519 -N "" -C "<account> signing" -f /etc/dwell/git-signing
sudo chown root:dwell /etc/dwell/git-signing /etc/dwell/git-signing.pub
sudo chmod 640 /etc/dwell/git-signing
```

将 `/etc/dwell/git-signing.pub` 加入账号 Settings → SSH and GPG keys，类型选择 **Signing Key**，此 key 不能用于 push。再向 `/etc/gitconfig` 追加：

```ini
[gpg]
	format = ssh
[user]
	signingkey = /etc/dwell/git-signing.pub
[commit]
	gpgsign = true
[tag]
	gpgsign = true
```

key 需要放在 `/etc` 下，沙箱内 git 才能读取。noreply 地址算作账号的已验证邮箱，因此这些签名 commit 会显示 Verified。

## 构建检查与 CI

bash 与服务共用内存。系统提示要求本地只做轻量检查：formatter、linter、改动包的构建与测试，并使用 `timeout` 和 `nice`。`OOMPolicy=continue` 不能阻止内核杀掉主 Node 进程；主进程被杀后仍需由重启策略拉起。内存配置见 [systemd 设置](deployment.zh-CN.md#systemd-unit)。

完整 CI 在账号 fork 的 GitHub Actions 上运行，模型通过 `gh run` 跟进。保持该账号的 Actions 开启。fork 没有 secrets，fork 的 `GITHUB_TOKEN` 只作用于 fork。仅在 `pull_request` 触发、需要 secrets 或 self-hosted runner 的 workflow 无法在 fork 运行，模型会报告未运行的检查。

本地工具链安装在宿主，因为沙箱只读挂载 `/usr`。缓存放在工作目录之外。以 Go 为例，将官方 tarball 安装到 `/usr/local/go`，把 `go` 与 `gofmt` 链接到 `/usr/bin`（在 `DWELL_TOOL_PATH` 内），设置 `/usr/local/go/go.env`：

```ini
GOPATH=/tmp/dwell-go/path
GOCACHE=/tmp/dwell-go/cache
GOTOOLCHAIN=local
```

默认代理不可达时，在这里设置 `GOPROXY`/`GOSUMDB` 镜像。`GOTOOLCHAIN=local` 禁止自动下载其他版本工具链。重新安装 Go 会覆盖 `go.env`。

## 容器

仓库的 Dockerfile 不含 git 和 gh，需要自行构建派生镜像安装，并写入 `/etc/gitconfig`。若运维关闭 bash 沙箱，bash 可见 `GH_TOKEN` 与擦除后剩余环境，需相应配置[容器隔离](deployment.zh-CN.md#docker)。

## 验证与排障

- 确认启动日志包含 `[dwell] GH_TOKEN 自检通过`，`/healthz` 返回 `"sandbox":true`。沙箱关闭时，bash 继承剩余的完整环境。
- 在会话中让 dwell 执行 `gh auth status`。
- 获得发布测试内容的授权后，选择近期改过 workflow 的上游：fork、执行 `gh repo sync`、push 分支到 fork，再提 PR。commit 作者应关联到该账号；已签名 commit 应显示 Verified。直接 push 上游必须返回 403。
- 确认会话工作目录未出现 `.config` 或 `.local`。

遇到 401 时，修正或替换 token。同步或推送因 workflow 改动失败时，检查 `workflow` scope。commit 无法识别作者时，检查系统级 `user.name` 与 `user.email`。运行 `test/probe-bwrap.ts` 后要重启 dwell。探针按自身环境重写共用沙箱 wrapper，需由服务恢复 `GH_TOKEN` 透传。

## 凭证暴露与吊销

`GH_TOKEN` 是[凭证边界](security.zh-CN.md)的例外：`gh` 与 `git` 从环境读取，bash 也能读取，需按已暴露对待：

- 任何白名单成员都能让模型打印 token，bash 输出在会话和 panel 中可见。
- 依赖安装、构建脚本和测试会继承 token，除非模型使用 `env -u GH_TOKEN` 执行。沙箱不隔离网络。
- 模型读取的内容可能诱导它外发 token。

签名私钥同样对 bash 可读。泄露后他人能生成显示该账号 Verified 的 commit，但不能用它 push 或代表账号操作。需在 GitHub 删除对应 Signing Key，使其失效。

系统提示要求模型保护两类凭证，并在运行仓库代码前移除 token。这能减少误操作，无法阻止恶意成员或成功的 prompt injection。专用账号不要存放其他资产，只授予 `public_repo` 与 `workflow`，设置到期日，泄露即吊销。push 到 fork 或以该账号发布的内容都是公开的。
