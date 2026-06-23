#!/usr/bin/env python3
"""
Build the headline results figure for HandoffLens.

Reads the public aggregate numbers from eval/public_results_summary.json and
draws a two-bar comparison of schema validity versus exact-source provenance
on the 400-case held-out baseline run. No case-level data is read or written.

Output: docs/assets/schema-vs-provenance.png
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
OUT_FILE = OUT_DIR / "schema-vs-provenance.png"

data = json.loads(SUMMARY.read_text())
run = data["heldout_engineering_run"]

cases = run["cases"]
schema_valid = run["json_schema_reasoning_512_valid"]
provenance_passed = run["posthoc_provenance_gate_passed"]

schema_pct = 100.0 * schema_valid / cases
provenance_pct = 100.0 * provenance_passed / cases

labels = ["Schema-valid\n(JSON passes)", "Source-grounded\n(provenance gate)"]
values = [schema_pct, provenance_pct]
counts = [f"{schema_valid} / {cases}", f"{provenance_passed} / {cases}"]
colors = ["#4C78A8", "#4C78A8"]

fig, ax = plt.subplots(figsize=(6.6, 4.3))
bars = ax.bar(labels, values, color=colors, width=0.58, zorder=3)

ax.set_ylim(0, 100)
ax.set_ylabel("Percentage of held-out cases")
ax.set_title("Schema validity is not evidence fidelity", fontsize=13, fontweight="bold", pad=12)
ax.yaxis.grid(True, color="#E6E6E6", zorder=0)
ax.set_axisbelow(True)
for spine in ("top", "right"):
    ax.spines[spine].set_visible(False)

for bar, pct, count in zip(bars, values, counts):
    x = bar.get_x() + bar.get_width() / 2
    ax.text(x, bar.get_height() + 2.0, f"{pct:.0f}%", ha="center", va="bottom",
            fontsize=12, fontweight="bold")
    ax.text(x, bar.get_height() / 2, count, ha="center", va="center",
            fontsize=10, color="white")

gap_x = 1.0
ax.annotate(
    "",
    xy=(gap_x + 0.34, provenance_pct),
    xytext=(gap_x + 0.34, schema_pct),
    arrowprops=dict(arrowstyle="<->", color="#888888", lw=1.2),
)
ax.text(gap_x + 0.40, (schema_pct + provenance_pct) / 2,
        "schema-valid but\nungrounded output",
        ha="left", va="center", fontsize=9, color="#555555")

fig.text(0.5, -0.02,
         f"{cases}-case held-out baseline run (direct structured-output generation). "
         "Aggregate engineering metric, not a clinical accuracy measure.",
         ha="center", va="top", fontsize=8, color="#666666")

OUT_DIR.mkdir(parents=True, exist_ok=True)
fig.tight_layout()
fig.savefig(OUT_FILE, dpi=200, bbox_inches="tight")
print(f"Wrote {OUT_FILE.relative_to(ROOT)}")