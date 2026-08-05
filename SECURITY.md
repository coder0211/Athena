# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report them privately via one of:

- GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  (**Security → Report a vulnerability** on the repo), or
- email the maintainer.

Please include a description of the issue, steps to reproduce, and the impact.
We aim to acknowledge reports within a few business days and will keep you
updated on remediation progress.

## Handling secrets

Athena reads an `OPENAI_API_KEY` from a local `.env` file, which is **not**
committed (it is gitignored). When contributing:

- Never commit `.env`, real API keys, or any file under `.sources/` or
  `.knowledge/`.
- The runtime config in `config/` is gitignored — never commit
  `config/mcp_servers.json` (it can hold provider tokens in `env`/`headers`) or
  the other `config/*.yaml` runtime files. Only the `config/*.example.*` templates
  are tracked.
- Never hardcode absolute machine paths or credentials in tracked files
  (e.g. `.mcp.json`, source code).

If you believe a secret was committed, rotate it immediately and report it.
