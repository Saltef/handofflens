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
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

const requiredFiles = [
  ".env.example",
  ".gitignore",
  ".dockerignore",
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
  "scripts/validate-model-evidence.js",
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
  "docs/protocol-freeze.md",
  "docs/statistical-analysis-plan.md",
  "docs/claims-register.md",
  "docs/experiment-runbook.md",
  "docs/safety-ablation-design.md",
  "docs/evaluation-plan.md",
  "docs/handoff-atoms-design.md",
  "docs/clinical-handover-evaluation.md",
  "docs/human-ai-collaboration-framework.md",
  "docs/probabilistic-model-boundaries.md",
  "docs/human-in-the-loop-map.md",
  "docs/atomic-clinician-review-protocol.md"
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
const protocolFreeze = readText(path.join("docs", "protocol-freeze.md"));
const boundaryDoc = readText(path.join("docs", "probabilistic-model-boundaries.md"));
const hitlDoc = readText(path.join("docs", "human-in-the-loop-map.md"));
const atomicReviewDoc = readText(path.join("docs", "atomic-clinician-review-protocol.md"));
const statisticalPlan = readText(path.join("docs", "statistical-analysis-plan.md"));
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
check("Frozen artifact hashes match current files", Object.entries(manifest.frozen_artifacts || {}).every(([filePath, expected]) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex") === expected));
check("Evaluator defaults match frozen primary configurations", evaluatorSource.includes("const FROZEN_MODELS = [\"cohere-aplus:command-a-plus-05-2026\", \"anthropic/claude-haiku-4.5\"]"));
check("Environment model override requires exploratory mode", evaluatorSource.includes("process.env.EXPERIMENT_MODE === \"exploratory\""));
check("Confirmatory runtime ignores tuning overrides", evaluatorSource.includes("function runtimeNumber(name, frozenValue)") && evaluatorSource.includes("if (!IS_EXPLORATORY"));
check("Representative sampler enforces subject independence", samplerSource.includes("selectedSubjects") && samplerSource.includes("subjectKey"));
check("Confirmatory sampler enforces duplicate-cluster isolation", confirmatorySamplerSource.includes("--clusters is required") && confirmatorySamplerSource.includes("selectedClusters"));
check("Duplicate-cluster script parses", (() => { try { new Function(duplicateClusterSource.replace(/^#!.*\n/, "")); return true; } catch { return false; } })());
check("Evaluator interleaves paired configurations", evaluatorSource.includes("orderedModelsForCase(models, testCase.case_id)") && evaluatorSource.includes("execution_design"));
check("Evaluator records per-attempt telemetry", ["attempt_audit", "provider_request_id", "returned_model", "finish_reason", "request_hash", "source_hash"].every((item) => evaluatorSource.includes(item)));
check("Model evidence validator rejects credential and provider-error runs", ["Missing\\s+(COHERE|OPENROUTER)_API_KEY", "\\b401\\b", "\\b403\\b", "provider_error", "no_selected_results", "zero_scored"].every((item) => modelEvidenceValidatorSource.includes(item)));
check("Provider-specific eval validation script is wired", readJson("package.json").scripts?.["eval:cohere-plus:validate"]?.includes("validate-model-evidence.js --input results/cohere-plus-eval.json"));
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
check("Boundary doc rejects highest-probability-only framing", /highest-probability/i.test(boundaryDoc) && /low-probability high-harm/i.test(boundaryDoc));
check("Human-in-the-loop map defines clinician sign-off", /Human sign-off required/.test(hitlDoc) && /Medication reconciliation/.test(hitlDoc));
check("Human-in-the-loop map rejects autonomous clinical use", /must not be treated as deciding/i.test(hitlDoc) && /clinician verification/i.test(hitlDoc));
check("Protocol freeze defines allowed claims", /Allowed Claims/.test(protocolFreeze) && /Disallowed Claims/.test(protocolFreeze));
check("Protocol freeze rejects autonomous care claims", /must not claim/i.test(protocolFreeze) && /replace clinician/i.test(protocolFreeze));
check("Atomic review protocol preserves blinding", /separate ignored key file/i.test(atomicReviewDoc) && /Do not unblind/i.test(atomicReviewDoc));
check("Atomic review protocol rejects prevalence claims from enriched sampling", /not a probability sample/i.test(atomicReviewDoc) && /must not be described as population prevalence/i.test(atomicReviewDoc));
check("Statistical plan defines a paired patient-level source-fidelity endpoint", /paired difference/i.test(statisticalPlan) && /subject_id/i.test(statisticalPlan) && /semantic source-fidelity error/i.test(statisticalPlan));
check("Statistical plan requires intervals and independent fidelity labels", /Wilson intervals/i.test(statisticalPlan) && /held-out adjudicated source-fidelity labels/i.test(statisticalPlan));
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
