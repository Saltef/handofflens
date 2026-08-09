#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { toProviderCompatibleSchema, schemaLeafPaths } = require("./schema-utils");

const checks = [];

function check(name, condition, detail = "") {
  checks.push({ name, ok: Boolean(condition), detail });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function stableTextDigest(filePath) {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  return crypto.createHash("sha256").update(text).digest("hex");
}

const requiredFiles = [
  ".env.example",
  ".gitignore",
  ".dockerignore",
  ".github/pull_request_template.md",
  ".github/workflows/check.yml",
  "Dockerfile",
  "docker-compose.yml",
  "README.md",
  "MODEL_CARD.md",
  "prompts/system.md",
  "prompts/clinical-extraction.md",
  "eval/schema.json",
  "eval/pricing_snapshot.example.json",
  "eval/experiment_manifest.json",
  "eval/safety_ablation_manifest.json",
  "eval/pilot_reference_cases.json",
  "eval/clinical_handover_rubric.json",
  "eval/human_ai_collaboration_review.json",
  "eval/probabilistic_boundary_review.json",
  "eval/manual_boundary_review_template.csv",
  "eval/atomic_clinician_review_schema.json",
  "eval/source_fidelity_review_schema.json",
  "review.html",
  "review.css",
  "review.js",
  "scripts/evaluate-models.js",
  "scripts/evaluate-span-id-v5-ablation.js",
  "scripts/validate-model-evidence.js",
  "scripts/check-syntax.js",
  "scripts/schema-utils.js",
  "scripts/judge-handoffs.js",
  "scripts/run-batches.js",
  "scripts/summarize-batches.js",
  "scripts/analyze-routing.js",
  "scripts/prepare-atomic-clinician-review.js",
  "scripts/select-confirmatory-cohort.js",
  "scripts/cluster-near-duplicates.js",
  "scripts/apply-cost-snapshot.js",
  "scripts/preflight-experiment.js",
  "scripts/run-safety-ablation.js",
  "scripts/run-recovery-ablation.js",
  "scripts/plan-clinical-sample-size.js",
  "scripts/judge-atomic-reviews.js",
  "scripts/analyze-atomic-clinician-review.js",
  "scripts/validate-judge-against-clinicians.js",
  "scripts/serve-review.js",
  "docs/claims-register.md",
  "docs/benchmark-adapter-scoring.md",
  "docs/public-benchmark-results-2026-07-21.md",
  "docs/records-adapter-contract.md",
  "eval/benchmark_manifest.example.json",
  "eval/aci_bench_adapter_fixture.json",
  "profiles/discharge-summary.json",
  "profiles/clinical-dialogue.json",
  "scripts/profile-config.js",
  "scripts/adapt-aci-bench.js",
  "scripts/score-aci-note-generation.js",
  "scripts/score-aci-note-factuality.js",
  "scripts/generate-aci-note-baselines.js",
  "scripts/evaluate-aci-note-baselines.js",
  "scripts/evaluate-aci-note-cohere.js",
  "scripts/repair-aci-note-attribution.js",
  "scripts/score-benchmark-records.js",
  "scripts/derive-reference-gold.js",
  "scripts/predict-benchmark-candidates.js",
  "scripts/evaluate-bioscope-assertions.js",
  "scripts/evaluate-bioscope-conformal.js",
  "scripts/evaluate-bioscope-baselines.js",
  "scripts/test-benchmark-adapter-scoring.js",
  "scripts/validate-benchmark-manifest.js"
];

for (const filePath of requiredFiles) {
  check(`Required file: ${filePath}`, fs.existsSync(filePath));
}

const schema = readJson(path.join("eval", "schema.json"));
const providerSchema = toProviderCompatibleSchema(schema);
const cases = readJson(path.join("eval", "pilot_reference_cases.json"));
const handoverRubric = readJson(path.join("eval", "clinical_handover_rubric.json"));
const collaborationRubric = readJson(path.join("eval", "human_ai_collaboration_review.json"));
const boundaryRubric = readJson(path.join("eval", "probabilistic_boundary_review.json"));
const atomicReviewSchema = readJson(path.join("eval", "atomic_clinician_review_schema.json"));
const sourceFidelitySchema = readJson(path.join("eval", "source_fidelity_review_schema.json"));
const manifest = readJson(path.join("eval", "experiment_manifest.json"));
const ablationManifest = readJson(path.join("eval", "safety_ablation_manifest.json"));
const systemPrompt = readText(path.join("prompts", "system.md"));
const extractionPrompt = readText(path.join("prompts", "clinical-extraction.md"));
const claimsRegister = readText(path.join("docs", "claims-register.md"));
const evaluatorSource = readText(path.join("scripts", "evaluate-models.js"));
const modelEvidenceValidatorSource = readText(path.join("scripts", "validate-model-evidence.js"));
const judgeSource = readText(path.join("scripts", "judge-handoffs.js"));
const samplerSource = readText(path.join("scripts", "select-representative-sample.js"));
const confirmatorySamplerSource = readText(path.join("scripts", "select-confirmatory-cohort.js"));
const duplicateClusterSource = readText(path.join("scripts", "cluster-near-duplicates.js"));
const envExample = readText(".env.example");
const gitignore = readText(".gitignore");
const dockerignore = readText(".dockerignore");
const ciWorkflow = readText(path.join(".github", "workflows", "check.yml"));
const prTemplate = readText(path.join(".github", "pull_request_template.md"));
const packageJson = readJson("package.json");
const spanIdV5Schema = readJson(path.join("eval", "schema_evidence_span_id_v5.json"));
const spanIdV5AblationSource = readText(path.join("scripts", "evaluate-span-id-v5-ablation.js"));
const publicResultsSummary = readJson(path.join("eval", "public_results_summary.json"));

check("Schema root is object", schema.type === "object");
check("Schema forbids root extra keys", schema.additionalProperties === false);
check("Schema requires two_page_summary", schema.required.includes("two_page_summary"));
check("Schema requires source_quote on evidence items", schema.$defs?.evidenceItem?.required?.includes("source_quote"));
check("Schema has medication change buckets", ["started", "stopped", "changed", "continued", "uncertain"].every((key) => schema.properties.medication_changes.required.includes(key)));
check("Provider schema derives from canonical schema without unsupported references", !JSON.stringify(providerSchema).includes("$ref") && !("$defs" in providerSchema));
const providerLeafPaths = schemaLeafPaths(providerSchema);
check("Provider schema preserves all canonical leaf fields and types", providerLeafPaths.length === 56 && [
  "case_id:string",
  "medication_changes.started[].source_quote:string",
  "diagnosis_changes.new_or_changed[].label:string",
  "follow_up_actions[].source_quote:string",
  "safety_flags[].label:string",
  "safety_flags[].safety_type:string",
  "handoff_atoms[].atom_id:string",
  "handoff_atoms[].derived_views[]:string",
  "handoff_atoms[].time_window:string",
  "two_page_summary:string"
].every((item) => providerLeafPaths.includes(item)));
check("Evaluator imports the canonical schema adapter", evaluatorSource.includes("require(\"./schema-utils\")") && evaluatorSource.includes("toProviderCompatibleSchema(schema)"));
check("Atomic review separates factual and relationship support", ["factual_support", "relationship_support"].every((key) => atomicReviewSchema.properties.claim_reviews.items.required.includes(key)));
check("Atomic review includes omission and severity labels", atomicReviewSchema.required.includes("omissions") && JSON.stringify(atomicReviewSchema).includes("potentially_harmful"));
check("Source-fidelity review separates factual and relationship support", ["factual_support", "relationship_support", "error_scope"].every((key) => sourceFidelitySchema.properties.claim_reviews.items.required.includes(key)));
check("Source-fidelity review excludes clinical severity and safety", !/potentially_harmful|handover_safety|disposition/.test(JSON.stringify(sourceFidelitySchema)));

const referenceCategories = new Set(cases.flatMap((testCase) => Object.keys(testCase.gold || {})));
const expectedCategories = [
  "medication_changes.started",
  "medication_changes.changed",
  "medication_changes.stopped",
  "diagnosis_changes.new_or_changed",
  "procedures_and_tests",
  "labs",
  "follow_up_actions",
  "safety_flags"
];
check("Pilot reference cases include expected scoring categories", expectedCategories.every((category) => referenceCategories.has(category)), [...referenceCategories].join(", "));
check("Pilot reference cases have discharge summaries", cases.every((testCase) => testCase.discharge_summary && testCase.discharge_summary.length > 200));
check("At least two pilot reference cases exist", cases.length >= 2, `cases=${cases.length}`);
check("Public pilot cases are explicitly synthetic", cases.every((testCase) => testCase.synthetic === true && /^SYNTH_/.test(testCase.case_id)));
check("Public pilot cases contain no source-dataset identifiers", cases.every((testCase) => !("source_dataset_case_id" in testCase)));

check("Manifest is prospectively versioned", /^\d+\.\d+\.\d+$/.test(manifest.protocol_version) && manifest.status === "prospective_from_next_run");
check("Manifest uses patient-level analysis", ["sampling", "splitting", "inference"].every((key) => manifest.analysis_units?.[key] === "subject_id"));
check("Manifest freezes the two primary configurations", manifest.primary_configurations?.map((item) => item.id).join(",") === "cohere-aplus-routed-v1,claude-haiku45-strict-v1");
check("Safety ablation uses nested prespecified policies", ablationManifest.policies?.map((item) => item.id).join(",") === "accept_all,raw_schema_gate,first_pass_raw_schema_gate,quote_coverage_90_gate,quote_coverage_95_gate,literal_quote_gate,atomic_consistency_gate,atomic_plus_high_risk_guard");
check("Safety ablation makes yield and selective risk explicit", /automation yield/i.test(ablationManifest.research_question) && ablationManifest.primary_metrics?.includes("automation_yield"));
const frozenArtifactMismatches = Object.entries(manifest.frozen_artifacts || {})
  .map(([filePath, expected]) => ({ filePath, expected, actual: stableTextDigest(filePath) }))
  .filter((item) => item.actual !== item.expected);
check("Frozen artifact hashes match current files", frozenArtifactMismatches.length === 0, frozenArtifactMismatches.map((item) => `${item.filePath}: expected ${item.expected}, got ${item.actual}`).join("; "));
check("Evaluator defaults match frozen primary configurations", evaluatorSource.includes("const FROZEN_MODELS = [\"cohere-aplus:command-a-plus-05-2026\", \"anthropic/claude-haiku-4.5\"]"));
check("Environment model override requires exploratory mode", evaluatorSource.includes("process.env.EXPERIMENT_MODE === \"exploratory\""));
check("Confirmatory runtime ignores tuning overrides", evaluatorSource.includes("function runtimeNumber(name, frozenValue)") && evaluatorSource.includes("if (!IS_EXPLORATORY"));
check("Representative sampler enforces subject independence", samplerSource.includes("selectedSubjects") && samplerSource.includes("subjectKey"));
check("Confirmatory sampler enforces duplicate-cluster isolation", confirmatorySamplerSource.includes("--clusters is required") && confirmatorySamplerSource.includes("selectedClusters"));
check("Duplicate-cluster script parses", (() => { try { new Function(duplicateClusterSource.replace(/^#!.*\n/, "")); return true; } catch { return false; } })());
check("Evaluator interleaves paired configurations", evaluatorSource.includes("orderedModelsForCase(models, testCase.case_id)") && evaluatorSource.includes("execution_design"));
check("Evaluator records per-attempt telemetry", ["attempt_audit", "provider_request_id", "returned_model", "finish_reason", "request_hash", "source_hash"].every((item) => evaluatorSource.includes(item)));
check("Span-ID v5 schema caps evidence span IDs", spanIdV5Schema.properties?.evidence_span_ids?.maxItems === 3);
check("Span-ID v5 schema keeps entailment unscored", spanIdV5Schema.properties?.entailment_scored?.const === false && spanIdV5Schema.properties?.entailment_score?.type === "null");
check("Span-ID v5 ablation constrains IDs by enum at provider schema time", spanIdV5AblationSource.includes("enum: spanIds") && spanIdV5AblationSource.includes("span_id_v5"));
check("Span-ID v5 ablation preserves hosted-logit boundary", spanIdV5AblationSource.includes("raw_logits_available_from_hosted_chat_api: false") && spanIdV5AblationSource.includes("field_level_logprobs_available"));
check("Span-ID v5 ablation script is wired", packageJson.scripts?.["span:id:v5:ablation"]?.includes("evaluate-span-id-v5-ablation.js") && packageJson.scripts?.["span:id:v5:ablation:test"]?.includes("test-span-id-v5-ablation.js"));
check("Public summary carries schema ablation boundary", /schema_ablation/.test(JSON.stringify(publicResultsSummary)) && /semantic factuality|semantic entailment|by construction/i.test(JSON.stringify(publicResultsSummary.schema_ablation || {})));
check("Public summary carries schema ablation volume-confound check", /volume_normalized_comparisons/.test(JSON.stringify(publicResultsSummary.schema_ablation || {})) && /matched-count|conjunctive case-gate volume confound/i.test(JSON.stringify(publicResultsSummary.schema_ablation || {})));
check("Model evidence validator rejects credential and provider-error runs", ["Missing\\s+(COHERE|OPENROUTER)_API_KEY", "\\b401\\b", "\\b403\\b", "provider_error", "no_selected_results", "zero_scored"].every((item) => modelEvidenceValidatorSource.includes(item)));
check("Provider-specific eval validation script is wired", packageJson.scripts?.["eval:cohere-plus:validate"]?.includes("validate-model-evidence.js --input results/cohere-plus-eval.json"));
check("Benchmark adapter and scoring scripts are wired", ["benchmark:adapt:aci", "benchmark:score:aci-note", "benchmark:score:aci-factuality", "benchmark:generate:aci-note", "benchmark:aci-note:baselines", "benchmark:aci-note:cohere", "benchmark:aci-note:repair", "benchmark:score", "benchmark:test", "benchmark:public:test", "benchmark:bioscope", "benchmark:bioscope:conformal", "benchmark:bioscope:baselines", "benchmark:derive-reference-gold", "benchmark:predict:candidates", "benchmark:validate"].every((key) => packageJson.scripts?.[key]));
check("Syntax check is file-discovery based", packageJson.scripts?.check === "node scripts/check-syntax.js && node scripts/validate-experiment.js");
check("CI runs the full public verification gate", /pull_request/.test(ciWorkflow) && /npm run check:all/.test(ciWorkflow));
check("PR template requires evidence and privacy review", /Evidence/.test(prTemplate) && /Claim Boundary/.test(prTemplate) && /Privacy Sweep/.test(prTemplate));
check("Private confirmatory cohorts are ignored", /^eval\/confirmatory_\*\.json$/m.test(gitignore) && /^eval\/confirmatory_\*\.json$/m.test(dockerignore));
check("LLM judge is blinded by default", judgeSource.includes("const blind = !Boolean(args.unblinded)"));

check("System prompt prohibits unsupported clinical judgment", /not diagnosing|not replacing clinician judgment/i.test(systemPrompt));
check("System prompt requires exact schema output", /schema/i.test(systemPrompt) && /extra keys/i.test(systemPrompt));
check("User prompt requires source quotes", /source_quote/i.test(extractionPrompt));
check("User prompt includes uncertainty handling", /uncertain/i.test(extractionPrompt));
check("User prompt requires typed atomic safety flags", /safety_type/i.test(extractionPrompt) && /return_precaution/i.test(extractionPrompt) && /Prefer atomic safety flags/i.test(extractionPrompt));
check("User prompt requires handoff atom projection", /handoff_atoms/i.test(extractionPrompt) && /derived_views/i.test(extractionPrompt) && /compatibility category fields/i.test(extractionPrompt));
check("User prompt constrains summary to source facts", /must not contain facts absent/i.test(extractionPrompt));

check("Clinical handover rubric cites Moore et al.", /Moore M, Bain-Donohue S, Barry M, Gray P/.test(JSON.stringify(handoverRubric)));
check("Clinical handover rubric includes before-source domains", Array.isArray(handoverRubric.domains_before_source_review) && handoverRubric.domains_before_source_review.length >= 7);
check("Clinical handover rubric includes after-source safety", JSON.stringify(handoverRubric).includes("handover_safety"));
check("Human-AI rubric cites Li and Tian", /Li H, Tian F/.test(JSON.stringify(collaborationRubric)));
check("Human-AI rubric includes automation risk", JSON.stringify(collaborationRubric).includes("automation_risk"));
check("Probabilistic boundary rubric includes safety-critical recall", JSON.stringify(boundaryRubric).includes("safety_critical_recall"));
check("Probabilistic boundary rubric includes abstention quality", JSON.stringify(boundaryRubric).includes("abstention_quality"));
check("Claims register rejects highest-probability-only framing", /highest-probability/i.test(claimsRegister) && /low-probability high-harm/i.test(claimsRegister));
check("Claims register requires human verification boundaries", /clinician verification/i.test(claimsRegister) && /must not be treated as autonomous care guidance/i.test(claimsRegister));
check("Claims register preserves blinded review protocol", /separate ignored key file/i.test(claimsRegister) && /Do not unblind/i.test(claimsRegister));
check("Claims register rejects prevalence claims from enriched sampling", /not probability samples/i.test(claimsRegister) && /population prevalence/i.test(claimsRegister));
check("Claims register defines paired source-fidelity endpoint", /paired difference/i.test(claimsRegister) && /subject_id/i.test(claimsRegister) && /semantic source-fidelity error/i.test(claimsRegister));
check("Claims register requires intervals and independent fidelity labels", /Wilson intervals/i.test(claimsRegister) && /held-out adjudicated source-fidelity labels/i.test(claimsRegister));
check("Claims register separates synthetic, proxy, and source-fidelity evidence", /Synthetic two-case fixture/.test(claimsRegister) && /Proxy-calibrated conformal/.test(claimsRegister) && /independent source-fidelity test cohort/i.test(claimsRegister));

check(".env is ignored", /^\.env$/m.test(gitignore));
check("Raw dataset is ignored", /^clinical_cases\.csv\.gz$/m.test(gitignore));
check("Generated results are ignored", /^results\/$/m.test(gitignore));
check("Docker ignores .env", /^\.env$/m.test(dockerignore));
check("Docker ignores raw dataset", /^clinical_cases\.csv\.gz$/m.test(dockerignore));
check("Docker ignores generated results", /^results\/$/m.test(dockerignore));
check(".env.example has no OpenRouter secret", !/^OPENROUTER_API_KEY=\S+/m.test(envExample));
check(".env.example has no Cohere secret", !/^COHERE_API_KEY=\S+/m.test(envExample));

const failed = checks.filter((item) => !item.ok);
for (const item of checks) {
  console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name}${item.detail ? ` (${item.detail})` : ""}`);
}

if (failed.length) {
  console.error(`\n${failed.length} validation check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${checks.length} validation checks passed.`);
}

