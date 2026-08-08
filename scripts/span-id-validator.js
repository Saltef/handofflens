const ASSERTIONS = new Set(["present", "absent", "uncertain", "conditional", "historical"]);
const SUPPORT_STATUSES = new Set(["supported", "insufficient_evidence", "not_found"]);
const ITEM_ARRAY_PATHS = [
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
  "uncertain_items",
  "handoff_atoms",
];

function validateSpanIdEvidenceItem(item, spanIndex, options = {}) {
  const maxEvidenceSpans = Number(options.maxEvidenceSpans || 3);
  const errors = [];
  const warnings = [];
  const byId = asSpanMap(spanIndex);

  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return { valid: false, errors: [{ code: "item_not_object", message: "Evidence item must be an object." }], warnings };
  }

  const supportStatus = item.support_status;
  if (!SUPPORT_STATUSES.has(supportStatus)) {
    errors.push({ code: "invalid_support_status", message: "support_status must be supported, insufficient_evidence, or not_found." });
  }

  if (!ASSERTIONS.has(item.assertion)) {
    errors.push({ code: "invalid_assertion", message: "assertion must be present, absent, uncertain, conditional, or historical." });
  }

  if (!Array.isArray(item.evidence_span_ids)) {
    errors.push({ code: "span_ids_not_array", message: "evidence_span_ids must be an array." });
  } else {
    if (item.support_status === "supported" && item.evidence_span_ids.length < 1) {
      errors.push({ code: "empty_supported_span_ids", message: "supported items require at least one evidence_span_id." });
    }
    if (item.evidence_span_ids.length > maxEvidenceSpans) {
      errors.push({ code: "too_many_span_ids", message: `evidence_span_ids must not contain more than ${maxEvidenceSpans} IDs.` });
    }
    const seen = new Set();
    for (const spanId of item.evidence_span_ids) {
      if (seen.has(spanId)) warnings.push({ code: "duplicate_span_id", span_id: spanId, message: "Duplicate evidence span ID." });
      seen.add(spanId);
      if (!byId.has(spanId)) errors.push({ code: "unknown_span_id", span_id: spanId, message: `Unknown evidence span ID: ${spanId}` });
    }
  }

  if (item.surface_form !== undefined) {
    validateSurfaceForm(item.surface_form, byId, errors);
  }

  if (item.normalized_value !== undefined && typeof item.normalized_value !== "string") {
    errors.push({ code: "invalid_normalized_value", message: "normalized_value must be a string when present." });
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateSpanIdExtraction(extraction, spanIndex, options = {}) {
  const items = enumerateEvidenceItems(extraction);
  const item_results = items.map(({ path, item }) => ({
    path,
    ...validateSpanIdEvidenceItem(item, spanIndex, options),
  }));
  return {
    valid: item_results.every((item) => item.valid),
    item_count: item_results.length,
    invalid_item_count: item_results.filter((item) => !item.valid).length,
    item_results,
  };
}

function enforceSpanIdValidationPolicy(item, spanIndex, options = {}) {
  const maxRetries = Number(options.maxRetries ?? 2);
  const retryCount = Number(options.retryCount ?? 0);
  const validation = validateSpanIdEvidenceItem(item, spanIndex, options);
  if (validation.valid) {
    return { item, validation, retry_required: false, exhausted: false, audit: [] };
  }
  const invalidIds = validation.errors
    .filter((error) => error.code === "unknown_span_id")
    .map((error) => error.span_id);
  const audit = [{
    code: "span_id_validation_failed",
    retry_count: retryCount,
    invalid_span_ids: invalidIds,
    errors: validation.errors,
  }];
  if (retryCount < maxRetries) {
    return { item, validation, retry_required: true, exhausted: false, audit };
  }
  const exhaustedItem = {
    ...item,
    evidence_span_ids: [],
    support_status: "not_found",
  };
  return {
    item: exhaustedItem,
    validation: validateSpanIdEvidenceItem(exhaustedItem, spanIndex, options),
    retry_required: false,
    exhausted: true,
    audit: [...audit, { code: "span_id_retry_exhausted_routed_not_found", max_retries: maxRetries }],
  };
}

function validateSurfaceForm(surfaceForm, byId, errors) {
  if (!surfaceForm || typeof surfaceForm !== "object" || Array.isArray(surfaceForm)) {
    errors.push({ code: "surface_form_not_object", message: "surface_form must be an object when present." });
    return;
  }
  const span = byId.get(surfaceForm.span_id);
  if (!span) {
    errors.push({ code: "unknown_surface_span_id", span_id: surfaceForm.span_id, message: `Unknown surface_form span ID: ${surfaceForm.span_id}` });
    return;
  }
  if (!Number.isInteger(surfaceForm.token_start) || !Number.isInteger(surfaceForm.token_end)) {
    errors.push({ code: "surface_offsets_not_integers", message: "surface_form token_start and token_end must be integers." });
    return;
  }
  const tokenCount = String(span.text || "").trim().split(/\s+/).filter(Boolean).length;
  if (surfaceForm.token_start < 0 || surfaceForm.token_end <= surfaceForm.token_start || surfaceForm.token_end > tokenCount) {
    errors.push({ code: "surface_offsets_out_of_range", message: "surface_form token offsets must identify tokens within the named span." });
  }
}

function enumerateEvidenceItems(extraction) {
  const out = [];
  for (const path of ITEM_ARRAY_PATHS) {
    const value = getPath(extraction, path);
    if (!Array.isArray(value)) continue;
    value.forEach((item, index) => out.push({ path: `${path}[${index}]`, item }));
  }
  return out;
}

function getPath(object, dottedPath) {
  return dottedPath.split(".").reduce((value, key) => (value && value[key] !== undefined ? value[key] : undefined), object);
}

function asSpanMap(spanIndex) {
  if (spanIndex?.byId instanceof Map) return spanIndex.byId;
  if (spanIndex?.byId && typeof spanIndex.byId === "object") return new Map(Object.entries(spanIndex.byId));
  return new Map((spanIndex?.spans || []).map((span) => [span.id, span]));
}

module.exports = {
  validateSpanIdEvidenceItem,
  validateSpanIdExtraction,
  enforceSpanIdValidationPolicy,
  ASSERTIONS,
  SUPPORT_STATUSES,
};
