// Every planted flaw in the demo data must produce the verdict it was planted for.
// Expected verdicts live in data/expected.json, which DATASHEET.md documents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCSV, autoMap, runAudit, evalThreshold, nearDuplicate } from "../src/engine.js";

const rules = JSON.parse(readFileSync(new URL("../dist/rules.json", import.meta.url)));
const expected = JSON.parse(readFileSync(new URL("../data/expected.json", import.meta.url)));
const load = (f) => parseCSV(readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));

function audit(which, bot = null) {
  const { headers, records } = load(which === "snapshot" ? "larkspur_snapshot.csv" : "larkspur_with_history.csv");
  const history = which === "snapshot" ? null : load("larkspur_history_log.csv").records;
  const mapping = autoMap(headers, rules);
  return { report: runAudit({ records, mapping, history, bot, rules }), headers, mapping };
}
// A bot conversations export is mapped in bot scope, never case scope.
function botFile(f) {
  const { headers, records } = load(f);
  return { records, mapping: autoMap(headers, rules, "bot"), headers };
}

for (const which of ["snapshot", "history"]) {
  const { report, headers, mapping } = audit(which);
  test(`${which}: every column maps`, () => {
    assert.deepEqual(headers.filter((h) => !Object.values(mapping).includes(h)), []);
  });
  for (const [id, want] of Object.entries(expected[which].checks)) {
    test(`${which}: ${id} is ${want}`, () => assert.equal(report.checks[id].outcome, want, report.checks[id].detail));
  }
  for (const [id, want] of Object.entries(expected[which].uses)) {
    test(`${which}: use ${id} is ${want}`, () => assert.equal(report.uses.find((u) => u.id === id).outcome, want));
  }
  for (const [id, want] of Object.entries(expected[which].signals)) {
    test(`${which}: signal ${id} is ${want}`, () => assert.equal(report.signals.find((s) => s.id === id).state, want));
  }
  test(`${which}: only the planted drivers hold`, () => {
    const holds = report.drivers.results.filter((r) => r.holds).map((r) => r.id).sort();
    assert.deepEqual(holds, [...expected[which].drivers_hold].sort());
  });
}

test("thresholds: higher and lower directions", () => {
  assert.equal(evalThreshold(0.95, { dir: "higher", pass: 0.9, warn: 0.6 }), "pass");
  assert.equal(evalThreshold(0.7, { dir: "higher", pass: 0.9, warn: 0.6 }), "warn");
  assert.equal(evalThreshold(0.5, { dir: "higher", pass: 0.9, warn: 0.6 }), "fail");
  assert.equal(evalThreshold(0.0, { dir: "lower", pass: 0, warn: 0.01 }), "pass");
  assert.equal(evalThreshold(0.02, { dir: "lower", pass: 0, warn: 0.01 }), "fail");
});

test("csv parser handles quotes, commas and newlines in fields", () => {
  const { records } = parseCSV('a,b\n"x, y","line1\nline2"\n"he said ""hi""",2\n');
  assert.equal(records[0].a, "x, y");
  assert.equal(records[0].b, "line1\nline2");
  assert.equal(records[1].a, 'he said "hi"');
});

// B3 reports near-duplicate reason pairs and the audit folds them to one theme.
// Both call this, so pin it directly as well as through them.
test("near-duplicate reasons: plural spellings and acronyms, but not cousins", () => {
  assert.ok(nearDuplicate("Login issue", "Login Issues"));
  assert.ok(nearDuplicate("SSO", "Single sign-on"));
  assert.ok(nearDuplicate("Single sign-on", "SSO"), "the test is symmetric");
  assert.ok(!nearDuplicate("Login issue", "Billing question"));
  assert.ok(!nearDuplicate("Add users", "Remove users"), "same shape, different need");
});

// ---------------------------------------------------------------- file scoping
// The two field sets share synonyms on purpose. Scoping is the only thing keeping
// them apart, so test both directions of every shared header.

const BOT_FILES = { snapshot: "larkspur_bot_snapshot.csv", with_history: "larkspur_bot_with_history.csv" };
const caseHeaders = load("larkspur_with_history.csv").headers;

for (const [which, f] of Object.entries(BOT_FILES)) {
  test(`bot ${which}: every column maps`, () => {
    const { headers, mapping } = botFile(f);
    assert.deepEqual(headers.filter((h) => !Object.values(mapping).includes(h)), []);
  });
}

test("reopens is reopen_count in a case file and bot_reopens in a bot file", () => {
  const asCase = autoMap(caseHeaders, rules);
  assert.equal(asCase.reopen_count, "reopens");
  assert.equal(asCase.bot_reopens, undefined);
  const asBot = botFile(BOT_FILES.with_history).mapping;
  assert.equal(asBot.bot_reopens, "reopens");
  assert.equal(asBot.reopen_count, undefined);
});

// Scoping decides what a header means per file, not which file it is. A bot export
// handed to the case slot is still read as cases, and its `reopens` is still
// reopen_count, because nothing in a column name says which file it came from.
// What scoping guarantees is that no bot field can reach into a case file.
test("no bot field is ever offered a case file's columns", () => {
  for (const f of [...Object.values(BOT_FILES), "larkspur_with_history.csv", "larkspur_snapshot.csv"])
    assert.deepEqual(Object.keys(autoMap(load(f).headers, rules)).filter((k) => k.startsWith("bot_")), [], f);
});

test("a case file whose only ID column is conversation_id maps to case_id", () => {
  const raw = readFileSync(new URL("../data/larkspur_snapshot.csv", import.meta.url), "utf8");
  const nl = raw.indexOf("\n");
  const { headers, records } = parseCSV(raw.slice(0, nl).replace(/^case_id,/, "conversation_id,") + raw.slice(nl));
  assert.ok(headers.includes("conversation_id") && !headers.includes("case_id"));
  const mapping = autoMap(headers, rules);
  assert.equal(mapping.case_id, "conversation_id");
  assert.equal(mapping.bot_conversation_id, undefined, "a bot field must not claim a case file's column");
  assert.deepEqual(headers.filter((h) => !Object.values(mapping).includes(h)), []);
  const report = runAudit({ records, mapping, rules });
  assert.equal(report.checks.C1.outcome, "pass");
  assert.equal(report.checks.C4.outcome, expected.snapshot.checks.C4, "the ID still drives duplicate detection");
});
