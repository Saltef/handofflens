const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_PROFILE_ID = "discharge-summary";
const PROFILES_DIR = path.resolve(__dirname, "..", "profiles");

function listProfileFiles() {
  if (!fs.existsSync(PROFILES_DIR)) return [];
  return fs.readdirSync(PROFILES_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(PROFILES_DIR, name))
    .sort();
}

function resolveProfilePath(profileRef = DEFAULT_PROFILE_ID) {
  const ref = String(profileRef || DEFAULT_PROFILE_ID);
  if (path.isAbsolute(ref) || ref.includes("/") || ref.includes("\\") || ref.endsWith(".json")) {
    return path.resolve(ref);
  }
  return path.join(PROFILES_DIR, `${ref}.json`);
}

function loadProfile(profileRef = process.env.HANDOFFLENS_PROFILE || DEFAULT_PROFILE_ID) {
  if (profileRef && typeof profileRef === "object") return profileRef;
  const profilePath = resolveProfilePath(profileRef);
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8").replace(/^\uFEFF/, ""));
  const issues = validateProfile(profile);
  if (issues.length) {
    throw new Error(`Invalid profile ${profilePath}: ${issues.join("; ")}`);
  }
  return profile;
}

function validateProfile(profile) {
  const issues = [];
  if (!profile || typeof profile !== "object") return ["profile must be an object"];
  if (!profile.profile_id || typeof profile.profile_id !== "string") issues.push("profile_id is required");
  if (!profile.schema_version || typeof profile.schema_version !== "string") issues.push("schema_version is required");
  if (!profile.domains || typeof profile.domains !== "object") {
    issues.push("domains object is required");
  } else {
    for (const [domain, config] of Object.entries(profile.domains)) {
      if (!config || typeof config !== "object") {
        issues.push(`${domain}: domain config must be an object`);
        continue;
      }
      for (const field of ["headings", "cues"]) {
        if (!Array.isArray(config[field])) {
          issues.push(`${domain}: ${field} must be an array`);
          continue;
        }
        for (const rule of config[field]) {
          const pattern = typeof rule === "string" ? rule : rule?.pattern;
          if (!pattern || typeof pattern !== "string") issues.push(`${domain}: ${field} pattern must be a string`);
          else {
            try { new RegExp(pattern, typeof rule === "object" && rule.flags ? rule.flags : "i"); }
            catch (error) { issues.push(`${domain}: invalid ${field} regex ${pattern}: ${error.message}`); }
          }
        }
      }
    }
  }
  if (!Array.isArray(profile.normalization_pairs)) {
    issues.push("normalization_pairs must be an array");
  } else {
    for (const pair of profile.normalization_pairs) {
      if (!Array.isArray(pair) || pair.length !== 2 || pair.some((value) => typeof value !== "string" || !value.trim())) {
        issues.push("normalization_pairs entries must be [short, long] strings");
      }
    }
  }
  if (profile.lab_inferences !== undefined) {
    if (!Array.isArray(profile.lab_inferences)) issues.push("lab_inferences must be an array");
    else {
      for (const rule of profile.lab_inferences) {
        for (const field of ["label", "quote", "cue"]) {
          if (!rule || typeof rule[field] !== "string") issues.push(`lab_inferences.${field} must be a string`);
          else {
            try { new RegExp(rule[field], rule.flags || "i"); }
            catch (error) { issues.push(`invalid lab_inferences.${field} regex ${rule[field]}: ${error.message}`); }
          }
        }
      }
    }
  }
  return issues;
}

function compileProfile(profileRef = process.env.HANDOFFLENS_PROFILE || DEFAULT_PROFILE_ID) {
  const profile = typeof profileRef === "object" && profileRef.raw ? profileRef.raw : loadProfile(profileRef);
  const issues = validateProfile(profile);
  if (issues.length) throw new Error(`Invalid profile ${profile.profile_id || "<unknown>"}: ${issues.join("; ")}`);

  const headings = [];
  const cues = {};
  for (const [domain, config] of Object.entries(profile.domains)) {
    for (const rule of config.headings) {
      headings.push([domain, compileRule(rule, "gi")]);
    }
    cues[domain] = config.cues.map((rule) => compileRule(rule, "i"));
  }
  return {
    profile_id: profile.profile_id,
    headings,
    cues,
    normalizationPairs: profile.normalization_pairs || [],
    labInferences: (profile.lab_inferences || []).map((rule) => ({
      label: compileRule({ pattern: rule.label, flags: rule.flags || "i" }, "i"),
      quote: compileRule({ pattern: rule.quote, flags: rule.flags || "i" }, "i"),
      cue: compileRule({ pattern: rule.cue, flags: rule.flags || "i" }, "i"),
    })),
    safetyTypes: profile.safety_types || [],
    raw: profile,
  };
}

function compileRule(rule, defaultFlags) {
  if (typeof rule === "string") return new RegExp(rule, defaultFlags);
  return new RegExp(rule.pattern, rule.flags || defaultFlags);
}

module.exports = {
  DEFAULT_PROFILE_ID,
  PROFILES_DIR,
  compileProfile,
  listProfileFiles,
  loadProfile,
  resolveProfilePath,
  validateProfile,
};

