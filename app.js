const sampleCase = {
  meta: {
    case_id: "SYNTH_CARDIAC_001",
    age: "72",
    gender: "F",
    admission_diagnosis: "ACUTE DECOMPENSATED HEART FAILURE"
  },
  discharge_summary: `SYNTHETIC TRAINING EXAMPLE - NOT A PATIENT RECORD.

ADMISSION REASON:
A fictional 72-year-old woman was admitted with increasing leg edema and shortness of breath.

MEDICATIONS AT HOME:
1. Lisinopril 10 mg daily.
2. Furosemide 20 mg daily.
3. Simvastatin 20 mg nightly.

BRIEF SUMMARY OF HOSPITAL COURSE:
Chest radiograph showed pulmonary vascular congestion. Echocardiogram showed an ejection fraction of 35 percent. The patient received intravenous diuresis and symptoms improved. Furosemide was increased to 40 mg daily. Carvedilol 3.125 mg twice daily was started. Simvastatin was stopped because of muscle pain and replaced with atorvastatin 20 mg nightly. Potassium was 3.1 mmol/L after diuresis and was replaced.

DISCHARGE DIAGNOSES:
1. Heart failure with reduced ejection fraction.
2. Hypokalemia, corrected.

DISCHARGE MEDICATIONS:
1. Lisinopril 10 mg daily.
2. Furosemide 40 mg daily.
3. Carvedilol 3.125 mg twice daily.
4. Atorvastatin 20 mg nightly.

FOLLOW-UP PLANS:
Cardiology clinic in 7 days. Primary care laboratory check for potassium and creatinine in 3 days. Record daily weight and call for a gain above 2 kg in 3 days.`
};

const selectors = {
  meta: document.querySelector("#caseMeta"),
  input: document.querySelector("#summaryInput"),
  output: document.querySelector("#summaryOutput"),
  generate: document.querySelector("#generate"),
  clear: document.querySelector("#clear"),
  loadSample: document.querySelector("#loadSample"),
  copyMarkdown: document.querySelector("#copyMarkdown"),
  downloadMarkdown: document.querySelector("#downloadMarkdown"),
  printSummary: document.querySelector("#printSummary")
};

let currentMarkdown = "";

function parseMeta(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return Object.fromEntries(
      text
        .split(/\n+/)
        .map((line) => line.split(/:\s*/))
        .filter((parts) => parts.length >= 2)
        .map(([key, ...rest]) => [key.trim(), rest.join(": ").trim()])
    );
  }
}

function normalizeLine(line) {
  return line
    .replace(/^\s*(?:\d+[\).]|[-*])\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getSection(text, names) {
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`(?:^|\\n)\\s*(?:${escaped})\\s*:?\\s*\\n([\\s\\S]*?)(?=\\n\\s*[A-Z][A-Z /-]{3,}:|$)`, "i");
  return text.match(pattern)?.[1]?.trim() || "";
}

function listFromSection(section) {
  if (!section) return [];
  return section
    .split(/\n+/)
    .map(normalizeLine)
    .filter((line) => line.length > 2)
    .filter((line) => !/^(and|or|the|with)$/i.test(line));
}

function medKey(line) {
  return line
    .toLowerCase()
    .replace(/\b(tablet|capsule|puff|puffs|mg|mcg|units|daily|q\.?d\.?|bid|tid|qid|every|hours?|po|iv|oral)\b/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .trim()
    .split(/\s+/)[0];
}

function compareMedications(homeMeds, dischargeMeds) {
  const homeMap = new Map(homeMeds.map((med) => [medKey(med), med]));
  const dischargeMap = new Map(dischargeMeds.map((med) => [medKey(med), med]));
  const continued = [];
  const changed = [];
  const started = [];
  const stopped = [];

  dischargeMap.forEach((med, key) => {
    if (!key) return;
    if (!homeMap.has(key)) {
      started.push(med);
    } else if (homeMap.get(key).toLowerCase() !== med.toLowerCase()) {
      changed.push(`${homeMap.get(key)} -> ${med}`);
    } else {
      continued.push(med);
    }
  });

  homeMap.forEach((med, key) => {
    if (key && !dischargeMap.has(key)) stopped.push(med);
  });

  return { continued, changed, started, stopped };
}

function extractLabs(text) {
  const labLines = text
    .split(/\n+/)
    .map(normalizeLine)
    .filter((line) => /(?:wbc|white count|hgb|hematocrit|platelets?|creat|inr|glucose|troponin|abg|sodium|potassium|blood)/i.test(line))
    .filter((line) => /(?:\*|#|\d)/.test(line));
  return unique(labLines).slice(0, 8);
}

function extractProcedures(text) {
  const procedureSection = getSection(text, ["MAJOR SURGICAL OR INVASIVE PROCEDURE", "PROCEDURES", "PAST SURGICAL HISTORY"]);
  const course = getSection(text, ["BRIEF SUMMARY OF HOSPITAL COURSE", "HOSPITAL COURSE"]);
  const candidates = `${procedureSection}\n${course}`
    .split(/\n+/)
    .map(normalizeLine)
    .filter((line) => /(?:underwent|procedure|bronchoscopy|biopsy|catheter|debridement|stent|intubat|extubat|surgery|placed|removed|drain)/i.test(line));
  return unique(candidates).slice(0, 7);
}

function extractFollowUp(text) {
  const follow = getSection(text, ["FOLLOW-UP PLANS", "FOLLOWUP PLANS", "DISCHARGE INSTRUCTIONS", "FOLLOW UP", "FOLLOW-UP"]);
  const fallback = text
    .split(/\n+/)
    .map(normalizeLine)
    .filter((line) => /(?:follow|appointment|outpatient|return|monitor|study|clinic|primary care|pcp|pulmonolog|cardiolog|nephrolog)/i.test(line));
  return unique(listFromSection(follow).concat(fallback)).slice(0, 8);
}

function extractDates(text) {
  const admission = text.match(/Admission Date:\s*([^\n]+)/i)?.[1]?.trim() || "Not found";
  const discharge = text.match(/Discharge Date:\s*([^\n]+)/i)?.[1]?.trim() || "Not found";
  return { admission, discharge };
}

function unique(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function list(items, fallback = "Not clearly documented in extracted text.") {
  const safeItems = items.length ? items : [fallback];
  return safeItems.map((item) => `- ${item}`).join("\n");
}

function generateSummary(meta, text) {
  const dates = extractDates(text);
  const homeMeds = listFromSection(getSection(text, ["MEDICATIONS AT HOME", "HOME MEDICATIONS", "ADMISSION MEDICATIONS"]));
  const dischargeMeds = listFromSection(getSection(text, ["DISCHARGE MEDICATIONS", "MEDICATIONS ON DISCHARGE"]));
  const meds = compareMedications(homeMeds, dischargeMeds);
  const dischargeDiagnoses = listFromSection(getSection(text, ["DISCHARGE DIAGNOSES", "DISCHARGE DIAGNOSIS"]));
  const labs = extractLabs(text);
  const procedures = extractProcedures(text);
  const followUp = extractFollowUp(text);
  const course = listFromSection(getSection(text, ["BRIEF SUMMARY OF HOSPITAL COURSE", "HOSPITAL COURSE"])).slice(0, 8);

  return `# Baseline Follow-up Extraction

## Patient and Visit
- Case: ${meta.case_id || "Not provided"}
- Age/Sex: ${[meta.age, meta.gender].filter(Boolean).join("/") || "Not provided"}
- Admission diagnosis: ${meta.admission_diagnosis || "Not provided"}
- Admission date: ${dates.admission}
- Discharge date: ${dates.discharge}

## High-priority Follow-up
${list(followUp)}

## Medication Changes
Started or newly emphasized:
${list(meds.started)}

Changed dose, duration, or instructions:
${list(meds.changed)}

Likely stopped or absent from discharge list:
${list(meds.stopped)}

Continued:
${list(meds.continued)}

## Diagnosis Changes
- Admission diagnosis: ${meta.admission_diagnosis || "Not provided"}

Discharge diagnoses:
${list(dischargeDiagnoses)}

## Hospital Course and Procedures
${list(course.concat(procedures))}

## Labs and Tests Requiring Attention
${list(labs)}

## Review Checklist
- Confirm medication reconciliation against the source EHR and pharmacy list.
- Verify abnormal labs and pending tests before signing outpatient plan.
- Confirm specialist follow-up timing and patient access barriers.
- This deterministic baseline output is a demo artifact and should not replace clinician review.`;
}

function markdownToHtml(markdown) {
  const html = [];
  let paragraph = [];
  let listItems = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    html.push(`<p>${paragraph.map(escapeHtml).join("<br>")}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (!listItems.length) return;
    html.push(`<ul>${listItems.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`);
    listItems = [];
  }

  markdown.split("\n").forEach((line) => {
    if (line.startsWith("# ")) {
      flushParagraph();
      flushList();
      html.push(`<h3>${escapeHtml(line.slice(2))}</h3>`);
      return;
    }
    if (line.startsWith("## ")) {
      flushParagraph();
      flushList();
      html.push(`<h3>${escapeHtml(line.slice(3))}</h3>`);
      return;
    }
    if (line.startsWith("- ")) {
      flushParagraph();
      listItems.push(line.slice(2));
      return;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      return;
    }
    flushList();
    paragraph.push(line);
  });

  flushParagraph();
  flushList();
  return html.join("");
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function loadSample() {
  selectors.meta.value = JSON.stringify(sampleCase.meta, null, 2);
  selectors.input.value = sampleCase.discharge_summary;
}

selectors.loadSample.addEventListener("click", loadSample);

selectors.generate.addEventListener("click", () => {
  const meta = parseMeta(selectors.meta.value);
  const text = selectors.input.value.trim();
  if (!text) {
    selectors.output.innerHTML = `<p class="empty-state">Paste a discharge summary first.</p>`;
    return;
  }
  currentMarkdown = generateSummary(meta, text);
  selectors.output.innerHTML = `<div class="callout">Draft output for clinical review. Verify medication reconciliation and source-document citations before patient care use.</div>${markdownToHtml(currentMarkdown)}`;
});

selectors.clear.addEventListener("click", () => {
  selectors.meta.value = "";
  selectors.input.value = "";
  currentMarkdown = "";
  selectors.output.innerHTML = `<p class="empty-state">Load the synthetic software sample or paste a test case. This static demo makes no network model calls.</p>`;
});

selectors.copyMarkdown.addEventListener("click", async () => {
  if (!currentMarkdown) return;
  await navigator.clipboard.writeText(currentMarkdown);
  selectors.copyMarkdown.textContent = "Copied";
  setTimeout(() => {
    selectors.copyMarkdown.textContent = "Copy Markdown";
  }, 1200);
});

selectors.downloadMarkdown.addEventListener("click", () => {
  if (!currentMarkdown) return;
  const blob = new Blob([currentMarkdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "physician-follow-up-summary.md";
  anchor.click();
  URL.revokeObjectURL(url);
});

selectors.printSummary.addEventListener("click", () => {
  if (currentMarkdown) window.print();
});

loadSample();
