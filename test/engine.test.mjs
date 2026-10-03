// Every planted flaw in the demo data must produce the verdict it was planted for.
// Expected verdicts live in data/expected.json, which DATASHEET.md documents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCSV, autoMap, runAudit, evalThreshold } from "../src/engine.js";

const rules = JSON.parse(readFileSync(new URL("../dist/rules.json", import.meta.url)));
const expected = JSON.parse(readFileSync(new URL("../data/expected.json", import.meta.url)));
const load = (f) => parseCSV(readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));

function audit(which) {
  const { headers, records } = load(which === "snapshot" ? "larkspur_snapshot.csv" : "larkspur_with_history.csv");
  const history = which === "snapshot" ? null : load("larkspur_history_log.csv").records;
  const mapping = autoMap(headers, rules);
  return { report: runAudit({ records, mapping, history, rules }), headers, mapping };
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
