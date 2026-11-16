# GitHub integration

English | [简体中文](github.zh-CN.md) | [README](../README.md)

With `GH_TOKEN` set, bash gets `gh` and `git` authenticated under a dedicated GitHub account. dwell works as an outside contributor: fork the upstream, push to the fork, and open a PR with `gh pr create`. It needs no collaborator access to the upstream repository. Set up the host and sandbox using [Deployment](deployment.md) first; configuration variables are listed in [Configuration](configuration.md).

## Account and token

1. Create a dedicated account for dwell. Use an email address the operators read; GitHub sends expiry warnings there.
2. Create a **classic** personal access token with `public_repo` and `workflow` scopes and an expiration date. Fine-grained tokens cannot open PRs on public repositories the account is not a member of. Without `workflow`, `gh repo sync` and pushes to the fork fail when upstream changes include `.github/workflows/`.
3. Add `GH_TOKEN=<token>` to the private environment file and restart dwell.

At startup and every 24 hours, dwell checks the token against `https://api.github.com/user`. It sends admins a direct message on a 401, a missing `public_repo` or `workflow` scope, or an expiry within 14 days.

## Host configuration

Install `git` and `gh` (from GitHub's official apt repository), then write the system-wide `/etc/gitconfig`. The sandbox mounts `/etc` read-only and sets `HOME` to the working directory, so only system-level git configuration applies:

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

Get `<ID>` with `gh api user --jq .id`. Missing `user.name` or `user.email` makes sandbox commits fail. The `insteadOf` rules convert SSH URLs, including submodule URLs, to HTTPS because the sandbox has no SSH key. dwell sets the non-interactive `gh` and `git` environment variables itself.

## Commit signing

GitHub shows commits as Verified when git signs them locally; commits created through the API with a personal access token are not signed. For optional signing, create a signing-only SSH key (git 2.34 or later):

```sh
sudo install -d -o root -g dwell -m 750 /etc/dwell
sudo ssh-keygen -t ed25519 -N "" -C "<account> signing" -f /etc/dwell/git-signing
sudo chown root:dwell /etc/dwell/git-signing /etc/dwell/git-signing.pub
sudo chmod 640 /etc/dwell/git-signing
```

Add `/etc/dwell/git-signing.pub` under the account's Settings → SSH and GPG keys as a **Signing Key**. This key cannot push. Append to `/etc/gitconfig`:

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

The key must be under `/etc` for sandboxed git to read it. The noreply address counts as a verified email for the account, so these signed commits show as Verified.

## Build checks and CI

bash shares the service's memory. The system prompt asks for light local checks: formatters, linters, and builds/tests of touched packages, under `timeout` and `nice`. The unit's `OOMPolicy=continue` keeps an oversized build from stopping dwell; see [systemd setup](deployment.md#systemd-unit) for memory sizing.

Full CI runs on the account's fork using GitHub Actions; the model follows it with `gh run`. Keep Actions enabled on that account. Forks have no secrets, and the fork's `GITHUB_TOKEN` only reaches the fork. Workflows that run only on `pull_request`, require secrets, or need self-hosted runners do not run on the fork; the model reports the checks it could not run.

Install toolchains on the host because the sandbox mounts `/usr` read-only. Keep caches outside the working directory. For Go, install the official tarball to `/usr/local/go`, link `go` and `gofmt` into `/usr/bin` (within `DWELL_TOOL_PATH`), and set `/usr/local/go/go.env`:

```ini
GOPATH=/tmp/dwell-go/path
GOCACHE=/tmp/dwell-go/cache
GOTOOLCHAIN=local
```

Set `GOPROXY`/`GOSUMDB` mirrors there if the default proxy is unreachable. `GOTOOLCHAIN=local` prevents automatic downloads of other toolchains. Reinstalling Go overwrites `go.env`.

## Containers

The repository's Dockerfile includes neither git nor gh. Build a derived image that installs them and writes `/etc/gitconfig`. If the operator disables the bash sandbox, bash sees `GH_TOKEN` and the remaining post-scrub environment; configure [container isolation](deployment.md#docker) accordingly.

## Verify and troubleshoot

- Confirm the startup log includes `[dwell] GH_TOKEN 自检通过` and `/healthz` reports `"sandbox":true`. With the sandbox off, bash inherits the full remaining environment.
- Ask dwell to run `gh auth status` in a conversation.
- With authorization to publish test content, choose an upstream that changed its workflows recently: fork it, run `gh repo sync`, push a branch to the fork, and open a PR. The commit author should link to the account; signed commits should show Verified. A direct upstream push must return 403.
- Confirm no `.config` or `.local` appears in the conversation's working directory.

For a 401, correct or replace the token. For sync/push failures involving workflow changes, check the `workflow` scope. If commits fail to identify an author, check system-wide `user.name` and `user.email`. Restart dwell after running `test/probe-bwrap.ts`. The probe rewrites the shared sandbox wrapper from its own environment, so the service must restore `GH_TOKEN` passthrough.

## Credential exposure and revocation

`GH_TOKEN` is the exception to the [credential boundary](security.md): `gh` and `git` read it from the environment, so bash can read it. Treat it as exposed:

- Any allowlisted member can ask the model to print it; bash output is visible in the conversation and panel.
- Dependency installs, build scripts, and tests receive it unless the model runs them with `env -u GH_TOKEN`. The sandbox does not isolate the network.
- Content the model reads can try to induce token exfiltration.

The signing private key is also readable by bash. A leaked signing key lets someone create commits that show as Verified for the account, although it cannot push or act as the account. Delete the Signing Key from GitHub to revoke it.

The system prompt asks the model to protect both credentials and remove the token before running repository code. This reduces mistakes but cannot stop a malicious member or successful prompt injection. Keep other assets out of the dedicated account, limit scopes to `public_repo` and `workflow`, set an expiration date, and revoke the token if it leaks. Anything pushed to the fork or posted under the account is public.
