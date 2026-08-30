import * as core from "@actions/core";
import * as github from "@actions/github";
import { getOctokit } from "@actions/github";

interface RiskAssessment {
  risk_score: number;
  risk_level: string;
  reasoning: string;
}

interface LlmChoice {
  message?: { content?: string };
}

interface LlmResponse {
  choices?: LlmChoice[];
  error?: { message?: string };
}

function parseExtraHeaders(raw: string): Record<string, string> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    core.warning(`Could not parse llm-extra-headers as JSON, ignoring: ${raw}`);
  }
  return {};
}

function extractJson(text: string): unknown {
  let t = text.trim();
  // Strip markdown code fences if present.
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  // Find the outermost JSON object.
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    t = t.slice(start, end + 1);
  }
  return JSON.parse(t);
}

function levelFromScore(score: number): string {
  if (score <= 3) return "low";
  if (score <= 6) return "medium";
  return "high";
}

async function callLlm(
  baseUrl: string,
  apiKey: string,
  model: string,
  extraHeaders: Record<string, string>,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...extraHeaders,
  };
  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0,
    response_format: { type: "json_object" },
  };

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 500)}`);
  }

  let json: LlmResponse;
  try {
    json = JSON.parse(text) as LlmResponse;
  } catch {
    throw new Error(`LLM returned non-JSON response: ${text.slice(0, 500)}`);
  }

  if (json.error) {
    throw new Error(`LLM API error: ${json.error.message ?? "unknown"}`);
  }
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`LLM response had no message content: ${text.slice(0, 500)}`);
  }
  return content;
}

async function run(): Promise<void> {
  const token = core.getInput("github-token", { required: true });
  const baseUrl = core.getInput("llm-base-url", { required: true });
  const apiKey = core.getInput("llm-api-key", { required: true });
  const model = core.getInput("llm-model", { required: true });
  const extraHeaders = parseExtraHeaders(core.getInput("llm-extra-headers") || "{}");
  const threshold = Number(core.getInput("risk-threshold") || "3");
  const maxDiffChars = Number(core.getInput("max-diff-chars") || "60000");
  const shouldApprove = (core.getInput("approve") || "true").toLowerCase() === "true";
  const failOnHigh = (core.getInput("fail-on-high-risk") || "false").toLowerCase() === "true";
  const explicitPull = core.getInput("pull-number") || "";

  const ctx = github.context;
  const owner = ctx.repo.owner;
  const repo = ctx.repo.repo;

  let pullNumber: number | undefined;
  if (explicitPull) {
    pullNumber = Number(explicitPull);
  } else if (ctx.payload.pull_request?.number) {
    pullNumber = ctx.payload.pull_request.number;
  }

  if (!pullNumber || !Number.isFinite(pullNumber)) {
    throw new Error(
      "Could not determine the pull request number. Run the action on a pull_request event or pass the `pull-number` input."
    );
  }

  core.info(`Evaluating PR #${pullNumber} in ${owner}/${repo} with model ${model}`);

  const octokit = getOctokit(token);

  // Fetch the diff text.
  const diffRes = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
    mediaType: { format: "diff" },
  });
  let diff = typeof diffRes.data === "string" ? diffRes.data : JSON.stringify(diffRes.data);
  if (!diff || !diff.trim()) {
    core.info("Diff is empty; treating as low risk (score 1).");
    const assessment: RiskAssessment = { risk_score: 1, risk_level: "low", reasoning: "Empty diff." };
    await finalize(octokit, owner, repo, pullNumber, assessment, threshold, shouldApprove, failOnHigh);
    return;
  }

  const truncated = diff.length > maxDiffChars;
  if (truncated) {
    diff = diff.slice(0, maxDiffChars);
  }

  const systemPrompt =
    "You are a senior code reviewer and risk assessor. You are given the unified diff of a pull request. " +
    "Assess the risk of merging this change. Risk reflects the likelihood and severity of unintended " +
    "consequences: regressions, outages, data loss, security issues, breaking API changes, infra/DB migrations, " +
    "deletions, permission changes, or anything that would be hard to roll back.\n\n" +
    "Respond with STRICT JSON only, no prose, matching exactly this schema:\n" +
    '{"risk_score": <integer 1-10, 1 = safest>, "risk_level": "<low|medium|high>", "reasoning": "<one or two sentences>"}\n\n' +
    "Guidelines:\n" +
    "- score 1-3 = low (docs, comments, formatting, trivial tests, small safe refactors)\n" +
    "- score 4-6 = medium (new features, logic changes, dependency bumps)\n" +
    "- score 7-10 = high (migrations, infra, security, auth, mass deletion, prod config)\n" +
    "Be conservative: when uncertain, score higher rather than lower.";

  const userPrompt =
    `Repository: ${owner}/${repo}\nPull request: #${pullNumber}\n` +
    `Title: ${ctx.payload.pull_request?.title ?? ""}\n` +
    (truncated ? `\n[NOTE: diff truncated to ${maxDiffChars} characters]\n` : "") +
    `\nHere is the diff:\n\n${diff}`;

  let content: string;
  try {
    content = await callLlm(baseUrl, apiKey, model, extraHeaders, systemPrompt, userPrompt);
  } catch (err) {
    core.warning("JSON-mode request failed, retrying without response_format...");
    content = await callLlmRaw(baseUrl, apiKey, model, extraHeaders, systemPrompt, userPrompt);
  }

  let assessment: RiskAssessment;
  try {
    const parsed = extractJson(content) as Partial<RiskAssessment>;
    const score = Math.max(1, Math.min(10, Math.round(Number(parsed.risk_score) || 5)));
    assessment = {
      risk_score: score,
      risk_level: typeof parsed.risk_level === "string" ? parsed.risk_level : levelFromScore(score),
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "No reasoning provided.",
    };
  } catch {
    throw new Error(`Could not parse LLM assessment as JSON. Raw content: ${content.slice(0, 500)}`);
  }

  await finalize(octokit, owner, repo, pullNumber, assessment, threshold, shouldApprove, failOnHigh);
}

async function callLlmRaw(
  baseUrl: string,
  apiKey: string,
  model: string,
  extraHeaders: Record<string, string>,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...extraHeaders,
  };
  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0,
  };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 500)}`);
  }
  const json = JSON.parse(text) as LlmResponse;
  if (json.error) throw new Error(`LLM API error: ${json.error.message ?? "unknown"}`);
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error(`LLM response had no message content: ${text.slice(0, 500)}`);
  return content;
}

async function finalize(
  octokit: ReturnType<typeof getOctokit>,
  owner: string,
  repo: string,
  pullNumber: number,
  assessment: RiskAssessment,
  threshold: number,
  shouldApprove: boolean,
  failOnHigh: boolean
): Promise<void> {
  core.info(`Risk assessment: score=${assessment.risk_score} level=${assessment.risk_level}`);

  const isLowRisk = assessment.risk_score <= threshold;
  const approved = isLowRisk && shouldApprove;

  const body =
    `**LLM risk review**\n\n` +
    `- Risk score: **${assessment.risk_score}/10** (level: **${assessment.risk_level}**)\n` +
    `- Auto-approval threshold: <= ${threshold}\n` +
    `- Result: ${approved ? "approved" : isLowRisk ? "low risk (approval disabled)" : "not approved"}\n\n` +
    `**Reasoning:** ${assessment.reasoning}\n\n` +
    `_Generated by the llm-diff-risk-review GitHub Action._`;

  if (approved) {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      event: "APPROVE",
      body,
    });
    core.info("Submitted APPROVE review.");
  } else {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      event: "COMMENT",
      body,
    });
    core.info("Submitted COMMENT review (not auto-approved).");
  }

  core.setOutput("risk-score", String(assessment.risk_score));
  core.setOutput("risk-level", assessment.risk_level);
  core.setOutput("approved", String(approved));
  core.setOutput("reasoning", assessment.reasoning);

  if (!isLowRisk && failOnHigh) {
    core.setFailed(`High-risk change detected (score ${assessment.risk_score}/10).`);
  }
}

run().catch((err: Error) => {
  core.setFailed(err.message);
});
