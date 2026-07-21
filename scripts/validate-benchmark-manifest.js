const fs = require("node:fs");
const path = require("node:path");
const { loadProfile } = require("./profile-config");

const allowedAvailability = new Set(["verify_required", "open_verified", "dua_required"]);
const allowedAdapterStatus = new Set(["planned", "optional", "planned_private", "implemented_public", "implemented_private"]);

function parseArgs(argv) {
  const args = { manifest: path.resolve(__dirname, "..", "eval", "benchmark_manifest.example.json") };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--manifest") args.manifest = argv[++i];
  }
  return args;
}

function validateManifest(manifest) {
  const issues = [];
  if (!manifest || typeof manifest !== "object") return ["manifest must be an object"];
  if (manifest.schema_version !== "handofflens-benchmark-manifest-v1") issues.push("schema_version must be handofflens-benchmark-manifest-v1");
  if (!manifest.result_policy?.no_headline_results_without_verified_source) issues.push("result policy must block unverifiable headline results");
  if (!Array.isArray(manifest.datasets) || !manifest.datasets.length) issues.push("datasets must be a non-empty array");

  const ids = new Set();
  for (const dataset of manifest.datasets || []) {
    if (!dataset.dataset_id) issues.push("dataset_id is required");
    else if (ids.has(dataset.dataset_id)) issues.push(`duplicate dataset_id: ${dataset.dataset_id}`);
    else ids.add(dataset.dataset_id);
    if (![1, 2].includes(dataset.tier)) issues.push(`${dataset.dataset_id}: tier must be 1 or 2`);
    if (!allowedAvailability.has(dataset.availability)) issues.push(`${dataset.dataset_id}: unsupported availability ${dataset.availability}`);
    if (!allowedAdapterStatus.has(dataset.adapter_status)) issues.push(`${dataset.dataset_id}: unsupported adapter_status ${dataset.adapter_status}`);
    if (!Array.isArray(dataset.tasks) || !dataset.tasks.length) issues.push(`${dataset.dataset_id}: tasks must be non-empty`);
    if (dataset.claimed_results !== null) issues.push(`${dataset.dataset_id}: claimed_results must stay null until evidence artifacts exist`);
    try { loadProfile(dataset.profile_id); }
    catch (error) { issues.push(`${dataset.dataset_id}: profile_id ${dataset.profile_id} does not load: ${error.message}`); }
  }

  for (const required of ["bioscope", "aci_bench", "i2b2_2009_medication", "i2b2_2010_assertion", "n2c2_2018_ade"]) {
    if (!ids.has(required)) issues.push(`missing target dataset ${required}`);
  }
  return issues;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(args.manifest, "utf8").replace(/^\uFEFF/, ""));
  const issues = validateManifest(manifest);
  if (issues.length) {
    console.error(`Benchmark manifest validation failed:\n- ${issues.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`PASS benchmark manifest validation (${manifest.datasets.length} datasets)`);
}

if (require.main === module) main();

module.exports = { validateManifest };

