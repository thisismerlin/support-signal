// Support Signal engine. Pure functions, no dependencies; runs in the browser and in Node.
// Everything it judges comes from the rules object (compiled from rules/rules.yaml).

export const ENGINE_VERSION = "0.3.0";

// ---------- CSV ----------
export function parseCSV(text) {
  const rows = [];
  let row = [], field = "", i = 0, q = false;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r) => Object.fromEntries(headers.map((h, k) => [h, r[k] ?? ""])));
  return { headers, records };
}

// ---------- column mapping ----------
// Real exports don't use our names. Matching is three steps: normalise a header into
// a small set of plausible forms, score every field/header pair, then assign the best
// scores first so one column can never serve two fields.

const norm = (s) => String(s).toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();

// Leading words that describe the column's type rather than its meaning. Stripped only
// as an *extra* candidate, never in place of the full form, so "date closed" can still
// match closed_at by its full name.
const LEAD_NOISE = ["date time", "datetime", "date", "time", "ticket", "case", "custom field", "field"];

// "CreatedDate" -> "Created Date"; "CSATScore" -> "CSAT Score"; "caseId" -> "case Id".
// The first branch keeps acronyms whole by splitting only before the last capital of a run.
const splitCamel = (s) => String(s)
  .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
  .replace(/([a-z\d])([A-Z])/g, "$1 $2");

// Every form of a header worth matching on. Order is irrelevant; membership is what counts.
export function headerVariants(raw) {
  let s = String(raw ?? "").replace(/^﻿/, "").trim();
  s = s.replace(/__c$/i, "");            // Salesforce custom field suffix
  s = s.replace(/^[A-Za-z0-9]+__(?=[A-Za-z])/, ""); // Salesforce namespace prefix
  const base = norm(splitCamel(s).replace(/[\/.:#()\[\]{}|,;*"'`~!?+=<>%$@^&]+/g, " "));
  const out = new Set();
  if (base) out.add(base);
  // Drop a type-ish leading word: "date time opened" -> "opened".
  for (const lead of LEAD_NOISE) {
    if (base.startsWith(lead + " ")) {
      const rest = base.slice(lead.length + 1).trim();
      if (rest) out.add(rest);
    }
  }
  // Drop a trailing unit or qualifier: "customer wait mins" -> "customer wait".
  const tail = base.replace(/\s+(mins?|minutes?|hrs?|hours?|days?|secs?|seconds?|utc|gmt|local|id)$/,"").trim();
  if (tail && tail !== base) out.add(tail);
  return [...out];
}

const tokens = (s) => s.split(" ").filter(Boolean);
const dice = (a, b) => {
  const A = new Set(a), B = new Set(b);
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return (2 * hit) / (A.size + B.size);
};

// How well one candidate name fits one header variant. 0 means no relationship.
function scorePair(cand, variant) {
  if (!cand || !variant) return 0;
  if (cand === variant) return 100;
  const c = tokens(cand), v = tokens(variant);
  const cs = new Set(c), vs = new Set(v);
  if (cs.size === vs.size && [...cs].every((t) => vs.has(t))) return 80;   // same words, any order
  const sub = [...cs].every((t) => vs.has(t)) || [...vs].every((t) => cs.has(t));
  if (sub) return 68;                                                       // one contains the other
  const d = dice(c, v);
  return d >= 0.5 ? Math.round(40 + d * 25) : 0;                            // partial overlap
}

const NAME_FLOOR = 45;       // below this, a name match is a coincidence, not a match
const inScope = (f, scope) => { const s = f.file || "case"; return s === scope || s === "both"; };

// The full result: the map, plus how each field was matched and how strongly.
export function mapColumns({ headers, rules, scope = "case", records = null }) {
  const fields = Object.entries(rules.fields).filter(([, f]) => inScope(f, scope));
  const order = Object.fromEntries(fields.map(([k], i) => [k, i]));
  const hv = new Map(headers.map((h) => [h, headerVariants(h)]));

  // Score every pair once.
  const pairs = [];
  for (const [key, f] of fields) {
    const cands = [key.replace(/_/g, " "), ...(f.synonyms || [])].flatMap((c) => headerVariants(c));
    for (const h of headers) {
      let best = 0;
      for (const c of cands) for (const v of hv.get(h)) {
        const sc = scorePair(c, v);
        if (sc > best) best = sc;
      }
      if (best >= NAME_FLOOR) pairs.push({ key, header: h, score: best });
    }
  }
  // Best first, then stable by field order and header order, so the result never
  // depends on object iteration luck.
  pairs.sort((a, b) => b.score - a.score || order[a.key] - order[b.key]
    || headers.indexOf(a.header) - headers.indexOf(b.header));

  const map = {}, confidence = {}, scores = {};
  const usedHeader = new Set();
  for (const p of pairs) {
    if (map[p.key] || usedHeader.has(p.header)) continue;   // one field, one column, each way
    map[p.key] = p.header; usedHeader.add(p.header);
    confidence[p.key] = "name"; scores[p.key] = p.score;
  }

  // Anything still unmatched may be inferable from what the column contains.
  if (records && records.length) {
    const guessed = inferFromValues({ fields, headers, records, map, usedHeader });
    for (const [key, header] of Object.entries(guessed)) {
      map[key] = header; usedHeader.add(header);
      confidence[key] = "guess"; scores[key] = null;
    }
  }
  return { map, confidence, scores };
}

// When no name matches, the values sometimes give a field away: a column of parseable
// dates, of near-unique short tokens, of a dozen repeating labels, of long prose. A
// guess is only ever offered for a field whose `shape` it fits, it is always marked a
// guess, and an ambiguous column is left alone — a visible gap beats a quiet mistake.
const SAMPLE = 300;

// parseDate() ends in Date.parse(), which is lenient enough to read "CASE-42" as the
// year 2042 and "ACC-0637" as 637. That is fine when a column is already known to hold
// dates; it is useless for deciding whether it does. Inference asks for a date shape
// first, and only then whether it parses.
const DATE_SHAPES = [
  /^\d{4}-\d{2}-\d{2}([ T]|$)/,              // 2026-03-12, ISO
  /^\d{1,2}[\/.]\d{1,2}[\/.]\d{4}($|[ ,])/,   // 12/03/2026, 12.03.2026
  /^\d{1,2} [A-Za-z]{3,} \d{4}($|[ ,])/,      // 12 March 2026
  /^[A-Za-z]{3,} \d{1,2},? \d{4}($|[ ,])/,    // March 12, 2026
];
const isDateLike = (v) => DATE_SHAPES.some((re) => re.test(v)) && parseDate(v) != null;

function profileColumn(records, header) {
  const vals = [];
  for (const r of records) {
    if (vals.length >= SAMPLE) break;
    const v = String(r[header] ?? "").trim();
    if (v) vals.push(v);
  }
  if (vals.length < 5) return null;                       // too thin to judge
  const distinct = new Set(vals).size;
  const dates = vals.filter(isDateLike).length / vals.length;
  const numeric = vals.filter((v) => v !== "" && Number.isFinite(Number(v))).length / vals.length;
  const avgLen = vals.reduce((a, v) => a + v.length, 0) / vals.length;
  const avgWords = vals.reduce((a, v) => a + v.split(/\s+/).length, 0) / vals.length;
  return { n: vals.length, distinct, unique: distinct / vals.length, dates, numeric, avgLen, avgWords,
    boolish: vals.every((v) => /^(y|n|yes|no|true|false|0|1|t|f)$/i.test(v)) };
}

function fitsShape(shape, p) {
  switch (shape) {
    case "date":     return p.dates >= 0.8;
    case "id":       return p.unique >= 0.95 && p.avgWords < 2 && p.avgLen <= 40 && p.dates < 0.5;
    case "flag":     return p.boolish;
    case "number":   return p.numeric >= 0.9 && p.dates < 0.5;
    case "category": return p.distinct <= 25 && p.unique <= 0.25 && p.avgWords <= 4 && p.dates < 0.5 && !p.boolish;
    case "text":     return p.avgWords >= 5 && p.unique > 0.25;
    default:         return false;
  }
}

function inferFromValues({ fields, headers, records, map, usedHeader }) {
  const open = headers.filter((h) => !usedHeader.has(h));
  if (!open.length) return {};
  const profiles = new Map();
  for (const h of open) { const p = profileColumn(records, h); if (p) profiles.set(h, p); }

  const guessed = {};
  const taken = new Set();
  for (const [key, f] of fields) {
    if (map[key] || !f.shape) continue;
    const fits = [...profiles].filter(([h, p]) => !taken.has(h) && fitsShape(f.shape, p)).map(([h]) => h);
    // Exactly one candidate or none. Two columns that both look like dates give us no
    // way to tell created from closed, and picking one would be a coin toss.
    if (fits.length === 1) { guessed[key] = fits[0]; taken.add(fits[0]); }
  }
  return guessed;
}

// Backwards compatible: the plain {field: header} map the engine and the page use.
export function autoMap(headers, rules, scope = "case") {
  return mapColumns({ headers, rules, scope }).map;
}

// ---------- helpers ----------
export function parseDate(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0));
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}
const DAY = 86400000;
const MINUTE = 60000;

// Reason and theme matching, shared by B3, which reports near-duplicate reason
// pairs, and the resolution audit, which has to fold those same pairs to one
// theme or miss real returns. One implementation so the two can't drift.
export const themeKey = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim().replace(/s\b/g, "").replace(/ /g, "");
const acronym = (s) => String(s).toLowerCase().split(/[\s\-]+/).filter(Boolean).map((w) => w[0]).join("");
// "Login issue" / "Login Issues" by key; "SSO" / "Single sign-on" by initials.
export function nearDuplicate(x, y) {
  return themeKey(x) === themeKey(y) ||
    (x.length <= 5 && x.toLowerCase() === acronym(y)) ||
    (y.length <= 5 && y.toLowerCase() === acronym(x));
}
const plainEqual = (x, y) => String(x).trim().toLowerCase().replace(/\s+/g, " ") === String(y).trim().toLowerCase().replace(/\s+/g, " ");
const sameTheme = (a, b, normalise) => (normalise ? nearDuplicate(a, b) : plainEqual(a, b));

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const pct = (x, d = 0) => (x == null ? "n/a" : `${(x * 100).toFixed(d)}%`);
const truthy = (v) => /^(y|yes|true|1|t)$/i.test(String(v).trim());
const isClosedStatus = (s) => /solved|closed|resolved|done|complete/i.test(s);

export function evalThreshold(value, t) {
  if (value == null || Number.isNaN(value)) return "needs_human";
  if (t.dir === "higher") return value >= t.pass ? "pass" : value >= t.warn ? "warn" : "fail";
  return value <= t.pass ? "pass" : value <= t.warn ? "warn" : "fail";
}
export function describeThreshold(t, asPct = true) {
  if (!t) return null;
  const f = (x) => (asPct ? pct(x, x < 0.01 && x > 0 ? 1 : 0) : String(x));
  return t.dir === "higher"
    ? `Green at ${f(t.pass)} or more, amber at ${f(t.warn)} or more`
    : t.pass === 0 ? `Green at none, amber up to ${f(t.warn)}` : `Green at ${f(t.pass)} or less, amber up to ${f(t.warn)}`;
}

// ---------- build canonical cases ----------
function canonical(records, map, rules) {
  const ph = new Set(rules.placeholders.map((p) => p.toLowerCase()));
  const get = (r, k) => (map[k] ? String(r[map[k]] ?? "").trim() : undefined);
  const real = (v) => v !== undefined && !ph.has(String(v).trim().toLowerCase());
  const cases = records.map((r) => {
    const c = {};
    for (const k of Object.keys(rules.fields)) c[k] = get(r, k);
    c._created = parseDate(c.created_at);
    c._closed = parseDate(c.closed_at);
    c._isClosed = c.status !== undefined ? isClosedStatus(c.status) : c._closed != null;
    c._days = c._created != null && c._closed != null ? (c._closed - c._created) / DAY : null;
    c._owners = c.owner_changes !== undefined && c.owner_changes !== "" ? Number(c.owner_changes) : null;
    return c;
  });
  return { cases, real, ph };
}

// ---------- the audit ----------
export function runAudit({ records, mapping, history = null, bot = null, rules, source = "upload" }) {
  const map = mapping;
  const has = (k) => !!map[k];
  const { cases, real } = canonical(records, map, rules);
  const n = cases.length;
  const R = {};
  const checkDef = Object.fromEntries(rules.checks.map((c) => [c.id, c]));
  const set = (id, outcome, value, display, detail, extra = {}) => {
    const d = checkDef[id];
    // A check may carry its own amber title, for when "failed" would misdescribe
    // what the export holds (B11: the account and the timings are there).
    const title = outcome === "pass" ? d.title
      : outcome === "warn" && d.warn_title ? d.warn_title
      : d.failure_title || d.title;
    R[id] = { id, band: d.band, title, rule_title: d.title,
      outcome, value, display, detail, threshold: describeThreshold(d.threshold), ...extra };
  };
  const fill = (k) => (has(k) && n ? cases.filter((c) => real(c[k])).length / n : null);

  // history: owners per case and earliest change
  let hist = null;
  if (history && history.length) {
    const byCase = new Map();
    let earliest = Infinity;
    for (const h of history) {
      const t = parseDate(h.changed_at);
      if (t != null && t < earliest) earliest = t;
      if (!byCase.has(h.case_id)) byCase.set(h.case_id, []);
      byCase.get(h.case_id).push(h);
    }
    hist = { byCase, earliest };
    for (const c of cases) {
      const ev = byCase.get(c.case_id) || [];
      const ownerMoves = ev.filter((e) => /owner|assignee/i.test(e.field)).length;
      if (c._owners == null && ev.length) c._owners = 1 + ownerMoves;
      c._toEng = ev.some((e) => /group|queue/i.test(e.field) && /engineer|tier 3|l3|escalat/i.test(e.new_value));
    }
  }

  // C1
  const core = Object.entries(rules.fields).filter(([, f]) => f.required).map(([k]) => k);
  const coreShare = core.filter(has).length / core.length;
  set("C1", evalThreshold(coreShare, checkDef.C1.threshold), coreShare, `${core.filter(has).length} of ${core.length}`,
    coreShare === 1 ? "All four core columns found." : `Missing: ${core.filter((k) => !has(k)).map((k) => rules.fields[k].label).join(", ")}.`);

  // C2
  const countCols = ["owner_changes", "group_changes", "reopen_count"].filter((k) => fill(k) > 0);
  if (hist) set("C2", "pass", 1, "History file", `${history.length.toLocaleString()} change records loaded.`);
  else if (countCols.length) set("C2", "warn", 0.5, "Counts only", `Count columns present (${countCols.map((k) => rules.fields[k].label).join(", ")}) but no change log, so you know how many owners, not who or when.`);
  else set("C2", "not_in_export", 0, "Snapshot", "Each case appears only in its final state. Transfers, reopens and time spent with each team can't be seen.");

  // C3
  if (!hist) set("C3", "not_in_export", null, "No history", "No change log to measure.");
  else {
    const covered = cases.filter((c) => c._created != null && c._created >= hist.earliest).length / n;
    const start = new Date(hist.earliest).toISOString().slice(0, 10);
    set("C3", evalThreshold(covered, checkDef.C3.threshold), covered, pct(covered),
      `History starts ${start}. ${pct(1 - covered)} of cases were created before then and look as if they never moved.`);
  }

  // C4
  const ids = new Map();
  for (const c of cases) ids.set(c.case_id, (ids.get(c.case_id) || 0) + 1);
  const dupRows = [...ids.values()].filter((v) => v > 1).reduce((s, v) => s + v, 0);
  const dupShare = n ? dupRows / n : 0;
  set("C4", has("case_id") ? evalThreshold(dupShare, checkDef.C4.threshold) : "not_in_export", dupShare, pct(dupShare, 1),
    dupRows ? `${dupRows} rows share a case ID with another row.` : "No repeated case IDs.");

  // de-duplicated set for everything else
  const seen = new Set();
  const U = cases.filter((c) => (seen.has(c.case_id) ? false : (seen.add(c.case_id), true)));
  const u = U.length;
  const ufill = (k) => (has(k) && u ? U.filter((c) => real(c[k])).length / u : null);

  // B1
  const routing = ["owner", "group", "reason"].filter(has);
  if (!routing.length) set("B1", "not_in_export", null, "Not found", "No owner, group or reason column.");
  else {
    const fills = routing.map((k) => [k, ufill(k)]);
    const worst = fills.reduce((a, b) => (b[1] < a[1] ? b : a));
    set("B1", evalThreshold(worst[1], checkDef.B1.threshold), worst[1], pct(worst[1]),
      fills.map(([k, v]) => `${rules.fields[k].label} ${pct(v)}`).join(" · ") + ` real values. Lowest: ${rules.fields[worst[0]].label.toLowerCase()}.`);
  }

  // reason profile
  const reasonCounts = new Map();
  if (has("reason")) for (const c of U) { const v = (c.reason || "").trim(); reasonCounts.set(v, (reasonCounts.get(v) || 0) + 1); }
  const realReasons = [...reasonCounts].filter(([v]) => real(v));

  // B2
  if (!has("reason")) set("B2", "not_in_export", null, "No reason", "No contact reason column.");
  else {
    const catchAll = U.filter((c) => !real(c.reason)).length / u;
    const top = [...reasonCounts].filter(([v]) => !real(v)).sort((a, b) => b[1] - a[1]).map(([v, k]) => `"${v || "(blank)"}" ${pct(k / u)}`);
    set("B2", evalThreshold(catchAll, checkDef.B2.threshold), catchAll, pct(catchAll), `${pct(catchAll)} of cases sit in blank or catch-all reasons: ${top.slice(0, 3).join(", ")}.`);
  }

  // B3 near-duplicates
  const nearDups = [];
  if (has("reason")) {
    const names = realReasons.map(([v]) => v);
    for (let a = 0; a < names.length; a++) for (let b = a + 1; b < names.length; b++)
      if (nearDuplicate(names[a], names[b])) nearDups.push([names[a], names[b]]);
    const rare = realReasons.filter(([, k]) => k < 5).length;
    const tail = realReasons.length ? rare / realReasons.length : 0;
    const outcome = nearDups.length === 0 && tail < 0.2 ? "pass" : nearDups.length <= 3 ? "warn" : "fail";
    set("B3", outcome, nearDups.length, `${nearDups.length} pairs`,
      `${realReasons.length} distinct reasons. ${nearDups.length ? "Near-duplicates: " + nearDups.map(([x, y]) => `"${x}" / "${y}"`).join(", ") + ". " : ""}${rare} used fewer than 5 times.`, { pairs: nearDups });
  } else set("B3", "not_in_export", null, "No reason", "No contact reason column.");

  // B4
  const bad = U.filter((c) => (c._created != null && c._closed != null && c._closed < c._created) ||
    (has("status") && c._isClosed && c._closed == null) || (has("status") && !c._isClosed && c._closed != null)).length;
  const badShare = u ? bad / u : 0;
  set("B4", evalThreshold(badShare, checkDef.B4.threshold), badShare, pct(badShare, 1), `${bad} cases with impossible or contradictory dates.`);

  // B5
  set("B5", fill("wait_time") > 0.5 ? "pass" : "needs_human", fill("wait_time"), fill("wait_time") > 0.5 ? "Wait field" : "No wait field",
    fill("wait_time") > 0.5 ? "Customer wait time is recorded, so resolution time can be split into waiting and working."
      : "Check how your helpdesk defines resolution time. If it includes time waiting on the customer, 'slow' may not mean slow.");

  // B6
  if (has("reopen_count") && has("follow_up_of")) set("B6", "pass", 1, "Linked", "Reopen counts and follow-up links present.");
  else if (has("reopen_count")) set("B6", "warn", 0.5, "Count only", "Reopen counts present, but follow-up cases aren't linked to their originals, so repeat contacts after closure are missed.");
  else set("B6", "not_in_export", null, "Not found", "No reopen information in this export.");

  // B7
  if (!has("escalated")) set("B7", "not_in_export", null, "No flag", "No escalation flag column.");
  else {
    const rate = U.filter((c) => truthy(c.escalated)).length / u;
    if (hist) {
      const moved = U.filter((c) => c._toEng).length / u;
      const ok = moved === 0 || rate >= moved / 4;
      set("B7", ok ? "pass" : "fail", rate, pct(rate, 1),
        `Flag set on ${pct(rate, 1)} of cases, but history shows ${pct(moved, 1)} moving to engineering. ${ok ? "" : "The flag misses most escalations."}`);
    } else set("B7", rate < 0.01 ? "needs_human" : "pass", rate, pct(rate, 1),
      rate < 0.01 ? `Flag set on only ${pct(rate, 1)} of cases. Without history it's impossible to tell whether escalations are rare or the flag is ignored.` : `Flag set on ${pct(rate, 1)} of cases.`);
  }

  // B8
  const closedU = U.filter((c) => c._isClosed);
  if (!has("csat_score")) set("B8", "not_in_export", null, "No survey", "No survey score column.");
  else {
    const cov = closedU.length ? closedU.filter((c) => real(c.csat_score)).length / closedU.length : 0;
    set("B8", evalThreshold(cov, checkDef.B8.threshold), cov, pct(cov), `${pct(cov)} of closed cases carry a survey score. Satisfied customers respond more, so treat averages as flattering.`);
  }

  // B9
  const acc = ufill("account_id");
  set("B9", acc == null ? "not_in_export" : evalThreshold(acc, checkDef.B9.threshold), acc, pct(acc), acc == null ? "No account column." : `${pct(acc)} of cases link to an account.`);

  // B10
  const strat = Math.max(ufill("account_size") ?? 0, ufill("segment") ?? 0);
  const stratCols = ["account_size", "segment"].filter(has).map((k) => rules.fields[k].label.toLowerCase());
  set("B10", stratCols.length ? evalThreshold(strat, checkDef.B10.threshold) : "not_in_export", strat, stratCols.length ? pct(strat) : "None",
    stratCols.length ? `Can control for ${stratCols.join(" and ")}.` : "No account size or product field, so case-volume effects can't be separated from real drivers.");

  // AI1
  const junk = new Set(rules.junk_text);
  const usable = (s) => s && !junk.has(s.toLowerCase().trim()) && s.trim().split(/\s+/).length >= 5;
  if (!has("subject") && !has("description")) set("AI1", "not_in_export", null, "No text", "No subject or description column.");
  else {
    const share = U.filter((c) => usable(c.subject) || usable(c.description)).length / u;
    set("AI1", evalThreshold(share, checkDef.AI1.threshold), share, pct(share), `${pct(share)} of cases have usable customer wording.`);
  }

  // AI2
  if (!has("reason")) set("AI2", "not_in_export", null, "No reason", "No contact reason column.");
  else {
    const words = rules.team_words;
    const teamy = (v) => words.some((w) => new RegExp(`\\b${w}\\b`, "i").test(v));
    const tv = realReasons.filter(([v]) => teamy(v));
    const share = tv.reduce((s, [, k]) => s + k, 0) / u;
    set("AI2", evalThreshold(share, checkDef.AI2.threshold), share, pct(share),
      tv.length ? `${pct(share)} of cases use team-type reasons: ${tv.map(([v]) => `"${v}"`).join(", ")}.` : "Reasons describe customer needs.");
  }

  // AI3
  set("AI3", has("reason") ? "needs_human" : "not_in_export", null, "Review",
    nearDups.length ? `Start with the near-duplicates found: ${nearDups.map(([x, y]) => `"${x}" / "${y}"`).join(", ")}. Then sample cases from similar reasons.` : "Sample cases from similar-sounding reasons and check they really differ.");

  // AI4
  if (!has("resolution_note") && !has("linked_article")) set("AI4", "not_in_export", null, "Not found", "No resolution note or article column.");
  else {
    const share = closedU.filter((c) => real(c.resolution_note) || real(c.linked_article)).length / Math.max(1, closedU.length);
    set("AI4", evalThreshold(share, checkDef.AI4.threshold), share, pct(share), `${pct(share)} of closed cases record how they were solved.`);
  }

  // AI5
  const teamyR = (v) => rules.team_words.some((w) => new RegExp(`\\b${w}\\b`, "i").test(v));
  const needReasons = realReasons.filter(([v]) => !teamyR(v)).sort((a, b) => b[1] - a[1]);
  const needTotal = needReasons.reduce((s, [, k]) => s + k, 0);
  if (!needTotal) set("AI5", has("reason") ? "needs_human" : "not_in_export", null, "n/a", "No usable reasons to measure.");
  else {
    const top10 = needReasons.slice(0, 10).reduce((s, [, k]) => s + k, 0) / needTotal;
    set("AI5", evalThreshold(top10, checkDef.AI5.threshold), top10, pct(top10), `The ten most common customer-need reasons hold ${pct(top10)} of cases that have one.`);
  }

  // AI6
  const dates = U.map((c) => c._created).filter((x) => x != null);
  const months = dates.length ? Math.max(1, (Math.max(...dates) - Math.min(...dates)) / (30.44 * DAY)) : 1;
  const ec = has("channel") ? U.filter((c) => /mail|chat/i.test(c.channel || "")).length : u;
  const perMonth = ec / months;
  set("AI6", u >= 20000 && perMonth >= 2000 ? "pass" : "warn", u, `${u.toLocaleString()} cases`,
    `${u.toLocaleString()} cases, about ${Math.round(perMonth).toLocaleString()} email or chat a month. Forethought publishes 20,000+ historical and 2,000+ a month; most vendors publish nothing, so ask.`);

  // B11. Judges the bot conversations export, not the case export: can a claimed
  // resolution be reached from the conversation to the cases that followed it?
  // The wording of every outcome is the rules' own, reported verbatim.
  const botRows = bot && bot.records ? bot.records : [];
  const botHas = (k) => !!(bot && bot.mapping && bot.mapping[k] && botRows.length);
  const b11Words = (o) => (checkDef.B11.outcomes || {})[o] || "";
  if (!botRows.length) set("B11", "not_in_export", null, "No bot export", b11Words("not_in_export"));
  else if (botHas("bot_linked_cases")) set("B11", "pass", 1, "Case links", b11Words("pass"));
  else if (botHas("account_id") && botHas("bot_started_at") && botHas("bot_ended_at"))
    set("B11", "warn", 0.5, "Account and timings", b11Words("warn"));
  else set("B11", "not_in_export", 0, "Not found", b11Words("not_in_export"));

  // Checks defined in the rules but not computed by this engine version. Without an
  // entry here the uses loop below dereferences undefined.
  for (const c of rules.checks) if (!R[c.id]) set(c.id, "needs_human", null, "Not yet", "This engine version doesn't run this check yet.");

  // ---------- the resolution audit ----------
  const resolution_audit = resolutionAudit({ bot, botRows, U, byIdKey: has("case_id"), rules, outcome: R.B11.outcome, real });

  // ---------- uses ----------
  // A use may need a file beyond the case export. It still reports its verdict
  // when that file is absent, so the question stays visible, but it is left out of
  // the fix-first weighting below: a missing second file isn't a flaw in this one.
  const fileSupplied = (f) => (f === "bot" ? botRows.length > 0 : true);
  const rank = { pass: 0, warn: 1, needs_human: 1, fail: 2, not_in_export: 2 };
  const uses = rules.uses.map((us) => {
    const req = us.required.map((id) => R[id]);
    const worst = req.reduce((a, b) => (rank[b.outcome] > rank[a.outcome] ? b : a));
    let outcome = worst.outcome === "needs_human" ? "warn" : worst.outcome;
    const optBad = us.optional.map((id) => R[id]).filter((c) => rank[c.outcome] >= 1);
    if (outcome === "pass" && optBad.length) outcome = "warn";
    // Matching returns by timing alone isn't implemented, so the audit returns
    // can't tell for every conversation. That is this tool's limit, not a flaw in
    // the export, so it reports "needs a human" rather than amber "usable with care".
    if (us.id === "resolution_audit" && resolution_audit.basis === "account_and_timing") outcome = "needs_human";
    const blockers = req.filter((c) => rank[c.outcome] >= 1).concat(outcome !== "fail" && outcome !== "not_in_export" ? optBad : []);
    return { id: us.id, title: us.title, outcome, blockers: blockers.map((c) => c.id),
      ...(us.needs_file ? { needs_file: us.needs_file, file_supplied: fileSupplied(us.needs_file) } : {}) };
  });
  const useById = Object.fromEntries(uses.map((x) => [x.id, x]));

  // ---------- signals ----------
  const signals = rules.signals.map((s) => computeSignal(s, { R, useById, has, U, real, rules, hist }));

  // ---------- fix first ----------
  const blockCount = {};
  for (const us of uses) {
    if (us.needs_file && !us.file_supplied) continue;
    for (const id of us.blockers) blockCount[id] = (blockCount[id] || 0) + (rank[R[id].outcome] === 2 ? 2 : 1);
  }
  const fixFirst = Object.entries(blockCount).filter(([id]) => R[id].outcome !== "needs_human" || blockCount[id] > 1)
    .sort((a, b) => b[1] - a[1] || rank[R[b[0]].outcome] - rank[R[a[0]].outcome]).slice(0, 3).map(([id]) => id);

  // ---------- drivers ----------
  const drivers = computeDrivers({ U, has, real, rules });

  return {
    meta: { engine: ENGINE_VERSION, rules: rules.meta.version, rules_status: rules.meta.status, source,
      rows: n, cases: u, history_rows: history ? history.length : 0, bot_rows: botRows.length,
      generated: new Date().toISOString() },
    checks: R, uses, signals, fixFirst, drivers, resolution_audit,
    vendor_questions: rules.vendor_questions,
  };
}

// ---------- the resolution audit ----------
// For conversations the bot claimed it resolved, what happened next? Three answers
// only: contradicted, not contradicted, and can't tell. "Not contradicted" is
// silence, never success; the disclaimer carried in the result says so.
//
// Every parameter comes from rules.resolution_audit.params. There is deliberately
// no parameter for where returns begin: they begin where the escalation window
// ends, so no same-theme case can land between the two and be banked as silence.
function resolutionAudit({ bot, botRows, U, byIdKey, rules, outcome, real }) {
  const spec = rules.resolution_audit || {};
  const P = spec.params;
  if (!P) return { available: false, reason: "The rules carry no resolution_audit parameters." };
  const windows = [...P.return_windows_days].sort((a, b) => a - b);
  const escMs = P.escalation_within_minutes * MINUTE;
  const maxMs = windows[windows.length - 1] * DAY;
  const normalise = !!P.normalise_reasons;
  const base = {
    available: true,
    basis: outcome === "pass" ? "case_links" : outcome === "warn" ? "account_and_timing" : "none",
    params: { return_windows_days: windows, escalation_within_minutes: P.escalation_within_minutes, normalise_reasons: normalise },
    disclaimer: spec.disclaimer,
  };
  if (!botRows.length) return { ...base, available: false, basis: "none", reason: "No bot conversations export." };
  if (!byIdKey) return { ...base, available: false, reason: "No case ID column, so linked cases can't be looked up." };

  const bg = (r, k) => (bot.mapping[k] ? String(r[bot.mapping[k]] ?? "").trim() : "");
  const byId = new Map();
  for (const c of U) byId.set(c.case_id, c);

  const buckets = { contradicted: 0, not_contradicted: 0, cant_tell: 0 };
  // Priority order, so these sum to the contradicted total rather than double-count
  // a conversation that was both reopened and escalated. Per-conversation `flags`
  // keep the overlap visible.
  const contradicted_by = { reopened: 0, escalated: 0, same_theme: 0 };
  const cumulative = windows.map((d) => ({ days: d, contradicted: 0 }));
  const by_conversation = [];
  let claimed = 0, out_of_scope = 0, unreadable_theme_cases = 0, unresolved_links = 0;

  for (const r of botRows) {
    const id = bg(r, "bot_conversation_id");
    if (!truthy(bg(r, "bot_claimed_resolved"))) { out_of_scope++; continue; }
    claimed++;
    if (outcome !== "pass") {
      // Amber B11 means the links would have to be inferred from account and
      // timing. That isn't implemented, and guessing would be worse than silence.
      buckets.cant_tell++;
      by_conversation.push({ id, bucket: "cant_tell", why: null, matched: [] });
      continue;
    }
    const end = parseDate(bg(r, "bot_ended_at"));
    const intent = bg(r, "bot_intent");
    const themeReadable = real(intent);
    const reopens = Number(bg(r, "bot_reopens"));
    const flags = { reopened: Number.isFinite(reopens) && reopens > 0, escalated: false, same_theme: false };
    const matched = [];
    for (const cid of bg(r, "bot_linked_cases").split(/[;,|]/).map((s) => s.trim()).filter(Boolean)) {
      const c = byId.get(cid);
      if (!c) { unresolved_links++; continue; }
      if (end == null || c._created == null) continue;
      const lag = c._created - end;
      if (lag <= 0 || lag > maxMs) continue;
      if (lag <= escMs) {
        // A human picking it up this soon is the bot handing over, not the
        // customer coming back. Theme isn't asked: the handover is the evidence.
        flags.escalated = true;
        matched.push({ case_id: cid, lag_days: lag / DAY, as: "escalated", reason: c.reason });
        continue;
      }
      if (!themeReadable) continue;
      if (!real(c.reason)) { unreadable_theme_cases++; continue; }
      if (sameTheme(c.reason, intent, normalise)) {
        flags.same_theme = true;
        matched.push({ case_id: cid, lag_days: lag / DAY, as: "same_theme", reason: c.reason });
      }
    }
    const why = flags.reopened ? "reopened" : flags.escalated ? "escalated" : flags.same_theme ? "same_theme" : null;
    // No contradiction and no readable theme means the return was never looked
    // for, which is not the same as not finding one.
    const bucket = why ? "contradicted" : themeReadable ? "not_contradicted" : "cant_tell";
    buckets[bucket]++;
    if (why) {
      contradicted_by[why]++;
      // Reopens and escalations happen at once, so they count in every window.
      const soonest = flags.reopened || flags.escalated
        ? 0 : Math.min(...matched.filter((m) => m.as === "same_theme").map((m) => m.lag_days));
      for (const w of cumulative) if (soonest <= w.days) w.contradicted++;
    }
    by_conversation.push({ id, bucket, why, flags, matched });
  }
  return { ...base, conversations: botRows.length, claimed, out_of_scope, buckets,
    contradicted_cumulative: cumulative, contradicted_by, unreadable_theme_cases, unresolved_links, by_conversation };
}

// ---------- signals ----------
function computeSignal(s, ctx) {
  const { R, useById, has, U, real, hist } = ctx;
  const base = { id: s.id, title: s.title, shows: s.shows, disclaimer: s.disclaimer };
  for (const f of s.requires_fields || []) if (!has(f)) return { ...base, state: "locked", reason: `Needs a ${ctx.rules.fields[f].label.toLowerCase()} column.` };
  if (s.unlocked_by_uses) {
    const blocked = s.unlocked_by_uses.map((id) => useById[id]).filter((x) => x.outcome === "fail" || x.outcome === "not_in_export");
    if (blocked.length) return { ...base, state: "locked", reason: `Locked until ${blocked.map((b) => b.title.toLowerCase()).join(" and ")} ${blocked.length > 1 ? "pass" : "passes"}.`, blockers: blocked.flatMap((b) => b.blockers) };
  }
  if (s.unlocked_by_any_check && !s.unlocked_by_any_check.some((id) => ["pass", "warn"].includes(R[id].outcome)))
    return { ...base, state: "locked", reason: `Locked until ${s.unlocked_by_any_check.join(" or ")} passes.` };
  const caution = (s.unlocked_by_uses || []).some((id) => useById[id].outcome === "warn");
  const out = { ...base, state: caution ? "caution" : "on" };
  const closed = U.filter((c) => c._days != null && c._days >= 0);
  const P = s.params || {};
  if (s.id === "slow_passed") {
    const withO = closed.filter((c) => c._owners != null);
    const hit = withO.filter((c) => c._days > P.slow_days && c._owners >= P.min_owners);
    const byGroup = groupShare(withO, (c) => c.group || "(none)", (c) => c._days > P.slow_days && c._owners >= P.min_owners);
    out.headline = `${pct(hit.length / Math.max(1, withO.length), 1)} of closed cases`;
    out.detail = `${hit.length} cases open more than ${P.slow_days} days with ${P.min_owners}+ owners.`;
    out.rows = byGroup.slice(0, 4).map((g) => [g.key, pct(g.share, 1), `${g.n} cases`]);
  } else if (s.id === "handoff") {
    const held = closed.filter((c) => c._owners === 1), handed = closed.filter((c) => c._owners > 1);
    const cs = (a) => { const v = a.map((c) => Number(c.csat_score)).filter((x) => x >= 1); return v.length ? (v.reduce((p, q) => p + q, 0) / v.length).toFixed(2) : "n/a"; };
    out.headline = `${median(handed.map((c) => c._days))?.toFixed(1)} vs ${median(held.map((c) => c._days))?.toFixed(1)} days`;
    out.detail = "Median days to resolve, handed on versus held.";
    out.rows = [["Held by one owner", `${median(held.map((c) => c._days))?.toFixed(1)} days`, `CSAT ${cs(held)}`], ["Handed on", `${median(handed.map((c) => c._days))?.toFixed(1)} days`, `CSAT ${cs(handed)}`]];
  } else if (s.id === "theme_movers") {
    const t = U.map((c) => c._created).filter((x) => x != null);
    const end = Math.max(...t), cut = end - 91 * DAY;
    const recent = U.filter((c) => c._created >= cut && real(c.reason)), prior = U.filter((c) => c._created < cut && real(c.reason));
    const share = (a) => { const m = new Map(); for (const c of a) m.set(c.reason, (m.get(c.reason) || 0) + 1); return m; };
    const r = share(recent), p = share(prior);
    const moves = [...new Set([...r.keys(), ...p.keys()])].map((k) => ({ k, d: (r.get(k) || 0) / Math.max(1, recent.length) - (p.get(k) || 0) / Math.max(1, prior.length), n: (r.get(k) || 0) + (p.get(k) || 0) }))
      .filter((x) => x.n >= 30).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    out.headline = moves[0] ? `${moves[0].k} ${moves[0].d > 0 ? "up" : "down"}` : "Stable";
    out.detail = "Change in share of cases, last quarter versus the nine months before.";
    out.rows = moves.slice(0, 4).map((m) => [m.k, `${m.d > 0 ? "+" : ""}${(m.d * 100).toFixed(1)} pts`, `${m.n} cases`]);
  } else if (s.id === "open_risk") {
    const p70 = quantile(closed.map((c) => c._days), 0.7);
    const end = Math.max(...U.map((c) => c._created).filter((x) => x != null));
    const open = U.filter((c) => !c._isClosed && c._created != null);
    const old = open.filter((c) => (end - c._created) / DAY > p70);
    out.headline = `${old.length} of ${open.length} open cases`;
    out.detail = `Open longer than ${p70?.toFixed(1)} days, the time 70% of closed cases took.`;
    out.rows = groupShare(old, (c) => c.group || "(none)", () => true).slice(0, 4).map((g) => [g.key, `${g.n} cases`, ""]);
  } else if (s.id === "exit_events") {
    const ev = U.filter((c) => real(c.exit_event));
    out.headline = `${new Set(ev.map((c) => c.account_id)).size} accounts`;
    out.detail = `${ev.length} cases record an exit event.`;
    out.rows = [];
  } else if (s.id === "self_help" || s.id === "keep_human") {
    const by = new Map();
    for (const c of closed) { if (!real(c.reason) || ctx.rules.team_words.some((w) => new RegExp(`\\b${w}\\b`, "i").test(c.reason))) continue; if (!by.has(c.reason)) by.set(c.reason, []); by.get(c.reason).push(c); }
    const total = closed.length;
    const stats = [...by].map(([k, a]) => ({ k, n: a.length, med: median(a.map((c) => c._days)), owners: a.filter((c) => c._owners != null).length ? a.filter((c) => c._owners != null).reduce((p, c) => p + c._owners, 0) / a.filter((c) => c._owners != null).length : null, doc: a.filter((c) => real(c.resolution_note) || real(c.linked_article)).length / a.length }));
    if (s.id === "self_help") {
      const list = stats.filter((x) => x.n / total >= 0.02 && x.med <= 1.5 && (x.owners == null || x.owners < 1.4)).sort((a, b) => b.n - a.n);
      out.headline = `${list.length} candidate reasons`;
      out.detail = "Frequent, resolved within a day and a half, mostly by one owner.";
      out.rows = list.slice(0, 5).map((x) => [x.k, `${x.n} cases`, `${pct(x.doc)} documented`]);
    } else {
      const list = stats.filter((x) => x.n >= 30 && (x.med > 5 || (x.owners != null && x.owners >= 2))).sort((a, b) => b.med - a.med);
      out.headline = `${list.length} reasons`;
      out.detail = "Long to resolve or usually passed between owners.";
      out.rows = list.slice(0, 5).map((x) => [x.k, `${x.med.toFixed(1)} days`, x.owners != null ? `${x.owners.toFixed(1)} owners` : ""]);
    }
  }
  return out;
}
function groupShare(arr, keyFn, hitFn) {
  const m = new Map();
  for (const c of arr) { const k = keyFn(c); const g = m.get(k) || { key: k, n: 0, hit: 0 }; g.n++; if (hitFn(c)) g.hit++; m.set(k, g); }
  return [...m.values()].map((g) => ({ ...g, share: g.hit / g.n })).sort((a, b) => b.share - a.share);
}

// ---------- drivers: why most aren't ----------
export function computeDrivers({ U, has, real }) {
  if (!has("account_id") || !has("churned")) return { available: false, reason: "Needs an account column and an account outcome (churned) column." };
  const stratKey = has("segment") ? "segment" : has("account_size") ? "account_size" : null;
  const acc = new Map();
  for (const c of U) {
    if (!real(c.account_id)) continue;
    const a = acc.get(c.account_id) || { cases: [], churned: truthy(c.churned), seg: stratKey ? c[stratKey] : "all" };
    a.cases.push(c); acc.set(c.account_id, a);
  }
  const A = [...acc.values()];
  const any = (fn) => (a) => a.cases.some(fn);
  const ownersKnown = U.some((c) => c._owners != null);
  const flags = [
    { id: "volume", label: "10 or more cases in the year", fn: (a) => a.cases.length >= 10, volume: true },
    { id: "priority", label: "Any high or urgent priority case", fn: any((c) => /high|urgent/i.test(c.priority || "")), need: "priority" },
    { id: "phone", label: "Any phone contact", fn: any((c) => /phone|call/i.test(c.channel || "")), need: "channel" },
    { id: "other", label: "Any case logged as Other or blank", fn: any((c) => !real(c.reason)), need: "reason" },
    { id: "billing", label: "Any billing or invoice case", fn: any((c) => /bill|invoice/i.test(`${c.reason} ${c.subject}`)) },
    { id: "lowcsat", label: "Any CSAT of 1 or 2", fn: any((c) => Number(c.csat_score) >= 1 && Number(c.csat_score) <= 2), need: "csat_score" },
    { id: "reopen", label: "Any reopened case", fn: any((c) => Number(c.reopen_count) > 0), need: "reopen_count" },
    { id: "slow", label: "Any case open 30+ days", fn: any((c) => c._days != null && c._days > 30) },
    { id: "eng", label: "Any case routed to engineering", fn: any((c) => /engineer/i.test(c.group || "") || c._toEng), need: "group" },
    { id: "owners", label: "Any case with 3+ owners", fn: any((c) => c._owners >= 3), owners: true },
    { id: "slow_passed", label: "Any case slow (30+ days) and passed around (3+ owners)", fn: any((c) => c._days > 30 && c._owners >= 3), owners: true },
  ].filter((f) => (!f.need || has(f.need)) && (!f.owners || ownersKnown));
  const band = (a) => (a.cases.length <= 3 ? "1-3" : a.cases.length <= 9 ? "4-9" : "10+");
  const results = flags.map((f) => {
    const tab = (list) => { let a = 0, b = 0, c = 0, d = 0; for (const x of list) { const e = f.fn(x); if (e && x.churned) a++; else if (e) b++; else if (x.churned) c++; else d++; } return { a, b, c, d }; };
    const raw = tab(A);
    const rawOR = orWoolf(raw);
    const strata = new Map();
    for (const x of A) { const k = `${x.seg}|${f.volume ? "" : band(x)}`; if (!strata.has(k)) strata.set(k, []); strata.get(k).push(x); }
    const adj = mantelHaenszel([...strata.values()].map(tab));
    const prevalence = (raw.a + raw.b) / A.length;
    const holds = !!adj && adj.lo > 1;
    const verdict = !adj ? "too_few" : adj.lo > 1 ? "holds" : adj.hi < 1 ? "reverses" : "falls_away";
    return { id: f.id, label: f.label, prevalence, raw: rawOR, adj, holds, verdict };
  });
  const churnRate = A.filter((a) => a.churned).length / A.length;
  return { available: true, accounts: A.length, churn_rate: churnRate, controls: [stratKey ? (stratKey === "segment" ? "product" : "account size") : null, "case volume band"].filter(Boolean), results };
}
function orWoolf({ a, b, c, d }) {
  if ([a, b, c, d].some((x) => x === 0)) { a += 0.5; b += 0.5; c += 0.5; d += 0.5; }
  const or = (a * d) / (b * c), se = Math.sqrt(1 / a + 1 / b + 1 / c + 1 / d);
  return { or, lo: Math.exp(Math.log(or) - 1.96 * se), hi: Math.exp(Math.log(or) + 1.96 * se) };
}
// Mantel-Haenszel odds ratio with Robins-Breslow-Greenland variance
function mantelHaenszel(tabs) {
  let R = 0, S = 0, PR = 0, PSQR = 0, QS = 0;
  for (const { a, b, c, d } of tabs) {
    const n = a + b + c + d; if (n < 2) continue;
    const r = (a * d) / n, s = (b * c) / n, P = (a + d) / n, Q = (b + c) / n;
    R += r; S += s; PR += P * r; PSQR += P * s + Q * r; QS += Q * s;
  }
  if (R === 0 || S === 0) return null;
  const or = R / S;
  const v = PR / (2 * R * R) + PSQR / (2 * R * S) + QS / (2 * S * S);
  const se = Math.sqrt(v);
  return { or, lo: Math.exp(Math.log(or) - 1.96 * se), hi: Math.exp(Math.log(or) + 1.96 * se) };
}
