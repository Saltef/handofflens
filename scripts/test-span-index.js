#!/usr/bin/env node

const assert = require("node:assert/strict");
const { buildSpanIndex } = require("./span-index");

const source = [
  "DISCHARGE MEDICATIONS: Aspirin 81 mg daily / Metformin 500 mg BID.",
  "HOSPITAL COURSE:",
  "Admission: Lasix 40 mg daily. Discharge: Furosemide 20 mg daily.",
  "FOLLOW-UP: Cardiology in one week, with BMP before visit.",
].join("\n");

const first = buildSpanIndex(source, { granularity: "clause" });
const second = buildSpanIndex(source, { granularity: "clause" });

assert.deepEqual(
  first.spans.map((span) => ({ id: span.id, text: span.text, char_start: span.char_start, char_end: span.char_end, section: span.section, line: span.line })),
  second.spans.map((span) => ({ id: span.id, text: span.text, char_start: span.char_start, char_end: span.char_end, section: span.section, line: span.line })),
);

for (const span of first.spans) {
  assert.equal(source.slice(span.char_start, span.char_end), span.text, `${span.id} offsets must slice exactly to span.text`);
}

assert.ok(first.spans.some((span) => span.text === "Aspirin 81 mg daily" && span.section === "medications"));
assert.ok(first.spans.some((span) => span.text === "Metformin 500 mg BID." && span.section === "medications"));
assert.ok(first.spans.some((span) => span.text === "Admission: Lasix 40 mg daily."));
assert.ok(first.spans.some((span) => span.text === "Discharge: Furosemide 20 mg daily."));
assert.ok(first.spans.some((span) => span.text === "Cardiology in one week"));
assert.ok(first.spans.some((span) => span.text === "with BMP before visit."));
assert.equal(first.byId.get("S1").id, "S1");
assert.equal(first.render().split("\n").length, first.spans.length);

const lineIndex = buildSpanIndex(source, { granularity: "line" });
assert.equal(lineIndex.spans.length, 3);
assert.equal(lineIndex.spans[0].text, "DISCHARGE MEDICATIONS: Aspirin 81 mg daily / Metformin 500 mg BID.");

const sentenceIndex = buildSpanIndex(source, { granularity: "sentence" });
assert.ok(sentenceIndex.spans.some((span) => span.text === "Admission: Lasix 40 mg daily."));
assert.ok(sentenceIndex.spans.some((span) => span.text === "Discharge: Furosemide 20 mg daily."));

assert.throws(() => buildSpanIndex(source, { granularity: "paragraph" }), /Unsupported span granularity/);

console.log("PASS span index (15 assertions)");
