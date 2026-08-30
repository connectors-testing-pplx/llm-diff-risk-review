# LLM Diff Risk Review

A GitHub Action that rates the risk of a pull request's diff using **any OpenAI-compatible LLM** and **auto-approves the PR when the risk is low**.

Point it at OpenAI, OpenRouter, Groq, Together, Azure OpenAI, Ollama, LM Studio, vLLM, or any other server that speaks the OpenAI Chat Completions API.

## How it works

1. On a pull request, the action fetches the PR diff via the GitHub API.
2. It sends the diff to your chosen LLM with a risk-assessment prompt.
3. The LLM returns a JSON risk score (1–10), a level (low/medium/high), and a short reasoning.
4. If the score is at or below your threshold (default `3`), the action submits an **APPROVE** review. Otherwise it leaves a **COMMENT** with the assessment.

## Usage

```yaml
name: LLM Risk Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: connectors-testing-pplx/llm-diff-risk-review@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          llm-base-url: https://api.openai.com/v1
          llm-api-key: ${{ secrets.OPENAI_API_KEY }}
          llm-model: gpt-4o-mini
          risk-threshold: "3"
```

### Use a different LLM provider

OpenRouter (any model, including Claude / Gemini / Llama):

```yaml
- uses: connectors-testing-pplx/llm-diff-risk-review@v1
  with:
    llm-base-url: https://openrouter.ai/api/v1
    llm-api-key: ${{ secrets.OPENROUTER_API_KEY }}
    llm-model: anthropic/claude-3.5-sonnet
    llm-extra-headers: '{"HTTP-Referer": "https://github.com", "X-Title": "risk-review"}'
```

Local model via Ollama:

```yaml
- uses: connectors-testing-pplx/llm-diff-risk-review@v1
  with:
    llm-base-url: http://localhost:11434/v1
    llm-api-key: dummy
    llm-model: llama3.1
```

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `github-token` | no | `${{ github.token }}` | Token to fetch the diff and post the review. |
| `llm-base-url` | no | `https://api.openai.com/v1` | Base URL of an OpenAI-compatible chat-completions endpoint. |
| `llm-api-key` | yes | — | API key for the LLM endpoint. |
| `llm-model` | yes | — | Model name to call. |
| `llm-extra-headers` | no | `{}` | JSON object of extra HTTP headers (e.g. for OpenRouter). |
| `risk-threshold` | no | `3` | Max risk score (1–10) considered low risk / auto-approvable. |
| `max-diff-chars` | no | `60000` | Cap the diff sent to the LLM to this many characters. |
| `approve` | no | `true` | Set to `false` to only comment, never approve. |
| `fail-on-high-risk` | no | `false` | Fail the workflow run when risk is high. |
| `pull-number` | no | — | PR number; defaults to the PR that triggered the workflow. |

## Outputs

| Output | Description |
| --- | --- |
| `risk-score` | Numeric risk score 1–10. |
| `risk-level` | `low`, `medium`, or `high`. |
| `approved` | `true` if the PR was auto-approved. |
| `reasoning` | Short explanation from the LLM. |

## Permissions

The action needs `pull-requests: write` (and `contents: read` via checkout) to post reviews and approvals.

## Risk scale

| Score | Level | Examples |
| --- | --- | --- |
| 1–3 | low | docs, comments, formatting, trivial tests, small safe refactors |
| 4–6 | medium | new features, logic changes, dependency bumps |
| 7–10 | high | migrations, infra, security, auth, mass deletion, prod config |

## Security note

Reviewing code with an LLM is a heuristic aid, not a substitute for human review. Auto-approval is a trust decision — keep the `risk-threshold` conservative and restrict which workflows can run this action. The LLM only sees the diff, not the full repo context.

## License

MIT
