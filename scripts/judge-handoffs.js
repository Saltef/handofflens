#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

loadEnvFile(".env");

const DEFAULT_JUDGE_MODEL = process.env.JUDGE_MODEL || "openai/gpt-5-mini";
const rubric = JSON.parse(fs.readFileSync(path.join("eval", "clinical_handover_rubric.json"), "utf8"));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const casesPath = args.cases || path.join("eval", "pilot_reference_cases.json");
  const resultsPath = args.results || path.join("results", "cohere-plus-eval.json");
  const outPath = args.out || resultsPath.replace(/\.json$/i, ".judge.json");
  const mdOutPath = args.mdout || outPath.replace(/\.json$/i, ".md");
  const judgeModel = args["judge-model"] || DEFAULT_JUDGE_MODEL;
  const limit = args.limit ? Number(args.limit) : undefined;
  const offset = args.offset ? Number(args.offset) : 0;
  const blind = !Boolean(args.unblinded);

  const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
  const casesById = Object.fromEntries(cases.map((item) => [item.case_id, item]));
  const modelReport = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  const allCandidates = modelReport.results
    .filter((result) => !result.error && result.extraction)
  const blindMap = blind ? buildBlindMap(allCandidates) : {};
  const candidates = allCandidates.slice(offset, limit === undefined ? undefined : offset + limit);

  if (args["dry-run"]) {
    const first = candidates[0];
    const preview = buildJudgeRequest(judgeModel, casesById[first.case_id], blindResult(first, blindMap));
    console.log(JSON.stringify(redactLongSummary(preview), null, 2));
    return;
  }

  const judgments = [];
  for (const result of candidates) {
    const testCase = casesById[result.case_id];
    if (!testCase) {
      judgments.push({ model: result.model, case_id: result.case_id, error: "Source case not found for judgment" });
      continue;
    }

    const startedAt = Date.now();
    const judgedResult = blindResult(result, blindMap);
    try {
      const judgment = await callOpenRouterJudge(judgeModel, testCase, judgedResult);
      judgment.case_id = result.case_id;
      judgment.judged_model = judgedResult.model;
      assertJudgmentShape(judgment);
      judgments.push({
        judge_model: judgeModel,
        judged_model: judgedResult.model,
        actual_model: result.model,
        case_id: result.case_id,
        latency_ms: Date.now() - startedAt,
        judgment
      });
      console.log(`${judgedResult.model} ${result.case_id}: handover=${meanDomainScore(judgment).toFixed(2)} safety=${judgment.after_source_review.handover_safety.score}`);
    } catch (error) {
      const safeError = redactSensitiveText(error.message);
      judgments.push({
        judge_model: judgeModel,
        judged_model: judgedResult.model,
        actual_model: result.model,
        case_id: result.case_id,
        latency_ms: Date.now() - startedAt,
        error: safeError
      });
      console.error(`${judgedResult.model} ${result.case_id}: ${safeError}`);
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    source_results: resultsPath,
    source_cases: casesPath,
    result_offset: offset,
    result_limit: limit || null,
    judge_model: judgeModel,
    blinded: blind,
    blind_model_map: blindMap,
    summary: summarizeJudgments(judgments),
    judgments
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(mdOutPath, renderJudgeMarkdown(report));
  console.log(`Wrote ${outPath}`);
  console.log(`Wrote ${mdOutPath}`);
}

async function callOpenRouterJudge(model, testCase, result) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const timeoutMs = Number(process.env.OPENROUTER_TIMEOUT_MS || 120000);
  const retries = Number(process.env.OPENROUTER_RETRIES || 2);
  const requestBody = buildJudgeRequest(model, testCase, result);

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    try {
      const { response, body } = await withTimeout((async () => {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://github.com",
            "X-Title": process.env.OPENROUTER_APP_NAME || "HandoffLens Judge"
          },
          body: JSON.stringify(requestBody)
        });
        const body = await response.json();
        return { response, body };
      })(), timeoutMs, `Judge request timed out after ${timeoutMs} ms`, controller);

      if (!response.ok) {
        const error = new Error(`OpenRouter judge error ${response.status}: ${JSON.stringify(body)}`);
        error.retryable = response.status >= 500 || response.status === 429 || response.status === 408;
        throw error;
      }
      const content = body.choices?.[0]?.message?.content;
      if (!content) {
        const error = new Error(`Judge response missing message content: ${JSON.stringify(body)}`);
        error.retryable = true;
        throw error;
      }
      return typeof content === "string" ? parseJsonFromText(content) : content;
    } catch (error) {
      lastError = error;
      if (String(error.message || "").includes("timed out")) error.retryable = true;
      if (!error.retryable || attempt === retries) break;
      await sleep(Math.min(30000, 1500 * 2 ** attempt));
    }
  }
  throw lastError;
}

function buildJudgeRequest(model, testCase, result) {
  return {
    model,
    max_tokens: Number(process.env.JUDGE_MAX_TOKENS || 5000),
    provider: { require_parameters: true },
    messages: [
      {
        role: "system",
        content: "You are a strict clinical handover evaluator. You are not providing medical advice. Score only the supplied model handover against the supplied source discharge summary and rubric. Penalize unsupported claims, missing safety-critical facts, and vague follow-up plans. Return only valid JSON matching the requested schema."
      },
      {
        role: "user",
        content: buildJudgePrompt(testCase, result)
      }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "clinical_handover_judgment",
        strict: true,
        schema: judgeSchema()
      }
    }
  };
}

function buildJudgePrompt(testCase, result) {
  return `Evaluate this model-generated physician handover using the adapted Moore et al. handover rubric.

The judged system label is intentionally blinded. Do not infer the underlying model or provider from writing style, latency, phrasing, or formatting.

Scoring:
- 0 = not performed competently
- 1 = able to perform under firm direction
- 2 = able to perform under modest direction
- 3 = able to perform under minimal direction

Rubric:
${JSON.stringify(rubric, null, 2)}

Source case metadata:
${JSON.stringify({
  case_id: testCase.case_id,
  judged_model: result.model,
  age: testCase.age,
  gender: testCase.gender,
  admission_diagnosis: testCase.admission_diagnosis
}, null, 2)}

Source discharge summary:
${testCase.discharge_summary}

Model structured extraction and summary:
${JSON.stringify(result.extraction, null, 2)}

Tasks:
1. Score the seven before-source-review domains as if reading the handover first.
2. Then compare against the source summary and score source_record_match and handover_safety.
3. Classify failure modes and case features that may explain failures.
4. Identify whether failures appear related to medication reconciliation, diagnosis/problem representation, objective data, follow-up planning, safety, source support, or case complexity.
5. Be conservative: if the handover sounds fluent but omits source-supported safety-critical information, lower source_record_match and handover_safety.`;
}

function judgeSchema() {
  const scoreItem = {
    type: "object",
    additionalProperties: false,
    required: ["score", "rationale"],
    properties: {
      score: { type: "integer" },
      rationale: { type: "string" }
    }
  };
  const evidenceItem = {
    type: "object",
    additionalProperties: false,
    required: ["type", "description", "source_quote", "handover_quote"],
    properties: {
      type: { type: "string" },
      description: { type: "string" },
      source_quote: { type: "string" },
      handover_quote: { type: "string" }
    }
  };
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "case_id",
      "judged_model",
      "before_source_review",
      "after_source_review",
      "failure_modes",
      "case_features",
      "evidence_examples",
      "overall_comment"
    ],
    properties: {
      case_id: { type: "string" },
      judged_model: { type: "string" },
      before_source_review: {
        type: "object",
        additionalProperties: false,
        required: [
          "identifies_patient_context",
          "identifies_main_problem",
          "focused_history",
          "examination_observations",
          "logical_assessment",
          "clear_follow_up_recommendation",
          "global_perceived_quality"
        ],
        properties: {
          identifies_patient_context: scoreItem,
          identifies_main_problem: scoreItem,
          focused_history: scoreItem,
          examination_observations: scoreItem,
          logical_assessment: scoreItem,
          clear_follow_up_recommendation: scoreItem,
          global_perceived_quality: scoreItem
        }
      },
      after_source_review: {
        type: "object",
        additionalProperties: false,
        required: ["source_record_match", "handover_safety"],
        properties: {
          source_record_match: scoreItem,
          handover_safety: scoreItem
        }
      },
      failure_modes: {
        type: "array",
        items: {
          type: "string",
          enum: [
            "none",
            "unsupported_claim",
            "missing_critical_follow_up",
            "medication_reconciliation_gap",
            "diagnosis_or_problem_gap",
            "objective_data_gap",
            "poor_prioritization",
            "safety_omission",
            "source_quote_problem",
            "too_vague",
            "too_granular"
          ]
        }
      },
      case_features: {
        type: "array",
        items: {
          type: "string",
          enum: [
            "polypharmacy",
            "antibiotics_or_antimicrobials",
            "anticoagulation_or_bleeding_risk",
            "dialysis_or_renal_disease",
            "oxygen_or_respiratory_failure",
            "wound_or_device_care",
            "abnormal_labs",
            "multiple_specialty_follow_up",
            "procedure_or_operation",
            "infection_or_culture_result",
            "ambiguous_medication_reconciliation",
            "complex_chronic_disease"
          ]
        }
      },
      evidence_examples: { type: "array", items: evidenceItem },
      overall_comment: { type: "string" }
    }
  };
}

function assertJudgmentShape(judgment) {
  const before = judgment.before_source_review || {};
  const after = judgment.after_source_review || {};
  for (const key of ["identifies_patient_context", "identifies_main_problem", "focused_history", "examination_observations", "logical_assessment", "clear_follow_up_recommendation", "global_perceived_quality"]) {
    if (!validScore(before[key]?.score)) throw new Error(`Judge schema mismatch: before_source_review.${key}.score must be an integer from 0 to 3`);
  }
  for (const key of ["source_record_match", "handover_safety"]) {
    if (!validScore(after[key]?.score)) throw new Error(`Judge schema mismatch: after_source_review.${key}.score must be an integer from 0 to 3`);
  }
  if (!Array.isArray(judgment.failure_modes)) throw new Error("Judge schema mismatch: failure_modes must be an array");
  if (!Array.isArray(judgment.case_features)) throw new Error("Judge schema mismatch: case_features must be an array");
}

function buildBlindMap(results) {
  const labels = ["Model A", "Model B", "Model C", "Model D", "Model E"];
  const models = Array.from(new Set(results.map((result) => result.model).filter(Boolean)));
  return Object.fromEntries(models.map((model, index) => [model, labels[index] || `Model ${index + 1}`]));
}

function blindResult(result, blindMap) {
  const alias = blindMap[result.model];
  return alias ? { ...result, model: alias } : result;
}

function validScore(value) {
  return Number.isInteger(value) && value >= 0 && value <= 3;
}

function summarizeJudgments(judgments) {
  const byModel = {};
  for (const item of judgments) {
    const key = item.judged_model || "unknown";
    byModel[key] ||= [];
    byModel[key].push(item);
  }
  return Object.fromEntries(Object.entries(byModel).map(([model, items]) => {
    const completed = items.filter((item) => !item.error);
    const domainScores = completed.map((item) => meanDomainScore(item.judgment));
    const sourceScores = completed.map((item) => item.judgment.after_source_review.source_record_match.score);
    const safetyScores = completed.map((item) => item.judgment.after_source_review.handover_safety.score);
    const modes = countTags(completed.flatMap((item) => item.judgment.failure_modes || []));
    const features = countTags(completed.flatMap((item) => item.judgment.case_features || []));
    const featureFailureMatrix = buildFeatureFailureMatrix(completed);
    return [model, {
      attempted: items.length,
      completed: completed.length,
      failures: items.length - completed.length,
      mean_handover_score: mean(domainScores),
      mean_source_record_match: mean(sourceScores),
      mean_handover_safety: mean(safetyScores),
      failure_modes: modes,
      case_features: features,
      feature_failure_matrix: featureFailureMatrix
    }];
  }));
}

function buildFeatureFailureMatrix(items) {
  const matrix = {};
  for (const item of items) {
    const features = (item.judgment.case_features || []).filter(Boolean);
    const modes = (item.judgment.failure_modes || []).filter((mode) => mode && mode !== "none");
    for (const feature of features) {
      matrix[feature] ||= {};
      for (const mode of modes) {
        matrix[feature][mode] = (matrix[feature][mode] || 0) + 1;
      }
    }
  }
  return matrix;
}

function meanDomainScore(judgment) {
  const before = judgment.before_source_review;
  const scores = Object.values(before).map((item) => item.score);
  return mean(scores);
}

function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
}

function countTags(tags) {
  const counts = {};
  for (const tag of tags.filter((item) => item && item !== "none")) {
    counts[tag] = (counts[tag] || 0) + 1;
  }
  return counts;
}

function renderJudgeMarkdown(report) {
  const lines = [
    "# Handover Judge Report",
    "",
    `Generated: ${report.generated_at}`,
    `Judge model: \`${report.judge_model}\``,
    `Source results: \`${report.source_results}\``,
    "",
    "## Summary",
    "",
    "| Judged Model | Attempted | Completed | Mean Handover | Source Match | Safety |",
    "| --- | ---: | ---: | ---: | ---: | ---: |"
  ];
  for (const [model, summary] of Object.entries(report.summary)) {
    lines.push(`| \`${model}\` | ${summary.attempted} | ${summary.completed} | ${format(summary.mean_handover_score)} | ${format(summary.mean_source_record_match)} | ${format(summary.mean_handover_safety)} |`);
  }
  lines.push("", "## Failure Modes", "");
  for (const [model, summary] of Object.entries(report.summary)) {
    lines.push(`### ${model}`, "");
    const modes = Object.entries(summary.failure_modes).sort((a, b) => b[1] - a[1]);
    lines.push(modes.length ? modes.map(([tag, count]) => `- ${tag}: ${count}`).join("\n") : "- none");
    lines.push("");
  }
  lines.push("## Failure-Feature Co-occurrence", "");
  for (const [model, summary] of Object.entries(report.summary)) {
    lines.push(`### ${model}`, "");
    const rows = [];
    for (const [feature, modes] of Object.entries(summary.feature_failure_matrix || {})) {
      for (const [mode, count] of Object.entries(modes)) {
        rows.push([feature, mode, count]);
      }
    }
    rows.sort((a, b) => b[2] - a[2]);
    if (!rows.length) {
      lines.push("- none", "");
      continue;
    }
    lines.push("| Case Feature | Failure Mode | Count |", "| --- | --- | ---: |");
    for (const [feature, mode, count] of rows) {
      lines.push(`| ${feature} | ${mode} | ${count} |`);
    }
    lines.push("");
  }
  lines.push("## Case Results", "", "| Model | Case | Handover | Source Match | Safety | Failure Modes | Case Features |", "| --- | --- | ---: | ---: | ---: | --- | --- |");
  for (const item of report.judgments) {
    if (item.error) {
      lines.push(`| \`${item.judged_model}\` | ${item.case_id} | N/A | N/A | N/A | Error: ${escapeTable(item.error)} |  |`);
      continue;
    }
    lines.push(`| \`${item.judged_model}\` | ${item.case_id} | ${format(meanDomainScore(item.judgment))} | ${item.judgment.after_source_review.source_record_match.score} | ${item.judgment.after_source_review.handover_safety.score} | ${escapeTable((item.judgment.failure_modes || []).join(", "))} | ${escapeTable((item.judgment.case_features || []).join(", "))} |`);
  }
  lines.push("", "## Notes", "", "- These scores are LLM-as-judge rubric scores, not definitive clinician adjudication.", "- Use this for scalable screening, failure taxonomy, and selecting cases for manual review.", "");
  return `${lines.join("\n")}\n`;
}

function withTimeout(promise, timeoutMs, message, controller) {
  let timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timeout)),
    new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller?.abort();
        reject(new Error(message));
      }, timeoutMs);
    })
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonFromText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("Missing JSON text");
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw error;
  }
}

function redactLongSummary(request) {
  return {
    ...request,
    messages: request.messages.map((message) => ({
      ...message,
      content: message.content.length > 1600 ? `${message.content.slice(0, 1600)}\n...[truncated for dry-run preview]` : message.content
    }))
  };
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex < 0) continue;
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function format(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "N/A";
}

function escapeTable(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 220);
}

function redactSensitiveText(value) {
  return String(value || "")
    .replace(/https:\/\/openrouter\.ai\/workspaces\/[^"\s]+/gi, "[redacted OpenRouter dashboard URL]")
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "[redacted OpenRouter key]")
    .replace(/"user_id"\s*:\s*"[^"]+"/gi, "\"user_id\":\"[redacted OpenRouter user id]\"")
    .replace(/user_[A-Za-z0-9_-]+/g, "[redacted OpenRouter user id]");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
