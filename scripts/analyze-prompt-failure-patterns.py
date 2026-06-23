#!/usr/bin/env python3
"""Case-level failure analysis for the 100-case Cohere prompt screen."""

from __future__ import annotations

import argparse
import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy.stats import fisher_exact, mannwhitneyu, spearmanr
from sklearn.cluster import KMeans
from sklearn.compose import ColumnTransformer
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    balanced_accuracy_score,
    brier_score_loss,
    roc_auc_score,
    silhouette_score,
)
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.decomposition import NMF


PROMPTS = ["prompt_baseline", "prompt_evidence_first", "prompt_coverage_checklist"]
PROMPT_LABEL = {
    "prompt_baseline": "Baseline",
    "prompt_evidence_first": "Evidence-first",
    "prompt_coverage_checklist": "Coverage checklist",
}
CONTINUOUS_FEATURES = [
    "note_words", "note_lines", "section_count", "deid_count", "dose_count",
    "numeric_token_count", "negation_count", "uncertainty_count", "followup_cue_count",
    "medication_cue_count", "lab_cue_count", "procedure_cue_count", "age_numeric",
]
CATEGORICAL_FEATURES = [
    "has_discharge_medications", "has_hospital_course", "has_followup_section",
    "has_lab_section", "has_procedure_section", "has_discharge_diagnoses", "prompt",
]


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default="results/cohere-prompt-screen-100-v1")
    parser.add_argument("--cases", default="eval/dataset_sample_representative_500.json")
    parser.add_argument("--out", default="results/cohere-prompt-screen-100-v1/failure-pattern-analysis.json")
    parser.add_argument("--mdout", default="docs/cohere-prompt-failure-pattern-analysis.md")
    parser.add_argument("--fig-dir", default="results/cohere-prompt-screen-100-v1/failure-pattern-figures")
    return parser.parse_args()


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def source_features(case):
    text = str(case.get("discharge_summary") or "")
    upper = text.upper()
    words = re.findall(r"\b\w+\b", text)
    headings = re.findall(r"^[A-Z][A-Z /_-]{3,}:?\s*$|^[A-Z][A-Z /_-]{3,}:\s+", text, flags=re.M)
    def count(pattern): return len(re.findall(pattern, text, flags=re.I))
    age = pd.to_numeric(case.get("age"), errors="coerce")
    return {
        "case_id": case["case_id"],
        "note_words": len(words),
        "note_lines": len(text.splitlines()),
        "section_count": len(headings),
        "deid_count": text.count("[**"),
        "dose_count": count(r"\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|units?|ml|meq)\b"),
        "numeric_token_count": len(re.findall(r"\b\d+(?:\.\d+)?\b", text)),
        "negation_count": count(r"\b(?:no|not|without|denies|negative|ruled out|none)\b"),
        "uncertainty_count": count(r"\b(?:possible|possibly|probable|likely|suspected|unclear|uncertain|pending)\b"),
        "followup_cue_count": count(r"follow[- ]?up|appointment|clinic|monitor|return"),
        "medication_cue_count": count(r"medication|medications|discharge meds|\bpo\b|\biv\b|tablet|capsule"),
        "lab_cue_count": count(r"laborator|\blabs?\b|sodium|potassium|creatinine|hemoglobin|hematocrit|wbc|platelet"),
        "procedure_cue_count": count(r"procedure|surgery|operation|imaging|x-ray|ct scan|mri|ultrasound|echocardi|ekg|ecg"),
        "age_numeric": float(age) if pd.notna(age) else np.nan,
        "has_discharge_medications": int(bool(re.search(r"DISCHARGE MEDICATION", upper))),
        "has_hospital_course": int(bool(re.search(r"HOSPITAL COURSE", upper))),
        "has_followup_section": int(bool(re.search(r"FOLLOW ?UP|DISCHARGE FOLLOW", upper))),
        "has_lab_section": int(bool(re.search(r"LABORATOR|PERTINENT RESULTS", upper))),
        "has_procedure_section": int(bool(re.search(r"PROCEDURE|OPERATIONS?", upper))),
        "has_discharge_diagnoses": int(bool(re.search(r"DISCHARGE DIAGNOS", upper))),
        "admission_diagnosis": str(case.get("admission_diagnosis") or "unknown"),
    }


def telemetry_for(row):
    telemetry = row.get("telemetry")
    if telemetry is None:
        audits = row.get("attempt_audit") or []
        telemetry = (audits[-1].get("telemetry") if audits else None)
    usage = (telemetry or {}).get("usage") or {}
    return {
        "finish_reason": (telemetry or {}).get("finish_reason"),
        "input_tokens": usage.get("input_tokens"),
        "output_tokens": usage.get("output_tokens"),
    }


def primary_audits(judge):
    output = {}
    for record in judge.get("judgments", []):
        if record.get("repeat") or not record.get("judgment"):
            continue
        for label, prompt in (record.get("blind_map") or {}).items():
            audit = next((x for x in record["judgment"].get("audits", []) if x.get("output_label") == label), None)
            if audit:
                output[(record["case_id"], prompt)] = audit
    return output


def declared_error_burden(audit):
    return sum([
        int(audit.get("unsupported_count") or 0), int(audit.get("contradiction_count") or 0),
        int(audit.get("relationship_error_count") or 0), int(audit.get("explicit_target_omission_count") or 0),
        int(bool(audit.get("summary_semantic_error"))),
    ])


def evidence_domain(description):
    text = description.lower()
    rules = [
        ("medication", r"medicat|drug|dose|prednisone|antibiotic|insulin|anticoag"),
        ("diagnosis", r"diagnos|problem|condition|disease"),
        ("follow_up", r"follow|appointment|clinic|monitor|return|pending"),
        ("laboratory", r"\blab|sodium|potassium|creatin|hemoglobin|wbc|platelet|abg"),
        ("test_or_procedure", r"test|procedure|imaging|x-ray|\bct\b|mri|ekg|ecg|surgery"),
        ("temporality_or_status", r"timing|duration|histor|new|start|stop|continue|discharge|admission"),
        ("summary", r"summary|narrative"),
    ]
    return next((name for name, pattern in rules if re.search(pattern, text)), "other")


def build_rows(root, cases_path):
    root = Path(root)
    cases = load_json(cases_path)[:100]
    features = {case["case_id"]: source_features(case) for case in cases}
    reports = {p: load_json(root / f"{p}.json") for p in PROMPTS}
    judge = load_json(root / "comparative-judge.json")
    audits = primary_audits(judge)
    rows, evidence_rows = [], []
    for prompt, report in reports.items():
        for result in report.get("results", []):
            case_id = result["case_id"]
            row = {**features[case_id], "prompt": prompt, "prompt_label": PROMPT_LABEL[prompt]}
            success = bool(result.get("extraction") and not result.get("error") and result.get("raw_schema_valid") is True)
            error = str(result.get("error") or "")
            row.update({
                "technical_success": int(success), "technical_failure": int(not success),
                "failure_type": "empty_summary" if "two_page_summary" in error else ("provider_500" if "API error 500" in error else ("other" if error else "none")),
                "latency_ms": result.get("latency_ms"),
            })
            row.update(telemetry_for(result))
            extraction = result.get("extraction") or {}
            lists = [
                *[(extraction.get("medication_changes") or {}).get(k, []) for k in ["started", "stopped", "changed", "continued", "uncertain"]],
                (extraction.get("diagnosis_changes") or {}).get("discharge", []),
                (extraction.get("diagnosis_changes") or {}).get("new_or_changed", []),
                extraction.get("procedures_and_tests", []), extraction.get("labs", []), extraction.get("follow_up_actions", []),
                extraction.get("safety_flags", []), extraction.get("uncertain_items", []),
            ]
            row["structured_item_count"] = sum(len(x or []) for x in lists)
            row["summary_words"] = len(re.findall(r"\b\w+\b", str(extraction.get("two_page_summary") or "")))
            audit = audits.get((case_id, prompt))
            if audit:
                burden = declared_error_burden(audit)
                row.update({
                    "judged": 1, "judge_any_reported": int(bool(audit.get("any_semantic_error"))),
                    "judge_any_derived": int(burden > 0), "judge_error_burden": burden,
                    "judge_unsupported": int(audit.get("unsupported_count") or 0),
                    "judge_contradiction": int(audit.get("contradiction_count") or 0),
                    "judge_relationship": int(audit.get("relationship_error_count") or 0),
                    "judge_omission": int(audit.get("explicit_target_omission_count") or 0),
                    "judge_summary": int(bool(audit.get("summary_semantic_error"))),
                })
                for item in audit.get("evidence", []):
                    evidence_rows.append({"case_id": case_id, "prompt": prompt, "error_type": item.get("error_type"), "description": item.get("description", ""), "domain": evidence_domain(item.get("description", ""))})
            else:
                row.update({k: np.nan for k in ["judged", "judge_any_reported", "judge_any_derived", "judge_error_burden", "judge_unsupported", "judge_contradiction", "judge_relationship", "judge_omission", "judge_summary"]})
            row["usable_derived"] = int(success and audit is not None and declared_error_burden(audit) == 0)
            rows.append(row)
    return pd.DataFrame(rows), pd.DataFrame(evidence_rows), judge


def bh_adjust(p_values):
    p = np.asarray(p_values, dtype=float)
    order = np.argsort(p)
    adjusted = np.empty_like(p)
    running = 1.0
    for rank in range(len(p) - 1, -1, -1):
        index = order[rank]
        running = min(running, p[index] * len(p) / (rank + 1))
        adjusted[index] = running
    return adjusted.tolist()


def univariate_associations(df, endpoint, prompts=True):
    records = []
    groups = PROMPTS if prompts else ["pooled"]
    for prompt in groups:
        sub = df if prompt == "pooled" else df[df.prompt == prompt]
        sub = sub[sub[endpoint].notna()]
        if sub[endpoint].nunique() < 2:
            continue
        for feature in CONTINUOUS_FEATURES + ["output_tokens", "structured_item_count", "summary_words"]:
            valid = sub[[feature, endpoint]].dropna()
            if len(valid) < 20 or valid[feature].nunique() < 2:
                continue
            rho, p = spearmanr(valid[feature], valid[endpoint])
            a, b = valid[valid[endpoint] == 1][feature], valid[valid[endpoint] == 0][feature]
            records.append({"prompt": prompt, "endpoint": endpoint, "feature": feature, "n": len(valid), "rho": float(rho), "p": float(p), "median_event": float(a.median()), "median_no_event": float(b.median())})
    if records:
        adjusted = bh_adjust([x["p"] for x in records])
        for record, value in zip(records, adjusted): record["p_bh"] = value
    return records


def categorical_associations(df, endpoint):
    records = []
    for prompt in PROMPTS:
        sub = df[(df.prompt == prompt) & df[endpoint].notna()]
        if sub[endpoint].nunique() < 2: continue
        for feature in CATEGORICAL_FEATURES[:-1]:
            table = pd.crosstab(sub[feature], sub[endpoint]).reindex(index=[0, 1], columns=[0, 1], fill_value=0)
            odds, p = fisher_exact(table.values)
            r1 = sub[sub[feature] == 1][endpoint].mean() if (sub[feature] == 1).any() else np.nan
            r0 = sub[sub[feature] == 0][endpoint].mean() if (sub[feature] == 0).any() else np.nan
            records.append({"prompt": prompt, "endpoint": endpoint, "feature": feature, "odds_ratio": float(odds), "risk_with": float(r1), "risk_without": float(r0), "risk_difference": float(r1-r0), "p": float(p)})
    if records:
        adjusted = bh_adjust([x["p"] for x in records])
        for record, value in zip(records, adjusted): record["p_bh"] = value
    return records


def grouped_logistic_cv(df, endpoint):
    data = df[df[endpoint].notna()].copy()
    y = data[endpoint].astype(int).to_numpy()
    if min(np.bincount(y)) < 10:
        return {"status": "not_estimable", "reason": "fewer than 10 observations in one outcome class"}
    numeric = CONTINUOUS_FEATURES
    categorical = CATEGORICAL_FEATURES
    pre = ColumnTransformer([
        ("num", Pipeline([("impute", SimpleImputer(strategy="median")), ("scale", StandardScaler())]), numeric),
        ("cat", OneHotEncoder(handle_unknown="ignore", drop="if_binary"), categorical),
    ])
    folds = GroupKFold(n_splits=5)
    predictions = np.zeros(len(data))
    fold_metrics = []
    for train, test in folds.split(data, y, groups=data.case_id):
        model = Pipeline([("pre", pre), ("model", LogisticRegression(max_iter=5000, class_weight="balanced", C=0.5))])
        model.fit(data.iloc[train], y[train])
        prob = model.predict_proba(data.iloc[test])[:, 1]
        predictions[test] = prob
        if len(np.unique(y[test])) == 2:
            fold_metrics.append({"roc_auc": roc_auc_score(y[test], prob), "average_precision": average_precision_score(y[test], prob)})
    return {
        "status": "estimated", "n": len(data), "events": int(y.sum()),
        "grouped_cv_roc_auc": float(roc_auc_score(y, predictions)),
        "grouped_cv_average_precision": float(average_precision_score(y, predictions)),
        "grouped_cv_balanced_accuracy_at_0_5": float(balanced_accuracy_score(y, predictions >= .5)),
        "grouped_cv_brier": float(brier_score_loss(y, predictions)),
        "fold_roc_auc": [float(x["roc_auc"]) for x in fold_metrics],
    }


def cluster_cases(df):
    case = df.drop_duplicates("case_id").set_index("case_id")
    x = case[CONTINUOUS_FEATURES].copy().fillna(case[CONTINUOUS_FEATURES].median())
    x = StandardScaler().fit_transform(x)
    candidates = []
    for k in range(2, 7):
        labels = KMeans(n_clusters=k, n_init=50, random_state=20260621).fit_predict(x)
        candidates.append((silhouette_score(x, labels), k, labels))
    score, k, labels = max(candidates)
    mapping = dict(zip(case.index, labels))
    work = df.copy(); work["cluster"] = work.case_id.map(mapping)
    profiles = []
    for cluster in range(k):
        unique = case.loc[[cid for cid, lab in mapping.items() if lab == cluster]]
        profile = {"cluster": cluster, "cases": len(unique), "silhouette_selected_k": k, "silhouette": float(score)}
        for feature in ["note_words", "dose_count", "deid_count", "numeric_token_count", "section_count"]: profile[f"median_{feature}"] = float(unique[feature].median())
        for prompt in PROMPTS:
            sub = work[(work.cluster == cluster) & (work.prompt == prompt)]
            profile[f"failure_rate_{prompt}"] = float(sub.technical_failure.mean())
        profiles.append(profile)
    return profiles, work


def nmf_topics(evidence):
    if len(evidence) < 20: return []
    vectorizer = TfidfVectorizer(stop_words="english", min_df=2, ngram_range=(1, 2), max_features=1000)
    x = vectorizer.fit_transform(evidence.description)
    n_topics = min(6, max(2, x.shape[0] // 30), x.shape[1] - 1)
    model = NMF(n_components=n_topics, init="nndsvda", random_state=20260621, max_iter=1000)
    weights = model.fit_transform(x)
    terms = np.array(vectorizer.get_feature_names_out())
    topics = []
    for idx, component in enumerate(model.components_):
        members = np.where(weights[:, idx] == weights.max(axis=1))[0]
        representative = evidence.iloc[members[np.argmax(weights[members, idx])]].description if len(members) else ""
        topics.append({"topic": idx, "count": int(len(members)), "top_terms": terms[component.argsort()[-10:][::-1]].tolist(), "representative_description": representative})
    return topics


def make_figures(df, evidence, fig_dir):
    fig_dir = Path(fig_dir); fig_dir.mkdir(parents=True, exist_ok=True)
    order = PROMPTS; labels = [PROMPT_LABEL[x] for x in order]
    rates = [df[df.prompt == x].technical_failure.mean() for x in order]
    plt.figure(figsize=(7, 4)); plt.bar(labels, rates, color=["#4C78A8", "#F58518", "#54A24B"]); plt.ylabel("Technical failure rate"); plt.ylim(0, .45); plt.tight_layout(); plt.savefig(fig_dir / "technical-failure-rate.png", dpi=180); plt.close()

    temp = df.copy(); temp["length_quartile"] = pd.qcut(temp.note_words, 4, labels=["Q1 shortest", "Q2", "Q3", "Q4 longest"])
    pivot = temp.pivot_table(index="length_quartile", columns="prompt", values="technical_failure", observed=False)
    pivot = pivot[order]; pivot.columns = labels
    pivot.plot(kind="bar", figsize=(8, 4), color=["#4C78A8", "#F58518", "#54A24B"]); plt.ylabel("Technical failure rate"); plt.xlabel("Source-note length quartile"); plt.xticks(rotation=0); plt.tight_layout(); plt.savefig(fig_dir / "failure-by-note-length.png", dpi=180); plt.close()

    if not evidence.empty:
        counts = evidence.groupby(["domain", "prompt"]).size().unstack(fill_value=0).reindex(columns=order)
        counts.columns = labels; counts.plot(kind="bar", figsize=(10, 5)); plt.ylabel("Judge evidence examples"); plt.xticks(rotation=35, ha="right"); plt.tight_layout(); plt.savefig(fig_dir / "judge-evidence-domains.png", dpi=180); plt.close()

    valid = df[df.output_tokens.notna()].copy()
    groups, names = [], []
    for prompt in order:
        for status, name in [(0, "success"), (1, "failure")]:
            values = valid[(valid.prompt == prompt) & (valid.technical_failure == status)].output_tokens.to_numpy()
            if len(values): groups.append(values); names.append(f"{PROMPT_LABEL[prompt]}\n{name}")
    plt.figure(figsize=(10, 5)); plt.boxplot(groups, tick_labels=names, showfliers=False); plt.ylabel("Generated output tokens"); plt.xticks(rotation=25, ha="right"); plt.tight_layout(); plt.savefig(fig_dir / "output-tokens-by-status.png", dpi=180); plt.close()


def json_safe(value):
    if isinstance(value, dict): return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)): return [json_safe(v) for v in value]
    if isinstance(value, (np.integer,)): return int(value)
    if isinstance(value, (np.floating, float)):
        return float(value) if np.isfinite(value) else None
    return value


def main():
    args = parse_args()
    df, evidence, judge = build_rows(args.root, args.cases)
    audit_rows = df[df.judged == 1].copy()
    inconsistency = audit_rows[audit_rows.judge_any_reported != audit_rows.judge_any_derived]
    technical_summary = []
    for prompt in PROMPTS:
        sub = df[df.prompt == prompt]
        technical_summary.append({
            "prompt": prompt, "attempted": len(sub), "technical_failures": int(sub.technical_failure.sum()),
            "failure_rate": float(sub.technical_failure.mean()), "empty_summary_failures": int((sub.failure_type == "empty_summary").sum()),
            "provider_500_failures": int((sub.failure_type == "provider_500").sum()),
            "median_output_tokens_success": float(sub[sub.technical_success == 1].output_tokens.median()),
            "median_output_tokens_empty_summary": float(sub[sub.failure_type == "empty_summary"].output_tokens.median()),
            "complete_finish_fraction_empty_summary": float((sub[sub.failure_type == "empty_summary"].finish_reason == "COMPLETE").mean()),
        })
    patterns = df.pivot(index="case_id", columns="prompt", values="technical_failure")
    combination_counts = patterns.apply(lambda row: "+".join([PROMPT_LABEL[p] for p in PROMPTS if row[p] == 1]) or "none", axis=1).value_counts().to_dict()
    continuous = univariate_associations(df, "technical_failure")
    categorical = categorical_associations(df, "technical_failure")
    burden_assoc = univariate_associations(audit_rows, "judge_error_burden")
    clusters, clustered = cluster_cases(df)
    domain_counts = evidence.groupby(["prompt", "error_type", "domain"]).size().reset_index(name="count").to_dict("records") if not evidence.empty else []
    make_figures(df, evidence, args.fig_dir)
    report = {
        "generated_at": pd.Timestamp.utcnow().isoformat(), "case_count": int(df.case_id.nunique()), "output_count": len(df),
        "technical_summary": technical_summary, "failure_combinations": combination_counts,
        "judge_validation": {
            "audits": len(audit_rows), "internally_inconsistent_any_error_labels": len(inconsistency),
            "inconsistency_rate": float(len(inconsistency) / len(audit_rows)),
            "reported_any_error_rate": float(audit_rows.judge_any_reported.mean()),
            "derived_any_error_rate": float(audit_rows.judge_any_derived.mean()),
            "warning": "Derived status is positive when any component count or summary flag is positive. The judge-provided binary is not used when inconsistent.",
            "by_prompt": {
                prompt: {
                    "audits": int(len(audit_rows[audit_rows.prompt == prompt])),
                    "inconsistent_labels": int((audit_rows[audit_rows.prompt == prompt].judge_any_reported != audit_rows[audit_rows.prompt == prompt].judge_any_derived).sum()),
                    "derived_error_rate": float(audit_rows[audit_rows.prompt == prompt].judge_any_derived.mean()),
                    "median_error_burden": float(audit_rows[audit_rows.prompt == prompt].judge_error_burden.median()),
                    "median_omission_count": float(audit_rows[audit_rows.prompt == prompt].judge_omission.median()),
                } for prompt in PROMPTS
            },
        },
        "judge_component_summary": {
            prompt: {
                "audits": int(len(audit_rows[audit_rows.prompt == prompt])),
                "unsupported": int(audit_rows[audit_rows.prompt == prompt].judge_unsupported.sum()),
                "contradictions": int(audit_rows[audit_rows.prompt == prompt].judge_contradiction.sum()),
                "relationship_errors": int(audit_rows[audit_rows.prompt == prompt].judge_relationship.sum()),
                "omissions": int(audit_rows[audit_rows.prompt == prompt].judge_omission.sum()),
                "summary_errors": int(audit_rows[audit_rows.prompt == prompt].judge_summary.sum()),
                "mean_total_burden": float(audit_rows[audit_rows.prompt == prompt].judge_error_burden.mean()),
            } for prompt in PROMPTS
        },
        "grouped_predictive_models": {
            "technical_failure_pooled_with_prompt": grouped_logistic_cv(df, "technical_failure"),
            **{f"technical_failure_{prompt}": grouped_logistic_cv(df[df.prompt == prompt], "technical_failure") for prompt in PROMPTS},
            "judge_derived_any_error_conditional_on_success": grouped_logistic_cv(audit_rows, "judge_any_derived"),
            "usable_derived": grouped_logistic_cv(df, "usable_derived"),
        },
        "continuous_associations_technical_failure": continuous,
        "categorical_associations_technical_failure": categorical,
        "continuous_associations_judge_error_burden": burden_assoc,
        "case_clusters": clusters, "judge_evidence_domain_counts": domain_counts,
        "judge_evidence_nmf_topics": nmf_topics(evidence),
        "limitations": [
            "Only 100 development cases; subgroup and multivariable estimates are unstable.",
            "The LLM judge is not validated against independent annotations and displayed internal label inconsistencies.",
            "Semantic analyses are conditional on technically successful outputs and are vulnerable to selection bias.",
            "Associations are exploratory, multiplicity-adjusted where shown, and do not establish causality.",
        ],
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    report = json_safe(report)
    Path(args.out).write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
    write_markdown(report, df, evidence, args.mdout, args.fig_dir)
    print(f"Wrote {args.out}")
    print(f"Wrote {args.mdout}")


def fmt(value, digits=3):
    return "NA" if value is None or not np.isfinite(value) else f"{value:.{digits}f}"


def write_markdown(report, df, evidence, path, fig_dir):
    fig_rel = Path("..") / Path(fig_dir)
    lines = [
        "# Prompt Failure-Pattern Analysis", "",
        "## Executive finding", "",
        "The dominant technical failure is a model-compliance failure: the API returned `finish_reason=COMPLETE`, but `two_page_summary` was empty or uninformative. The alternative prompts reduced latency and judge-recorded error burden among successful outputs, while substantially increasing this missing-summary failure. This is a quality–availability trade-off, not a single winning prompt.", "",
        "The automated judge's top-level binary label is internally inconsistent with its own component counts. All semantic conclusions below therefore use component-derived status and error burden; the original binary is reported only as a judge-quality diagnostic.", "",
        "## Technical failures", "",
        "| Prompt | Failures | Empty summary | HTTP 500 | Median output tokens: success | Median output tokens: empty summary | Empty-summary finish=COMPLETE |", "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for x in report["technical_summary"]:
        lines.append(f"| {PROMPT_LABEL[x['prompt']]} | {x['technical_failures']}/100 | {x['empty_summary_failures']} | {x['provider_500_failures']} | {x['median_output_tokens_success']:.0f} | {x['median_output_tokens_empty_summary']:.0f} | {100*x['complete_finish_fraction_empty_summary']:.1f}% |")
    lines += ["", f"![Technical failure rate]({(fig_rel / 'technical-failure-rate.png').as_posix()})", "", f"![Failure by source-note length]({(fig_rel / 'failure-by-note-length.png').as_posix()})", "", f"![Output tokens by status]({(fig_rel / 'output-tokens-by-status.png').as_posix()})", "",
        "Failure overlap across the same 100 cases:", ""]
    for name, count in sorted(report["failure_combinations"].items(), key=lambda item: -item[1]): lines.append(f"- {name}: {count} cases")
    j = report["judge_validation"]
    lines += ["", "## Automated-judge validity check", "", f"Of {j['audits']} output audits, {j['internally_inconsistent_any_error_labels']} ({100*j['inconsistency_rate']:.1f}%) had a top-level `any_semantic_error` value inconsistent with the judge's own component counts. Reported binary error rate was {100*j['reported_any_error_rate']:.1f}%; component-derived error rate was {100*j['derived_any_error_rate']:.1f}%.", "", "This invalidates the earlier clean/error composite based on the judge-provided Boolean. Error burden and explicit error categories remain usable as exploratory proxy measurements, but not as ground truth.", "",
        "| Prompt | Audits | Inconsistent binary | Derived error rate | Median error burden | Median omissions |", "|---|---:|---:|---:|---:|---:|",
    ]
    for prompt in PROMPTS:
        x = j["by_prompt"][prompt]
        lines.append(f"| {PROMPT_LABEL[prompt]} | {x['audits']} | {x['inconsistent_labels']} | {100*x['derived_error_rate']:.1f}% | {x['median_error_burden']:.1f} | {x['median_omission_count']:.1f} |")
    lines += ["", "The prompts mostly changed the **type** of judge-recorded error, not the total burden:", "", "| Prompt | Unsupported | Contradictions | Relationship | Omissions | Summary | Mean total burden/output |", "|---|---:|---:|---:|---:|---:|---:|"]
    for prompt in PROMPTS:
        x = report["judge_component_summary"][prompt]
        lines.append(f"| {PROMPT_LABEL[prompt]} | {x['unsupported']} | {x['contradictions']} | {x['relationship_errors']} | {x['omissions']} | {x['summary_errors']} | {x['mean_total_burden']:.2f} |")
    lines += ["", "Baseline outputs attracted more unsupported-claim, relationship, and summary flags. Evidence-first and coverage outputs attracted far more omission flags. Because the judge saw only successful outputs and the prompts had different failure rates, these totals are descriptive rather than causal.", "",
        "## Predictive classification", ""]
    for endpoint, model in report["grouped_predictive_models"].items():
        if model["status"] == "estimated": lines.append(f"- `{endpoint}`: grouped 5-fold ROC AUC {model['grouped_cv_roc_auc']:.3f}, average precision {model['grouped_cv_average_precision']:.3f}, balanced accuracy {model['grouped_cv_balanced_accuracy_at_0_5']:.3f}. Groups were source cases, preventing prompt versions of one case from crossing folds.")
        else: lines.append(f"- `{endpoint}`: not estimable ({model['reason']}).")
    source_sig = [x for x in report["continuous_associations_technical_failure"] if x.get("p_bh", 1) < .10 and x["feature"] in CONTINUOUS_FEATURES]
    output_sig = [x for x in report["continuous_associations_technical_failure"] if x.get("p_bh", 1) < .10 and x["feature"] not in CONTINUOUS_FEATURES]
    lines += ["", "## Output-side failure signature", "", "These variables are observed after generation and are consequences or near-definitions of failure. They are useful for detection, not causal prediction.", ""]
    if output_sig:
        lines += ["| Prompt | Output feature | Spearman rho | Failure median | Success median | BH-adjusted p |", "|---|---|---:|---:|---:|---:|"]
        for x in sorted(output_sig, key=lambda z: z["p_bh"]): lines.append(f"| {PROMPT_LABEL.get(x['prompt'], x['prompt'])} | {x['feature']} | {x['rho']:.3f} | {x['median_event']:.1f} | {x['median_no_event']:.1f} | {x['p_bh']:.3g} |")
    lines += ["", "## Pre-request case features associated with technical failure", ""]
    if source_sig:
        lines += ["| Prompt | Feature | Spearman rho | Event median | Non-event median | BH-adjusted p |", "|---|---|---:|---:|---:|---:|"]
        for x in sorted(source_sig, key=lambda z: z["p_bh"]): lines.append(f"| {PROMPT_LABEL.get(x['prompt'], x['prompt'])} | {x['feature']} | {x['rho']:.3f} | {x['median_event']:.1f} | {x['median_no_event']:.1f} | {x['p_bh']:.3g} |")
    else: lines.append("No continuous case feature survived BH adjustment at q < 0.10. Apparent raw correlations should be treated as unstable.")
    cat = [x for x in report["categorical_associations_technical_failure"] if x.get("p_bh", 1) < .10]
    if cat:
        lines += ["", "Categorical section signals surviving q < 0.10:", ""]
        for x in sorted(cat, key=lambda z: z["p_bh"]): lines.append(f"- {PROMPT_LABEL[x['prompt']]} / `{x['feature']}`: risk difference {100*x['risk_difference']:.1f} percentage points, q={x['p_bh']:.3g}.")
    else: lines += ["", "No section-presence indicator survived BH adjustment at q < 0.10."]
    lines += ["", "## Unsupervised case groups", "", "These clusters describe source complexity; they are not clinical phenotypes.", "", "| Cluster | Cases | Median words | Median dose mentions | Baseline failure | Evidence-first failure | Coverage failure |", "|---:|---:|---:|---:|---:|---:|---:|"]
    for x in report["case_clusters"]: lines.append(f"| {x['cluster']} | {x['cases']} | {x['median_note_words']:.0f} | {x['median_dose_count']:.0f} | {100*x['failure_rate_prompt_baseline']:.1f}% | {100*x['failure_rate_prompt_evidence_first']:.1f}% | {100*x['failure_rate_prompt_coverage_checklist']:.1f}% |")
    lines += ["", "## Judge-described error classes", "", f"![Judge evidence domains]({(fig_rel / 'judge-evidence-domains.png').as_posix()})", "", "Machine-derived NMF themes:", ""]
    for topic in report["judge_evidence_nmf_topics"]: lines.append(f"- Topic {topic['topic']} ({topic['count']} evidence items): {', '.join(topic['top_terms'][:7])}. Representative: {topic['representative_description']}")
    lines += ["", "## Scientific interpretation", "", "1. **Failure is mostly output-policy noncompliance, not transport instability.** HTTP 500s were rare; empty required summaries dominated.", "2. **Prompt constraints trade completeness against compliance.** The more verification-heavy prompts often returned shorter outputs and omitted the final summary.", "3. **The source alone is unlikely to support a strong failure router at n=100.** Cross-validated discrimination must be interpreted against the event prevalence and uncertainty; no model should be deployed from this screen.", "4. **Judge-derived binary cleanliness is invalid.** Any future automated judgment must enforce the invariant `any_semantic_error = OR(component errors)` in code rather than ask the LLM to set both independently.", "5. **Semantic comparisons are selected on successful outputs.** A prompt that fails on hard cases can appear cleaner among survivors. Report availability and conditional fidelity jointly.", "", "## Limitations", ""]
    lines.extend([f"- {x}" for x in report["limitations"]])
    Path(path).parent.mkdir(parents=True, exist_ok=True); Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
