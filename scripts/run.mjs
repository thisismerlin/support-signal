import { readFileSync } from "node:fs";
import { parseCSV, autoMap, runAudit } from "../src/engine.js";
const rules = JSON.parse(readFileSync(new URL("../dist/rules.json", import.meta.url)));
const FILES = {
  snapshot: "larkspur_snapshot.csv",
  history: "larkspur_with_history.csv",
  comments: "larkspur_comment_rows.csv",
  "comments-dups": "larkspur_comment_rows_with_duplicates.csv",
};
const which = process.argv[2] || "snapshot";
const file = FILES[which];
if (!file) { console.error(`usage: node scripts/run.mjs [${Object.keys(FILES).join("|")}]`); process.exit(2); }
const { headers, records } = parseCSV(readFileSync(new URL(`../data/${file}`, import.meta.url), "utf8"));
const mapping = autoMap(headers, rules);
const history = which === "history" ? parseCSV(readFileSync(new URL("../data/larkspur_history_log.csv", import.meta.url), "utf8")).records : null;
const rep = runAudit({ records, mapping, headers, history, rules, source: which });
console.log("unmapped:", headers.filter(h => !Object.values(mapping).includes(h)));
// What was read, before any verdict.
const L = rep.load;
console.log("READ", `shape=${L.shape}`, `rows=${L.rows}`, `cases=${L.cases}`,
  `comments=${L.comments}`, `duplicate_rows=${L.duplicate_rows}`, `no_id_rows=${L.no_id_rows}`,
  L.comments_per_case ? `per_case=${L.comments_per_case.min}/${L.comments_per_case.median}/${L.comments_per_case.max}` : "");
for (const d of L.derived) console.log("DERIVED", d.field, `(${d.from})`, d.cases, "cases");
for (const c of L.conflicts) console.log("CONFLICT", c.field, c.cases, "cases disagree between their rows");
for (const d of L.dropped) console.log("DROPPED", d.rows, "rows:", d.reason, d.note ? `\n        ${d.note}` : "");
// Cautions: caveats on numbers, never verdicts, so they print before the verdicts do.
for (const c of rep.cautions) console.log("CAUTION", c.id, `-> ${c.reads.join(", ")}:`, c.text);
for (const c of Object.values(rep.checks)) console.log(c.id.padEnd(4), c.outcome.padEnd(14), String(c.display).padEnd(14), c.detail);
for (const u of rep.uses) console.log("USE", u.id.padEnd(10), u.outcome.padEnd(14), u.blockers.join(","));
for (const s of rep.signals) console.log("SIG", s.id.padEnd(13), s.state.padEnd(8), s.headline || s.reason || "");
console.log("fix first", rep.fixFirst);
if (rep.drivers.available) for (const r of rep.drivers.results) console.log("DRV", r.label.padEnd(56), r.raw.or.toFixed(2), `[${r.raw.lo.toFixed(2)},${r.raw.hi.toFixed(2)}]`, "->", r.adj?.or.toFixed(2), `[${r.adj?.lo.toFixed(2)},${r.adj?.hi.toFixed(2)}]`, r.holds ? "HOLDS" : "");
