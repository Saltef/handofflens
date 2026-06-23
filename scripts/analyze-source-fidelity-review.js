#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const args = parseArgs(process.argv.slice(2));
const inputPath = args.input || "results/source-fidelity-review-completed.json";
const keyPath = args.key || "results/source-fidelity-model-key.json";
const outPath = args.out || "results/source-fidelity-analysis.json";
const packet = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const key = JSON.parse(fs.readFileSync(keyPath, "utf8")).key || {};
if (packet.review_design?.mode !== "source_fidelity") throw new Error("Input is not a source-fidelity packet");
const reviews = [];
for (const item of packet.cases || []) for (const output of item.outputs || []) {
  const identity = key[`${item.case_id}:${output.model_slot}`];
  if (!identity) throw new Error(`Missing model key for ${item.case_id}:${output.model_slot}`);
  reviews.push(build(item, output, identity));
}
const complete = reviews.filter((item) => item.complete);
const models = [...new Set(complete.map((item) => item.model))].sort();
const byModel = Object.fromEntries(models.map((model) => [model, summarize(complete.filter((item) => item.model === model))]));
const pairs = Object.values(groupBy(complete, (item) => item.case_id)).filter((items) => items.length === 2 && new Set(items.map((item) => item.model)).size === 2);
const paired = pairSummary(pairs, models);
const report = {
  generated_at: new Date().toISOString(), input_path: inputPath, reviewer_id: packet.reviewer_id || "",
  endpoint: "any semantic source-fidelity error in an included claim, relationship, explicit required target, or narrative summary",
  interpretation: "Source fidelity only; no clinical harmfulness, appropriateness, safety, or external-generalization claim.",
  reviews_total: reviews.length, reviews_complete: complete.length, reviews_incomplete: reviews.length - complete.length,
  models: byModel, paired_comparison: paired
};
fs.mkdirSync(path.dirname(outPath), { recursive: true }); fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report, null, 2));

function build(item, output, identity) {
  const claims = output.claims || []; const omissions = output.omissions || []; const global = output.global_review || {};
  const complete = claims.every((claim) => claim.review?.factual_support && claim.review?.relationship_support && claim.review?.error_scope) && omissions.every((omission) => omission.status && omission.target_explicitness) && global.summary_fidelity && global.structured_output_completeness;
  const claimError = claims.some((claim) => ["partially_supported", "unsupported"].includes(claim.review?.factual_support) || ["partially_supported", "unsupported"].includes(claim.review?.relationship_support) || claim.review?.error_scope === "semantic_error");
  const omissionError = omissions.some((omission) => omission.status === "present" && omission.target_explicitness === "explicit_in_source");
  const summaryError = global.summary_fidelity === "contains_semantic_error" || global.structured_output_completeness === "explicit_target_missing";
  return { case_id: item.case_id, model: identity.model, provider: identity.provider, complete, any_error: claimError || omissionError || summaryError, claim_error: claimError, omission_error: omissionError, summary_error: summaryError, review_minutes: global.review_minutes };
}
function summarize(items) { const errors = items.filter((item) => item.any_error).length; return { output_reviews: items.length, outputs_with_error: errors, error_rate: ratio(errors, items.length), error_rate_ci95: wilson(errors, items.length), claim_error_rate: rate(items, "claim_error"), explicit_omission_rate: rate(items, "omission_error"), summary_error_rate: rate(items, "summary_error"), mean_review_minutes: mean(items.map((item) => item.review_minutes)) }; }
function pairSummary(pairs, models) {
  if (models.length !== 2) return { completed_pairs: pairs.length, comparison_available: false };
  let aOnly=0,bOnly=0,both=0,neither=0; const diffs=[]; const [aModel,bModel]=models;
  for (const pair of pairs) { const a=pair.find((item)=>item.model===aModel), b=pair.find((item)=>item.model===bModel); if(a.any_error&&b.any_error)both++; else if(a.any_error)aOnly++; else if(b.any_error)bOnly++; else neither++; diffs.push(Number(a.any_error)-Number(b.any_error)); }
  return { completed_pairs:pairs.length, comparison_available:true, model_a:aModel, model_b:bModel, cells:{both_error:both,model_a_only:aOnly,model_b_only:bOnly,neither}, risk_difference_a_minus_b:mean(diffs), risk_difference_ci95:bootstrap(diffs), exact_mcnemar_p:exactMcNemar(aOnly,bOnly) };
}
function exactMcNemar(a,b){const n=a+b;if(!n)return 1;const k=Math.min(a,b);let term=2**(-n),sum=term;for(let i=1;i<=k;i++){term*=((n-i+1)/i);sum+=term;}return Math.min(1,2*sum);}
function bootstrap(values,repeats=5000){if(!values.length)return null;let state=20260618;const out=[];for(let r=0;r<repeats;r++){let total=0;for(let i=0;i<values.length;i++){state=(1664525*state+1013904223)>>>0;total+=values[Math.floor(state/0x100000000*values.length)];}out.push(total/values.length);}out.sort((a,b)=>a-b);return [out[Math.floor(.025*(repeats-1))],out[Math.floor(.975*(repeats-1))]];}
function wilson(x,n,z=1.959963984540054){if(!n)return null;const p=x/n,d=1+z*z/n,c=(p+z*z/(2*n))/d,h=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;return [Math.max(0,c-h),Math.min(1,c+h)];}
function rate(items,key){return ratio(items.filter((item)=>item[key]).length,items.length);} function ratio(a,b){return b?a/b:null;} function mean(values){const v=values.filter(Number.isFinite);return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;} function groupBy(items,keyFn){const g={};for(const item of items){const k=keyFn(item);g[k]||=[];g[k].push(item);}return g;}
function parseArgs(argv){const p={};for(let i=0;i<argv.length;i++){if(!argv[i].startsWith("--"))continue;const n=argv[i+1];if(!n||n.startsWith("--"))p[argv[i].slice(2)]=true;else{p[argv[i].slice(2)]=n;i++;}}return p;}
