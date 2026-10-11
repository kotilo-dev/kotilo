# Security policy

## Supported versions

Only the latest release of Kotilo receives security fixes. Please update (the app can update itself from GitHub Releases) before reporting, and check whether the problem still exists on the `main` branch if you can.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub's private vulnerability reporting: open the repository's [Security tab](https://github.com/kotilo-dev/kotilo/security) and choose **Report a vulnerability**. Only the maintainers can see the report.

Helpful details:

- the Kotilo version (Settings → About & diagnostics → **Copy version info**) and Windows version/architecture;
- what an attacker can do and under which conditions (local user, another process, a malicious repository or file, network);
- steps to reproduce or a proof of concept;
- any logs, with prompts, file contents and personal data removed.

Do not send anyone's agent credentials, tokens or API keys, including your own.

## Scope

Kotilo runs entirely on your machine. Areas where a vulnerability matters most:

- **Local hub API:** the background service listens on loopback only (`127.0.0.1`, a random port) and requires a per-start random token (`X-AgentHub-Token`) from `port.json` in the user's data folder; requests with an `Origin` header are refused. Bypassing the token or reaching the API from a web page or another user account is in scope.
- **Hook sidecar:** the small executable the agents' hooks call. It must never block or break an agent, and it strips prompt and response content before sending events to the hub. Content leaking past it, or a way to make it run something else, is in scope.
- **Config mergers:** the code that installs and removes Kotilo's hooks in agent config files (backup-first, own entries only, invalid files refused). Losing or corrupting a user's config, or writing entries that run unintended commands, is in scope.
- **Credentials:** Kotilo must never read agent login/token files, and stores AI provider keys only in Windows Credential Manager. Any path where a key or token reaches settings, logs, the database or the network (other than the provider you configured) is in scope.
- **Terminals and file viewer:** escape-sequence or link handling that runs commands or opens unexpected targets.
- **Updater:** updates are verified with a minisign signature before installing; bypassing that check is in scope.

Out of scope: vulnerabilities in the agent CLIs themselves (report those to their vendors), issues that require an attacker who already has full control of your user account, and missing hardening without a concrete impact.

## What to expect

Kotilo is maintained by volunteers, so responses are best effort. We aim to acknowledge a report within a week, keep you informed while we work on it, and publish a fix and a GitHub security advisory crediting you (unless you prefer otherwise). Please give us reasonable time to fix the issue before disclosing it publicly.
