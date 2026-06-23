function indexSource(source) {
  const text = String(source || "");
  const segments = [];
  let ordinal = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    ordinal += 1;
    segments.push({ id: `L${String(ordinal).padStart(4, "0")}`, ordinal, text: line });
  }
  return { version: "source-line-index-v1", source: text, segments, byId: Object.fromEntries(segments.map((item) => [item.id, item])) };
}

function renderIndexedSource(index) {
  return index.segments.map((item) => `${item.id} | ${item.text}`).join("\n");
}

function materializeExtraction(pointerExtraction, index, options = {}) {
  return materializeExtractionWithAudit(pointerExtraction, index, options).extraction;
}

function materializeExtractionWithAudit(pointerExtraction, index, options = {}) {
  const output = structuredClone(pointerExtraction);
  const audit = [];
  const convertList = (list, path) => {
    if (!Array.isArray(list)) throw new Error(`${path} must be an array`);
    const converted = [];
    list.forEach((item, position) => {
      try { converted.push(materializeItem(item, index, `${path}[${position}]`, options, audit)); }
      catch (error) {
        if (!options.dropInvalidItems) throw error;
        audit.push({ code: "invalid_span_item_rejected", path: `${path}[${position}]`, message: String(error.message || error) });
      }
    });
    return converted;
  };
  for (const bucket of ["started", "stopped", "changed", "continued", "uncertain"]) output.medication_changes[bucket] = convertList(output.medication_changes[bucket], `medication_changes.${bucket}`);
  output.diagnosis_changes.discharge = convertList(output.diagnosis_changes.discharge, "diagnosis_changes.discharge");
  output.diagnosis_changes.new_or_changed = convertList(output.diagnosis_changes.new_or_changed, "diagnosis_changes.new_or_changed");
  for (const key of ["procedures_and_tests", "labs", "follow_up_actions", "safety_flags", "uncertain_items"]) output[key] = convertList(output[key], key);
  return { extraction: output, audit };
}

function materializeItem(item, index, path, options, audit) {
  if (!item || typeof item !== "object") throw new Error(`${path} must be an object`);
  const start = index.byId[item.source_start_id];
  const end = index.byId[item.source_end_id];
  if (!start) throw new Error(`${path}.source_start_id contains unknown identifier ${item.source_start_id}`);
  if (!end) throw new Error(`${path}.source_end_id contains unknown identifier ${item.source_end_id}`);
  let first = start, last = end;
  if (last.ordinal < first.ordinal) {
    const width = first.ordinal - last.ordinal + 1;
    if (!options.repairReversed || width > Number(options.maxRepairSpanLines || 12)) throw new Error(`${path} source span is reversed`);
    [first, last] = [last, first];
    audit.push({ code: "reversed_span_repaired", path, original_start_id: start.id, original_end_id: end.id, repaired_start_id: first.id, repaired_end_id: last.id, span_lines: width });
  }
  const width = last.ordinal - first.ordinal + 1;
  if (width > Number(options.maxSpanLines || 12)) throw new Error(`${path} source span exceeds maximum of ${Number(options.maxSpanLines || 12)} lines`);
  const segments = index.segments.slice(first.ordinal - 1, last.ordinal);
  return { label: String(item.label || ""), rationale: String(item.rationale || ""), source_quote: segments.map((segment) => segment.text).join("\n") };
}

module.exports = { indexSource, renderIndexedSource, materializeExtraction, materializeExtractionWithAudit };
