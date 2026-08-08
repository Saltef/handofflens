function dedupeEvidenceInPlace(list) {
  const kept = [];
  const groups = [];
  for (const item of list) {
    const duplicateOf = kept.findIndex((candidate) => nearDuplicateEvidence(candidate, item));
    if (duplicateOf >= 0) {
      groups.push({
        kept_index: duplicateOf,
        kept_label: kept[duplicateOf].label,
        removed_label: item.label,
        reason: duplicateReason(kept[duplicateOf], item),
      });
      continue;
    }
    kept.push(item);
  }
  const removedItems = list.length - kept.length;
  list.splice(0, list.length, ...kept);
  return { removed_items: removedItems, groups };
}

function nearDuplicateEvidence(a, b) {
  const labelA = normalize(a.label);
  const labelB = normalize(b.label);
  const quoteA = normalize(a.source_quote);
  const quoteB = normalize(b.source_quote);
  if (labelA && quoteA && labelA === labelB && quoteA === quoteB) return true;
  if (quoteA && quoteA === quoteB && tokenOverlap(labelA, labelB) >= 0.8) return true;
  if (containmentOverlap(quoteA, quoteB) >= 0.92 && tokenOverlap(labelA, labelB) >= 0.55) return true;
  if (tokenOverlap(quoteA, quoteB) >= 0.92 && tokenOverlap(labelA, labelB) >= 0.65) return true;
  return false;
}

function duplicateReason(a, b) {
  if (normalize(a.source_quote) === normalize(b.source_quote)) return "same_source_quote";
  if (containmentOverlap(normalize(a.source_quote), normalize(b.source_quote)) >= 0.92) return "contained_source_quote";
  return "high_token_overlap";
}

function normalize(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function contentTokens(value) {
  const stop = new Set(["the", "and", "with", "for", "from", "this", "that", "was", "were", "are", "sig", "daily"]);
  return normalize(value).replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((token) => token.length >= 3 && !stop.has(token));
}

function tokenOverlap(a, b) {
  const A = new Set(contentTokens(a));
  const B = new Set(contentTokens(b));
  if (!A.size || !B.size) return 0;
  const intersection = [...A].filter((token) => B.has(token)).length;
  return intersection / Math.min(A.size, B.size);
}

function containmentOverlap(a, b) {
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  return tokenOverlap(a, b);
}

module.exports = {
  dedupeEvidenceInPlace,
  nearDuplicateEvidence,
};
