function planRecovery(gateResult) {
  if (gateResult.valid) return { policy_version: "explicit-recovery-policy-v1", action: "accept", max_additional_calls: 0, preserve_original: true };
  const codes = new Set(gateResult.blocking.map((item) => item.code));
  if (codes.size === 1 && codes.has("empty_or_short_summary")) return plan("summary_only_regeneration", 1, "Preserve the validated structured fields and regenerate only the narrative summary from source plus structured extraction.");
  if ([...codes].every((code) => ["duplicate_evidence_item"].includes(code))) return plan("deterministic_duplicate_review", 0, "Do not silently mutate. Present exact duplicates for explicit deterministic removal and re-run the gate.");
  if (codes.has("source_quote_not_found") || codes.has("empty_evidence_field")) return plan("targeted_evidence_reextraction", 1, "Regenerate only failed evidence items with exact source quotes; retain the original output and audit trail.");
  if (codes.has("medication_state_conflict")) return plan("medication_reconciliation_reextraction", 1, "Re-extract medication reconciliation with mutually exclusive state constraints.");
  return plan("full_json_schema_reextraction", 1, "Repeat the frozen JSON-Schema configuration once and retain both attempts. If the second attempt fails, quarantine the case.");
}
function plan(action, calls, rationale) { return { policy_version: "explicit-recovery-policy-v1", action, max_additional_calls: calls, preserve_original: true, rationale, hidden_retries: false }; }
module.exports = { planRecovery };
