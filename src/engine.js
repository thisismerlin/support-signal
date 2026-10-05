// Support Signal engine. Pure functions, no dependencies; runs in the browser and in Node.
// Everything it judges comes from the rules object (compiled from rules/rules.yaml).

export const ENGINE_VERSION = "0.6.0";

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
const TRUSTED_NAME = 80;     // exact (100) or the same words in another order (80)
const inScope = (f, scope) => { const s = f.file || "case"; return s === scope || s === "both"; };

// The full result: the map, plus how each field was matched and how strongly, and
// anything that was offered a field and refused it.
export function mapColumns({ headers, rules, scope = "case", records = null }) {
  const fields = Object.entries(rules.fields).filter(([, f]) => inScope(f, scope));
  const order = Object.fromEntries(fields.map(([k], i) => [k, i]));
  const hv = new Map(headers.map((h) => [h, headerVariants(h)]));

  // In a one-row-per-comment export, a column whose values change between rows of one
  // case is not a case-level column, whatever its name says. Mapping it to one anyway
  // is how a comment column ends up filed as `follow_up_of`: the collapse then has to
  // pick one value per case and report the rest as a conflict, for a column that never
  // belonged to the case. Needs the values, like shape inference does, so autoMap()
  // below can't do it.
  const varying = records && records.length ? varyingWithinCase({ headers, records, rules, scope }) : null;

  // One profile per column, shared by the name gate below and by inference. Built
  // once: profiling 300 values a column twice is the same answer at twice the cost.
  const profiles = new Map();
  if (records && records.length) for (const h of headers) {
    const p = profileColumn(records, h);
    if (p) profiles.set(h, p);
  }

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

  const map = {}, confidence = {}, scores = {}, refused = {};
  const usedHeader = new Set();
  for (const p of pairs) {
    if (map[p.key] || usedHeader.has(p.header)) continue;   // one field, one column, each way
    // A case-level field will not take a column that changes within a case. The header
    // is left free, so a comment field can still win it by name; if none does, the
    // column stays unmapped and the refusal is reported rather than passed over.
    if (varying && varying.has(p.header) && isCaseLevelField(rules.fields[p.key], p.key)) {
      if (!refused[p.key]) refused[p.key] = { header: p.header, reason: "varies_within_case" };
      continue;
    }
    // Below an exact or same-words match, a comment field's name match is a partial
    // word overlap, which is a guess wearing a match's confidence: "CommentCreatedDate"
    // overlaps comment_id's own name, so a column of dates was filed as an ID and the
    // comment timestamp went unmapped. A loose match whose values contradict the
    // field's shape is refused and the column left for a field that fits.
    if (p.score < TRUSTED_NAME && isCommentField(rules.fields[p.key])
        && contradictsShape(rules.fields[p.key].shape, profiles.get(p.header))) {
      if (!refused[p.key]) refused[p.key] = { header: p.header, reason: "shape_mismatch" };
      continue;
    }
    map[p.key] = p.header; usedHeader.add(p.header);
    confidence[p.key] = "name"; scores[p.key] = p.score;
  }

  // Anything still unmatched may be inferable from what the column contains.
  if (records && records.length) {
    const guessed = inferFromValues({ fields, headers, records, map, usedHeader, varying, rules, profiles });
    for (const [key, header] of Object.entries(guessed)) {
      map[key] = header; usedHeader.add(header);
      confidence[key] = "guess"; scores[key] = null;
    }
  }
  // A refusal explains a gap, so it only stands while there is a gap to explain: the
  // field is still unmapped *and* so is the column it turned down. Checked after
  // inference rather than before it, or a field the guess pass went on to fill is
  // reported as refused and mapped at once, and a column that found the comment field
  // it belonged to is still described as one to go and map by hand.
  for (const k of Object.keys(refused)) {
    if (map[k] || usedHeader.has(refused[k].header)) delete refused[k];
  }
  return { map, confidence, scores, refused, shape: varying ? varying.shape : null };
}

// Case-level means: not a comment field, and not the case ID itself. The ID is the key
// the rows are grouped by, so it cannot be judged on whether it varies within a group.
const isCaseLevelField = (f, key) => key !== "case_id" && (f.level || "case") !== "comment";

// Which headers change between rows of the same case, and whether this export is one
// row per comment at all. Blanks are ignored: a repeated case field blanked on all but
// the first row is how plenty of exports look, and the collapser treats the first real
// value as the answer rather than as a disagreement.
function varyingWithinCase({ headers, records, rules, scope }) {
  // The case ID has to be found before anything can be grouped. Name match only, and
  // in this scope, which is the same way the main pass would find it.
  const idField = rules.fields.case_id;
  if (!idField || !inScope(idField, scope)) return null;
  const cands = ["case id", ...(idField.synonyms || [])].flatMap((c) => headerVariants(c));
  let idHeader = null, bestScore = 0;
  for (const h of headers) {
    for (const c of cands) for (const v of headerVariants(h)) {
      const sc = scorePair(c, v);
      if (sc > bestScore && sc >= NAME_FLOOR) { bestScore = sc; idHeader = h; }
    }
  }
  if (!idHeader) return null;

  const groups = new Map();
  for (const r of records) {
    const id = String(r[idHeader] ?? "").trim();
    if (!id) continue;                                      // nothing to group it by
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(r);
  }
  const multi = [...groups.values()].filter((rows) => rows.length > 1);
  if (!multi.length) return null;                           // one row per case: nothing to judge

  // Identical copies are not a comment export. Judge only cases with distinct rows, or
  // a file that merely repeats a row would make every column look case-level anyway.
  const cols = headers;
  const distinctRows = (rows) => new Set(rows.map((r) => JSON.stringify(cols.map((h) => String(r[h] ?? ""))))).size;
  const spans = multi.filter((rows) => distinctRows(rows) > 1);
  if (!spans.length) return null;

  const out = new Set();
  out.shape = "one_row_per_comment";
  for (const h of headers) {
    if (h === idHeader) continue;
    for (const rows of spans) {
      const vals = new Set();
      for (const r of rows) { const v = String(r[h] ?? "").trim(); if (v) vals.add(v); }
      if (vals.size > 1) { out.add(h); break; }
    }
  }
  return out;
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

// What a column's values rule *out*. Stated as a contradiction rather than as a
// required fit on purpose: a comment author column holding hundreds of agent IDs
// fails the `category` test without being the wrong column, and refusing it would
// lose a column we could have read. Only a positive clash counts.
function contradictsShape(shape, p) {
  if (!p) return false;                                   // too thin to profile: no evidence
  const prose = p.avgWords >= 5;
  switch (shape) {
    case "text":     return p.boolish || p.dates >= 0.8 || p.numeric >= 0.9;
    case "id":       return p.boolish || p.dates >= 0.8 || prose;
    case "date":     return p.boolish || prose;
    case "flag":     return p.dates >= 0.8 || prose;
    case "category": return p.dates >= 0.8 || prose;
    case "number":   return p.boolish || p.dates >= 0.8 || prose;
    default:         return false;
  }
}

// A field that declares `guess_requires_word` may only be *guessed* onto a column
// whose name carries one of those words. Shape cannot separate two flag fields of
// opposite polarity: both fit, so the winner was whichever was declared first, and
// reading `comment_private` where `comment_public` was meant inverts every "latest
// public comment" without saying anything. A name match needs no such guard, because
// the header has already said which one it is.
const guessWordOk = (f, header) => {
  if (!f.guess_requires_word) return true;
  const words = new Set(headerVariants(header).flatMap((v) => v.split(" ")));
  return f.guess_requires_word.some((w) => words.has(w));
};

function inferFromValues({ fields, headers, records, map, usedHeader, varying, rules, profiles }) {
  const open = headers.filter((h) => !usedHeader.has(h));
  if (!open.length) return {};
  const fit = new Map();
  for (const h of open) { const p = profiles.get(h); if (p) fit.set(h, p); }

  const guessed = {};
  const taken = new Set();
  for (const [key, f] of fields) {
    if (map[key] || !f.shape) continue;
    const fits = [...fit].filter(([h, p]) => {
      if (taken.has(h)) return false;
      // The same rule the name pass applies, applied here too. Without it a column
      // refused for a case-level field by name is handed straight back to it by
      // shape: a varying free-text column is refused for follow_up_of and then
      // guessed as the subject, which is how the comment body went unread.
      if (varying && varying.has(h) && isCaseLevelField(f, key)) return false;
      if (!guessWordOk(f, h)) return false;
      return fitsShape(f.shape, p);
    }).map(([h]) => h);
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
// A share too small to show at this precision, but not zero. Printing "0.0%" beside
// "2 of 5,083" invites the reader to believe one of the two numbers is wrong.
const pctFloor = (x, d = 1) => {
  if (x == null) return "n/a";
  const smallest = 1 / 10 ** d / 100;
  return x > 0 && x < smallest ? `under ${pct(smallest, d)}` : pct(x, d);
};
// "1 row" / "2 rows". Detail lines are read by people, and "1 rows" reads as a bug.
const plural = (k, one, many = `${one}s`) => `${k.toLocaleString()} ${k === 1 ? one : many}`;
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

// ---------- the file's shape, and collapsing it to one row per case ----------
// A real export is often one row per case comment or email, with the case fields
// repeated on every row. That is a shape, not a fault, so it is named rather than
// failed, and the comment rows are read rather than thrown away.
//
// A repeated case ID has two possible causes and they are told apart by what varies:
//   rows identical in every column            -> a redundant copy. A true duplicate.
//   rows whose case-level columns agree        -> one row per comment. The file's shape.
//   rows whose case-level columns disagree     -> a conflict, named and counted.
// Collapsing happens before any check runs, so nothing downstream sees a raw row.

const isCommentField = (f) => (f.level || "case") === "comment";

// A field whose value belongs to the case, so it must agree across the case's rows.
// Only mapped fields are judged: an unmapped column that varies is what a comment
// export looks like, and guessing at its meaning would invent conflicts.
const caseLevelKeys = (rules, map) => Object.keys(rules.fields)
  .filter((k) => map[k] && !isCommentField(rules.fields[k]) && (rules.fields[k].file || "case") !== "bot");

// Repeated case fields are sometimes blanked on all but the first row of a case.
// Blanks are therefore not disagreement: the first real value wins, and only two
// different real values are a conflict worth a warning.
function agree(rows, read) {
  const vals = [];
  for (const r of rows) { const v = read(r); if (v !== undefined && v !== "") vals.push(v); }
  if (!vals.length) return { value: "", conflict: false };
  const distinct = new Set(vals);
  return { value: vals[0], conflict: distinct.size > 1, distinct: [...distinct] };
}

export function collapseRows({ records, headers = null, map, rules }) {
  const ph = new Set(rules.placeholders.map((p) => p.toLowerCase()));
  const get = (r, k) => (map[k] ? String(r[map[k]] ?? "").trim() : undefined);
  const real = (v) => v !== undefined && !ph.has(String(v).trim().toLowerCase());
  const cols = headers && headers.length ? headers
    : [...new Set(records.flatMap((r) => Object.keys(r)))];
  const rowKey = (r) => JSON.stringify(cols.map((h) => String(r[h] ?? "")));

  const commentKeys = Object.keys(rules.fields).filter((k) => isCommentField(rules.fields[k]));
  const caseKeys = caseLevelKeys(rules, map);
  const hasId = !!map.case_id;

  // Group by case ID, first appearance first. A row with no case ID can't be
  // grouped with anything, so it stays its own case and is counted separately
  // rather than silently piled in with every other blank.
  const groups = new Map();
  let noIdRows = 0;
  records.forEach((r, i) => {
    const id = hasId ? get(r, "case_id") : "";
    const key = hasId && id !== "" ? `id:${id}` : (noIdRows++, `row:${i}`);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });

  let duplicateRows = 0, commentRows = 0, multiRowCases = 0, conflictCases = 0;
  const conflictCount = new Map();
  const cases = [];

  for (const rows of groups.values()) {
    // Drop redundant copies first, so an identical row repeated inside a comment
    // export is a duplicate and not an extra comment.
    const seenRow = new Set();
    const kept = [];
    for (const r of rows) {
      const k = rowKey(r);
      if (seenRow.has(k)) { duplicateRows++; continue; }
      seenRow.add(k); kept.push(r);
    }
    if (kept.length > 1) { multiRowCases++; commentRows += kept.length; }

    const c = {};
    let conflicted = false;
    for (const k of Object.keys(rules.fields)) {
      if (isCommentField(rules.fields[k])) { c[k] = get(kept[0], k); continue; }
      if (!map[k]) { c[k] = undefined; continue; }
      const a = agree(kept, (r) => get(r, k));
      c[k] = a.value;
      if (a.conflict && kept.length > 1) { conflictCount.set(k, (conflictCount.get(k) || 0) + 1); conflicted = true; }
    }
    // Counted per case as well as per field: a case whose rows disagree about two
    // fields is one dirty collapse, and C4 measures cases, not field-disagreements.
    if (conflicted) conflictCases++;

    // Every row of the case is a comment when the export carries comment columns.
    c._comments = commentKeys.length ? kept.map((r) => {
      const at = get(r, "comment_at");
      return {
        id: get(r, "comment_id") || "",
        at: at || "", _at: parseDate(at),
        body: get(r, "comment_body") || "",
        author: get(r, "comment_author") || "",
        author_type: get(r, "comment_author_type") || "",
        // One answer from two spellings of opposite polarity. Unknown stays null:
        // an export with neither column says nothing about who could see what.
        public: map.comment_public ? truthy(get(r, "comment_public"))
          : map.comment_private ? !truthy(get(r, "comment_private")) : null,
      };
    }).filter((cm) => cm.at || cm.body) : [];
    // Oldest first, by time where there is one and by file order where there isn't.
    if (c._comments.some((cm) => cm._at != null)) {
      c._comments.sort((a, b) => (a._at ?? Infinity) - (b._at ?? Infinity));
    }
    c._rows = kept.length;
    // Rows before identical copies were dropped. C4 needs this in a one-row-per-case
    // export, where a repeated case ID is the fault being measured.
    c._rawRows = rows.length;
    cases.push(c);
  }

  const shape = multiRowCases > 0 ? "one_row_per_comment" : "one_row_per_case";
  const conflicts = [...conflictCount].map(([field, n]) => ({
    field, label: rules.fields[field].label, cases: n,
  })).sort((a, b) => b.cases - a.cases || a.field.localeCompare(b.field));

  return { cases, real, ph, shape, rows: records.length, duplicate_rows: duplicateRows,
    comment_rows: commentRows, multi_row_cases: multiRowCases, no_id_rows: noIdRows,
    conflicts, conflict_cases: conflictCases,
    case_level_fields: caseKeys, comment_fields: commentKeys.filter((k) => map[k]) };
}

// Per-case values the checks and signals read. Derived after collapsing, so a case
// built from twenty comment rows is indistinguishable here from one built from one.
function deriveCase(c, { map, real }) {
  c._created = parseDate(c.created_at);
  c._closed = parseDate(c.closed_at);
  c._isClosed = c.status !== undefined ? isClosedStatus(c.status) : c._closed != null;
  c._days = c._created != null && c._closed != null ? (c._closed - c._created) / DAY : null;
  c._owners = c.owner_changes !== undefined && c.owner_changes !== "" ? Number(c.owner_changes) : null;

  // Comment text is customer and agent wording the case fields don't carry. One
  // accessor, so the text checks and the theme signals can't drift apart.
  c._commentText = c._comments.map((cm) => cm.body).filter(Boolean).join(" \n");
  c._text = [c.subject, c.description, c._commentText].filter((s) => real(s) && s).join(" \n");

  // The last update is the latest public comment. Derived only when no column was
  // mapped, and only from comments we can date; which pool it came from is reported,
  // because "latest comment of any kind" includes internal notes the customer never saw.
  c._lastUpdateFrom = null;
  if (!map.last_update_at && c._comments.length) {
    const dated = c._comments.filter((cm) => cm._at != null);
    const pub = dated.filter((cm) => cm.public === true);
    const pool = pub.length ? pub : dated;
    if (pool.length) {
      const latest = pool.reduce((a, b) => (b._at > a._at ? b : a));
      c.last_update_at = latest.at;
      c._lastUpdateFrom = pub.length ? "latest_public_comment" : "latest_comment";
    }
  }
  c._lastUpdate = parseDate(c.last_update_at);
  return c;
}

// ---------- what was read ----------
// Said plainly and before any verdict: how many rows arrived, how many cases they
// collapsed to, how many comments came with them, and anything dropped or derived.
//
// One function, used by the audit and by the page's before-you-run summary, because
// two of these drifting apart is how a page ends up reporting "NaN cases".
function summariseLoad(L, U, rules) {
  const perCase = U.map((c) => c._comments.length).filter((k) => k > 0);
  const derived = [];
  const lastFrom = U.filter((c) => c._lastUpdateFrom);
  if (lastFrom.length) {
    const fromPublic = lastFrom.filter((c) => c._lastUpdateFrom === "latest_public_comment").length;
    derived.push({ field: "last_update_at", label: rules.fields.last_update_at.label, cases: lastFrom.length,
      from: fromPublic === lastFrom.length ? "latest_public_comment"
        : fromPublic ? "latest_public_comment_where_known" : "latest_comment",
      detail: fromPublic === lastFrom.length
        ? `Not in the export, so taken from the latest public comment on each of ${lastFrom.length.toLocaleString()} cases.`
        : fromPublic
          ? `Not in the export. Taken from the latest public comment where the export says which comments were public (${fromPublic.toLocaleString()} cases) and from the latest comment of any kind otherwise (${(lastFrom.length - fromPublic).toLocaleString()}).`
          : `Not in the export, and no column says which comments were public, so taken from the latest comment of any kind on each of ${lastFrom.length.toLocaleString()} cases. Internal notes count towards it.` });
  }
  const dropped = [];
  if (L.duplicate_rows) {
    const c = (rules.cautions || {}).dropped_comment_rows;
    dropped.push({ reason: "Repeated an earlier row identically in every column", rows: L.duplicate_rows,
      // In a comment export the likely cause is worth saying, because it changes what
      // the comment counts mean. In a one-row-per-case export the rows are simply
      // redundant copies and C4 counts them, so there is nothing to explain away.
      ...(L.shape === "one_row_per_comment" && c ? { note: c.text.trim() } : {}) });
  }
  return {
    shape: L.shape,
    rows: L.rows, cases: U.length,
    duplicate_rows: L.duplicate_rows,
    comment_rows: L.comment_rows,
    multi_row_cases: L.multi_row_cases,
    no_id_rows: L.no_id_rows,
    comments: perCase.reduce((a, b) => a + b, 0),
    cases_with_comments: perCase.length,
    comments_per_case: perCase.length
      ? { min: Math.min(...perCase), median: median(perCase), max: Math.max(...perCase) } : null,
    comment_fields: L.comment_fields,
    conflicts: L.conflicts,
    // Cases with at least one disagreeing field, which is what C4 measures in a
    // comment export; `conflicts` counts per field and a case can appear in two.
    conflict_cases: L.conflict_cases,
    dropped, derived,
  };
}

// The same summary, without running a single check. The page shows this beside the
// file picker so what was read is said before anything is judged.
export function readSummary({ records, headers = null, map, rules }) {
  const L = collapseRows({ records, headers, map, rules });
  const U = L.cases.map((c) => deriveCase(c, { map, real: L.real }));
  return summariseLoad(L, U, rules);
}

// The measure for a one-row-per-case export: rows that don't identify one case on
// their own. Every row of a repeated ID counts, because in that shape there is no
// reason for a second row to exist. Rows with no ID at all count too, for the same
// reason as ever: nothing tells them apart. They are reported separately, though,
// because "shares an ID" and "has no ID" are different things to go and fix.
function unidentifiedRows(cases, rows) {
  const counts = new Map();
  let blank = 0;
  for (const c of cases) {
    if (!c.case_id) { blank += c._rawRows; continue; }
    counts.set(c.case_id, (counts.get(c.case_id) || 0) + c._rawRows);
  }
  let repeated = 0;
  for (const k of counts.values()) if (k > 1) repeated += k;
  return { repeated, blank, share: rows ? (repeated + blank) / rows : 0 };
}

// ---------- cautions ----------
// A caution says a number was measured on data that arrived thinned. It is attached
// to whatever declared that it reads the thinned thing, and it never changes an
// outcome, a state or a lock: a caveat on a measurement is not a verdict on an export.
function activeCautions(rules, L) {
  const out = [];
  for (const [id, c] of Object.entries(rules.cautions || {})) {
    // Each condition sits with the caution that depends on it.
    if (id === "dropped_comment_rows" && !(L.shape === "one_row_per_comment" && L.duplicate_rows)) continue;
    if (id === "conflicting_case_field" && !L.conflicts.length) continue;
    out.push({ id, title: c.title, text: c.text.trim(), reads: c.applies_to_reads || [],
      ...(id === "dropped_comment_rows" ? { rows: L.duplicate_rows } : {}),
      ...(id === "conflicting_case_field" ? { fields: L.conflicts.map((x) => x.field),
        labels: L.conflicts.map((x) => x.label) } : {}) });
  }
  return out;
}
// What a check, signal or driver flag hears, given what it declared it reads.
const cautionsFor = (active, reads) =>
  (!reads || !reads.length) ? [] : active.filter((c) => c.reads.some((t) => reads.includes(t)));

// ---------- the audit ----------
export function runAudit({ records, mapping, headers = null, history = null, bot = null, rules, source = "upload" }) {
  const map = mapping;
  // Collapse first. Every check below sees one row per case, whatever shape arrived.
  const L = collapseRows({ records, headers, map, rules });
  const real = L.real;
  const U = L.cases.map((c) => deriveCase(c, { map, real }));
  const n = L.rows;        // rows read from the file
  const u = U.length;      // distinct cases after collapsing

  // A field the comment rows supplied is as present as one a column supplied, so
  // `has` has to know about it: otherwise deriving the last update from comments
  // would fill the value and still leave every signal that needs it locked.
  const derivedFields = new Set();
  if (!map.last_update_at && U.some((c) => c._lastUpdateFrom)) derivedFields.add("last_update_at");
  const has = (k) => !!map[k] || derivedFields.has(k);
  // A column can be present and hold nothing. `has` answers whether the export
  // carries the field, which is not the same question as whether anything is in it,
  // and a check that reads the values to judge something else has no business
  // passing on none of them: "0 distinct reasons, 0 used fewer than 5 times" came
  // out green, and "Reasons describe customer needs" was printed about a column
  // with no reasons in it at all. A check that *measures* emptiness is different and
  // keeps its verdict: B2's whole job is the blank share, and B1's is the fill rate.
  const hasValues = (k) => has(k) && U.some((c) => real(c[k]));
  // Nearly empty is not fine either. A reason column filled on 2 of 5,083 cases is
  // enough for `hasValues`, and that was enough to print "Reasons describe customer
  // needs", to warn about sprawl across two values, and to report "100% of cases that
  // have one" from two of them. A check that judges what the values *say* needs a
  // floor; one that counts how many there are does not, which is why B1 and B2 don't
  // declare requires_values and keep their verdicts.
  const FLOOR = rules.evidence_floor || {};
  const evidence = (k) => {
    const n = has(k) ? U.filter((c) => real(c[k])).length : 0;
    return { n, share: u ? n / u : 0 };
  };
  const belowFloor = (k) => {
    const e = evidence(k);
    const minN = FLOOR.min_cases ?? 0, minS = FLOOR.min_share ?? 0;
    const shortCount = e.n < minN, shortShare = e.share < minS;
    return shortCount || shortShare ? { ...e, minN, minS, shortCount, shortShare } : null;
  };
  // Only the floor that failed. Both can, and often do, but naming both when one was
  // met tells the reader the wrong thing about their data.
  const floorWanted = (e) => (e.shortCount && e.shortShare ? `${e.minN} cases and ${pct(e.minS, 0)}`
    : e.shortCount ? `${e.minN} cases` : `${pct(e.minS, 0)} of cases`);
  // The first field a check or signal declares that doesn't clear the floor.
  const shortOn = (def) => {
    for (const k of def.requires_values || []) {
      const e = belowFloor(k);
      if (e) return { field: k, ...e };
    }
    return null;
  };
  // The same shortfall said as a reason rather than as a check detail, for a signal.
  const shortReason = (k, e) => {
    const label = rules.fields[k].label.toLowerCase();
    return e.n
      ? `The ${label} column has a real value on only ${e.n.toLocaleString()} of ${u.toLocaleString()} cases (${pctFloor(e.share)}), below the ${floorWanted(e)} needed to group by it.`
      : `The ${label} column is there but every value in it is blank, so there is nothing to group by.`;
  };
  // Named with its column and its counts, because the fix is to that column and the
  // reader needs to see how far short it fell rather than take "too few" on trust.
  const tooFewDetail = (e) => {
    const label = rules.fields[e.field].label;
    const where = map[e.field] ? `mapped to “${map[e.field]}”` : "derived from the comment rows";
    if (!e.n) return `${label} is ${where}, and every value is blank or a placeholder. There is nothing here to judge.`;
    return `${label} is ${where}, with a real value on ${e.n.toLocaleString()} of ${u.toLocaleString()} cases (${pctFloor(e.share)}). `
      + `Judging what the values say needs at least ${floorWanted(e)}, so there isn't enough here to judge.`;
  };

  const R = {};
  const cautions = activeCautions(rules, L);
  const checkDef = Object.fromEntries(rules.checks.map((c) => [c.id, c]));
  const set = (id, outcome, value, display, detail, extra = {}) => {
    const d = checkDef[id];
    // A check may carry its own amber title, for when "failed" would misdescribe
    // what the export holds (B11: the account and the timings are there).
    // A column with too few values gets its own title first. Neither of the others
    // can be used: both the pass title and the failure title are claims about the
    // values, and on two reasons "Reasons describe teams, not customers" is as
    // baseless as "Reasons describe customer needs".
    const title = extra.title_from && d[extra.title_from] ? d[extra.title_from]
      : extra.too_few_field && d.too_few_title ? d.too_few_title
      : outcome === "pass" ? d.title
      : extra.conflict_cases && d.conflict_title ? d.conflict_title
      : outcome === "warn" && d.warn_title ? d.warn_title
      : d.failure_title || d.title;
    const heard = cautionsFor(cautions, d.reads);
    R[id] = { id, band: d.band, title, rule_title: d.title,
      outcome, value, display, detail, threshold: describeThreshold(d.threshold),
      ...(heard.length ? { cautions: heard } : {}), ...extra };
  };
  // Fill rates are per case, never per row: in a comment export a row count would
  // weight a case with forty comments forty times.
  const fill = (k) => (has(k) && u ? U.filter((c) => real(c[k])).length / u : null);
  const ufill = fill;

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
    for (const c of U) {
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
    const covered = U.filter((c) => c._created != null && c._created >= hist.earliest).length / u;
    const start = new Date(hist.earliest).toISOString().slice(0, 10);
    set("C3", evalThreshold(covered, checkDef.C3.threshold), covered, pct(covered),
      `History starts ${start}. ${pct(1 - covered)} of cases were created before then and look as if they never moved.`);
  }

  // C4, at case level, which means a different measurement in each shape.
  //
  // One row per case: a repeated case ID is two rows for one case, the old measure.
  // One row per comment: the case fields repeat on every row by design, so case
  // uniqueness still holds once collapsed and resolution analysis is unaffected. What
  // can still go wrong is a dirty collapse, where a case's rows disagree about a case
  // field and one value has to be discarded. That is what is measured there.
  //
  // Rows identical in every column are dropped before either measurement. In a
  // one-row-per-case export they are also a repeated case ID, so they count. In a
  // comment export they do not: they are reported in what was read and raise a
  // caution on anything read from comment text or counts, and nothing more.
  const comments = L.shape === "one_row_per_comment";
  const conflictCases = L.conflict_cases;
  const ident = comments ? null : unidentifiedRows(L.cases, n);
  const c4Value = comments ? (u ? conflictCases / u : 0) : ident.share;
  // Identical rows are dropped in either shape, but they mean opposite things: in a
  // one-row-per-case export they are the repeated case ID being measured, and in a
  // comment export they are a thinned comment log and nothing to do with the cases.
  const dropNote = !L.duplicate_rows ? ""
    : comments
      ? ` ${plural(L.duplicate_rows, "row")} identical in every column ${L.duplicate_rows === 1 ? "was" : "were"} dropped before this was measured. They thin the comment log, not the cases, so they don't count here; what was read says how many.`
      : ` ${plural(L.duplicate_rows, "row")} identical in every column ${L.duplicate_rows === 1 ? "was" : "were"} dropped before this was measured.`;
  const c4Detail = comments
    ? `${L.multi_row_cases.toLocaleString()} cases span more than one row: this export is one row per comment, not per case, and was collapsed before these checks ran. ` +
      (L.conflicts.length
        ? `${plural(conflictCases, "case")} ${conflictCases === 1 ? "has" : "have"} rows that disagree about a case field (${L.conflicts.map((c) => `${c.label.toLowerCase()} on ${c.cases.toLocaleString()}`).join(", ")}), so the collapse kept one value and dropped the rest.`
        : "Every case's rows agree on every case-level field, so the collapse is clean and each case is counted once.") + dropNote
    : ([ident.repeated ? `${plural(ident.repeated, "row")} ${ident.repeated === 1 ? "shares" : "share"} a case ID with another row` : "",
        ident.blank ? `${plural(ident.blank, "row")} ${ident.blank === 1 ? "carries" : "carry"} no case ID, so nothing tells ${ident.blank === 1 ? "it apart from another" : "them apart"}` : "",
       ].filter(Boolean).join(", and ") || "No repeated case IDs") + "." + dropNote;
  set("C4", has("case_id") ? evalThreshold(c4Value, checkDef.C4.threshold) : "not_in_export", c4Value, pct(c4Value, 1), c4Detail,
    { shape: L.shape, duplicate_rows: L.duplicate_rows, conflict_cases: conflictCases, rows: n, cases: u,
      ...(L.conflicts.length ? { conflict_fields: L.conflicts.map((c) => c.field),
        conflict_labels: L.conflicts.map((c) => c.label), fix: checkDef.C4.conflict_fix } : {}) });

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
  const b3Short = has("reason") ? shortOn(checkDef.B3) : null;
  if (b3Short) set("B3", "too_few", null, plural(b3Short.n, "reason"), tooFewDetail(b3Short), { too_few_field: b3Short.field });
  else if (has("reason")) {
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
  // Comment bodies are customer wording too, and in a comment export they are
  // usually the only place the customer's own words survive.
  const hasText = has("subject") || has("description") || has("comment_body");
  if (!hasText) set("AI1", "not_in_export", null, "No text", "No subject, description or comment body column.");
  else {
    const viaComment = U.filter((c) => !usable(c.subject) && !usable(c.description) && usable(c._commentText)).length;
    const share = U.filter((c) => usable(c.subject) || usable(c.description) || usable(c._commentText)).length / u;
    set("AI1", evalThreshold(share, checkDef.AI1.threshold), share, pct(share),
      `${pct(share)} of cases have usable customer wording.` +
      (viaComment ? ` ${viaComment.toLocaleString()} of them only in the comment text, not in the subject or description.` : ""));
  }

  // AI2
  if (!has("reason")) set("AI2", "not_in_export", null, "No reason", "No contact reason column.");
  else if (shortOn(checkDef.AI2)) { const e = shortOn(checkDef.AI2);
    set("AI2", "too_few", null, plural(e.n, "reason"), tooFewDetail(e), { too_few_field: e.field }); }
  else {
    const words = rules.team_words;
    const teamy = (v) => words.some((w) => new RegExp(`\\b${w}\\b`, "i").test(v));
    const tv = realReasons.filter(([v]) => teamy(v));
    const share = tv.reduce((s, [, k]) => s + k, 0) / u;
    set("AI2", evalThreshold(share, checkDef.AI2.threshold), share, pct(share),
      tv.length ? `${pct(share)} of cases use team-type reasons: ${tv.map(([v]) => `"${v}"`).join(", ")}.` : "Reasons describe customer needs.");
  }

  // AI3. Telling someone to sample cases from similar-sounding reasons is useless
  // advice when the reason column is empty, so it says what to fix instead.
  const ai3Short = has("reason") ? shortOn(checkDef.AI3) : null;
  if (ai3Short) set("AI3", "too_few", null, plural(ai3Short.n, "reason"), tooFewDetail(ai3Short), { too_few_field: ai3Short.field });
  else set("AI3", has("reason") ? "needs_human" : "not_in_export", null, "Review",
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
  // An empty reason column and a column of nothing but team-type reasons both leave
  // nothing to measure, but they are different problems with different fixes.
  const ai5Short = has("reason") ? shortOn(checkDef.AI5) : null;
  if (ai5Short) set("AI5", "too_few", null, plural(ai5Short.n, "reason"), tooFewDetail(ai5Short), { too_few_field: ai5Short.field });
  else if (!needTotal) set("AI5", has("reason") ? "needs_human" : "not_in_export", null, "n/a", "No usable reasons to measure.");
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
  // How many conversations this file marks as a resolution the bot claimed. Counted
  // here and not in the audit below, which is handed B11's verdict and so cannot
  // inform it. Without this, B11 passed on the case export loaded into the bot slot:
  // bot-scope matching had found a column for bot_linked_cases, which was all the
  // green path asked for, and nobody checked there was anything to audit.
  const botClaimed = bot && bot.mapping && bot.mapping.bot_claimed_resolved
    ? botRows.filter((r) => truthy(String(r[bot.mapping.bot_claimed_resolved] ?? ""))).length : 0;
  const botSameFile = looksLikeSameFile(records, headers, bot);
  // The basis the audit runs on. Named here rather than read back off B11's outcome,
  // because B11's amber now covers two different things and only one of them is a
  // conversation export that could be matched by account and timing.
  let b11Basis = "none";
  if (!botRows.length) set("B11", "not_in_export", null, "No bot export", b11Words("not_in_export"));
  else if (botSameFile) set("B11", "warn", 0, "Same file", b11Words("same_file"),
    { title_from: "same_file_title", bot_same_as_cases: true });
  else if (!botClaimed) set("B11", "too_few", 0, "0 claimed", b11Words("too_few"),
    { title_from: "too_few_title", bot_conversations: botRows.length, bot_claimed: 0 });
  else if (botHas("bot_linked_cases")) { b11Basis = "case_links"; set("B11", "pass", 1, "Case links", b11Words("pass")); }
  else if (botHas("account_id") && botHas("bot_started_at") && botHas("bot_ended_at")) {
    b11Basis = "account_and_timing";
    set("B11", "warn", 0.5, "Account and timings", b11Words("warn"));
  }
  else set("B11", "not_in_export", 0, "Not found", b11Words("not_in_export"));

  // Checks defined in the rules but not computed by this engine version. Without an
  // entry here the uses loop below dereferences undefined.
  for (const c of rules.checks) if (!R[c.id]) set(c.id, "needs_human", null, "Not yet", "This engine version doesn't run this check yet.");

  // ---------- the resolution audit ----------
  const resolution_audit = resolutionAudit({ bot, botRows, U, byIdKey: has("case_id"), rules, basis: b11Basis, real });

  // ---------- uses ----------
  // A use may need a file beyond the case export. It still reports its verdict
  // when that file is absent, so the question stays visible, but it is left out of
  // the fix-first weighting below: a missing second file isn't a flaw in this one.
  const fileSupplied = (f) => (f === "bot" ? botRows.length > 0 : true);
  // too_few ranks with needs_human: it holds a use back from green without being a
  // verdict on the export, and it maps to "can't tell yet" below rather than to amber
  // "usable with care", which would be too generous about data nothing can be read from.
  const rank = { pass: 0, warn: 1, needs_human: 1, too_few: 1, fail: 2, not_in_export: 2 };

  // A dirty collapse is a fault in named fields, so it holds back only the uses whose
  // numbers come from one of them. A conflict in follow_up_of says nothing about how
  // long cases took to resolve, and turning resolution time red for it sends people to
  // fix the wrong thing. The use's fields are the union of what its checks read, so
  // this follows the rules rather than a second list that could disagree with them.
  const conflictFields = new Set(L.conflicts.map((c) => c.field));
  const readsConflicted = (ids) => ids.some((id) =>
    (checkDef[id].reads_fields || []).some((f) => conflictFields.has(f)));
  // How far a conflict reaches into one use, in proportion to how the use uses the
  // field. Required check reads it: the use's own numbers are wrong, so C4 stands and
  // the use can go red. Only an optional check reads it: context is unreliable but the
  // headline isn't, so amber. Nothing reads it: C4 is set aside for this use entirely.
  // C4 itself is excluded from the test, because it reads the case ID and the case ID
  // is the key the rows were grouped by, so it cannot be one of the conflicts.
  const reach = (us) => {
    const all = [...us.required, ...us.optional];
    if (!conflictFields.size || !all.includes("C4")) return null;
    // A repeated or blank case ID is not field-scoped: that is the cases themselves,
    // and every use reads the cases. Only a dirty collapse is scoped.
    if (!R.C4.conflict_cases || rank[R.C4.outcome] === 0) return null;
    if (readsConflicted(us.required.filter((id) => id !== "C4"))) return null;
    return { setAside: true, soft: readsConflicted(us.optional.filter((id) => id !== "C4")) };
  };

  // What a use's own checks needed values in and didn't get enough of. A verdict
  // assembled from checks that each say "can't be judged" should say why on the use
  // itself: an AI readiness panel next to a full comment-text column gives no hint
  // that the reason column it groups by holds two values. Both halves are named,
  // because "no reason" alone reads as if nothing is in the export at all.
  //
  // Driven by the checks' own requires_values, not by every field they read: B8 reads
  // csat_score to measure how many cases carry a score, and a note saying that column
  // is thin would be repeating B8's answer back as a fault.
  const shortNote = (us) => {
    const ids = us.required.concat(us.optional || []);
    const declared = [...new Set(ids.flatMap((id) => checkDef[id].requires_values || []))];
    const short = declared.map((k) => [k, belowFloor(k)]).filter(([, e]) => e);
    if (!short.length) return {};
    const label = (k) => rules.fields[k].label.toLowerCase();
    const list = (a) => a.map(label).join(", ").replace(/, ([^,]*)$/, " and $1");
    const reads = [...new Set(ids.flatMap((id) => checkDef[id].reads_fields || []))];
    const held = reads.filter((k) => rules.fields[k].shape === "text" && hasValues(k));
    const lead = held.length ? `The ${list(held)} ${held.length > 1 ? "columns are" : "column is"} there, but ` : "";
    const keys = short.map(([k]) => k);
    const one = keys.length === 1;
    const body = one
      ? `${list(keys)} field has a real value on only ${short[0][1].n.toLocaleString()} of ${u.toLocaleString()} cases, too little to judge from`
      : `${list(keys)} fields hold too little to judge: ${short.map(([k, e]) => `${label(k)} on ${e.n.toLocaleString()}`).join(", ")} of ${u.toLocaleString()} cases`;
    return { too_few_fields: keys, too_few_note: `${lead}${lead ? "the" : "The"} ${body}.` };
  };
  const uses = rules.uses.map((us) => {
    const scoped = reach(us);
    const at = (id) => (scoped && scoped.setAside && id === "C4" ? { ...R[id], outcome: "pass" } : R[id]);
    const req = us.required.map(at);
    const worst = req.reduce((a, b) => (rank[b.outcome] > rank[a.outcome] ? b : a));
    let outcome = worst.outcome === "needs_human" ? "warn" : worst.outcome === "too_few" ? "needs_human" : worst.outcome;
    const optBad = us.optional.map(at).filter((c) => rank[c.outcome] >= 1);
    if (outcome === "pass" && optBad.length) outcome = "warn";
    // Matching returns by timing alone isn't implemented, so the audit returns
    // can't tell for every conversation. That is this tool's limit, not a flaw in
    // the export, so it reports "needs a human" rather than amber "usable with care".
    if (us.id === "resolution_audit" && resolution_audit.basis === "account_and_timing") outcome = "needs_human";
    // A file with no claimed resolutions, or the case export uploaded twice, is not a
    // judgement on the bot export: there isn't one yet. "Usable with care" would be
    // read as a verdict on data the audit never saw.
    if (us.id === "resolution_audit" && (R.B11.bot_same_as_cases || R.B11.outcome === "too_few")) outcome = "needs_human";
    // A conflict only an optional check reads costs the use its green, never its verdict.
    if (scoped && scoped.soft && outcome === "pass") outcome = "warn";
    const blockers = req.filter((c) => rank[c.outcome] >= 1).concat(outcome !== "fail" && outcome !== "not_in_export" ? optBad : []);
    if (scoped && scoped.soft && !blockers.includes(R.C4)) blockers.push(R.C4);
    return { id: us.id, title: us.title, outcome, blockers: blockers.map((c) => c.id),
      // Said plainly on the use, because "not held back by C4" is only trustworthy if
      // the reason it was set aside is visible next to the verdict.
      ...(scoped && scoped.setAside ? { conflicts_set_aside: [...conflictFields], conflicts_are_context_only: !!scoped.soft } : {}),
      ...shortNote(us),
      ...(us.needs_file ? { needs_file: us.needs_file, file_supplied: fileSupplied(us.needs_file) } : {}) };
  });
  const useById = Object.fromEntries(uses.map((x) => [x.id, x]));

  // ---------- signals ----------
  const signals = rules.signals.map((s) => computeSignal(s, { R, useById, has, hasValues, belowFloor, shortReason, U, real, rules, hist, cautions }));

  // ---------- fix first ----------
  const blockCount = {};
  for (const us of uses) {
    if (us.needs_file && !us.file_supplied) continue;
    for (const id of us.blockers) blockCount[id] = (blockCount[id] || 0) + (rank[R[id].outcome] === 2 ? 2 : 1);
  }
  const fixFirst = Object.entries(blockCount).filter(([id]) => R[id].outcome !== "needs_human" || blockCount[id] > 1)
    .sort((a, b) => b[1] - a[1] || rank[R[b[0]].outcome] - rank[R[a[0]].outcome]).slice(0, 3).map(([id]) => id);

  // ---------- drivers ----------
  const drivers = computeDrivers({ U, has, real, rules, cautions });

  const load = summariseLoad(L, U, rules);

  return {
    // build is the commit the page was deployed from, so a pasted report says which
    // build produced it. Read off the rules object like the rules version, which keeps
    // the engine a pure function of its inputs; the deploy workflow puts it there.
    meta: { engine: ENGINE_VERSION, rules: rules.meta.version, rules_status: rules.meta.status,
      build: rules.meta.build || "unstamped", source,
      rows: n, cases: u, shape: L.shape, history_rows: history ? history.length : 0, bot_rows: botRows.length,
      bot_claimed: botRows.length ? botClaimed : null, bot_same_as_cases: botSameFile,
      generated: new Date().toISOString() },
    load,
    checks: R, uses, signals, fixFirst, drivers, resolution_audit, cautions,
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
// Is the file in the bot slot the same file as the case export? Compared on structure
// and on the values of three rows rather than every cell: enough to catch the mistake
// that actually happens, which is uploading the case export into both slots. Bot-scope
// matching will happily find a column for every bot field in a case export, so without
// this the audit reports on cases as though they were conversations.
export function looksLikeSameFile(records, headers, bot) {
  if (!bot || !bot.records || !bot.records.length || !records || !records.length) return false;
  if (bot.records === records) return true;
  const ch = headers && headers.length ? headers : Object.keys(records[0]);
  const bh = bot.headers && bot.headers.length ? bot.headers : Object.keys(bot.records[0]);
  if (bh.length !== ch.length || bh.some((h, i) => h !== ch[i])) return false;
  if (bot.records.length !== records.length) return false;
  const row = (r) => ch.map((h) => String(r[h] ?? "")).join("\u0000");
  for (const i of [0, records.length >> 1, records.length - 1])
    if (row(records[i]) !== row(bot.records[i])) return false;
  return true;
}

function resolutionAudit({ bot, botRows, U, byIdKey, rules, basis, real }) {
  const spec = rules.resolution_audit || {};
  const P = spec.params;
  if (!P) return { available: false, reason: "The rules carry no resolution_audit parameters." };
  const windows = [...P.return_windows_days].sort((a, b) => a - b);
  const escMs = P.escalation_within_minutes * MINUTE;
  const maxMs = windows[windows.length - 1] * DAY;
  const normalise = !!P.normalise_reasons;
  const base = {
    available: true,
    basis,
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
    if (basis !== "case_links") {
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
  // Carried into every return below, locked ones included: a caution is a caveat on a
  // number, so it rides along with the signal rather than deciding whether it runs.
  // `reads` tags plus, for a conflict, the fields the signal says it requires: a signal
  // built on a field whose value had to be picked from disagreeing rows is worth a
  // caveat, and never worth a lock.
  const conflicted = (ctx.cautions || []).filter((c) =>
    c.id === "conflicting_case_field" && (s.requires_fields || []).some((f) => (c.fields || []).includes(f)));
  const heard = [...cautionsFor(ctx.cautions || [], s.reads), ...conflicted];
  const base = { id: s.id, title: s.title, shows: s.shows, disclaimer: s.disclaimer,
    ...(heard.length ? { cautions: heard } : {}) };
  for (const f of s.requires_fields || []) if (!has(f)) return { ...base, state: "locked", reason: `Needs a ${ctx.rules.fields[f].label.toLowerCase()} column.` };
  // A field this signal groups or counts by, which is present but holds too little to
  // group by. Left to run, theme movers reported "Stable" off two empty quarters and
  // self-help "0 candidate reasons", both of which read as findings rather than as the
  // absence of anything to find. Two reasons on 5,083 cases does the same thing.
  for (const f of s.requires_values || []) {
    if (!has(f)) return { ...base, state: "locked", reason: `Needs a ${ctx.rules.fields[f].label.toLowerCase()} column.` };
    const e = ctx.belowFloor(f);
    if (e) return { ...base, state: "too_few", reason: ctx.shortReason(f, e) };
  }
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
      .sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    // A reason has to appear often enough for a move in its share to mean anything.
    const minPer = P.min_cases_per_reason;
    const big = moves.filter((x) => x.n >= minPer);
    if (!big.length) {
      // "Stable" asserts that nothing moved. Nothing was measurable, which is not the
      // same claim, and on a thinly filled reason column it is the wrong one.
      const best = moves.reduce((a, b) => (b.n > (a?.n ?? -1) ? b : a), null);
      return { ...out, state: "too_few",
        reason: `No reason appears on ${minPer} or more cases, so no change in share can be read. `
          + (best ? `The most common, "${best.k}", has ${best.n}.` : "There are no reasons to compare."),
        headline: undefined };
    }
    out.headline = `${big[0].k} ${big[0].d > 0 ? "up" : "down"}`;
    out.detail = "Change in share of cases, last quarter versus the nine months before.";
    out.rows = big.slice(0, 4).map((m) => [m.k, `${m.d > 0 ? "+" : ""}${(m.d * 100).toFixed(1)} pts`, `${m.n} cases`]);
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
export function computeDrivers({ U, has, real, cautions = [] }) {
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
    // Reads the comment text as well, through the same accessor the text checks use.
    { id: "billing", label: "Any billing or invoice case", reads: ["comment_text"],
      fn: any((c) => /bill|invoice/i.test(`${c.reason} ${c.subject} ${c._commentText}`)) },
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
    const heard = cautionsFor(cautions, f.reads);
    return { id: f.id, label: f.label, prevalence, raw: rawOR, adj, holds, verdict,
      ...(heard.length ? { cautions: heard } : {}) };
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
