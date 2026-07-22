#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { readRows } = require("./adapt-aci-bench");
const { scoreAciNoteGeneration } = require("./score-aci-note-generation");
const { scoreAciNoteFactuality } = require("./score-aci-note-factuality");

loadEnvFile(".env");

function parseArgs(argv) {
  const args = {
    out: "results/aci-note-cohere.json",
    split: "unknown",
    model: "command-a-plus-05-2026",
    "prediction-field": "generated_note",
    "bootstrap-repeats": "1000",
    "max-tokens": process.env.COHERE_ACI_MAX_TOKENS || "2500",
    "timeout-ms": process.env.COHERE_TIMEOUT_MS || "120000",
    thinking: process.env.COHERE_ACI_THINKING || "auto",
    "thinking-policy": process.env.COHERE_ACI_THINKING_POLICY || "disabled_then_budget512",
    retries: process.env.COHERE_RETRIES || "0",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input || args.records;
  if (!input) {
    console.error("--input or --records is required");
    process.exit(1);
  }

  const allRows = readRows(input);
  const offset = numberOption(args.offset, 0);
  const limit = args.limit === undefined ? null : numberOption(args.limit, null);
  const rows = allRows.slice(offset, limit === null ? undefined : offset + limit);
  const predictionField = args["prediction-field"];
  const existingByRecordId = args.resume && fs.existsSync(args.out)
    ? existingRecordsByRecordId(JSON.parse(fs.readFileSync(args.out, "utf8")), predictionField)
    : new Map();
  const startedAt = new Date().toISOString();
  const records = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const source = firstValue(row, ["source_text", "src", "dialogue", "conversation", "transcript", "input", "text"]);
    const reference = firstValue(row, ["reference_text", "reference_note", "note", "clinical_note", "target", "tgt", "summary"]);
    const recordId = firstValue(row, ["record_id", "case_id", "encounter_id", "dialogue_id", "id", "file"]) || `${args.split}:${offset + index + 1}`;
    const existing = existingByRecordId.get(String(recordId));
    if (existing && String(existing[predictionField] || "").trim()) {
      records.push(existing);
      console.log(`${args.split} ${index + 1}/${rows.length} ${recordId}: resume-skip`);
      continue;
    }
    try {
      const response = await generateWithThinkingFallback({
        model: args.model,
        recordId,
        source,
        maxTokens: numberOption(args["max-tokens"], 2500),
        thinkingModes: thinkingAttemptPlan(args),
        timeoutMs: numberOption(args["timeout-ms"], 120000),
        retries: numberOption(args.retries, 0),
      });
      records.push({
        ...row,
        [predictionField]: response.generated,
        aci_note_generation_metadata: {
          provider: "cohere",
          model: args.model,
          thinking: response.thinking,
          attempt_count: response.attemptAudit.length,
          attempt_audit: response.attemptAudit,
          record_id: String(recordId),
          split: args.split,
          source_sha256: sha256(String(source || "")),
          reference_sha256: reference ? sha256(String(reference)) : null,
          request_hash: response.requestHash,
          request_started_at: response.requestStartedAt,
          request_completed_at: new Date().toISOString(),
          latency_ms: response.latencyMs,
          telemetry: response.telemetry,
          response_shape: describeCohereBody(response.body),
          caveat: "Model-generated ACI note from source dialogue only. Automated lexical metrics do not prove clinical correctness.",
        },
      });
      console.log(`${args.split} ${index + 1}/${rows.length} ${recordId}: ok`);
    } catch (error) {
      records.push({
        ...row,
        [predictionField]: "",
        aci_note_generation_metadata: {
          provider: "cohere",
          model: args.model,
          thinking: error.finalThinking || null,
          attempt_count: error.attemptAudit?.length || 0,
          attempt_audit: error.attemptAudit || [],
          record_id: String(recordId),
          split: args.split,
          source_sha256: sha256(String(source || "")),
          reference_sha256: reference ? sha256(String(reference)) : null,
          request_hash: error.requestHash || null,
          request_started_at: error.requestStartedAt || null,
          request_completed_at: new Date().toISOString(),
          latency_ms: error.latencyMs || null,
          error: redactSensitiveText(error.message),
          response_shape: error.responseShape || null,
          caveat: "Model call failed; this row is excluded from scored completed-case summaries.",
        },
      });
      console.error(`${args.split} ${index + 1}/${rows.length} ${recordId}: ${redactSensitiveText(error.message)}`);
      if (args["fail-on-error"]) process.exitCode = 1;
    }
  }

  const completedRecords = records.filter((row) => String(row[predictionField] || "").trim());
  const rouge = scoreAciNoteGeneration(completedRecords, {
    split: args.split,
    predictionField,
    bootstrapRepeats: numberOption(args["bootstrap-repeats"], 1000),
  });
  const factuality = scoreAciNoteFactuality(completedRecords, {
    split: args.split,
    predictionField,
  });
  const report = {
    generated_at: new Date().toISOString(),
    schema_version: "aci-note-cohere-eval-v1",
    input,
    split: args.split,
    provider: "cohere",
    model: args.model,
    prediction_field: predictionField,
    range: { offset, limit },
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    summary: {
      rows_requested: rows.length,
      completed_rows: completedRecords.length,
      failed_rows: records.length - completedRecords.length,
      rouge: rouge.summary,
      source_support: factuality.summary,
      attempts: summarizeAttempts(records),
      usage: summarizeUsage(records),
    },
    records,
    interpretation: "Cohere Command A+ ACI note-generation run scored against ACI reference notes with ROUGE plus lexical source-support diagnostics. This is benchmark-shaped model evidence, not official leaderboard evidence or clinical factuality proof.",
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.summary, null, 2));
}

function existingRecordsByRecordId(report, predictionField) {
  const out = new Map();
  for (const row of Array.isArray(report?.records) ? report.records : []) {
    const id = row.aci_note_generation_metadata?.record_id
      || firstValue(row, ["record_id", "case_id", "encounter_id", "dialogue_id", "id", "file"]);
    if (!id) continue;
    out.set(String(id), row);
  }
  return out;
}

async function generateWithThinkingFallback(options) {
  const attemptAudit = [];
  let lastError;
  for (let index = 0; index < options.thinkingModes.length; index += 1) {
    const thinking = options.thinkingModes[index];
    const request = buildCohereRequest({
      model: options.model,
      recordId: options.recordId,
      source: options.source,
      maxTokens: options.maxTokens,
      thinking,
    });
    const requestHash = sha256(JSON.stringify(request));
    const requestStartedAt = new Date().toISOString();
    const requestStarted = Date.now();
    try {
      const response = await callCohere(request, {
        timeoutMs: options.timeoutMs,
        retries: options.retries,
      });
      const generated = cohereMessageText(response.body).trim();
      const responseShape = describeCohereBody(response.body);
      if (!generated) {
        const error = new Error(responseShape.finish_reason === "MAX_TOKENS"
          ? "Cohere response exhausted max_tokens before visible note text"
          : "Cohere response contained no note text");
        error.retryable = true;
        error.responseShape = responseShape;
        throw error;
      }
      const latencyMs = Date.now() - requestStarted;
      attemptAudit.push({
        attempt: index + 1,
        thinking,
        status: "success",
        request_hash: requestHash,
        started_at: requestStartedAt,
        completed_at: new Date().toISOString(),
        latency_ms: latencyMs,
        telemetry: response.telemetry,
        response_shape: responseShape,
      });
      return {
        generated,
        body: response.body,
        telemetry: response.telemetry,
        thinking,
        requestHash,
        requestStartedAt,
        latencyMs,
        attemptAudit,
      };
    } catch (error) {
      lastError = error;
      const latencyMs = Date.now() - requestStarted;
      attemptAudit.push({
        attempt: index + 1,
        thinking,
        status: "failure",
        request_hash: requestHash,
        started_at: requestStartedAt,
        completed_at: new Date().toISOString(),
        latency_ms: latencyMs,
        error: redactSensitiveText(error.message),
        response_shape: error.responseShape || null,
      });
      if (index === options.thinkingModes.length - 1 || !isRetryableNoteGenerationError(error)) {
        error.finalThinking = thinking;
        error.attemptAudit = attemptAudit;
        error.requestHash = requestHash;
        error.requestStartedAt = requestStartedAt;
        error.latencyMs = latencyMs;
        error.responseShape = error.responseShape || null;
        throw error;
      }
    }
  }
  throw lastError;
}

function thinkingAttemptPlan(args) {
  if (args.thinking && args.thinking !== "auto") return [String(args.thinking)];
  if (args["thinking-policy"] === "disabled_then_budget512") return ["disabled", "budget:512"];
  if (args["thinking-policy"] === "budget512") return ["budget:512"];
  if (args["thinking-policy"] === "disabled") return ["disabled"];
  if (args["thinking-policy"] === "default") return ["default"];
  return ["disabled", "budget:512"];
}

function isRetryableNoteGenerationError(error) {
  return /INVALID_TOOL_GENERATION|invalid tool generation|no note text|exhausted max_tokens|timed out|fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(String(error.message || ""));
}

function buildCohereRequest(options) {
  const system = [
    "You are generating a concise clinical note from a clinician-patient dialogue for a research benchmark.",
    "Use only information explicitly supported by the dialogue.",
    "Do not invent diagnoses, medications, labs, plans, dates, or follow-up instructions.",
    "Preserve uncertainty, negation, and temporality.",
    "Return only the generated clinical note text.",
  ].join(" ");
  const user = [
    `Record: ${options.recordId}`,
    "",
    "Dialogue:",
    String(options.source || "").trim(),
    "",
    "Write the clinical note.",
  ].join("\n");
  const request = {
    model: options.model,
    temperature: 0,
    max_tokens: options.maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (options.thinking === "disabled") request.thinking = { type: "disabled" };
  else if (String(options.thinking || "").startsWith("budget:")) {
    request.thinking = { token_budget: Number(String(options.thinking).replace(/^budget:/, "")) };
  }
  return request;
}

async function callCohere(request, options = {}) {
  const apiKey = process.env.COHERE_API_KEY;
  if (!apiKey) throw new Error("Missing COHERE_API_KEY");
  const retries = Math.max(0, Number(options.retries) || 0);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    try {
      const { response, body } = await withTimeout((async () => {
        const response = await fetch("https://api.cohere.com/v2/chat", {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request),
        });
        const body = await response.json();
        return { response, body };
      })(), Number(options.timeoutMs) || 120000, controller);
      if (!response.ok) {
        const error = new Error(`Cohere API error ${response.status}: ${JSON.stringify(body)}`);
        error.retryable = response.status >= 500 || response.status === 429 || response.status === 408;
        throw error;
      }
      return {
        body,
        telemetry: {
          provider_request_id: body.id || response.headers.get("x-request-id") || null,
          returned_model: body.model || request.model,
          finish_reason: body.finish_reason || body.message?.finish_reason || null,
          usage: normalizeUsage(body.usage),
          provider_attempt: attempt + 1,
        },
      };
    } catch (error) {
      lastError = error;
      if (/timed out|fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(String(error.message || ""))) {
        error.retryable = true;
      }
      if (!error.retryable || attempt === retries) break;
      await sleep(Math.min(30000, 1500 * 2 ** attempt));
    } finally {
      controller.abort();
    }
  }
  throw lastError;
}

function cohereMessageText(body) {
  const content = body.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      return part?.text || part?.content || part?.output_text || "";
    }).join("").trim();
  }
  if (content && typeof content === "object") return content.text || content.content || content.output_text || "";
  if (typeof body.text === "string") return body.text;
  if (typeof body.generation === "string") return body.generation;
  if (typeof body.response?.text === "string") return body.response.text;
  if (Array.isArray(body.generations) && typeof body.generations[0]?.text === "string") return body.generations[0].text;
  return "";
}

function describeCohereBody(body) {
  return {
    top_level_keys: Object.keys(body || {}).sort(),
    message_keys: Object.keys(body?.message || {}).sort(),
    content_type: Array.isArray(body?.message?.content) ? "array" : typeof body?.message?.content,
    content_part_keys: Array.isArray(body?.message?.content)
      ? body.message.content.slice(0, 3).map((part) => typeof part === "object" && part ? Object.keys(part).sort() : typeof part)
      : null,
    finish_reason: body?.finish_reason || body?.message?.finish_reason || null,
  };
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? usage.tokens?.input_tokens ?? usage.billed_units?.input_tokens ?? null;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? usage.tokens?.output_tokens ?? usage.billed_units?.output_tokens ?? null;
  const totalTokens = usage.total_tokens ?? (Number.isFinite(Number(inputTokens)) && Number.isFinite(Number(outputTokens)) ? Number(inputTokens) + Number(outputTokens) : null);
  return {
    input_tokens: numericOrNull(inputTokens),
    output_tokens: numericOrNull(outputTokens),
    total_tokens: numericOrNull(totalTokens),
    billed_input_tokens: numericOrNull(usage.billed_units?.input_tokens),
    billed_output_tokens: numericOrNull(usage.billed_units?.output_tokens),
    raw: usage,
  };
}

function summarizeUsage(records) {
  const usageRows = records.map((row) => row.aci_note_generation_metadata?.telemetry?.usage).filter(Boolean);
  return {
    rows_with_usage: usageRows.length,
    input_tokens: sum(usageRows.map((row) => row.input_tokens)),
    output_tokens: sum(usageRows.map((row) => row.output_tokens)),
    total_tokens: sum(usageRows.map((row) => row.total_tokens)),
    billed_input_tokens: sum(usageRows.map((row) => row.billed_input_tokens)),
    billed_output_tokens: sum(usageRows.map((row) => row.billed_output_tokens)),
  };
}

function summarizeAttempts(records) {
  const attempts = records.flatMap((row) => row.aci_note_generation_metadata?.attempt_audit || []);
  return {
    total_attempts: attempts.length,
    success_attempts: attempts.filter((attempt) => attempt.status === "success").length,
    failure_attempts: attempts.filter((attempt) => attempt.status === "failure").length,
    thinking_counts: countBy(attempts.map((attempt) => attempt.thinking || "unknown")),
    failure_counts: countBy(attempts.filter((attempt) => attempt.status === "failure").map((attempt) => classifyAttemptFailure(attempt.error))),
  };
}

function classifyAttemptFailure(message) {
  const text = String(message || "");
  if (/INVALID_TOOL_GENERATION|invalid tool generation/i.test(text)) return "invalid_tool_generation";
  if (/max_tokens/i.test(text)) return "max_tokens_without_visible_note";
  if (/no note text/i.test(text)) return "empty_visible_note";
  if (/timed out/i.test(text)) return "timeout";
  if (/429/.test(text)) return "rate_limit";
  if (/5\d\d/.test(text)) return "provider_5xx";
  return "other";
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return counts;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex < 0) continue;
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function firstValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && String(row[key]).trim()) return row[key];
  }
  const lower = Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of keys) {
    if (lower[key] !== undefined && String(lower[key]).trim()) return lower[key];
  }
  return "";
}

function withTimeout(promise, timeoutMs, controller) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Cohere request timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function numberOption(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numericOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function sum(values) {
  const nums = values.filter((value) => Number.isFinite(Number(value))).map(Number);
  return nums.length ? nums.reduce((total, value) => total + value, 0) : null;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactSensitiveText(value) {
  return String(value || "")
    .replace(/cohere_[A-Za-z0-9_-]+/g, "[redacted Cohere key]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]");
}

if (require.main === module) main();
