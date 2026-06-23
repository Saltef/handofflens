#!/usr/bin/env python3
"""
Build the public results figures for HandoffLens.

Reads the public aggregate numbers from eval/public_results_summary.json and
draws a small set of comparison figures. No case-level data is read or written.

Outputs:
- docs/assets/schema-vs-provenance.png
- docs/assets/stage-yield.png
- docs/assets/rematerialization-proxy-audit.png

Requirements: Python 3 and matplotlib.
Run from the repository root:  python3 scripts/make-results-figure.py
"""

import json
import pathlib

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = pathlib.Path(__file__).resolve().parents[1]
SUMMARY = ROOT / "eval" / "public_results_summary.json"
OUT_DIR = ROOT / "docs" / "assets"
SCHEMA_FILE = OUT_DIR / "schema-vs-provenance.png"
STAGE_FILE = OUT_DIR / "stage-yield.png"
AUDIT_FILE = OUT_DIR / "rematerialization-proxy-audit.png"


def save_bar_figure(file_path, labels, values, counts, title, ylabel, subtitle, *, ylim=(0, 100), arrow=None, arrow_label=None):
    fig, ax = plt.subplots(figsize=(6.9, 4.3))
    bars = ax.bar(labels, values, color=["#4C78A8"] * len(values), width=0.58, zorder=3)
    ax.set_ylim(*ylim)
    ax.set_ylabel(ylabel)
    ax.set_title(title, fontsize=13, fontweight="bold", pad=12)
    ax.yaxis.grid(True, color="#E6E6E6", zorder=0)
    ax.set_axisbelow(True)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)

    top_padding = ylim[1] - ylim[0]
    for bar, pct, count in zip(bars, values, counts):
        x = bar.get_x() + bar.get_width() / 2
        ax.text(x, bar.get_height() + 0.04 * top_padding, f"{pct:.0f}%", ha="center", va="bottom",
                fontsize=12, fontweight="bold")
        ax.text(x, bar.get_height() / 2, count, ha="center", va="center",
                fontsize=10, color="white")

    if arrow is not None:
        x_pos, lower, upper = arrow
        ax.annotate(
            "",
            xy=(x_pos, upper),
            xytext=(x_pos, lower),
            arrowprops=dict(arrowstyle="<->", color="#888888", lw=1.2),
        )
        if arrow_label:
            ax.text(x_pos + 0.08, (lower + upper) / 2, arrow_label,
                    ha="left", va="center", fontsize=9, color="#555555")

    fig.text(0.5, -0.02, subtitle, ha="center", va="top", fontsize=8, color="#666666")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fig.tight_layout()
    fig.savefig(file_path, dpi=200, bbox_inches="tight")
    plt.close(fig)

data = json.loads(SUMMARY.read_text())
run = data["heldout_engineering_run"]
architecture = data["architecture_development"]

cases = run["cases"]
schema_valid = run["json_schema_reasoning_512_valid"]
provenance_passed = run["posthoc_provenance_gate_passed"]

schema_pct = 100.0 * schema_valid / cases
provenance_pct = 100.0 * provenance_passed / cases

labels = ["Schema-valid\n(JSON passes)", "Source-grounded\n(provenance gate)"]
values = [schema_pct, provenance_pct]
counts = [f"{schema_valid} / {cases}", f"{provenance_passed} / {cases}"]
save_bar_figure(
    SCHEMA_FILE,
    labels,
    values,
    counts,
    "Schema validity is not evidence fidelity",
    "Percentage of held-out cases",
    f"{cases}-case held-out baseline run (direct structured-output generation). Proxy engineering metric, not a clinical accuracy measure.",
    arrow=(1.34, schema_pct, provenance_pct),
    arrow_label="schema-valid but\nungrounded output",
)

stage_labels = ["Evidence-span\nv2 rerun", "Multi-stage\nv3", "Candidate-first\nv4", "V4 stability\nrepeat test"]
stage_values = [
    100.0 * architecture["evidence_span_v2_final_rerun"]["technical_successes"] / architecture["evidence_span_v2_final_rerun"]["cases"],
    100.0 * architecture["multi_stage_v3"]["deterministic_gate_passed"] / architecture["multi_stage_v3"]["cases"],
    100.0 * architecture["candidate_first_v4_final_rerun"]["deterministic_gate_passed"] / architecture["candidate_first_v4_final_rerun"]["cases"],
    100.0 * architecture["candidate_first_v4_stability"]["deterministic_gate_passed"] / architecture["candidate_first_v4_stability"]["cases"],
]
stage_counts = [
    f"{architecture['evidence_span_v2_final_rerun']['technical_successes']} / {architecture['evidence_span_v2_final_rerun']['cases']}",
    f"{architecture['multi_stage_v3']['deterministic_gate_passed']} / {architecture['multi_stage_v3']['cases']}",
    f"{architecture['candidate_first_v4_final_rerun']['deterministic_gate_passed']} / {architecture['candidate_first_v4_final_rerun']['cases']}",
    f"{architecture['candidate_first_v4_stability']['deterministic_gate_passed']} / {architecture['candidate_first_v4_stability']['cases']}",
]
save_bar_figure(
    STAGE_FILE,
    stage_labels,
    stage_values,
    stage_counts,
    "Stage-specific proxy success rates across the development path",
    "Percentage of cases meeting each stage's own gate",
    "Each bar uses the stage's own success criterion, so this is a development-path proxy snapshot rather than a single homogeneous benchmark.",
)

audit_labels = ["Model-written\nsummary audit", "Extractive\nrematerialized audit"]
audit_values = [25.0, 85.0]
audit_counts = ["5 / 20", "17 / 20"]
save_bar_figure(
    AUDIT_FILE,
    audit_labels,
    audit_values,
    audit_counts,
    "Deterministic rematerialization improved proxy audit pass rate",
    "Percentage of audit records passing the proxy check",
    "The audit is a proxy for unsupported-detail leakage, not a substitute for human factual review.",
    arrow=(1.34, 25.0, 85.0),
    arrow_label="unsupported numeric\ndetails removed",
)

print(f"Wrote {SCHEMA_FILE.relative_to(ROOT)}")
print(f"Wrote {STAGE_FILE.relative_to(ROOT)}")
print(f"Wrote {AUDIT_FILE.relative_to(ROOT)}")