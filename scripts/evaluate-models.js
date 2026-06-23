#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { toProviderCompatibleSchema } = require("./schema-utils");

loadEnvFile(".env");

const FROZEN_MODELS = ["cohere-aplus:command-a-plus-05-2026", "anthropic/claude-haiku-4.5"];
const exploratoryModels = process.env.EVAL_MODELS || process.env.OPENROUTER_MODELS;
const IS_EXPLORATORY = process.env.EXPERIMENT_MODE === "exploratory";
const DEFAULT_MODELS = IS_EXPLORATORY && exploratoryModels
  ? exploratoryModels.split(",").map((item) => item.trim()).filter(Boolean)
  : FROZEN_MODELS;

const schema = JSON.parse(fs.readFileSync(path.join("eval", "schema.json"), "utf8"));
const systemPrompt = fs.readFileSync(path.join("prompts", "system.md"), "utf8");
const extractionPromptPath = IS_EXPLORATORY && process.env.EXTRACTION_PROMPT_PATH
  ? process.env.EXTRACTION_PROMPT_PATH
  : path.join("prompts", "clinical-extraction.md");
const extractionPrompt = fs.readFileSync(extractionPromptPath, "utf8");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const casesPath = args.cases || path.join("eval", "pilot_reference_cases.json");
  const outPath = args.out || path.join("results", "model-eval.json");
  const mdOutPath = args.mdout || outPath.replace(/\.json$/i, ".md");
  const models = (args.models || args.providers || DEFAULT_MODELS.join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const limit = args.limit ? Number(args.limit) : undefined;
  const offset = args.offset ? Number(args.offset) : 0;
  const allCases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
  const cases = allCases.slice(offset, limit === undefined ? undefined : offset + limit);

  if (args["dry-run"]) {
    const previews = models.map((model) => ({ configuration: model, request: redactLongSummary(buildPreviewRequest(model, cases[0])) }));
    console.log(JSON.stringify({ case_id: cases[0]?.case_id, execution_order: orderedModelsForCase(models, cases[0]?.case_id), previews }, null, 2));
    return;
  }

  const results = [];
  let executionIndex = 0;
  for (const testCase of cases) {
    for (const model of orderedModelsForCase(models, testCase.case_id)) {
      const startedAt = Date.now();
      const startedAtIso = new Date(startedAt).toISOString();
      try {
        const { extraction, repairs, attempts, finalModel, rawSchemaValid, telemetry, attemptAudit } = await extractWithLocalRetries(model, testCase);
        const score = hasGold(testCase) ? scoreExtraction(extraction, testCase.gold) : null;
        results.push({
          execution_index: executionIndex++,
          provider: providerForModel(model),
          model,
          route_model: finalModel,
          case_id: testCase.case_id,
          source_hash: sha256(String(testCase.discharge_summary || "")),
          request_started_at: startedAtIso,
          request_completed_at: new Date().toISOString(),
          latency_ms: Date.now() - startedAt,
          attempts,
          attempt_audit: attemptAudit,
          telemetry,
          raw_schema_valid: rawSchemaValid,
          extraction,
          schema_repairs: repairs,
          score
        });
        console.log(`${model} ${testCase.case_id}: ${score ? `F1=${score.overall.f1.toFixed(3)}` : "completed, unscored"}`);
      } catch (error) {
        const safeError = redactSensitiveText(error.message);
        results.push({
          execution_index: executionIndex++,
          provider: providerForModel(model),
          model,
          route_model: error.finalModel || model,
          case_id: testCase.case_id,
          source_hash: sha256(String(testCase.discharge_summary || "")),
          request_started_at: startedAtIso,
          request_completed_at: new Date().toISOString(),
          latency_ms: Date.now() - startedAt,
          attempts: error.attempts || 1,
          attempt_audit: error.attemptAudit || [],
          error: safeError,
          score: hasGold(testCase) ? emptyScore() : null
        });
        console.error(`${model} ${testCase.case_id}: ${safeError}`);
      }
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    cases_path: casesPath,
    case_offset: offset,
    case_limit: limit || null,
    local_validation_retries: Number(process.env.EVAL_VALIDATION_RETRIES || 0),
    cases: cases.map(({ case_id }) => case_id),
    models,
    extraction_prompt_path: extractionPromptPath,
    extraction_prompt_sha256: sha256(extractionPrompt),
    execution_design: "case-interleaved paired execution with deterministic counterbalanced model order",
    summary: summarize(results),
    results
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(mdOutPath, renderMarkdownReport(report));
  console.log(`Wrote ${outPath}`);
  console.log(`Wrote ${mdOutPath}`);
  if (args["fail-on-error"] && results.some((result) => result.error)) process.exitCode = 1;
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

function runtimeNumber(name, frozenValue) {
  if (!IS_EXPLORATORY || process.env[name] === undefined || process.env[name] === "") return frozenValue;
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) throw new Error(`Invalid numeric environment value for ${name}`);
  return value;
}

function orderedModelsForCase(models, caseId) {
  if (models.length < 2) return [...models];
  let hash = 2166136261;
  for (const character of String(caseId)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2 === 0 ? [...models] : [...models].reverse();
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? usage.tokens?.input_tokens ?? usage.billed_units?.input_tokens ?? null;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? usage.tokens?.output_tokens ?? usage.billed_units?.output_tokens ?? null;
  const totalTokens = usage.total_tokens ?? (Number.isFinite(inputTokens) && Number.isFinite(outputTokens) ? inputTokens + outputTokens : null);
  return {
    input_tokens: inputTokens !== null && Number.isFinite(Number(inputTokens)) ? Number(inputTokens) : null,
    output_tokens: outputTokens !== null && Number.isFinite(Number(outputTokens)) ? Number(outputTokens) : null,
    total_tokens: totalTokens !== null && Number.isFinite(Number(totalTokens)) ? Number(totalTokens) : null,
    billed_input_tokens: Number.isFinite(Number(usage.billed_units?.input_tokens)) ? Number(usage.billed_units.input_tokens) : null,
    billed_output_tokens: Number.isFinite(Number(usage.billed_units?.output_tokens)) ? Number(usage.billed_units.output_tokens) : null,
    provider_reported_cost_usd: Number.isFinite(Number(usage.cost)) ? Number(usage.cost) : null,
    raw: usage
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
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

function buildUserMessage(testCase) {
  return `${extractionPrompt}

Case metadata:
${JSON.stringify({
  case_id: testCase.case_id,
  age: testCase.age,
  gender: testCase.gender,
  admission_diagnosis: testCase.admission_diagnosis
}, null, 2)}

Discharge summary:
${testCase.discharge_summary}`;
}

async function callOpenRouter(model, testCase) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const timeoutMs = Number(process.env.OPENROUTER_TIMEOUT_MS || 120000);
  const retries = runtimeNumber("OPENROUTER_RETRIES", 0);
  const requestBody = buildOpenRouterRequest(model, testCase);

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
            "X-Title": process.env.OPENROUTER_APP_NAME || "Hospital Course Change Summarizer Eval"
          },
          body: JSON.stringify(requestBody)
        });
        const body = await response.json();
        return { response, body };
      })(), timeoutMs, `OpenRouter request timed out after ${timeoutMs} ms`, controller);
      if (!response.ok) {
        const error = new Error(`OpenRouter API error ${response.status}: ${JSON.stringify(body)}`);
        error.retryable = response.status >= 500 || response.status === 429 || response.status === 408;
        throw error;
      }
      const message = body.choices?.[0]?.message;
      const toolArgs = message?.tool_calls?.[0]?.function?.arguments;
      const telemetry = {
        provider_request_id: body.id || response.headers.get("x-request-id") || null,
        returned_model: body.model || model,
        finish_reason: body.choices?.[0]?.finish_reason || null,
        usage: normalizeUsage(body.usage),
        provider_attempt: attempt + 1
      };
      telemetry.request_hash = sha256(JSON.stringify(requestBody));
      if (toolArgs) return { extraction: typeof toolArgs === "string" ? parseJsonFromText(toolArgs) : toolArgs, telemetry };

      const content = message?.content;
      if (!content) {
        const error = new Error(`OpenRouter response missing message content: ${JSON.stringify(body)}`);
        error.retryable = true;
        throw error;
      }
      return { extraction: typeof content === "string" ? parseJsonFromText(content) : content, telemetry };
    } catch (error) {
      lastError = error;
      if (String(error.message || "").includes("timed out")) error.retryable = true;
      if (!error.retryable || attempt === retries) break;
      await sleep(Math.min(30000, 1500 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function callModel(model, testCase) {
  if (model.startsWith("cohere-aplus:")) return callCohere(model.replace(/^cohere-aplus:/, ""), testCase, { schemaMode: "json-schema", defaultThinkingBudget: 512 });
  if (model.startsWith("cohere-flat:")) return callCohere(model.replace(/^cohere-flat:/, ""), testCase, { schemaMode: "tool-flat" });
  if (model.startsWith("cohere-strict:")) return callCohere(model.replace(/^cohere-strict:/, ""), testCase, { schemaMode: "tool-strict", defaultThinkingBudget: 512 });
  if (model.startsWith("cohere-json-schema:")) return callCohere(model.replace(/^cohere-json-schema:/, ""), testCase, { schemaMode: "json-schema", defaultThinkingBudget: 512 });
  if (model.startsWith("cohere-json:")) return callCohere(model.replace(/^cohere-json:/, ""), testCase, { schemaMode: "json-object", defaultThinkingBudget: 512 });
  if (model.startsWith("cohere:")) return callCohere(model.replace(/^cohere:/, ""), testCase);
  return callOpenRouter(model, testCase);
}

async function extractWithLocalRetries(model, testCase) {
  const localRetries = model.startsWith("cohere")
    ? runtimeNumber("COHERE_VALIDATION_RETRIES", 1)
    : runtimeNumber("OPENROUTER_VALIDATION_RETRIES", 1);
  const maxAttempts = localRetries + 1;
  let lastError;
  const attemptAudit = [];
  const attemptPlan = buildModelAttemptPlan(model, maxAttempts);

  for (let attempt = 1; attempt <= attemptPlan.length; attempt += 1) {
    const attemptModel = attemptPlan[attempt - 1];
    const attemptStartedAt = Date.now();
    let response;
    try {
      response = await callModel(attemptModel, testCase);
      const rawExtraction = response.extraction;
      let rawSchemaValid = true;
      try {
        assertExtractionShape(structuredClone(rawExtraction));
      } catch {
        rawSchemaValid = false;
      }
      const { extraction, repairs } = normalizeExtractionShape(rawExtraction);
      assertExtractionShape(extraction);
      attemptAudit.push({
        attempt,
        route_model: attemptModel,
        started_at: new Date(attemptStartedAt).toISOString(),
        completed_at: new Date().toISOString(),
        latency_ms: Date.now() - attemptStartedAt,
        status: "success",
        raw_schema_valid: rawSchemaValid,
        schema_repairs: repairs,
        telemetry: response.telemetry
      });
      return { extraction, repairs, attempts: attempt, finalModel: attemptModel, rawSchemaValid, telemetry: response.telemetry, attemptAudit };
    } catch (error) {
      lastError = error;
      attemptAudit.push({
        attempt,
        route_model: attemptModel,
        started_at: new Date(attemptStartedAt).toISOString(),
        completed_at: new Date().toISOString(),
        latency_ms: Date.now() - attemptStartedAt,
        status: "failure",
        error: redactSensitiveText(error.message),
        telemetry: response?.telemetry || null
      });
      error.attempts = attempt;
      error.finalModel = attemptModel;
      error.attemptAudit = attemptAudit;
      if (!isLocalRetryableExtractionError(error) || attempt === maxAttempts) break;
      await sleep(Math.min(10000, 1000 * attempt));
    }
  }

  throw lastError;
}

function buildModelAttemptPlan(model, maxAttempts) {
  if (!model.startsWith("cohere-aplus:")) return Array.from({ length: maxAttempts }, () => model);
  const baseModel = model.replace(/^cohere-aplus:/, "");
  if (maxAttempts === 1) return [`cohere-json-schema:${baseModel}`];
  return Array.from({ length: maxAttempts }, (_, index) => (
    index === maxAttempts - 1 ? `cohere-strict:${baseModel}` : `cohere-json-schema:${baseModel}`
  ));
}

function isLocalRetryableExtractionError(error) {
  const message = String(error.message || "");
  return [
    "Extraction schema mismatch",
    "Cohere API error 500",
    "timed out",
    "Missing JSON text",
    "missing JSON text",
    "missing tool call arguments",
    "Unexpected end of JSON input",
    "Unexpected token"
  ].some((pattern) => message.includes(pattern));
}

function providerForModel(model) {
  return model.startsWith("cohere") ? "cohere" : "openrouter";
}

async function callCohere(model, testCase, options = {}) {
  const apiKey = process.env.COHERE_API_KEY;
  if (!apiKey) throw new Error("Missing COHERE_API_KEY");

  const timeoutMs = Number(process.env.COHERE_TIMEOUT_MS || process.env.OPENROUTER_TIMEOUT_MS || 120000);
  const retries = runtimeNumber("COHERE_RETRIES", 0);
  const mode = options.schemaMode || process.env.COHERE_SCHEMA_MODE || "tool-loose";
  const requestBody = buildCohereRequest(model, testCase, mode);
  applyCohereTuning(requestBody, options);

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
            "Content-Type": "application/json"
          },
          body: JSON.stringify(requestBody)
        });
        const body = await response.json();
        return { response, body };
      })(), timeoutMs, `Cohere request timed out after ${timeoutMs} ms`, controller);

      if (!response.ok) {
        const error = new Error(`Cohere API error ${response.status}: ${JSON.stringify(body)}`);
        error.retryable = response.status >= 500 || response.status === 429;
        throw error;
      }
      return {
        extraction: parseCohereResponse(body, mode),
        telemetry: {
          provider_request_id: body.id || response.headers.get("x-request-id") || null,
          returned_model: body.model || model,
          finish_reason: body.finish_reason || body.message?.finish_reason || null,
          usage: normalizeUsage(body.usage),
          provider_attempt: attempt + 1,
          request_hash: sha256(JSON.stringify(requestBody))
        }
      };
    } catch (error) {
      lastError = error;
      if (/timed out|fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(String(error.message || ""))) {
        error.retryable = true;
      }
      if (!error.retryable || attempt === retries) break;
      await sleep(Math.min(30000, 1500 * 2 ** attempt));
    }
  }
  throw lastError;
}

function buildCohereRequest(model, testCase, mode) {
  const toolInstruction = mode.startsWith("tool")
    ? "\n\nWhen the extraction tool is available, call `extract_clinical_changes` exactly once. Do not write analysis or final prose outside the tool call."
    : "";
  const messages = [
    { role: "system", content: `${systemPrompt}${toolInstruction}` },
    { role: "user", content: buildUserMessage(testCase) }
  ];
  const request = { model, max_tokens: runtimeNumber("COHERE_MAX_TOKENS", 8000), messages };

  if (mode === "json-object" || mode === "json-schema") {
    request.response_format = { type: "json_object" };
    if (mode === "json-schema") request.response_format.schema = cohereCompatibleSchema();
    return request;
  }

  request.tools = [
    {
      type: "function",
      function: {
        name: "extract_clinical_changes",
        description: "Extract source-grounded clinical handover changes from a discharge summary.",
        parameters: mode === "tool-flat" ? cohereFlatSchema() : cohereCompatibleSchema()
      }
    }
  ];
  request.strict_tools = mode !== "tool-loose" && mode !== "tool-flat";
  return request;
}

function buildPreviewRequest(model, testCase) {
  if (model.startsWith("cohere-aplus:")) {
    const baseModel = model.replace(/^cohere-aplus:/, "");
    const request = buildCohereRequest(baseModel, testCase, "json-schema");
    applyCohereTuning(request, { defaultThinkingBudget: 512 });
    return request;
  }
  if (model.startsWith("cohere:")) {
    return buildCohereRequest(model.replace(/^cohere:/, ""), testCase, process.env.COHERE_SCHEMA_MODE || "tool-loose");
  }
  return buildOpenRouterRequest(model, testCase);
}

function applyCohereTuning(request, options = {}) {
  request.temperature = runtimeNumber("COHERE_TEMPERATURE", 0);

  if (IS_EXPLORATORY && process.env.COHERE_THINKING === "disabled") {
    request.thinking = { type: "disabled" };
  } else if (IS_EXPLORATORY && process.env.COHERE_THINKING_BUDGET) {
    request.thinking = { token_budget: Number(process.env.COHERE_THINKING_BUDGET) };
  } else if (options.defaultThinkingBudget) {
    request.thinking = { token_budget: Number(options.defaultThinkingBudget) };
  }

  if (IS_EXPLORATORY && request.tools && process.env.COHERE_TOOL_CHOICE) {
    request.tool_choice = process.env.COHERE_TOOL_CHOICE;
  }
}

function parseCohereResponse(body, mode) {
  if (mode === "json-object" || mode === "json-schema") {
    const text = cohereMessageText(body);
    if (!text) throw new Error(`Cohere response missing JSON text: ${JSON.stringify(body)}`);
    return parseJsonFromText(text);
  }

  const toolCall = body.message?.tool_calls?.[0];
  const args = toolCall?.function?.arguments;
  if (!args) {
    const text = cohereMessageText(body);
    if (text) return parseJsonFromText(text);
    throw new Error(`Cohere response missing tool call arguments: ${JSON.stringify(body)}`);
  }
  const parsed = typeof args === "string" ? parseJsonFromText(args) : args;
  return mode === "tool-flat" ? expandFlatExtraction(parsed) : parsed;
}

function parseJsonFromText(text) {
  const trimmed = String(text).trim();
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

function cohereMessageText(body) {
  const content = body.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => part?.text || "")
      .join("")
      .trim();
  }
  return "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertExtractionShape(extraction) {
  const requiredArrays = [
    "medication_changes.started",
    "medication_changes.stopped",
    "medication_changes.changed",
    "medication_changes.continued",
    "medication_changes.uncertain",
    "diagnosis_changes.discharge",
    "diagnosis_changes.new_or_changed",
    "procedures_and_tests",
    "labs",
    "follow_up_actions",
    "safety_flags",
    "uncertain_items"
  ];
  const requiredStrings = [
    "case_id",
    "patient_context.age",
    "patient_context.gender",
    "patient_context.admission_diagnosis",
    "diagnosis_changes.admission",
    "two_page_summary"
  ];

  for (const item of requiredArrays) {
    if (!Array.isArray(getPath(extraction, item))) throw new Error(`Extraction schema mismatch: ${item} must be an array`);
  }
  for (const item of requiredStrings) {
    if (typeof getPath(extraction, item) !== "string") throw new Error(`Extraction schema mismatch: ${item} must be a string`);
  }
  if (extraction.two_page_summary.trim().length < 80) {
    throw new Error("Extraction schema mismatch: two_page_summary must be non-empty and clinically informative");
  }
}

function normalizeExtractionShape(extraction) {
  const normalized = structuredClone(extraction);
  const repairs = [];
  const arrayPaths = [
    "medication_changes.started",
    "medication_changes.stopped",
    "medication_changes.changed",
    "medication_changes.continued",
    "medication_changes.uncertain",
    "diagnosis_changes.discharge",
    "diagnosis_changes.new_or_changed",
    "procedures_and_tests",
    "labs",
    "follow_up_actions",
    "safety_flags",
    "uncertain_items"
  ];

  for (const pathName of arrayPaths) {
    const value = getPath(normalized, pathName);
    if (Array.isArray(value)) continue;
    if (value === null || value === undefined) {
      setPath(normalized, pathName, []);
      repairs.push(`${pathName}:missing_to_empty_array`);
    } else if (Array.isArray(value.items)) {
      setPath(normalized, pathName, value.items);
      repairs.push(`${pathName}:items_array_unwrapped`);
    } else if (isEvidenceItem(value)) {
      setPath(normalized, pathName, [value]);
      repairs.push(`${pathName}:single_object_wrapped`);
    }
  }

  const summary = normalized.two_page_summary;
  if (summary && typeof summary !== "string") {
    if (typeof summary.text === "string") {
      normalized.two_page_summary = summary.text;
      repairs.push("two_page_summary:text_property_used");
    } else if (typeof summary.summary === "string") {
      normalized.two_page_summary = summary.summary;
      repairs.push("two_page_summary:summary_property_used");
    } else if (Array.isArray(summary)) {
      normalized.two_page_summary = summary.map((item) => typeof item === "string" ? item : item?.text || item?.summary || "").filter(Boolean).join("\n\n");
      repairs.push("two_page_summary:array_joined");
    }
  }

  const admissionDiagnosis = getPath(normalized, "diagnosis_changes.admission");
  if (admissionDiagnosis && typeof admissionDiagnosis !== "string") {
    if (typeof admissionDiagnosis.label === "string") {
      setPath(normalized, "diagnosis_changes.admission", admissionDiagnosis.label);
      repairs.push("diagnosis_changes.admission:label_property_used");
    } else if (typeof admissionDiagnosis.text === "string") {
      setPath(normalized, "diagnosis_changes.admission", admissionDiagnosis.text);
      repairs.push("diagnosis_changes.admission:text_property_used");
    } else if (Array.isArray(admissionDiagnosis)) {
      setPath(normalized, "diagnosis_changes.admission", admissionDiagnosis.map((item) => typeof item === "string" ? item : item?.label || item?.text || "").filter(Boolean).join("; "));
      repairs.push("diagnosis_changes.admission:array_joined");
    }
  }

  for (const stringPath of ["case_id", "patient_context.age", "patient_context.gender", "patient_context.admission_diagnosis"]) {
    const value = getPath(normalized, stringPath);
    if (value !== null && value !== undefined && typeof value !== "string") {
      setPath(normalized, stringPath, stringifySchemaValue(value));
      repairs.push(`${stringPath}:coerced_to_string`);
    }
  }

  return { extraction: normalized, repairs };
}

function stringifySchemaValue(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value?.label === "string") return value.label;
  if (typeof value?.text === "string") return value.text;
  if (Array.isArray(value)) return value.map(stringifySchemaValue).filter(Boolean).join("; ");
  return "";
}

function isEvidenceItem(value) {
  return value && typeof value === "object" && typeof value.label === "string" && typeof value.rationale === "string" && typeof value.source_quote === "string";
}

function setPath(object, dottedPath, value) {
  const keys = dottedPath.split(".");
  const finalKey = keys.pop();
  const parent = keys.reduce((current, key) => {
    current[key] ||= {};
    return current[key];
  }, object);
  parent[finalKey] = value;
}

function cohereCompatibleSchema() {
  return toProviderCompatibleSchema(schema);
}

function cohereFlatSchema() {
  const evidenceItem = {
    type: "object",
    additionalProperties: false,
    required: ["label", "rationale", "source_quote"],
    properties: {
      label: { type: "string" },
      rationale: { type: "string" },
      source_quote: { type: "string" }
    }
  };
  const evidenceList = { type: "array", items: evidenceItem };
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "case_id",
      "age",
      "gender",
      "admission_diagnosis",
      "medications_started",
      "medications_stopped",
      "medications_changed",
      "medications_continued",
      "medications_uncertain",
      "discharge_diagnoses",
      "new_or_changed_diagnoses",
      "procedures_and_tests",
      "labs",
      "follow_up_actions",
      "safety_flags",
      "uncertain_items",
      "two_page_summary"
    ],
    properties: {
      case_id: { type: "string" },
      age: { type: "string" },
      gender: { type: "string" },
      admission_diagnosis: { type: "string" },
      medications_started: evidenceList,
      medications_stopped: evidenceList,
      medications_changed: evidenceList,
      medications_continued: evidenceList,
      medications_uncertain: evidenceList,
      discharge_diagnoses: evidenceList,
      new_or_changed_diagnoses: evidenceList,
      procedures_and_tests: evidenceList,
      labs: evidenceList,
      follow_up_actions: evidenceList,
      safety_flags: evidenceList,
      uncertain_items: evidenceList,
      two_page_summary: { type: "string" }
    }
  };
}

function expandFlatExtraction(flat) {
  return {
    case_id: flat.case_id || "",
    patient_context: {
      age: flat.age || "",
      gender: flat.gender || "",
      admission_diagnosis: flat.admission_diagnosis || ""
    },
    medication_changes: {
      started: flat.medications_started || [],
      stopped: flat.medications_stopped || [],
      changed: flat.medications_changed || [],
      continued: flat.medications_continued || [],
      uncertain: flat.medications_uncertain || []
    },
    diagnosis_changes: {
      admission: flat.admission_diagnosis || "",
      discharge: flat.discharge_diagnoses || [],
      new_or_changed: flat.new_or_changed_diagnoses || []
    },
    procedures_and_tests: flat.procedures_and_tests || [],
    labs: flat.labs || [],
    follow_up_actions: flat.follow_up_actions || [],
    safety_flags: flat.safety_flags || [],
    uncertain_items: flat.uncertain_items || [],
    two_page_summary: flat.two_page_summary || ""
  };
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

function buildOpenRouterRequest(model, testCase) {
  const mode = IS_EXPLORATORY ? (process.env.OPENROUTER_SCHEMA_MODE || "json-schema") : "json-schema";
  const request = {
    model,
    max_tokens: runtimeNumber("OPENROUTER_MAX_TOKENS", 20000),
    temperature: runtimeNumber("OPENROUTER_TEMPERATURE", 0),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: buildUserMessage(testCase) }
    ]
  };

  const requireParameters = !IS_EXPLORATORY || process.env.OPENROUTER_REQUIRE_PARAMETERS === undefined
    ? mode === "json-schema"
    : process.env.OPENROUTER_REQUIRE_PARAMETERS === "true";
  if (requireParameters) request.provider = { require_parameters: true };

  if (mode === "json-schema") {
    request.response_format = {
      type: "json_schema",
      json_schema: {
        name: "clinical_change_extraction",
        strict: true,
        schema
      }
    };
    return request;
  }

  if (mode === "json-object") {
    request.response_format = { type: "json_object" };
    return request;
  }

  if (mode === "tool") {
    request.tools = [
      {
        type: "function",
        function: {
          name: "extract_clinical_changes",
          description: "Extract source-grounded clinical handover changes from a discharge summary.",
          parameters: cohereCompatibleSchema()
        }
      }
    ];
    request.tool_choice = {
      type: "function",
      function: { name: "extract_clinical_changes" }
    };
    return request;
  }

  if (mode === "plain-json") return request;

  throw new Error(`Unsupported OPENROUTER_SCHEMA_MODE: ${mode}`);
}

function redactLongSummary(request) {
  return {
    ...request,
    messages: request.messages.map((message) => ({
      ...message,
      content: message.content.length > 1200 ? `${message.content.slice(0, 1200)}\n...[truncated for dry-run preview]` : message.content
    }))
  };
}

function scoreExtraction(extraction, gold) {
  const categories = {};
  for (const category of Object.keys(gold)) {
    const predicted = flattenLabels(getPath(extraction, category));
    categories[category] = scoreList(predicted, gold[category]);
  }

  const totals = Object.values(categories).reduce(
    (acc, item) => ({
      true_positive: acc.true_positive + item.true_positive,
      false_positive: acc.false_positive + item.false_positive,
      false_negative: acc.false_negative + item.false_negative
    }),
    { true_positive: 0, false_positive: 0, false_negative: 0 }
  );

  return {
    categories,
    overall: calculateMetrics(totals.true_positive, totals.false_positive, totals.false_negative)
  };
}

function hasGold(testCase) {
  return testCase.gold && Object.keys(testCase.gold).length > 0;
}

function getPath(value, dottedPath) {
  return dottedPath.split(".").reduce((current, key) => current?.[key], value);
}

function flattenLabels(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => item?.label || item).filter(Boolean);
}

function scoreList(predicted, expected) {
  const normalizedPredicted = predicted.map(normalize);
  const matchedPredicted = new Set();
  let truePositive = 0;

  for (const expectedItem of expected) {
    const expectedNorm = normalize(expectedItem);
    const matchIndex = normalizedPredicted.findIndex((candidate, index) => {
      if (matchedPredicted.has(index)) return false;
      return candidate.includes(expectedNorm) || expectedNorm.includes(candidate);
    });
    if (matchIndex >= 0) {
      matchedPredicted.add(matchIndex);
      truePositive += 1;
    }
  }

  const falsePositive = Math.max(0, predicted.length - truePositive);
  const falseNegative = Math.max(0, expected.length - truePositive);
  return calculateMetrics(truePositive, falsePositive, falseNegative);
}

function calculateMetrics(truePositive, falsePositive, falseNegative) {
  const precision = truePositive + falsePositive === 0 ? 0 : truePositive / (truePositive + falsePositive);
  const recall = truePositive + falseNegative === 0 ? 0 : truePositive / (truePositive + falseNegative);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { true_positive: truePositive, false_positive: falsePositive, false_negative: falseNegative, precision, recall, f1 };
}

function normalize(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(mg|mcg|po|iv|daily|bid|tid|qid|the|and|with|for|to|of)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summarize(results) {
  const byModel = {};
  for (const result of results) {
    const key = result.model;
    byModel[key] ||= [];
    byModel[key].push(result);
  }
  return Object.fromEntries(
    Object.entries(byModel).map(([key, modelResults]) => {
      const successful = modelResults.filter((result) => !result.error);
      const firstPassSuccessful = successful.filter((result) => (result.attempts || 1) === 1);
      const rawSchemaValid = successful.filter((result) => result.raw_schema_valid === true);
      const normalizedOrRepaired = successful.filter((result) => result.raw_schema_valid === false || (result.schema_repairs || []).length > 0);
      const usageObserved = successful.filter((result) => result.telemetry?.usage);
      const scored = successful.filter((result) => result.score);
      const routeCounts = {};
      let attemptTotal = 0;
      for (const result of modelResults) {
        routeCounts[result.route_model || result.model] = (routeCounts[result.route_model || result.model] || 0) + 1;
        attemptTotal += result.attempts || 1;
      }
      const average = successful.reduce((acc, result) => ({
        precision: acc.precision + (result.score?.overall.precision || 0),
        recall: acc.recall + (result.score?.overall.recall || 0),
        f1: acc.f1 + (result.score?.overall.f1 || 0),
        latency_ms: acc.latency_ms + result.latency_ms
      }), { precision: 0, recall: 0, f1: 0, latency_ms: 0 });
      return [key, {
        cases_attempted: modelResults.length,
        cases_completed: successful.length,
        completion_rate: modelResults.length === 0 ? 0 : successful.length / modelResults.length,
        completion_ci95: wilsonInterval(successful.length, modelResults.length),
        first_pass_completed: firstPassSuccessful.length,
        first_pass_completion_rate: modelResults.length === 0 ? 0 : firstPassSuccessful.length / modelResults.length,
        first_pass_completion_ci95: wilsonInterval(firstPassSuccessful.length, modelResults.length),
        raw_schema_valid: rawSchemaValid.length,
        raw_schema_valid_rate: modelResults.length === 0 ? 0 : rawSchemaValid.length / modelResults.length,
        raw_schema_valid_ci95: wilsonInterval(rawSchemaValid.length, modelResults.length),
        normalized_or_repaired: normalizedOrRepaired.length,
        usage_observed_cases: usageObserved.length,
        mean_input_tokens: mean(usageObserved.map((result) => result.telemetry.usage.input_tokens)),
        mean_output_tokens: mean(usageObserved.map((result) => result.telemetry.usage.output_tokens)),
        total_input_tokens: sum(usageObserved.map((result) => result.telemetry.usage.input_tokens)),
        total_output_tokens: sum(usageObserved.map((result) => result.telemetry.usage.output_tokens)),
        cases_scored: scored.length,
        failures: modelResults.length - successful.length,
        failure_rate: modelResults.length === 0 ? 0 : (modelResults.length - successful.length) / modelResults.length,
        mean_latency_ms: successful.length === 0 ? 0 : average.latency_ms / successful.length,
        mean_attempts: modelResults.length === 0 ? 0 : attemptTotal / modelResults.length,
        route_counts: routeCounts,
        precision: scored.length === 0 ? null : average.precision / scored.length,
        recall: scored.length === 0 ? null : average.recall / scored.length,
        f1: scored.length === 0 ? null : average.f1 / scored.length
      }];
    })
  );
}

function renderMarkdownReport(report) {
  const lines = [
    "# Model Configuration Evaluation Report",
    "",
    `Generated: ${report.generated_at}`,
    "",
    "## Configurations",
    "",
    ...report.models.map((model) => `- \`${model}\``),
    "",
    "## Layer 1: Configuration Feasibility",
    "",
    "| Configuration | Attempted | First-pass valid (95% CI) | Policy-assisted valid (95% CI) | Failures | Mean Latency ms | Mean Attempts |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...Object.entries(report.summary).map(([model, score]) => (
      `| \`${model}\` | ${score.cases_attempted} | ${score.first_pass_completed} (${formatInterval(score.first_pass_completion_ci95)}) | ${score.cases_completed} (${formatInterval(score.completion_ci95)}) | ${score.failures} | ${Math.round(score.mean_latency_ms)} | ${format(score.mean_attempts)} |`
    )),
    "",
    "## Route Usage",
    "",
    "| Configuration | Route | Cases |",
    "| --- | --- | ---: |",
    ...Object.entries(report.summary).flatMap(([model, score]) => (
      Object.entries(score.route_counts || { [model]: score.cases_attempted }).map(([route, count]) => (
        `| \`${model}\` | \`${route}\` | ${count} |`
      ))
    )),
    "",
    "## Raw Schema Conformance",
    "",
    "| Configuration | Raw schema-valid (95% CI) | Normalized or repaired |",
    "| --- | ---: | ---: |",
    ...Object.entries(report.summary).map(([model, score]) => (
      `| \`${model}\` | ${score.raw_schema_valid}/${score.cases_attempted} (${formatInterval(score.raw_schema_valid_ci95)}) | ${score.normalized_or_repaired} |`
    )),
    "",
    "## Usage Telemetry",
    "",
    "| Configuration | Cases with usage | Mean input tokens | Mean output tokens | Total input | Total output |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...Object.entries(report.summary).map(([model, score]) => (
      `| \`${model}\` | ${score.usage_observed_cases} | ${format(score.mean_input_tokens)} | ${format(score.mean_output_tokens)} | ${format(score.total_input_tokens)} | ${format(score.total_output_tokens)} |`
    )),
    "",
    "## Layer 2: Extraction Quality",
    "",
    "Successful, schema-valid outputs only.",
    "",
    "| Configuration | Scored Cases | Precision | Recall | F1 |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...Object.entries(report.summary).map(([model, score]) => (
      `| \`${model}\` | ${score.cases_scored} | ${format(score.precision)} | ${format(score.recall)} | ${format(score.f1)} |`
    )),
    "",
    "## Case Results",
    "",
    "| Model | Case | Route | Attempts | Precision | Recall | F1 | Latency ms | Status |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |"
  ];

  for (const result of report.results) {
    const status = result.error ? `Error: ${escapeTable(result.error)}` : "OK";
    lines.push(`| \`${result.model}\` | ${result.case_id} | \`${result.route_model || result.model}\` | ${result.attempts || 1} | ${format(result.score?.overall.precision)} | ${format(result.score?.overall.recall)} | ${format(result.score?.overall.f1)} | ${result.latency_ms} | ${status} |`);
  }

  lines.push(
    "",
    "## Category Scores",
    "",
    "| Model | Case | Category | Precision | Recall | F1 | TP | FP | FN |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |"
  );

  for (const result of report.results) {
    for (const [category, score] of Object.entries(result.score?.categories || {})) {
      lines.push(`| \`${result.model}\` | ${result.case_id} | \`${category}\` | ${format(score.precision)} | ${format(score.recall)} | ${format(score.f1)} | ${score.true_positive} | ${score.false_positive} | ${score.false_negative} |`);
    }
  }

  lines.push(
    "",
    "## Evaluation Notes",
    "",
    "- This report compares model-provider-schema configurations, not pure model capability in isolation.",
    "- Layer 1 reports whether a configuration can return usable structured output reliably.",
    "- Layer 2 reports extraction quality among successful, schema-valid outputs that have reference labels.",
    "- Unlabeled dataset runs can evaluate feasibility, latency, and schema validity, but not precision/recall/F1.",
    "- Automated scores compare extracted labels against pilot reference labels using normalized partial string matching.",
    "- Extraction quality averages exclude failed API/schema calls and report failure rate separately.",
    "- Clinical handover quality, source-record match, and safety should be reviewed manually using `eval/clinical_handover_rubric.json`.",
    ""
  );

  return `${lines.join("\n")}\n`;
}

function format(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "N/A";
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((total, value) => total + value, 0) / finite.length : null;
}

function sum(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((total, value) => total + value, 0) : null;
}

function wilsonInterval(successes, total, z = 1.959963984540054) {
  if (!total) return null;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const half = z * Math.sqrt((p * (1 - p) / total) + (z * z) / (4 * total * total)) / denominator;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

function formatInterval(interval) {
  if (!Array.isArray(interval) || interval.length !== 2) return "N/A";
  return `${format(interval[0])}-${format(interval[1])}`;
}

function escapeTable(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 180);
}

function redactSensitiveText(value) {
  return String(value || "")
    .replace(/https:\/\/openrouter\.ai\/workspaces\/[^"\s]+/gi, "[redacted OpenRouter dashboard URL]")
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "[redacted OpenRouter key]")
    .replace(/"user_id"\s*:\s*"[^"]+"/gi, "\"user_id\":\"[redacted OpenRouter user id]\"")
    .replace(/user_[A-Za-z0-9_-]+/g, "[redacted OpenRouter user id]");
}

function emptyScore() {
  return {
    categories: {},
    overall: calculateMetrics(0, 0, 1)
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
