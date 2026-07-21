#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

loadEnvFile(".env");

const args = parseArgs(process.argv.slice(2));
const casesPath = required(args.cases, "--cases is required");
const outPath = required(args.out, "--out is required");
const model = args.model || "command-a-plus-05-2026";
const apiKey = process.env.COHERE_API_KEY;
if (!apiKey) throw new Error("Missing COHERE_API_KEY");

const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const results = [];
  for (const testCase of cases) {
    const startedAt = Date.now();
    try {
      const repair = await callCohereSummaryRepair(testCase);
      if (repair.case_id !== testCase.case_id) repair.case_id = testCase.case_id;
      if (!repair.two_page_summary || repair.two_page_summary.trim().length < 80) {
        throw new Error("Summary repair returned empty or uninformative summary");
      }
      results.push({
        provider: "cohere",
        model,
        case_id: testCase.case_id,
        latency_ms: Date.now() - startedAt,
        summary_repair_method: "cohere_summary_only",
        two_page_summary: repair.two_page_summary
      });
      console.log(`${testCase.case_id}: repaired summary`);
    } catch (error) {
      results.push({
        provider: "cohere",
        model,
        case_id: testCase.case_id,
        latency_ms: Date.now() - startedAt,
        error: redactSensitiveText(error.message),
        summary_repair_method: "cohere_summary_only"
      });
      console.error(`${testCase.case_id}: ${redactSensitiveText(error.message)}`);
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    cases_path: casesPath,
    model,
    summary: summarize(results),
    results
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(outPath.replace(/\.json$/i, ".md"), renderMarkdown(report));
  console.log(`Wrote ${outPath}`);
}

async function callCohereSummaryRepair(testCase) {
  const timeoutMs = Number(process.env.COHERE_TIMEOUT_MS || 120000);
  const retries = Number(process.env.COHERE_RETRIES || 2);
  const requestBody = {
    model,
    max_tokens: Number(process.env.COHERE_SUMMARY_MAX_TOKENS || 2500),
    temperature: Number(process.env.COHERE_TEMPERATURE || 0),
    messages: [
      {
        role: "system",
        content: "You are a careful clinical handover summarizer. Use only facts explicitly supported by the supplied de-identified discharge summary. You are not diagnosing or recommending treatment."
      },
      {
        role: "user",
        content: buildPrompt(testCase)
      }
    ]
  };
  applyCohereTuning(requestBody);

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    try {
      const { response, body } = await withTimeout((async () => {
        const response = await fetch("https://api.cohere.com/v2/chat", {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(requestBody)
        });
        const body = await response.json();
        return { response, body };
      })(), timeoutMs, `Cohere summary repair timed out after ${timeoutMs} ms`, controller);
      if (!response.ok) {
        const error = new Error(`Cohere summary repair error ${response.status}: ${JSON.stringify(body)}`);
        error.retryable = response.status >= 500 || response.status === 429;
        throw error;
      }
      return parseSummaryResponse(body);
    } catch (error) {
      lastError = error;
      if (String(error.message || "").includes("timed out")) error.retryable = true;
      if (!error.retryable || attempt === retries) break;
      await sleep(Math.min(30000, 1500 * 2 ** attempt));
    }
  }
  throw lastError;
}

function buildPrompt(testCase) {
  return `Return only a valid JSON object with keys "case_id" and "two_page_summary".

Write "two_page_summary" as a sectioned physician-facing handoff using these headings when supported:
- Reason for hospitalization and main problems
- Hospital course and treatments
- Medication changes
- New or changed diagnoses
- Tests, procedures, and labs
- Follow-up actions and safety concerns

If the source note is short, still write a concise summary of the supported facts. Do not leave the summary empty. Do not invent facts.

Case metadata:
${JSON.stringify({
  case_id: testCase.case_id,
  age: testCase.age,
  gender: testCase.gender,
  admission_diagnosis: testCase.admission_diagnosis
}, null, 2)}

Discharge summary:
${testCase.discharge_summary}`;
}

function parseSummaryResponse(body) {
  const text = cohereMessageText(body);
  if (!text) throw new Error(`Cohere summary repair missing text: ${JSON.stringify(body)}`);
  const parsed = parseJsonFromText(text);
  return {
    case_id: String(parsed.case_id || ""),
    two_page_summary: String(parsed.two_page_summary || "")
  };
}

function applyCohereTuning(request) {
  if (process.env.COHERE_THINKING === "disabled") {
    request.thinking = { type: "disabled" };
  } else if (process.env.COHERE_THINKING_BUDGET) {
    request.thinking = { token_budget: Number(process.env.COHERE_THINKING_BUDGET) };
  }
}

function cohereMessageText(body) {
  const content = body.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => part?.text || "").join("").trim();
  }
  return "";
}

function parseJsonFromText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("Missing JSON text");
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw error;
  }
}

function summarize(results) {
  const completed = results.filter((item) => !item.error);
  return {
    attempted: results.length,
    completed: completed.length,
    failed: results.length - completed.length,
    failure_rate: results.length ? (results.length - completed.length) / results.length : 0
  };
}

function renderMarkdown(report) {
  const lines = [
    "# Empty Summary Repair Report",
    "",
    `Generated: ${report.generated_at}`,
    `Cases: ${report.cases_path}`,
    `Model: ${report.model}`,
    "",
    "| Attempted | Completed | Failed | Failure Rate |",
    "| ---: | ---: | ---: | ---: |",
    `| ${report.summary.attempted} | ${report.summary.completed} | ${report.summary.failed} | ${report.summary.failure_rate.toFixed(3)} |`,
    "",
    "## Failed Cases",
    "",
    "| Case | Error |",
    "| --- | --- |"
  ];
  for (const item of report.results.filter((result) => result.error)) {
    lines.push(`| ${item.case_id} | ${escapeTable(item.error)} |`);
  }
  if (!report.results.some((result) => result.error)) lines.push("| none | |");
  return `${lines.join("\n")}\n`;
}

function escapeTable(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 220);
}

function withTimeout(promise, timeoutMs, message, controller) {
  let timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timeout)),
    new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller?.abort();
        reject(new Error(message));
      }, timeoutMs);
    })
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex < 0) continue;
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function redactSensitiveText(value) {
  return String(value || "").replace(/cohere_[A-Za-z0-9_-]+/g, "[redacted Cohere key]");
}

function required(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}
