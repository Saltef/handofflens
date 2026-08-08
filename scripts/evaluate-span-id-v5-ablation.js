#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { buildSpanIndex } = require("./span-index");
const { validateSpanIdEvidenceItem } = require("./span-id-validator");
const { selectMinimalEvidence } = require("./minimal-evidence-selector");
const { toProviderCompatibleSchema } = require("./schema-utils");
const { rateSummary, countBy, mean, round } = require("./experiment-metrics");

loadEnvFile(".env");

const FROZEN_MODELS = ["cohere-aplus:command-a-plus-05-2026", "anthropic/claude-haiku-4.5"];
const DEFAULT_ARMS = ["quote_v2", "quote_v2_minimal", "span_id_v5", "span_id_v5_minimal"];
const ASSERTIONS = ["present", "absent", "uncertain", "conditional", "historical"];
const SUPPORT_STATUSES = ["supported", "insufficient_evidence", "not_found"];
const FIELDS = ["medication", "diagnosis", "procedure_or_test", "lab", "follow_up", "safety", "uncertain"];
const CAPTURE_LOGPROBS = envFlag("EVAL_CAPTURE_LOGPROBS");
const STORE_RAW_LOGPROBS = envFlag("EVAL_STORE_RAW_LOGPROBS");
const TOP_LOGPROBS = boundedInteger(process.env.EVAL_TOP_LOGPROBS, 5, 0, 20);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const casesPath = args.cases || path.join("eval", "pilot_reference_cases.json");
  const outPath = args.out || path.join("results", "span-id-v5-ablation.json");
  const mdOutPath = args.mdout || outPath.replace(/\.json$/i, ".md");
  const publicSummaryPath = args["public-summary"] || null;
  const models = splitList(args.models || FROZEN_MODELS.join(","));
  const arms = splitList(args.arms || DEFAULT_ARMS.join(","));
  const repeats = boundedInteger(args.repeats, 3, 1, 20);
  const offset = boundedInteger(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = args.limit === undefined ? undefined : boundedInteger(args.limit, 0, 0, Number.MAX_SAFE_INTEGER);
  const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"))
    .slice(offset, limit === undefined ? undefined : offset + limit);
  if (!cases.length) throw new Error("No cases selected for span-ID v5 ablation.");

  if (args.rescore) {
    const previous = JSON.parse(fs.readFileSync(args.rescore, "utf8"));
    const report = rescoreReport({ previous, casesPath, cases, models, arms, repeats });
    writeReport({ report, outPath, mdOutPath, publicSummaryPath });
    return;
  }

  if (args["dry-run"]) {
    const preview = buildAblationJob(cases[0], arms[0], models[0], 1);
    console.log(JSON.stringify({
      case_id: cases[0].case_id,
      models,
      arms,
      repeats,
      selected_cases: cases.length,
      preview: redactPreviewRequest(preview.request),
      output_schema_leaf_count: countSchemaLeaves(preview.outputSchema),
    }, null, 2));
    return;
  }

  const results = [];
  let executionIndex = 0;
  for (const testCase of cases) {
    const modelOrder = orderedModelsForCase(models, testCase.case_id);
    for (const model of modelOrder) {
      for (const providerArm of providerArmsFor(arms)) {
        for (let repeat = 1; repeat <= repeats; repeat += 1) {
          const startedAt = Date.now();
          const job = buildAblationJob(testCase, providerArm, model, repeat);
          try {
            const response = await callProvider(job);
            for (const arm of resultArmsForProviderArm(providerArm, arms)) {
              const record = scoreAblationRecord({
                execution_index: executionIndex++,
                model,
                providerArm,
                arm,
                repeat,
                testCase,
                spanIndex: job.spanIndex,
                extraction: response.extraction,
                telemetry: structuredClone(response.telemetry),
                request_started_at: new Date(startedAt).toISOString(),
                latency_ms: Date.now() - startedAt,
              });
              results.push(record);
              console.log(`${model} ${arm} r${repeat} ${testCase.case_id}: ${record.scoring.item_count} items, ${record.scoring.case_gate_passed ? "case gate pass" : "case gate fail"}`);
            }
          } catch (error) {
            for (const arm of resultArmsForProviderArm(providerArm, arms)) {
              const record = errorRecord({
                execution_index: executionIndex++,
                model,
                providerArm,
                arm,
                repeat,
                testCase,
                request_started_at: new Date(startedAt).toISOString(),
                latency_ms: Date.now() - startedAt,
                error,
              });
              results.push(record);
              console.error(`${model} ${arm} r${repeat} ${testCase.case_id}: ${record.error}`);
            }
          }
        }
      }
    }
  }

  const report = buildReport({
    casesPath,
    cases,
    models,
    arms,
    repeats,
    results,
  });

  writeReport({ report, outPath, mdOutPath, publicSummaryPath });

  if (args["fail-on-error"] && results.some((result) => result.error)) process.exitCode = 1;
}

function writeReport({ report, outPath, mdOutPath, publicSummaryPath }) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(mdOutPath, renderMarkdownReport(report));
  console.log(`Wrote ${outPath}`);
  console.log(`Wrote ${mdOutPath}`);

  if (publicSummaryPath) {
    updatePublicSummary(publicSummaryPath, report);
    console.log(`Updated ${publicSummaryPath}`);
  }
}

function rescoreReport({ previous, casesPath, cases, models, arms, repeats }) {
  const casesById = new Map(cases.map((testCase) => [testCase.case_id, testCase]));
  const rescored = previous.results.map((record, index) => {
    if (!record.success) return { ...record, execution_index: index };
    const testCase = casesById.get(record.case_id);
    if (!testCase) throw new Error(`Cannot rescore missing case: ${record.case_id}`);
    return scoreAblationRecord({
      execution_index: index,
      model: record.model,
      providerArm: record.provider_arm || baseArmFor(record.arm),
      arm: record.arm,
      repeat: record.repeat,
      testCase,
      spanIndex: buildSpanIndex(sourceForCase(testCase), { granularity: "clause" }),
      extraction: record.extraction,
      telemetry: record.telemetry || null,
      request_started_at: record.request_started_at,
      latency_ms: record.latency_ms,
    });
  });
  return buildReport({
    casesPath,
    cases,
    models: previous.models || models,
    arms: previous.arms || arms,
    repeats: previous.repeats || repeats,
    results: rescored,
  });
}

function buildAblationJob(testCase, arm, model, repeat) {
  if (!DEFAULT_ARMS.includes(arm)) throw new Error(`Unsupported ablation arm: ${arm}`);
  const sourceText = sourceForCase(testCase);
  const spanIndex = buildSpanIndex(sourceText, { granularity: "clause" });
  const outputSchema = buildOutputSchema({ arm, spanIds: spanIndex.spans.map((span) => span.id) });
  const request = buildProviderRequest({ model, testCase, spanIndex, arm, outputSchema, repeat });
  return { testCase, model, arm, repeat, spanIndex, outputSchema, request };
}

function buildOutputSchema({ arm, spanIds = [] }) {
  const spanIdSchema = {
    type: "array",
    maxItems: 3,
    uniqueItems: true,
    items: spanIds.length ? { type: "string", enum: spanIds } : { type: "string", pattern: "^S[1-9][0-9]*$" },
  };
  const baseItem = {
    type: "object",
    additionalProperties: false,
    required: ["field", "normalized_value", "assertion", "support_status"],
    properties: {
      field: { type: "string", enum: FIELDS },
      normalized_value: { type: "string", minLength: 1 },
      assertion: { type: "string", enum: ASSERTIONS },
      support_status: { type: "string", enum: SUPPORT_STATUSES },
      rationale: { type: "string" },
    },
  };

  if (arm.startsWith("quote_v2")) {
    baseItem.required.push("source_quote");
    baseItem.properties.source_quote = { type: "string" };
  } else {
    baseItem.required.push("evidence_span_ids", "entailment_scored", "entailment_score");
    baseItem.properties.evidence_span_ids = spanIdSchema;
    baseItem.properties.surface_form = {
      type: "object",
      additionalProperties: false,
      required: ["span_id", "token_start", "token_end"],
      properties: {
        span_id: spanIds.length ? { type: "string", enum: spanIds } : { type: "string", pattern: "^S[1-9][0-9]*$" },
        token_start: { type: "integer", minimum: 0 },
        token_end: { type: "integer", minimum: 1 },
      },
    };
    baseItem.properties.entailment_scored = { type: "boolean", const: false };
    baseItem.properties.entailment_score = { type: "null" };
  }

  return {
    type: "object",
    additionalProperties: false,
    required: ["case_id", "items", "abstention_reason"],
    properties: {
      case_id: { type: "string" },
      abstention_reason: { type: "string" },
      items: { type: "array", maxItems: 80, items: baseItem },
    },
  };
}

function buildProviderRequest({ model, testCase, spanIndex, arm, outputSchema, repeat }) {
  const messages = [
    { role: "system", content: systemInstruction(arm) },
    { role: "user", content: userInstruction(testCase, spanIndex, arm, repeat) },
  ];
  if (providerForModel(model) === "cohere") {
    const request = {
      model: model.replace(/^cohere-aplus:/, "").replace(/^cohere:/, ""),
      max_tokens: runtimeNumber("COHERE_MAX_TOKENS", 8000),
      temperature: runtimeNumber("COHERE_TEMPERATURE", 0),
      messages,
      response_format: {
        type: "json_object",
        schema: toCohereCompatibleSchema(outputSchema),
      },
      thinking: { token_budget: runtimeNumber("COHERE_THINKING_BUDGET", 512) },
    };
    applyLogprobRequestOptions(request, "cohere");
    return request;
  }

  const request = {
    model,
    max_tokens: runtimeNumber("OPENROUTER_MAX_TOKENS", 20000),
    temperature: runtimeNumber("OPENROUTER_TEMPERATURE", 0),
    messages,
    provider: { require_parameters: true },
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "handofflens_span_id_v5_ablation",
        strict: true,
        schema: toHostedStructuredOutputSchema(outputSchema),
      },
    },
  };
  applyLogprobRequestOptions(request, "openrouter");
  return request;
}

function toHostedStructuredOutputSchema(schema) {
  const unsupported = new Set(["maxItems", "minItems", "minLength", "maxLength", "minimum", "maximum", "pattern", "uniqueItems"]);
  const base = toProviderCompatibleSchema(schema);
  const visit = (node) => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;
    return Object.fromEntries(Object.entries(node)
      .filter(([key]) => !unsupported.has(key))
      .map(([key, value]) => [key, visit(value)]));
  };
  return visit(base);
}

function toCohereCompatibleSchema(schema) {
  return toHostedStructuredOutputSchema(schema);
}

function systemInstruction(arm) {
  const evidenceMode = arm.startsWith("span_id")
    ? "Use only evidence_span_ids from the provided span index. Do not invent span IDs. If the source does not support an item, set support_status to not_found or insufficient_evidence."
    : "For each item, include a source_quote copied from the discharge summary. If the source does not support an item, set support_status to not_found or insufficient_evidence and leave source_quote empty.";
  return [
    "You are extracting source-grounded clinical handoff facts for an auditability experiment.",
    "Return only JSON matching the schema. Do not include prose outside JSON.",
    "Extract medication changes, diagnoses, procedures/tests, labs, follow-up actions, safety flags, and uncertain items that are relevant to handoff.",
    "Prefer abstention over unsupported inference. Do not diagnose, recommend care, or add facts not present in the source.",
    "Use assertion labels: present, absent, uncertain, conditional, historical.",
    evidenceMode,
    "Entailment scoring is out of scope here: set entailment_scored to false and entailment_score to null whenever those fields exist.",
  ].join(" ");
}

function userInstruction(testCase, spanIndex, arm, repeat) {
  const metadata = {
    case_id: testCase.case_id,
    age: testCase.age || "",
    gender: testCase.gender || "",
    admission_diagnosis: testCase.admission_diagnosis || "",
    repeat,
    arm,
  };
  const sourceText = sourceForCase(testCase);
  const sourceBlock = arm.startsWith("span_id")
    ? `Span index:\n${spanIndex.render()}`
    : `Discharge summary:\n${sourceText}`;
  return [
    "Extract a concise, auditable item list from this case.",
    "Each item should contain one clinical fact or one atomic safety/follow-up instruction.",
    "Do not output a general summary.",
    "",
    `Case metadata:\n${JSON.stringify(metadata, null, 2)}`,
    "",
    sourceBlock,
  ].join("\n");
}

async function callProvider(job) {
  if (providerForModel(job.model) === "cohere") return callCohere(job);
  return callOpenRouter(job);
}

async function callCohere(job) {
  const apiKey = process.env.COHERE_API_KEY;
  if (!apiKey) throw new Error("Missing COHERE_API_KEY");
  const timeoutMs = Number(process.env.COHERE_TIMEOUT_MS || 120000);
  const requestBody = providerRequestBody(job.request);
  const response = await withTimeout(fetch("https://api.cohere.com/v2/chat", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  }), timeoutMs, `Cohere request timed out after ${timeoutMs} ms`);
  const body = await safeJson(response);
  if (!response.ok) throw new Error(`Cohere API error ${response.status}: ${JSON.stringify(redactProviderBody(body))}`);
  return {
    extraction: parseJsonFromText(cohereMessageText(body)),
    telemetry: providerTelemetry({ provider: "cohere", body, response, request: job.request, rawLogprobs: body.logprobs || null }),
  };
}

async function callOpenRouter(job) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");
  const timeoutMs = Number(process.env.OPENROUTER_TIMEOUT_MS || 120000);
  const requestBody = providerRequestBody(job.request);
  const response = await withTimeout(fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-OpenRouter-Metadata": "enabled",
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://github.com",
      "X-Title": process.env.OPENROUTER_APP_NAME || "HandoffLens Span-ID v5 Ablation",
    },
    body: JSON.stringify(requestBody),
  }), timeoutMs, `OpenRouter request timed out after ${timeoutMs} ms`);
  const body = await safeJson(response);
  if (!response.ok) throw new Error(`OpenRouter API error ${response.status}: ${JSON.stringify(redactProviderBody(body))}`);
  const message = body.choices?.[0]?.message;
  const content = message?.content;
  return {
    extraction: typeof content === "string" ? parseJsonFromText(content) : content,
    telemetry: providerTelemetry({ provider: "openrouter", body, response, request: job.request, rawLogprobs: body.choices?.[0]?.logprobs || message?.logprobs || null }),
  };
}

function providerRequestBody(request) {
  const cloned = structuredClone(request);
  delete cloned.__logprob_policy;
  return cloned;
}

function scoreAblationRecord({ execution_index, model, providerArm, arm, repeat, testCase, spanIndex, extraction, telemetry, request_started_at, latency_ms }) {
  const items = normalizeItems(extraction?.items);
  const scoredItems = items.map((item, itemIndex) => scoreItem({ item, itemIndex, arm, sourceText: sourceForCase(testCase), spanIndex }));
  const scoring = summarizeScoredItems(scoredItems, arm);
  return {
    execution_index,
    provider: providerForModel(model),
    model,
    provider_arm: providerArm || baseArmFor(arm),
    arm,
    repeat,
    case_id: testCase.case_id,
    source_hash: sha256(sourceForCase(testCase)),
    request_started_at,
    request_completed_at: new Date().toISOString(),
    latency_ms,
    success: true,
    span_index: {
      granularity: spanIndex.granularity,
      span_count: spanIndex.spans.length,
      source_word_count: wordCount(sourceForCase(testCase)),
    },
    telemetry,
    extraction: {
      case_id: extraction?.case_id || "",
      abstention_reason: extraction?.abstention_reason || "",
      items,
    },
    scoring,
  };
}

function scoreItem({ item, itemIndex, arm, sourceText, spanIndex }) {
  const base = {
    item_index: itemIndex,
    field: item.field || "",
    normalized_value: item.normalized_value || "",
    assertion: item.assertion || "",
    support_status: item.support_status || "",
    entailment_scored: Boolean(item.entailment_scored),
    entailment_score: null,
  };
  if (arm.startsWith("quote_v2")) {
    const sourceQuote = String(item.source_quote || "");
    const exact = Boolean(sourceQuote.trim() && normalizeExact(sourceText).includes(normalizeExact(sourceQuote)));
    const selector = arm.endsWith("_minimal") ? selectMinimalEvidence(sourceText, {
      label: item.normalized_value || item.field || "",
      source_quote: sourceQuote || item.normalized_value || "",
      assertion: item.assertion || "present",
      domain: item.field || "unknown",
    }) : null;
    return {
      ...base,
      source_quote_present: Boolean(sourceQuote.trim()),
      exact_quote_supported: exact,
      span_valid: null,
      selector_status: selector?.support_status || null,
      selector_span_ids: selector?.evidence_span_ids || [],
      selected_context_words: selector ? selector.selected_context_words : null,
      supported: arm.endsWith("_minimal") ? selector.support_status === "supported" : exact,
      support_basis: arm.endsWith("_minimal") ? "minimal_selector" : "exact_source_quote",
    };
  }

  const validation = validateSpanIdEvidenceItem({
    ...item,
    entailment_scored: false,
    entailment_score: null,
  }, spanIndex);
  const resolution = spanIdResolution(item, spanIndex);
  const countValidity = evidenceSpanCountValidity(item);
  const provenanceValid = resolution.valid && countValidity.valid;
  const spanText = spanTexts(item.evidence_span_ids || [], spanIndex).join(" ");
  const selector = arm.endsWith("_minimal") && item.support_status === "supported" ? selectMinimalEvidence(sourceText, {
    label: item.normalized_value || item.field || "",
    source_quote: spanText || item.normalized_value || "",
    assertion: item.assertion || "present",
    domain: item.field || "unknown",
  }, { spanIndex }) : null;
  return {
    ...base,
    evidence_span_ids: Array.isArray(item.evidence_span_ids) ? item.evidence_span_ids : [],
    span_valid: resolution.valid,
    v5_contract_valid: validation.valid,
    evidence_span_count_valid: countValidity.valid,
    validation_errors: validation.errors.map((error) => error.code),
    span_resolution_errors: resolution.errors,
    span_count_errors: countValidity.errors,
    selector_status: selector?.support_status || null,
    selector_span_ids: selector?.evidence_span_ids || [],
    selected_context_words: selector ? selector.selected_context_words : contextWordsForSpanIds(item.evidence_span_ids || [], spanIndex),
    supported: arm.endsWith("_minimal")
      ? selector?.support_status === "supported"
      : provenanceValid && item.support_status === "supported",
    support_basis: arm.endsWith("_minimal") ? "span_id_plus_minimal_selector" : "span_id_schema_validation",
  };
}

function spanIdResolution(item, spanIndex) {
  const byId = spanIndex.byId instanceof Map ? spanIndex.byId : new Map(spanIndex.spans.map((span) => [span.id, span]));
  const errors = [];
  if (!Array.isArray(item.evidence_span_ids)) errors.push("span_ids_not_array");
  else for (const spanId of item.evidence_span_ids) if (!byId.has(spanId)) errors.push("unknown_span_id");
  if (item.surface_form?.span_id && !byId.has(item.surface_form.span_id)) errors.push("unknown_surface_span_id");
  return { valid: errors.length === 0, errors };
}

function evidenceSpanCountValidity(item) {
  const errors = [];
  const spanIds = Array.isArray(item.evidence_span_ids) ? item.evidence_span_ids : [];
  if (item.support_status === "supported" && spanIds.length < 1) errors.push("empty_supported_span_ids");
  if (spanIds.length > 3) errors.push("too_many_span_ids");
  return { valid: errors.length === 0, errors };
}

function summarizeScoredItems(scoredItems, arm) {
  const completed = scoredItems.length > 0;
  const supported = scoredItems.filter((item) => item.supported);
  const supportedOrAbstained = scoredItems.filter((item) => item.supported || ["not_found", "insufficient_evidence"].includes(item.support_status));
  const spanValidItems = scoredItems.filter((item) => item.span_valid === true);
  const contractValidItems = scoredItems.filter((item) => item.v5_contract_valid === true);
  const spanCountValidItems = scoredItems.filter((item) => item.evidence_span_count_valid === true);
  const exactQuoteItems = scoredItems.filter((item) => item.exact_quote_supported === true);
  const selectorSupported = scoredItems.filter((item) => item.selector_status === "supported");
  return {
    item_count: scoredItems.length,
    completed,
    case_gate_passed: completed && supported.length === scoredItems.length,
    auditable_or_abstained_case_gate_passed: completed && supportedOrAbstained.length === scoredItems.length,
    item_support_rate: rateSummary(supported.length, scoredItems.length),
    exact_quote_support_rate: arm.startsWith("quote_v2") ? rateSummary(exactQuoteItems.length, scoredItems.length) : null,
    span_validity_rate: arm.startsWith("span_id") ? rateSummary(spanValidItems.length, scoredItems.length) : null,
    v5_contract_validity_rate: arm.startsWith("span_id") ? rateSummary(contractValidItems.length, scoredItems.length) : null,
    evidence_span_count_validity_rate: arm.startsWith("span_id") ? rateSummary(spanCountValidItems.length, scoredItems.length) : null,
    selector_support_rate: arm.endsWith("_minimal") ? rateSummary(selectorSupported.length, scoredItems.length) : null,
    support_status_counts: countBy(scoredItems.map((item) => item.support_status || "missing")),
    validation_error_counts: countBy(scoredItems.flatMap((item) => item.validation_errors || [])),
    span_resolution_error_counts: countBy(scoredItems.flatMap((item) => item.span_resolution_errors || [])),
    span_count_error_counts: countBy(scoredItems.flatMap((item) => item.span_count_errors || [])),
    mean_selected_context_words: round(mean(scoredItems.map((item) => item.selected_context_words).filter(Number.isFinite))),
    scored_items: scoredItems,
  };
}

function buildReport({ casesPath, cases, models, arms, repeats, results }) {
  return {
    generated_at: new Date().toISOString(),
    experiment_id: "span-id-v5-cross-provider-ablation",
    cases_path: casesPath,
    cases_sha256: sha256(fs.readFileSync(casesPath)),
    cases: cases.map((testCase) => testCase.case_id),
    models,
    arms,
    repeats,
    routes: { primary: "json_schema", tool_routes: "not rerun in this span-ID-only ablation harness" },
    telemetry_policy: {
      capture_logprobs: CAPTURE_LOGPROBS,
      store_raw_logprobs: STORE_RAW_LOGPROBS,
      top_logprobs: CAPTURE_LOGPROBS ? TOP_LOGPROBS : null,
      raw_logits_available_from_hosted_chat_api: false,
      provider_logprob_policy: {
        cohere: CAPTURE_LOGPROBS && shouldCaptureLogprobs("cohere") ? "requested" : "not_sent",
        openrouter: CAPTURE_LOGPROBS && shouldCaptureLogprobs("openrouter")
          ? "requested"
          : "not_sent_by_default; structured-output Haiku route rejected logprobs in smoke testing",
      },
      field_level_logprobs: "exploratory_only; marked unavailable unless provider returns token offsets that can be mapped to evidence_span_ids",
    },
    claims_boundary: "Automated auditability evidence only; span-ID validity is by construction and does not prove semantic entailment, clinical correctness, safety, or completeness.",
    summary: summarizeAblation(results),
    results,
  };
}

function summarizeAblation(results) {
  const groups = {};
  for (const record of results) {
    const key = `${record.model}||${record.arm}`;
    groups[key] ||= [];
    groups[key].push(record);
  }
  return Object.fromEntries(Object.entries(groups).map(([key, records]) => {
    const [model, arm] = key.split("||");
    const successes = records.filter((record) => record.success);
    const itemCount = sum(successes.map((record) => record.scoring.item_count));
    const supportedItems = sum(successes.map((record) => record.scoring.item_support_rate.numerator));
    const exactQuoteItems = sum(successes.map((record) => record.scoring.exact_quote_support_rate?.numerator || 0));
    const spanValidItems = sum(successes.map((record) => record.scoring.span_validity_rate?.numerator || 0));
    const contractValidItems = sum(successes.map((record) => record.scoring.v5_contract_validity_rate?.numerator || 0));
    const spanCountValidItems = sum(successes.map((record) => record.scoring.evidence_span_count_validity_rate?.numerator || 0));
    const selectorSupportedItems = sum(successes.map((record) => record.scoring.selector_support_rate?.numerator || 0));
    const caseGatePasses = successes.filter((record) => record.scoring.case_gate_passed).length;
    return [key, {
      model,
      arm,
      runs: records.length,
      successful_runs: successes.length,
      completion_rate: rateSummary(successes.length, records.length),
      item_count: itemCount,
      item_support_rate: rateSummary(supportedItems, itemCount),
      case_gate_rate: rateSummary(caseGatePasses, successes.length),
      exact_quote_support_rate: arm.startsWith("quote_v2") ? rateSummary(exactQuoteItems, itemCount) : null,
      span_validity_rate: arm.startsWith("span_id") ? rateSummary(spanValidItems, itemCount) : null,
      v5_contract_validity_rate: arm.startsWith("span_id") ? rateSummary(contractValidItems, itemCount) : null,
      evidence_span_count_validity_rate: arm.startsWith("span_id") ? rateSummary(spanCountValidItems, itemCount) : null,
      selector_support_rate: arm.endsWith("_minimal") ? rateSummary(selectorSupportedItems, itemCount) : null,
      mean_items_per_successful_run: round(mean(successes.map((record) => record.scoring.item_count))),
      mean_selected_context_words: round(mean(successes.map((record) => record.scoring.mean_selected_context_words).filter(Number.isFinite))),
      support_status_counts: countBy(successes.flatMap((record) => Object.entries(record.scoring.support_status_counts).flatMap(([name, count]) => Array(count).fill(name)))),
      validation_error_counts: countBy(successes.flatMap((record) => Object.entries(record.scoring.validation_error_counts).flatMap(([name, count]) => Array(count).fill(name)))),
      span_resolution_error_counts: countBy(successes.flatMap((record) => Object.entries(record.scoring.span_resolution_error_counts || {}).flatMap(([name, count]) => Array(count).fill(name)))),
      span_count_error_counts: countBy(successes.flatMap((record) => Object.entries(record.scoring.span_count_error_counts || {}).flatMap(([name, count]) => Array(count).fill(name)))),
      repeat_spread: summarizeRepeats(successes),
      error_counts: countBy(records.filter((record) => record.error).map((record) => record.error_category || "error")),
    }];
  }).sort(([left], [right]) => left.localeCompare(right)));
}

function summarizeRepeats(records) {
  const byRepeat = {};
  for (const record of records) {
    byRepeat[record.repeat] ||= [];
    byRepeat[record.repeat].push(record);
  }
  return Object.fromEntries(Object.entries(byRepeat).map(([repeat, items]) => {
    const itemCount = sum(items.map((record) => record.scoring.item_count));
    const supported = sum(items.map((record) => record.scoring.item_support_rate.numerator));
    return [repeat, {
      successful_runs: items.length,
      item_count: itemCount,
      item_support_rate: rateSummary(supported, itemCount),
      case_gate_rate: rateSummary(items.filter((record) => record.scoring.case_gate_passed).length, items.length),
    }];
  }));
}

function updatePublicSummary(publicSummaryPath, report) {
  const publicSummary = JSON.parse(fs.readFileSync(publicSummaryPath, "utf8"));
  publicSummary.schema_ablation = {
    status: report.results.some((record) => record.error)
      ? "cross_provider_span_id_v5_ablation_completed_with_provider_errors"
      : "cross_provider_span_id_v5_ablation_completed",
    span_id_schema: "eval/schema_evidence_span_id_v5.json",
    span_index: {
      script: "scripts/span-index.js",
      default_granularity: "clause",
      supported_granularities: ["sentence", "line", "clause"],
      deterministic_ids: "S1..Sn in document order",
      offset_policy: "char_start/char_end must slice exactly to span.text",
    },
    span_id_validator: {
      script: "scripts/span-id-validator.js",
      max_supported_evidence_span_ids: 3,
      invalid_id_policy: "retry up to two times, then route to support_status not_found rather than accepting an unresolved pointer",
    },
    minimal_selector: {
      script: "scripts/minimal-evidence-selector.js",
      policy: "greedy set cover over claim tokens with adaptive stopping and budget-normalized label-risk checks",
      phase0_dependency: "built after guard calibration showed the fixed-budget cliff was a guard-threshold artifact",
    },
    completed_ablation_work: "Ran quote-v2 and span-ID-v5 arms across both frozen providers with three repeats per cell; case-level outputs and raw provider traces remain private.",
    remaining_schema_work: "Test a retry/repair loop for max-3 evidence-span cap violations, then compare lexical matching with learned reranking and entailment-backed faithfulness.",
    experiment_id: report.experiment_id,
    private_case_level_outputs_committed: false,
    cases: report.cases.length,
    models: report.models,
    arms: report.arms,
    repeats: report.repeats,
    routes: report.routes,
    telemetry_policy: report.telemetry_policy,
    claims_boundary: report.claims_boundary,
    aggregate_results: summarizeForPublic(report.summary),
    interpretation: "The v5 span-ID arm tests whether provenance can be made a constrained selection over a pre-enumerated source index. Resolvable span-ID validity is expected by construction when provider-side enums are honored and should not be read as semantic factuality. Full v5 contract validity is stricter because hosted providers did not enforce the max-3 span cap or optional token offsets; those violations remain local validation failures.",
  };
  fs.writeFileSync(publicSummaryPath, `${JSON.stringify(publicSummary, null, 2)}\n`);
}

function summarizeForPublic(summary) {
  return Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, {
    model: value.model,
    arm: value.arm,
    runs: value.runs,
    successful_runs: value.successful_runs,
    completion_rate: value.completion_rate,
    item_count: value.item_count,
    item_support_rate: value.item_support_rate,
    case_gate_rate: value.case_gate_rate,
    exact_quote_support_rate: value.exact_quote_support_rate,
    span_validity_rate: value.span_validity_rate,
    v5_contract_validity_rate: value.v5_contract_validity_rate,
    evidence_span_count_validity_rate: value.evidence_span_count_validity_rate,
    selector_support_rate: value.selector_support_rate,
    mean_items_per_successful_run: value.mean_items_per_successful_run,
    mean_selected_context_words: value.mean_selected_context_words,
    repeat_spread: value.repeat_spread,
    span_resolution_error_counts: value.span_resolution_error_counts,
    span_count_error_counts: value.span_count_error_counts,
    error_counts: value.error_counts,
  }]));
}

function renderMarkdownReport(report) {
  const lines = [
    "# Span-ID v5 Cross-Provider Ablation",
    "",
    `Generated: ${report.generated_at}`,
    "",
    "This private report contains aggregate and case-level model outputs. Do not publish raw records. The public repo may contain only aggregate summary fields.",
    "",
    "Resolvable span-ID validity is by construction when provider-side enums are honored. Full v5 contract validity is stricter and includes local cap/offset checks. Neither is semantic entailment or clinical correctness.",
    "",
    "| Model | Arm | Runs | Completion | Items | Item support | Case gate | Exact quote | Span-ID resolves | V5 contract | Selector support |",
    "| --- | --- | ---: | --- | ---: | --- | --- | --- | --- | --- | --- |",
  ];
  for (const value of Object.values(report.summary)) {
    lines.push([
      value.model,
      value.arm,
      value.runs,
      formatRate(value.completion_rate),
      value.item_count,
      formatRate(value.item_support_rate),
      formatRate(value.case_gate_rate),
      value.exact_quote_support_rate ? formatRate(value.exact_quote_support_rate) : "N/A",
      value.span_validity_rate ? formatRate(value.span_validity_rate) : "N/A",
      value.v5_contract_validity_rate ? formatRate(value.v5_contract_validity_rate) : "N/A",
      value.selector_support_rate ? formatRate(value.selector_support_rate) : "N/A",
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  lines.push("");
  lines.push("## Telemetry");
  lines.push("");
  lines.push(`Raw logits available from hosted chat API: ${report.telemetry_policy.raw_logits_available_from_hosted_chat_api}`);
  lines.push(`Logprobs requested: ${report.telemetry_policy.capture_logprobs}`);
  lines.push(`Raw logprobs stored: ${report.telemetry_policy.store_raw_logprobs}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function errorRecord({ execution_index, model, arm, repeat, testCase, request_started_at, latency_ms, error }) {
  return {
    execution_index,
    provider: providerForModel(model),
    model,
    provider_arm: baseArmFor(arm),
    arm,
    repeat,
    case_id: testCase.case_id,
    source_hash: sha256(sourceForCase(testCase)),
    request_started_at,
    request_completed_at: new Date().toISOString(),
    latency_ms,
    success: false,
    error: redactSensitiveText(error.message || error),
    error_category: categorizeError(error),
  };
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      ...item,
      field: String(item.field || "uncertain"),
      normalized_value: String(item.normalized_value || item.label || ""),
      assertion: ASSERTIONS.includes(item.assertion) ? item.assertion : "uncertain",
      support_status: SUPPORT_STATUSES.includes(item.support_status) ? item.support_status : "insufficient_evidence",
    }));
}

function providerTelemetry({ provider, body, response, request, rawLogprobs }) {
  return {
    provider_request_id: body?.id || response.headers.get("x-request-id") || null,
    returned_model: body?.model || body?.choices?.[0]?.model || request.model,
    finish_reason: provider === "openrouter" ? body?.choices?.[0]?.finish_reason || null : body?.finish_reason || body?.message?.finish_reason || null,
    usage: normalizeUsage(body?.usage),
    request_hash: sha256(JSON.stringify(request)),
    request_parameters: requestParameters(request),
    logprobs: normalizeLogprobTelemetry(rawLogprobs, request),
  };
}

function normalizeLogprobTelemetry(rawLogprobs, requestBody) {
  const policy = requestBody.__logprob_policy || { requested: CAPTURE_LOGPROBS, sent: CAPTURE_LOGPROBS, top_logprobs_requested: TOP_LOGPROBS };
  if (!rawLogprobs) {
    return {
      requested: policy.requested,
      sent_to_provider: Boolean(policy.sent),
      returned: false,
      raw_stored: false,
      skipped_reason: policy.skipped_reason || null,
      raw_logits_available_from_hosted_chat_api: false,
      field_level_logprobs_available: false,
      note: policy.skipped_reason || (policy.requested ? "Provider response did not include log probabilities." : "Log probability capture was not requested."),
    };
  }
  const tokenCount = Array.isArray(rawLogprobs)
    ? rawLogprobs.length
    : Array.isArray(rawLogprobs.content) ? rawLogprobs.content.length : null;
  return {
    requested: policy.requested,
    sent_to_provider: Boolean(policy.sent),
    returned: true,
    raw_stored: STORE_RAW_LOGPROBS,
    top_logprobs_requested: policy.top_logprobs_requested,
    token_count: tokenCount,
    raw_logits_available_from_hosted_chat_api: false,
    field_level_logprobs_available: false,
    field_level_note: "No provider token offsets were available for reliable evidence_span_ids field extraction.",
    raw: STORE_RAW_LOGPROBS ? rawLogprobs : undefined,
  };
}

function applyLogprobRequestOptions(requestBody, provider) {
  const providerCapture = shouldCaptureLogprobs(provider);
  if (!CAPTURE_LOGPROBS || !providerCapture) {
    requestBody.__logprob_policy = {
      requested: CAPTURE_LOGPROBS,
      sent: false,
      top_logprobs_requested: null,
      skipped_reason: CAPTURE_LOGPROBS && !providerCapture
        ? `${provider} structured-output route did not support logprobs in smoke testing.`
        : null,
    };
    return;
  }
  requestBody.logprobs = true;
  if (provider === "openrouter" && TOP_LOGPROBS > 0) requestBody.top_logprobs = TOP_LOGPROBS;
  requestBody.__logprob_policy = { requested: true, sent: true, top_logprobs_requested: provider === "openrouter" ? TOP_LOGPROBS : null };
}

function shouldCaptureLogprobs(provider) {
  if (provider === "openrouter") return envFlag("OPENROUTER_CAPTURE_LOGPROBS");
  if (provider === "cohere" && process.env.COHERE_CAPTURE_LOGPROBS !== undefined) return envFlag("COHERE_CAPTURE_LOGPROBS");
  return true;
}

function requestParameters(requestBody) {
  const out = {};
  for (const key of ["model", "max_tokens", "temperature", "thinking", "response_format", "provider", "logprobs", "top_logprobs"]) {
    if (requestBody[key] !== undefined) out[key] = summarizeRequestValue(requestBody[key]);
  }
  return out;
}

function summarizeRequestValue(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (value.type) return { type: value.type, schema_present: Boolean(value.schema || value.json_schema) };
  if (value.token_budget !== undefined) return { token_budget: value.token_budget };
  return { type: "object", keys: Object.keys(value).sort() };
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? usage.tokens?.input_tokens ?? usage.billed_units?.input_tokens ?? null;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? usage.tokens?.output_tokens ?? usage.billed_units?.output_tokens ?? null;
  const totalTokens = usage.total_tokens ?? (Number.isFinite(Number(inputTokens)) && Number.isFinite(Number(outputTokens)) ? Number(inputTokens) + Number(outputTokens) : null);
  return {
    input_tokens: numberOrNull(inputTokens),
    output_tokens: numberOrNull(outputTokens),
    total_tokens: numberOrNull(totalTokens),
    billed_input_tokens: numberOrNull(usage.billed_units?.input_tokens),
    billed_output_tokens: numberOrNull(usage.billed_units?.output_tokens),
    provider_reported_cost_usd: numberOrNull(usage.cost),
    raw: usage,
  };
}

function providerForModel(model) {
  return String(model).startsWith("cohere") ? "cohere" : "openrouter";
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

function sourceForCase(testCase) {
  return String(testCase.discharge_summary || testCase.source_text || testCase.source || testCase.case?.discharge_summary || "");
}

function spanTexts(spanIds, spanIndex) {
  const byId = spanIndex.byId instanceof Map ? spanIndex.byId : new Map(spanIndex.spans.map((span) => [span.id, span]));
  return spanIds.map((spanId) => byId.get(spanId)?.text || "").filter(Boolean);
}

function contextWordsForSpanIds(spanIds, spanIndex) {
  return wordCount(spanTexts(spanIds, spanIndex).join(" "));
}

function normalizeExact(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function wordCount(value) {
  return String(value || "").normalize("NFKC").replace(/[^A-Za-z0-9.]+/g, " ").trim().split(/\s+/).filter(Boolean).length;
}

function cohereMessageText(body) {
  const content = body?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part?.text || "").join("").trim();
  return "";
}

function parseJsonFromText(text) {
  const trimmed = typeof text === "string" ? text.trim() : JSON.stringify(text || "");
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

async function safeJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw_text: text.slice(0, 2000) };
  }
}

function redactPreviewRequest(request) {
  return {
    ...request,
    messages: request.messages.map((message) => ({
      ...message,
      content: message.content.length > 1200 ? `${message.content.slice(0, 1200)}\n...[truncated for dry-run preview]` : message.content,
    })),
  };
}

function redactProviderBody(body) {
  if (!body || typeof body !== "object") return body;
  return JSON.parse(redactSensitiveText(JSON.stringify(body)));
}

function redactSensitiveText(value) {
  return String(value || "")
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "[redacted OpenRouter key]")
    .replace(/\b[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, "[redacted token]")
    .replace(/"user_id"\s*:\s*"[^"]+"/gi, "\"user_id\":\"[redacted OpenRouter user id]\"");
}

function categorizeError(error) {
  const text = String(error?.message || error || "");
  if (/missing .*api_key/i.test(text)) return "missing_api_key";
  if (/\b401\b|\b403\b|auth|unauthor/i.test(text)) return "auth_error";
  if (/\b429\b|rate limit/i.test(text)) return "rate_limit";
  if (/timed out|fetch failed|network|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(text)) return "network_or_timeout";
  if (/JSON|schema|parse/i.test(text)) return "schema_or_parse";
  return "provider_or_runtime";
}

function withTimeout(promise, timeoutMs, message) {
  let timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timeout)),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
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
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function splitList(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function baseArmFor(arm) {
  if (arm === "quote_v2_minimal") return "quote_v2";
  if (arm === "span_id_v5_minimal") return "span_id_v5";
  return arm;
}

function providerArmsFor(arms) {
  return [...new Set(arms.map(baseArmFor))];
}

function resultArmsForProviderArm(providerArm, arms) {
  return arms.filter((arm) => baseArmFor(arm) === providerArm);
}

function boundedInteger(value, fallback, min, max) {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Invalid integer ${value}; expected ${min}-${max}`);
  return number;
}

function runtimeNumber(name, frozenValue) {
  if (process.env[name] === undefined || process.env[name] === "") return frozenValue;
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) throw new Error(`Invalid numeric environment value for ${name}`);
  return value;
}

function envFlag(name) {
  return /^(1|true|yes)$/i.test(String(process.env[name] || ""));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sum(values) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}

function numberOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function formatRate(summary) {
  if (!summary || summary.rate === null) return "N/A";
  return `${summary.numerator}/${summary.denominator}, ${(summary.rate * 100).toFixed(1)}% [${(summary.wilson_95[0] * 100).toFixed(1)}, ${(summary.wilson_95[1] * 100).toFixed(1)}]`;
}

function countSchemaLeaves(schema) {
  let count = 0;
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "object") Object.values(node.properties || {}).forEach(visit);
    else if (node.type === "array") visit(node.items);
    else count += 1;
  };
  visit(schema);
  return count;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(redactSensitiveText(error.stack || error.message));
    process.exitCode = 1;
  });
}

module.exports = {
  buildOutputSchema,
  buildAblationJob,
  toCohereCompatibleSchema,
  scoreAblationRecord,
  summarizeAblation,
  updatePublicSummary,
};
