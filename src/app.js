// Support Signal page. Depends on engine functions (parseCSV, autoMap, runAudit) and RULES being in scope.
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

  const state = { source: "demo-snapshot", report: null, upload: null, uploadHistory: null, mapping: null, driversOn: false };

  function runDemo(kind) {
    const headers = kind === "demo-snapshot" ? demoParsed.headers.filter((h) => !SNAPSHOT_DROP.includes(h)) : demoParsed.headers;
    const mapping = autoMap(headers, RULES);
    return runAudit({ records: demoParsed.records, mapping, history: kind === "demo-history" ? demoHistory : null, rules: RULES, source: kind });
  }

  // ---------- render ----------
  function render() {
    const r = state.report;
    $("#report").hidden = !r;
    $("#upload-panel").hidden = state.source !== "upload";
    if (!r) return;
    const src = { "demo-snapshot": "Demo company, snapshot export", "demo-history": "Demo company, export with history", upload: "Your export" }[state.source];
    $("#run-meta").textContent = `${src} · ${r.meta.cases.toLocaleString()} cases${r.meta.history_rows ? ` · ${r.meta.history_rows.toLocaleString()} history records` : ""}`;
    renderUses(r); renderFix(r); renderSignals(r); renderDrivers(r); renderChecks(r); renderVendor(r);
    $("#stamp").textContent = `Rules ${r.meta.rules} (${r.meta.rules_status}) · engine ${r.meta.engine} · run ${new Date(r.meta.generated).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}`;
  }

  function renderUses(r) {
    $("#uses").innerHTML = r.uses.map((u) => {
      const bl = u.blockers.map((id) => `<li><a href="#check-${id}">${esc(r.checks[id].title)}</a></li>`).join("");
      const verdict = { pass: "Ready", warn: "Usable with care", fail: "Not ready", not_in_export: "Not possible from this export" }[u.outcome];
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
    const bands = [["C", "Band C · Can it be read?"], ["B", "Band B · Is it faithful?"], ["A", "Band A · Is it fit for use?"]];
    $("#checks").innerHTML = bands.map(([b, h]) => {
      const list = Object.values(r.checks).filter((c) => c.band === b);
      return `<section class="band"><h3>${h}</h3>${list.map((c) => {
        const d = checkDef[c.id];
        const refs = (d.refs || []).map((k) => `<a href="${esc(RULES.refs[k].url)}" target="_blank" rel="noopener">${esc(RULES.refs[k].title)}</a>`).join(" · ");
        return `<details class="chk" id="check-${c.id}"><summary>${chip(c.outcome)}<span class="chk-t">${esc(c.title)}</span><span class="chk-v">${esc(c.display)}</span></summary>
          <div class="chk-body"><p>${esc(c.detail)}</p>
          <dl><dt>Why it matters</dt><dd>${esc(d.why)}</dd><dt>How to fix</dt><dd>${esc(d.fix)}</dd><dt>Measured as</dt><dd>${esc(d.metric)}</dd>
          ${c.threshold ? `<dt>Threshold</dt><dd>${esc(c.threshold)}${d.threshold && d.threshold.provisional ? " (provisional)" : ""}</dd>` : ""}
          ${d.note ? `<dt>Note</dt><dd>${esc(d.note)}</dd>` : ""}
          ${refs ? `<dt>Sources</dt><dd>${refs}</dd>` : ""}<dt>Rule</dt><dd class="mono">${c.id} · ${esc(d.dimension)}</dd></dl></div></details>`;
      }).join("")}</section>`;
    }).join("");
  }

  function renderVendor(r) { $("#vendor").innerHTML = r.vendor_questions.map((q) => `<li>${esc(q)}</li>`).join(""); }

  // ---------- upload ----------
  function readFile(input) {
    return new Promise((res, rej) => { const f = input.files[0]; if (!f) return res(null); const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsText(f); });
  }
  async function onCases() {
    const text = await readFile($("#file-cases"));
    if (!text) return;
    state.upload = parseCSV(text);
    state.mapping = autoMap(state.upload.headers, RULES);
    renderMapping();
    $("#upload-status").textContent = `${state.upload.records.length.toLocaleString()} rows, ${state.upload.headers.length} columns read. Check the mapping, then run.`;
  }
  async function onHistory() {
    const text = await readFile($("#file-history"));
    state.uploadHistory = text ? parseCSV(text).records : null;
    $("#history-status").textContent = state.uploadHistory ? `${state.uploadHistory.length.toLocaleString()} change records read.` : "";
  }
  function renderMapping() {
    const opts = (sel) => `<option value="">Not in export</option>` + state.upload.headers.map((h) => `<option value="${esc(h)}"${h === sel ? " selected" : ""}>${esc(h)}</option>`).join("");
    const pii = state.upload.headers.filter((h) => /e-?mail|phone|mobile|name$|first name|last name|address/i.test(h));
    $("#mapping").innerHTML = `<div class="tbl"><table class="map"><thead><tr><th>Field</th><th>Your column</th></tr></thead><tbody>${
      Object.entries(RULES.fields).map(([k, f]) => `<tr><td>${esc(f.label)}${f.required ? " <span class='req'>required</span>" : ""}</td><td><select id="map-${k}" data-k="${k}">${opts(state.mapping[k])}</select></td></tr>`).join("")
    }</tbody></table></div>${pii.length ? `<p class="pii">These columns look like personal data and are ignored unless you map them: ${pii.map(esc).join(", ")}.</p>` : ""}`;
    $("#mapping").querySelectorAll("select").forEach((s) => s.addEventListener("change", () => { if (s.value) state.mapping[s.dataset.k] = s.value; else delete state.mapping[s.dataset.k]; }));
    $("#run-upload").disabled = false;
  }
  function runUpload() {
    try {
      state.report = runAudit({ records: state.upload.records, mapping: state.mapping, history: state.uploadHistory, rules: RULES, source: "upload" });
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
  $("#run-upload").addEventListener("click", runUpload);
  $("#copy-report").addEventListener("click", async () => {
    const text = JSON.stringify(state.report, null, 2);
    try { await navigator.clipboard.writeText(text); $("#copy-status").textContent = "Report copied as JSON."; }
    catch { const t = $("#report-json"); t.hidden = false; t.value = text; t.select(); $("#copy-status").textContent = "Copy the selected text."; }
  });
  setSource("demo-snapshot");
})();
