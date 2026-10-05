// Support Signal page. Depends on engine functions (parseCSV, autoMap, mapColumns,
// readSummary, runAudit) and RULES being in scope.
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const OUT = RULES.meta.outcomes;
  const label = (o) => (OUT[o] ? OUT[o].label : o);
  const chip = (o, text) => `<span class="chip chip-${o}">${esc(text || label(o))}</span>`;
  const checkDef = Object.fromEntries(RULES.checks.map((c) => [c.id, c]));

  // demo data: one export with history; the snapshot is the same rows read without the history columns
  const demoParsed = parseCSV(document.getElementById("demo-cases").textContent);
  const demoHistory = parseCSV(document.getElementById("demo-history").textContent).records;
  const SNAPSHOT_DROP = ["reopens", "assignee_stations", "group_stations", "requester_wait_minutes"];
  // One bot export per case export. The snapshot pair has no case links, so B11 is amber
  // there and green on the pair with history; the switch alone shows both states.
  const demoBot = (id) => { const b = parseCSV(document.getElementById(id).textContent);
    return { records: b.records, mapping: autoMap(b.headers, RULES, "bot"), headers: b.headers }; };
  const DEMO_BOT = { "demo-snapshot": "demo-bot-snapshot", "demo-history": "demo-bot-history" };

  const state = { source: "demo-snapshot", report: null, upload: null, uploadHistory: null, uploadBot: null,
    mapping: null, confidence: {}, refused: {}, driversOn: false,
    required: new Set(Object.entries(RULES.fields).filter(([, f]) => f.required).map(([k]) => k)) };

  function runDemo(kind) {
    const headers = kind === "demo-snapshot" ? demoParsed.headers.filter((h) => !SNAPSHOT_DROP.includes(h)) : demoParsed.headers;
    const mapping = autoMap(headers, RULES);
    // headers is passed so row identity is judged on the columns actually in play.
    return runAudit({ records: demoParsed.records, mapping, headers, history: kind === "demo-history" ? demoHistory : null,
      bot: demoBot(DEMO_BOT[kind]), rules: RULES, source: kind });
  }

  // ---------- render ----------
  function render() {
    const r = state.report;
    $("#report").hidden = !r;
    $("#upload-panel").hidden = state.source !== "upload";
    if (!r) return;
    const src = { "demo-snapshot": "Demo company, snapshot export", "demo-history": "Demo company, export with history", upload: "Your export" }[state.source];
    $("#run-meta").textContent = `${src}, ${r.meta.cases.toLocaleString()} cases${
      r.meta.shape === "one_row_per_comment" ? ` from ${r.meta.rows.toLocaleString()} comment rows` : ""}${
      r.meta.history_rows ? `, ${r.meta.history_rows.toLocaleString()} history records` : ""}`;
    // Only worth a block when there is something to say beyond "one row per case".
    const L = r.load;
    const notable = L.shape === "one_row_per_comment" || L.duplicate_rows || L.no_id_rows
      || L.conflicts.length || L.derived.length;
    $("#load-note").innerHTML = notable ? loadBlock(L) : "";
    renderUses(r); renderFix(r); renderAudit(r); renderSignals(r); renderDrivers(r); renderChecks(r); renderVendor(r);
    $("#stamp").textContent = `Rules ${r.meta.rules} (${r.meta.rules_status}), engine ${r.meta.engine}, run ${new Date(r.meta.generated).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}`;
  }

  function renderUses(r) {
    // A use that needs a file nobody supplied isn't a verdict on this export, so it
    // stays off the panel until that file arrives.
    $("#uses").innerHTML = r.uses.filter((u) => !u.needs_file || u.file_supplied).map((u) => {
      const bl = u.blockers.map((id) => {
        const c = r.checks[id];
        // C4 on a conflict is about named columns, so name them and say what to do.
        const extra = c.conflict_labels && c.conflict_labels.length
          ? `<span class="use-bl-why">${esc(c.conflict_labels.join(", "))}${
              u.conflicts_are_context_only ? ", which this use only reads as context" : ""}. ${esc(c.fix || "")}</span>`
          : "";
        return `<li><a href="#check-${id}">${esc(c.title)}</a>${extra}</li>`;
      }).join("");
      // Verdict words for a use. The check list keeps the outcome labels from the
      // rules ("Not in export", "Needs a human"); these read as answers, not states.
      const verdict = { pass: "Ready", warn: "Usable with care", fail: "Not ready",
        not_in_export: "Not in this export", needs_human: "Can't tell yet" }[u.outcome];
      return `<article class="use use-${u.outcome}">
        <div class="use-top">${chip(u.outcome === "not_in_export" ? "fail" : u.outcome, verdict)}</div>
        <h3>${esc(u.title)}</h3>
        ${bl ? `<p class="use-why">Held back by</p><ul class="use-bl">${bl}</ul>` : `<p class="use-why">Nothing holding it back.</p>`}
      </article>`;
    }).join("");
  }

  function renderFix(r) {
    $("#fix").innerHTML = r.fixFirst.map((id, i) => {
      const c = r.checks[id];
      return `<li><span class="fix-n">${i + 1}</span><div><a href="#check-${id}" class="fix-t">${esc(c.title)}</a><p>${esc(checkDef[id].fix)}</p></div></li>`;
    }).join("") || "<li>Nothing urgent.</li>";
  }

  function renderSignals(r) {
    $("#signals").innerHTML = r.signals.map((s) => {
      if (s.state === "locked") return `<article class="sig sig-locked"><p class="sig-state">Locked</p><h3>${esc(s.title)}</h3><p class="sig-shows">${esc(s.shows)}</p><p class="sig-reason">${esc(s.reason)}</p></article>`;
      const rows = (s.rows || []).map((row) => `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("");
      return `<article class="sig sig-${s.state}"><p class="sig-state">${s.state === "caution" ? "On, with care" : "On"}</p><h3>${esc(s.title)}</h3>
        <p class="sig-head">${esc(s.headline)}</p><p class="sig-detail">${esc(s.detail)}</p>
        ${rows ? `<div class="tbl"><table>${rows}</table></div>` : ""}
        <p class="sig-disc">${esc(s.disclaimer)}</p></article>`;
    }).join("");
  }

  function renderDrivers(r) {
    const d = r.drivers;
    const box = $("#drivers-body");
    if (!d.available) { box.innerHTML = `<p class="muted">${esc(d.reason)}</p>`; $("#drivers-toggle").hidden = true; return; }
    $("#drivers-toggle").hidden = false;
    const res = [...d.results].sort((a, b) => b.raw.or - a.raw.or);
    const W = 760, L = 300, Rr = 40, rowH = 34, top = 38, H = top + res.length * rowH + 30;
    const lo = 0.25, hi = 8, X = (v) => L + ((Math.log(Math.min(hi, Math.max(lo, v))) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * (W - L - Rr);
    const ticks = [0.25, 0.5, 1, 2, 4, 8];
    const rows = res.map((x, i) => {
      const y = top + i * rowH + rowH / 2;
      return `<g class="drow" data-i="${i}">
        <text x="0" y="${y + 4}" class="dl">${esc(x.label)}</text>
        <rect class="wh" x="0" y="${y - 1}" width="1" height="2"></rect>
        <g class="dot" data-y="${y}"><circle r="6"></circle></g>
        <text x="${W - 2}" y="${y + 4}" text-anchor="end" class="dtag"></text>
      </g>`;
    }).join("");
    const axis = ticks.map((t) => `<g><line x1="${X(t)}" x2="${X(t)}" y1="${top - 8}" y2="${H - 26}" class="${t === 1 ? "one" : "grid"}"></line><text x="${X(t)}" y="${H - 8}" text-anchor="middle" class="tick">${t}×</text></g>`).join("");
    box.innerHTML = `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Odds of churn for each flag, before and after controls">
        <text x="${L}" y="16" class="axt">Odds of churning, accounts with the flag versus without</text>
        <text x="${X(1) - 6}" y="32" text-anchor="end" class="axs">less likely</text><text x="${X(1) + 6}" y="32" class="axs">more likely</text>
        ${axis}${rows}</svg></div><p class="drivers-caption" aria-live="polite"></p>`;
    box._res = res; box._X = X; box._d = d;
    updateDrivers();
  }
  function updateDrivers() {
    const box = $("#drivers-body"), res = box._res, X = box._X, d = box._d, on = state.driversOn;
    if (!res) return;
    box.querySelectorAll(".drow").forEach((g) => {
      const x = res[+g.dataset.i], v = on ? x.adj || x.raw : x.raw;
      g.setAttribute("class", `drow drow-${on ? x.verdict : "raw"}`);
      const dot = g.querySelector(".dot");
      dot.style.transform = `translate(${X(v.or)}px, ${dot.dataset.y}px)`;
      g.querySelector(".wh").style.transform = `translateX(${X(v.lo)}px) scaleX(${Math.max(1, X(v.hi) - X(v.lo))})`;
      g.querySelector(".dtag").textContent = on ? { holds: "holds", falls_away: "falls away", reverses: "looks protective, likely chance", too_few: "too few" }[x.verdict] : `${x.raw.or.toFixed(1)}×`;
    });
    const held = d.results.filter((x) => x.holds).length;
    box.querySelector(".drivers-caption").innerHTML = on
      ? `<strong>${held} of ${d.results.length} hold up</strong> once ${esc(d.controls.join(" and "))} are controlled. The rest were riding on which product the account uses and how many cases it raises. Test this many flags and the odd one will look protective by chance.`
      : `<strong>${d.results.filter((x) => x.raw.lo > 1).length} of ${d.results.length} look like churn drivers</strong> on the raw numbers. ${d.accounts.toLocaleString()} accounts, ${(d.churn_rate * 100).toFixed(0)}% churned. Lines show the 95% confidence range.`;
    $("#drivers-toggle").textContent = on ? "Show the raw numbers" : `Control for ${d.controls.join(" and ")}`;
    $("#drivers-toggle").setAttribute("aria-pressed", String(on));
  }

  function renderChecks(r) {
    const bands = [["C", "Can it be read?"], ["B", "Is it faithful?"], ["A", "Is it fit for use?"]];
    $("#checks").innerHTML = bands.map(([b, h]) => {
      const list = Object.values(r.checks).filter((c) => c.band === b);
      return `<section class="band"><h3>${h} <span class="band-id">Band ${b}</span></h3>${list.map((c) => {
        const d = checkDef[c.id];
        const refs = (d.refs || []).map((k) => `<a href="${esc(RULES.refs[k].url)}" target="_blank" rel="noopener">${esc(RULES.refs[k].title)}</a>`).join(", ");
        return `<details class="chk" id="check-${c.id}"><summary>${chip(c.outcome)}<span class="chk-t">${esc(c.title)}</span><span class="chk-v">${esc(c.display)}</span></summary>
          <div class="chk-body"><p>${esc(c.detail)}</p>
          ${(c.cautions || []).map((x) => `<p class="chk-caution"><strong>${esc(x.title)}.</strong> ${esc(x.text)}</p>`).join("")}
          <dl><dt>Why it matters</dt><dd>${esc(d.why)}</dd><dt>How to fix</dt><dd>${esc(d.fix)}</dd><dt>Measured as</dt><dd>${esc(d.metric)}</dd>
          ${c.threshold ? `<dt>Threshold</dt><dd>${esc(c.threshold)}${d.threshold && d.threshold.provisional ? " (provisional)" : ""}</dd>` : ""}
          ${d.note ? `<dt>Note</dt><dd>${esc(d.note)}</dd>` : ""}
          ${refs ? `<dt>Sources</dt><dd>${refs}</dd>` : ""}<dt>Rule</dt><dd class="mono">${c.id}, ${esc(d.dimension)}</dd></dl></div></details>`;
      }).join("")}</section>`;
    }).join("");
  }


  // ---------- the resolution audit ----------
  // Reads report.resolution_audit and B11 only. Every figure on the demo sources is
  // planted by the generator, so each one is labelled as such: nothing here is a
  // finding about AI agents in general.
  function renderAudit(r) {
    const a = r.resolution_audit, b = r.checks.B11, box = $("#audit");
    const demo = state.source !== "upload";
    const demoNote = demo
      ? `<p class="audit-demo">Planted demo data. Larkspur is fictional and these counts are exactly what the generator planted, not evidence about AI agents.</p>`
      : "";

    // No bot file at all. The case export isn't the problem, so don't say it is.
    if (!a || !a.available) {
      box.className = "audit";
      // The engine's reason only earns a line when it says something the heading doesn't.
      const why = a && a.reason && !/no bot conversations export/i.test(a.reason) ? `<p>${esc(a.reason)}</p>` : "";
      box.innerHTML = `<div class="audit-tile audit-empty">
        <h3>No bot conversations file yet.</h3>
        <p>Add one and this screen fills in: one row per AI conversation, with the cases that followed it. Nothing is wrong with the export you gave; this question just needs a second file.</p>${why}
        <p><button type="button" class="btn" id="audit-upload">Add a bot conversations file</button></p></div>`;
      $("#audit-upload").addEventListener("click", () => { setSource("upload"); $("#file-bot").focus(); });
      return;
    }

    const verdict = `<div class="audit-tile audit-verdict">${chip(b.outcome)}
      <h3>${esc(b.title)}</h3><p>${esc(b.detail)}</p></div>`;

    // Amber means matching would have to be inferred from timing, which isn't
    // implemented. Show can't tell and say so; never dress it as "usable with care".
    if (a.basis !== "case_links") {
      box.className = "audit";
      box.innerHTML = `${verdict}
        <div class="audit-figs">
          ${fig("cant_tell", a.buckets.cant_tell, "Can't tell", "Every conversation the bot claimed it resolved.")}
          ${fig("claimed", a.claimed, "Claimed resolved", "Conversations the bot said it had resolved.")}
        </div>
        <div class="audit-tile audit-disc"><p>Matching returns by account and timing alone isn't supported yet, so none of these conversations could be audited. This is a limit of this tool, not a fault in the export.</p></div>
        ${demoNote}`;
      return;
    }

    const cum = a.contradicted_cumulative.map((w) =>
      row(`Within ${w.days} days`, w.contradicted.toLocaleString(), pctOf(w.contradicted, a.claimed))).join("");
    const by = [["reopened", "Reopened"], ["escalated", "Escalated to a human"], ["same_theme", "Same theme back"]]
      .map(([k, lab]) => row(lab, a.contradicted_by[k].toLocaleString(), pctOf(a.contradicted_by[k], a.claimed))).join("");

    box.className = "audit";
    box.innerHTML = `${verdict}
      <div class="audit-figs">
        ${fig("claimed", a.claimed, "Claimed resolved", "Conversations the bot said it had resolved.")}
        ${fig("contradicted", a.buckets.contradicted, "Contradicted", "Something happened next that the claim can't survive.")}
        ${fig("not_contradicted", a.buckets.not_contradicted, "Not contradicted", "Nothing followed within " + a.params.return_windows_days.slice(-1)[0] + " days.")}
      </div>
      ${a.buckets.cant_tell ? `<div class="audit-figs">${fig("cant_tell", a.buckets.cant_tell, "Can't tell", "The theme couldn't be read, so no return was looked for.")}</div>` : ""}
      <div class="audit-split">
        <div class="audit-tile"><h4>Contradicted, by when</h4>
          <p class="s muted">Cumulative: each window includes the ones before it.</p>
          <div class="audit-rows">${cum}</div></div>
        <div class="audit-tile"><h4>Contradicted, by what happened</h4>
          <p class="s muted">Counted in this order, so a conversation that was both is counted once.</p>
          <div class="audit-rows">${by}</div></div>
      </div>
      <div class="audit-tile audit-disc"><p>${esc(a.disclaimer)}</p></div>
      ${demoNote}`;
  }
  const pctOf = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : "n/a");
  const row = (k, v, s2) => `<div><span>${esc(k)}</span><span><span class="v">${esc(v)}</span> <span class="muted">${esc(s2)}</span></span></div>`;
  const fig = (kind, n, k, s2) => `<div class="audit-tile audit-fig audit-fig-${kind}">
    <span class="n">${Number(n).toLocaleString()}</span><span class="k">${esc(k)}</span><span class="s">${esc(s2)}</span></div>`;

  function renderVendor(r) { $("#vendor").innerHTML = r.vendor_questions.map((q) => `<li>${esc(q)}</li>`).join(""); }

  // ---------- upload ----------
  function readFile(input) {
    return new Promise((res, rej) => { const f = input.files[0]; if (!f) return res(null); const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsText(f); });
  }
  async function onCases() {
    const text = await readFile($("#file-cases"));
    if (!text) return;
    state.upload = parseCSV(text);
    // Values are passed too: a column no name matches can still be inferred from them.
    const m = mapColumns({ headers: state.upload.headers, rules: RULES, records: state.upload.records });
    state.mapping = m.map;
    state.confidence = m.confidence;
    state.refused = m.refused || {};
    renderMapping();
    $("#upload-status").textContent = `${state.upload.records.length.toLocaleString()} rows, ${state.upload.headers.length} columns read. Check the mapping, then run.`;
    renderRead();
  }

  // What was read, said before anything is judged: the file's shape, what it
  // collapsed to, and anything dropped or disagreeing. Recomputed whenever the
  // mapping changes, because the mapping is what decides which columns are
  // case-level and so what counts as a disagreement.
  function renderRead() {
    const box = $("#load-read");
    if (!state.upload) { box.innerHTML = ""; return; }
    // The engine's own summary, so this says exactly what the report will say.
    const L = readSummary({ records: state.upload.records, headers: state.upload.headers,
      map: state.mapping, rules: RULES });
    box.innerHTML = loadBlock(L, { beforeRun: true });
  }

  // One renderer for both places this is shown: beside the file picker before a
  // run, and under the verdicts after one.
  function loadBlock(L, { beforeRun = false } = {}) {
    const n = (x) => Number(x || 0).toLocaleString();
    const comment = L.shape === "one_row_per_comment";
    const per = L.comments_per_case;
    const bits = [];
    bits.push(comment
      ? `<li><strong>${n(L.rows)} rows</strong> for <strong>${n(L.cases)} cases</strong>. The case fields repeat on every row, so this export is one row per comment or email, not one row per case. It was collapsed to one row per case before any check ran.</li>`
      : `<li><strong>${n(L.rows)} rows</strong> for <strong>${n(L.cases)} cases</strong>: one row per case${
          L.duplicate_rows ? ", once the repeated rows below are set aside" : ""}.</li>`);
    if (L.comments) {
      bits.push(`<li><strong>${n(L.comments)} comments</strong> read across ${n(L.cases_with_comments)} cases${
        per ? `, ${per.median} per case typically (${per.min} to ${per.max})` : ""}.</li>`);
    } else if (comment && !L.comment_fields.length) {
      bits.push(`<li>No comment columns were recognised, so the extra rows were collapsed but their contents couldn't be read. Map a comment body and time below to use them.</li>`);
    }
    if (L.duplicate_rows) {
      // The note is only set where the drop changes what a number means, so it is
      // printed when the engine supplies one rather than written out again here.
      const d = (L.dropped || []).find((x) => x.note);
      bits.push(`<li><strong>${n(L.duplicate_rows)} rows dropped</strong>: each repeated an earlier row identically in every column.${
        d ? ` ${esc(d.note)}` : ""}</li>`);
    }
    if (L.no_id_rows) bits.push(`<li><strong>${n(L.no_id_rows)} rows have no case ID.</strong> Each is counted as its own case, because there is nothing to group it by.</li>`);
    for (const d of L.derived || []) bits.push(`<li><strong>${esc(d.label)} derived.</strong> ${esc(d.detail)}</li>`);
    const conflicts = (L.conflicts || []).map((c) =>
      `<li><strong>${esc(c.label)}</strong> differs between rows of <strong>${n(c.cases)} cases</strong>. The first row's value was used. If this column holds a value per comment rather than per case, map it to a comment field below instead.</li>`).join("");
    return `<div class="load${conflicts ? " load-warn" : ""}">
      <h4>${conflicts ? "What was read, and what disagreed" : "What was read"}</h4>
      <ul>${bits.join("")}${conflicts}</ul>
      ${beforeRun && comment ? `<p class="s muted">Nothing is thrown away: the comment text is read by the wording checks, and the last update is taken from the latest public comment when no column carries it.</p>` : ""}
    </div>`;
  }
  async function onHistory() {
    const text = await readFile($("#file-history"));
    state.uploadHistory = text ? parseCSV(text).records : null;
    $("#history-status").textContent = state.uploadHistory ? `${state.uploadHistory.length.toLocaleString()} change records read.` : "";
  }
  // Mapped in bot scope, so bot synonyms are never offered a case file's columns.
  async function onBot() {
    const text = await readFile($("#file-bot"));
    if (!text) { state.uploadBot = null; $("#bot-status").textContent = ""; return; }
    const b = parseCSV(text);
    state.uploadBot = { records: b.records, headers: b.headers,
      mapping: mapColumns({ headers: b.headers, rules: RULES, scope: "bot", records: b.records }).map };
    const found = Object.keys(state.uploadBot.mapping).filter((k) => k.startsWith("bot_")).length;
    $("#bot-status").textContent = `${b.records.length.toLocaleString()} conversations read, ${found} bot fields recognised.`;
  }
  // How a field got its column. A guess is worth checking; a missing required field is
  // worth fixing before anything is run on it.
  function mapState(k) {
    if (!state.mapping[k]) {
      // A column was offered and turned down: a gap with a reason is not the same as a
      // gap, and without saying so the only clue is a field that looks unmatched.
      if (state.refused[k]) return "refused";
      return state.required.has(k) ? "missing" : "none";
    }
    return state.confidence[k] === "guess" ? "guess" : "name";
  }
  const MAP_NOTE = {
    name: "Matched by name",
    guess: "Guessed from values",
    missing: "Not found, and needed",
    none: "Not found",
  };
  // The reason, with the column named, because the fix is to move that column.
  function mapNote(k) {
    const r = state.refused[k];
    if (!r) return MAP_NOTE[mapState(k)];
    return `“${r.header}” changes between a case's comment rows, so it isn't a case field. Map it as a comment field, or leave it.`;
  }

  function renderMapping() {
    const opts = (sel) => `<option value="">Not in export</option>` + state.upload.headers.map((h) => `<option value="${esc(h)}"${h === sel ? " selected" : ""}>${esc(h)}</option>`).join("");
    const pii = state.upload.headers.filter((h) => /e-?mail|phone|mobile|name$|first name|last name|address/i.test(h));
    // Required fields first: nothing else matters until those are right. Comment
    // fields last, because they only apply to a one-row-per-comment export and
    // mixing them in among the case fields makes both harder to scan.
    const tier = ([k, f]) => (f.required ? 0 : (f.level || "case") === "comment" ? 2 : 1);
    const fields = Object.entries(RULES.fields).filter(([, f]) => (f.file || "case") !== "bot")
      .sort((a, b) => tier(a) - tier(b));
    const rows = fields.map(([k, f]) => {
      const st = mapState(k);
      const mark = f.required ? " <span class='req'>required</span>"
        : (f.level || "case") === "comment" ? " <span class='lvl'>per comment</span>" : "";
      return `<tr class="map-${st}"><td>${esc(f.label)}${mark}</td>
        <td><select id="map-${k}" data-k="${k}">${opts(state.mapping[k])}</select></td>
        <td class="map-note">${esc(mapNote(k))}</td></tr>`;
    }).join("");
    const missing = fields.filter(([k]) => mapState(k) === "missing").map(([, f]) => f.label);
    const guesses = fields.filter(([k]) => mapState(k) === "guess").length;
    $("#mapping").innerHTML = `${
      missing.length ? `<p class="map-alert">Required ${missing.length > 1 ? "fields" : "field"} not found: <strong>${missing.map(esc).join(", ")}</strong>. Pick the right column below, or the checks that need ${missing.length > 1 ? "them" : "it"} can't run.</p>` : ""
    }${
      guesses ? `<p class="map-hint">${guesses} ${guesses > 1 ? "fields were" : "field was"} guessed from the values rather than the column name. Worth a look before you run.</p>` : ""
    }${(() => {
      const r = Object.entries(state.refused || {});
      return r.length ? `<p class="map-hint">This export has one row per comment, so ${r.length > 1 ? "these columns were" : "this column was"} not mapped to a case field: <strong>${r.map(([, x]) => esc(x.header)).join(", ")}</strong>. ${r.length > 1 ? "Their values change" : "Its values change"} between rows of the same case, so ${r.length > 1 ? "they hold" : "it holds"} a value per comment rather than per case. Map ${r.length > 1 ? "them" : "it"} to a comment field if that's what ${r.length > 1 ? "they are" : "it is"}.</p>` : "";
    })()}<div class="tbl"><table class="map"><thead><tr><th>Field</th><th>Your column</th><th>How</th></tr></thead><tbody>${rows}</tbody></table></div>${
      pii.length ? `<p class="pii">These columns look like personal data and are ignored unless you map them: ${pii.map(esc).join(", ")}.</p>` : ""}`;
    $("#mapping").querySelectorAll("select").forEach((s) => s.addEventListener("change", () => {
      const k = s.dataset.k;
      if (s.value) {
        // One column, one field, by hand as well as automatically. Reading the same
        // column as both created and closed would quietly corrupt every duration.
        for (const [other, col] of Object.entries(state.mapping)) {
          if (other !== k && col === s.value) { delete state.mapping[other]; delete state.confidence[other]; }
        }
        state.mapping[k] = s.value; state.confidence[k] = "name";
      } else { delete state.mapping[k]; delete state.confidence[k]; }
      renderMapping();   // the How column and the alerts have to keep up
      renderRead();      // and so does what was read: the mapping decides what conflicts
    }));
    $("#run-upload").disabled = false;
  }
  function runUpload() {
    try {
      state.report = runAudit({ records: state.upload.records, mapping: state.mapping, headers: state.upload.headers,
        history: state.uploadHistory, bot: state.uploadBot, rules: RULES, source: "upload" });
      state.driversOn = false; render();
      $("#summary").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    } catch (e) { $("#upload-status").textContent = `Couldn't run the checks: ${e.message}. Check that the required columns are mapped.`; }
  }

  // ---------- wiring ----------
  function setSource(src) {
    state.source = src;
    document.querySelectorAll("[data-src]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.src === src)));
    if (src === "upload") state.report = null;
    else state.report = runDemo(src);
    state.driversOn = false;
    render();
  }
  document.querySelectorAll("[data-src]").forEach((b) => b.addEventListener("click", () => setSource(b.dataset.src)));
  $("#drivers-toggle").addEventListener("click", () => { state.driversOn = !state.driversOn; updateDrivers(); });
  $("#file-cases").addEventListener("change", onCases);
  $("#file-history").addEventListener("change", onHistory);
  $("#file-bot").addEventListener("change", onBot);
  $("#run-upload").addEventListener("click", runUpload);
  $("#copy-report").addEventListener("click", async () => {
    const text = JSON.stringify(state.report, null, 2);
    try { await navigator.clipboard.writeText(text); $("#copy-status").textContent = "Report copied as JSON."; }
    catch { const t = $("#report-json"); t.hidden = false; t.value = text; t.select(); $("#copy-status").textContent = "Copy the selected text."; }
  });
  setSource("demo-snapshot");
})();
