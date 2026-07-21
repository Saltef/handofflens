# Handoff Atoms Design

`handoff_atoms` is the source-grounded internal layer behind the public compatibility fields.

The original extraction schema asked the model to directly fill overlapping views such as `follow_up_actions` and `safety_flags`. That is brittle because one source instruction may legitimately belong to multiple views.

## Atom First

The model now extracts atoms first:

```json
{
  "atom_id": "SYNTH_CARDIAC_001-FU-002",
  "label": "Primary care laboratory check for potassium and creatinine in 3 days",
  "atom_type": "follow_up_instruction",
  "instruction_kind": "lab_monitoring",
  "safety_type": "monitoring_instruction",
  "action": "laboratory check",
  "target": "potassium and creatinine",
  "time_window": "in 3 days",
  "threshold": "",
  "owner": "primary care",
  "derived_views": ["follow_up_actions", "safety_flags"],
  "rationale": "Source-stated monitoring instruction after discharge.",
  "source_quote": "Primary care laboratory check for potassium and creatinine in 3 days."
}
```

Compatibility fields are then checked as derived views over those atoms:

```text
follow_up_actions = atoms projected into follow-up work
safety_flags = atoms projected into return precautions, monitoring, medication safety, pending results, or source-stated risks
```

## Deterministic Canonicalization

The evaluator now runs an audited atom/view bridge after schema validation:

1. If an atom declares a compatibility view but the view is missing the matching item, the evaluator projects a source-quoted item from the atom into that view.
2. If a compatibility view contains a source-quoted item that has no matching atom, the evaluator backfills an atom from that item.
3. Reports show both the raw model score and the post-canonicalization system score.

The bridge is deliberately conservative. It only uses facts already present in the model output with a `source_quote`; it does not scan the discharge summary to invent new items. This means it can fix projection failures, such as a lab-monitoring atom missing from `safety_flags`, but it cannot recover a clinically important item that the model failed to extract anywhere.

## Why This Exists

The cardiac pilot case exposed the issue:

```text
Primary care laboratory check for potassium and creatinine in 3 days.
Record daily weight and call for a gain above 2 kg in 3 days.
```

The first line is both a follow-up action and a monitoring safety item. The second line contains both self-monitoring and a return/call precaution. A flat schema makes the model duplicate source facts across categories. Atoms make the source instruction primary and the display categories secondary.

## Trade-Off

Benefits:

- catches category projection failures;
- preserves timing, thresholds, targets, and owners;
- separates extraction from presentation;
- makes safety omissions easier to diagnose.

Costs:

- larger schema and longer outputs;
- raw-model F1 and post-canonicalization system F1 must be reported separately;
- poor atoms can make derived-view checks noisier;
- deterministic projection can add false positives if the model emits a poor but source-quoted atom.

This is intentionally a bridge architecture: old public fields remain, but atom coverage now tells us whether they are supported by a source-grounded internal representation and whether deterministic canonicalization was needed.
