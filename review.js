(() => {
  const state = { packet: null, caseIndex: 0, outputIndex: 0, storageKey: "" };
  const elements = Object.fromEntries([
    "reviewerId", "packetFile", "loadButton", "emptyLoadButton", "exportButton", "emptyState", "workspace",
    "progressText", "progressPercent", "progressFill", "caseList", "casePosition", "caseTitle", "caseMeta",
    "modelTabs", "sourceToggle", "sourceText", "summaryTitle", "summaryText", "claimCount", "claims",
    "omissions", "globalReview", "previousButton", "nextButton", "saveStatus"
  ].map((id) => [id, document.getElementById(id)]));

  elements.loadButton.addEventListener("click", () => elements.packetFile.click());
  elements.emptyLoadButton.addEventListener("click", () => elements.packetFile.click());
  elements.packetFile.addEventListener("change", loadFile);
  elements.exportButton.addEventListener("click", exportReview);
  elements.reviewerId.addEventListener("input", () => {
    if (!state.packet) return;
    state.packet.reviewer_id = elements.reviewerId.value.trim();
    saveLocal();
  });
  elements.previousButton.addEventListener("click", () => moveOutput(-1));
  elements.nextButton.addEventListener("click", () => moveOutput(1));
  elements.sourceToggle.addEventListener("click", () => {
    const collapsed = elements.sourceText.hidden;
    elements.sourceText.hidden = !collapsed;
    elements.sourceToggle.textContent = collapsed ? "Collapse" : "Reveal source";
  });

  loadDefaultPacket();

  async function loadDefaultPacket() {
    if (location.protocol === "file:") return;
    try {
      const response = await fetch("/results/atomic-clinician-review-packet.json", { cache: "no-store" });
      if (!response.ok) return;
      initializePacket(await response.json());
    } catch {
      // File upload remains available when the local review server is not running.
    }
  }

  async function loadFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      initializePacket(JSON.parse(await file.text()));
    } catch (error) {
      window.alert(`Could not load packet: ${error.message}`);
    } finally {
      event.target.value = "";
    }
  }

  function initializePacket(packet) {
    if (!packet || !Array.isArray(packet.cases) || !packet.cases.length) throw new Error("Packet contains no review cases");
    state.storageKey = `handofflens-review:${packet.generated_at || packet.schema_version || "local"}`;
    const saved = localStorage.getItem(state.storageKey);
    state.packet = saved ? mergeSavedPacket(packet, JSON.parse(saved)) : packet;
    state.packet.reviewer_id ||= "";
    state.caseIndex = 0;
    state.outputIndex = 0;
    elements.reviewerId.value = state.packet.reviewer_id;
    elements.emptyState.hidden = true;
    elements.workspace.hidden = false;
    elements.exportButton.disabled = false;
    render();
  }

  function mergeSavedPacket(packet, saved) {
    if (!saved?.cases?.length) return packet;
    const savedOutputs = new Map();
    for (const item of saved.cases) {
      for (const output of item.outputs || []) savedOutputs.set(`${item.case_id}:${output.model_slot}`, output);
    }
    for (const item of packet.cases) {
      item.outputs = item.outputs.map((output) => savedOutputs.get(`${item.case_id}:${output.model_slot}`) || output);
    }
    packet.reviewer_id = saved.reviewer_id || "";
    return packet;
  }

  function render() {
    renderSidebar();
    renderCurrent();
    renderProgress();
  }

  function renderSidebar() {
    elements.caseList.replaceChildren(...state.packet.cases.map((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `case-link${index === state.caseIndex ? " active" : ""}`;
      const completed = item.outputs.filter(outputComplete).length;
      button.innerHTML = `<span>${escapeHtml(item.case_id)}</span><small class="${completed === item.outputs.length ? "done" : ""}">${completed}/${item.outputs.length}</small>`;
      button.addEventListener("click", () => {
        state.caseIndex = index;
        state.outputIndex = 0;
        render();
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
      return button;
    }));
  }

  function renderCurrent() {
    const item = currentCase();
    const output = currentOutput();
    elements.casePosition.textContent = `Case ${state.caseIndex + 1} of ${state.packet.cases.length}`;
    elements.caseTitle.textContent = item.case_id;
    const context = item.patient_context || {};
    elements.caseMeta.textContent = [context.age ? `Age ${context.age}` : "", context.gender, context.admission_diagnosis, context.diagnosis_family].filter(Boolean).join(" | ");
    elements.sourceText.textContent = item.source_discharge_summary || "";
    elements.sourceText.hidden = true;
    elements.sourceToggle.textContent = "Reveal source";
    elements.summaryTitle.textContent = `${output.model_slot} handoff`;
    elements.summaryText.textContent = output.two_page_summary || "No summary was produced.";
    elements.modelTabs.replaceChildren(...item.outputs.map((candidate, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.role = "tab";
      button.textContent = candidate.model_slot;
      button.className = index === state.outputIndex ? "active" : "";
      button.setAttribute("aria-selected", String(index === state.outputIndex));
      button.addEventListener("click", () => {
        state.outputIndex = index;
        render();
      });
      return button;
    }));
    renderClaims(output);
    renderOmissions(output);
    renderGlobal(output);
    const flatIndex = currentFlatIndex();
    const total = allOutputs().length;
    elements.previousButton.disabled = flatIndex === 0;
    elements.nextButton.disabled = flatIndex === total - 1;
    elements.nextButton.textContent = flatIndex === total - 1 ? "Final review" : "Next";
  }

  function renderClaims(output) {
    const sampling = output.claim_sampling || { selected_claims: output.claims.length, total_claims: output.claims.length };
    elements.claimCount.textContent = `${sampling.selected_claims} selected of ${sampling.total_claims}`;
    if (!output.claims.length) {
      const message = document.createElement("div");
      message.className = "claim";
      message.textContent = "No structured claims were produced. Record omissions and the global assessment below.";
      elements.claims.replaceChildren(message);
      return;
    }
    elements.claims.replaceChildren(...output.claims.map((claim) => renderClaim(claim)));
  }

  function renderClaim(claim) {
    const sourceFidelity = state.packet.review_design?.mode === "source_fidelity";
    const flagged = !claim.machine_checks?.quote_found_literally || !claim.machine_checks?.label_numbers_found_in_quote;
    const article = document.createElement("article");
    article.className = `claim${flagged ? " flagged" : ""}`;
    article.innerHTML = `
      <div class="claim-head">
        <div><span class="claim-domain">${escapeHtml(claim.domain)} / ${escapeHtml(claim.relationship)}</span><h3>${escapeHtml(claim.label)}</h3></div>
        <span class="machine-flags">${flagged ? "Machine flag" : "Quote located"}</span>
      </div>
      <p>${escapeHtml(claim.rationale)}</p>
      <p class="quote">${escapeHtml(claim.source_quote || "No source quote")}</p>
      <div class="review-grid"></div>`;
    const grid = article.querySelector(".review-grid");
    grid.append(
      selectField("Factual support", claim.review, "factual_support", ["", "supported", "partially_supported", "unsupported", "not_assessable"]),
      selectField("Relationship support", claim.review, "relationship_support", ["", "supported", "partially_supported", "unsupported", "not_applicable", "not_assessable"]),
      sourceFidelity ? selectField("Error scope", claim.review, "error_scope", ["", "none", "formatting_only", "semantic_error", "not_assessable"]) : selectField("Severity", claim.review, "severity", ["", "none", "minor", "material", "potentially_harmful"]),
      textField("Correction", claim.review, "corrected_text", true),
      textField("Reviewer note", claim.review, "reviewer_note", true)
    );
    return article;
  }

  function renderOmissions(output) {
    const sourceFidelity = state.packet.review_design?.mode === "source_fidelity";
    elements.omissions.replaceChildren(...output.omissions.map((omission) => {
      const row = document.createElement("div");
      row.className = "omission-row";
      const name = document.createElement("div");
      name.className = "omission-name";
      name.textContent = omission.domain.replaceAll("_", " ");
      row.append(
        name,
        selectField("Status", omission, "status", ["", "none", "present", "not_assessable"]),
        sourceFidelity ? selectField("Target explicitness", omission, "target_explicitness", ["", "explicit_in_source", "not_explicit", "not_assessable"]) : selectField("Severity", omission, "severity", ["", "none", "minor", "material", "potentially_harmful"]),
        textField("Description", omission, "description"),
        textField("Source evidence", omission, "source_quote")
      );
      return row;
    }));
  }

  function renderGlobal(output) {
    const sourceFidelity = state.packet.review_design?.mode === "source_fidelity";
    const review = output.global_review;
    const container = document.createElement("div");
    container.className = "global-grid";
    if (sourceFidelity) container.append(
      selectField("Summary fidelity", review, "summary_fidelity", ["", "fully_supported", "contains_semantic_error", "not_assessable"]),
      selectField("Structured completeness", review, "structured_output_completeness", ["", "complete_for_explicit_targets", "explicit_target_missing", "not_assessable"]),
      numberField("Review minutes", review, "review_minutes"),
      textField("Overall comment", review, "overall_comment", true, "wide")
    ); else container.append(
      selectField("Source-record match", review, "source_record_match", ["", "0", "1", "2", "3"], true),
      selectField("Handover safety", review, "handover_safety", ["", "0", "1", "2", "3"], true),
      selectField("Disposition", review, "disposition", ["", "accept_draft", "clinician_spot_check", "full_clinician_review", "reject_or_regenerate"]),
      numberField("Review minutes", review, "review_minutes"),
      textField("Overall comment", review, "overall_comment", true, "wide")
    );
    elements.globalReview.replaceChildren(container);
  }

  function selectField(labelText, object, property, choices, numeric = false) {
    const label = fieldLabel(labelText);
    const select = document.createElement("select");
    for (const choice of choices) {
      const option = document.createElement("option");
      option.value = choice;
      option.textContent = choice ? choice.replaceAll("_", " ") : "Select";
      select.append(option);
    }
    select.value = object[property] ?? "";
    select.addEventListener("change", () => {
      object[property] = numeric && select.value !== "" ? Number(select.value) : select.value;
      changed();
    });
    label.append(select);
    return label;
  }

  function textField(labelText, object, property, textarea = false, extraClass = "") {
    const label = fieldLabel(labelText, extraClass);
    const input = document.createElement(textarea ? "textarea" : "input");
    input.value = object[property] || "";
    input.addEventListener("input", () => {
      object[property] = input.value;
      changed();
    });
    label.append(input);
    return label;
  }

  function numberField(labelText, object, property) {
    const label = fieldLabel(labelText);
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "0.5";
    input.value = object[property] ?? "";
    input.addEventListener("input", () => {
      object[property] = input.value === "" ? null : Number(input.value);
      changed();
    });
    label.append(input);
    return label;
  }

  function fieldLabel(text, extraClass = "") {
    const label = document.createElement("label");
    label.className = `field ${extraClass}`.trim();
    const span = document.createElement("span");
    span.textContent = text;
    label.append(span);
    return label;
  }

  function changed() {
    elements.saveStatus.textContent = "Saving...";
    clearTimeout(changed.timer);
    changed.timer = setTimeout(() => {
      saveLocal();
      renderSidebar();
      renderProgress();
      elements.saveStatus.textContent = "Saved locally";
    }, 250);
  }

  function saveLocal() {
    if (!state.packet) return;
    localStorage.setItem(state.storageKey, JSON.stringify(state.packet));
  }

  function renderProgress() {
    const outputs = allOutputs().map(({ output }) => output);
    const complete = outputs.filter(outputComplete).length;
    const percent = outputs.length ? complete / outputs.length : 0;
    elements.progressText.textContent = `${complete} of ${outputs.length} complete`;
    elements.progressPercent.textContent = `${Math.round(percent * 100)}%`;
    elements.progressFill.style.width = `${percent * 100}%`;
  }

  function outputComplete(output) {
    const sourceFidelity = state.packet.review_design?.mode === "source_fidelity";
    const claimsComplete = output.claims.every((claim) => claim.review.factual_support && claim.review.relationship_support && (sourceFidelity ? claim.review.error_scope : claim.review.severity));
    const omissionsComplete = output.omissions.every((item) => item.status && (sourceFidelity ? item.target_explicitness : item.severity));
    const global = output.global_review;
    return sourceFidelity ? claimsComplete && omissionsComplete && Boolean(global.summary_fidelity) && Boolean(global.structured_output_completeness) : claimsComplete && omissionsComplete && global.source_record_match !== null && global.handover_safety !== null && Boolean(global.disposition);
  }

  function moveOutput(direction) {
    const outputs = allOutputs();
    const target = outputs[currentFlatIndex() + direction];
    if (!target) return;
    state.caseIndex = target.caseIndex;
    state.outputIndex = target.outputIndex;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function allOutputs() {
    return state.packet.cases.flatMap((item, caseIndex) => item.outputs.map((output, outputIndex) => ({ caseIndex, outputIndex, output })));
  }

  function currentFlatIndex() {
    return allOutputs().findIndex((item) => item.caseIndex === state.caseIndex && item.outputIndex === state.outputIndex);
  }

  function currentCase() { return state.packet.cases[state.caseIndex]; }
  function currentOutput() { return currentCase().outputs[state.outputIndex]; }

  function exportReview() {
    state.packet.reviewer_id = elements.reviewerId.value.trim();
    state.packet.review_exported_at = new Date().toISOString();
    const blob = new Blob([`${JSON.stringify(state.packet, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${state.packet.review_design?.mode === "source_fidelity" ? "source-fidelity-review" : "atomic-clinician-review"}-${state.packet.reviewer_id || "anonymous"}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
  }
})();
