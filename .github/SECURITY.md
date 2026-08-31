# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities. Instead,
report them privately via [GitHub Security Advisories](https://github.com/connectors-testing-pplx/llm-diff-risk-review/security/advisories/new)
for this repository.

Include as much detail as possible: affected version/ref, reproduction steps,
and potential impact (this action has `pull-requests: write` access and calls
an external LLM endpoint with PR diff contents, so leakage of diff contents to
an unintended endpoint or prompt-injection via diff content are in scope).

## Supported versions

Only the latest release on the default branch (`main`) is supported. Older
tagged versions (e.g. `v1`) receive fixes on a best-effort basis only.
