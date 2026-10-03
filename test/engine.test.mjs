// Every planted flaw in the demo data must produce the verdict it was planted for.
// Expected verdicts live in data/expected.json, which DATASHEET.md documents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCSV, autoMap, mapColumns, headerVariants, runAudit, evalThreshold, nearDuplicate } from "../src/engine.js";

const rules = JSON.parse(readFileSync(new URL("../dist/rules.json", import.meta.url)));
const expected = JSON.parse(readFileSync(new URL("../data/expected.json", import.meta.url)));
const stats = JSON.parse(readFileSync(new URL("../data/generation_stats.json", import.meta.url)));
const load = (f) => parseCSV(readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));

function audit(which, bot = null, withRules = rules) {
  const { headers, records } = load(which === "snapshot" ? "larkspur_snapshot.csv" : "larkspur_with_history.csv");
  const history = which === "snapshot" ? null : load("larkspur_history_log.csv").records;
  const mapping = autoMap(headers, withRules);
  return { report: runAudit({ records, mapping, history, bot, rules: withRules }), headers, mapping };
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

// The audit needs a file the case export can't supply. Absent, the use still
// reports, but flagged so the page can leave it off the verdict panel: a missing
// second file is not a verdict on this one.
test("resolution_audit is flagged unsupplied when no bot file is given", () => {
  const { report } = audit("snapshot");
  const u = report.uses.find((x) => x.id === "resolution_audit");
  assert.equal(u.needs_file, "bot");
  assert.equal(u.file_supplied, false);
  assert.equal(report.resolution_audit.available, false);
  assert.ok(!report.fixFirst.includes("B11"), "a missing bot file must not become a fix-first item");
});

test("a supplied bot file flags the use as supplied", () => {
  for (const f of Object.values(BOT_FILES)) {
    const u = audit("snapshot", botFile(f)).report.uses.find((x) => x.id === "resolution_audit");
    assert.equal(u.file_supplied, true, f);
  }
});

// Amber is this tool's limit, not a flaw in the export, so it must not surface as
// the amber "usable with care" verdict the other uses mean by it.
test("matching by account and timing reports needs_human, never warn", () => {
  const { report } = audit("snapshot", botFile(BOT_FILES.snapshot));
  assert.equal(report.resolution_audit.basis, "account_and_timing");
  assert.equal(report.checks.B11.outcome, "warn");
  assert.equal(report.uses.find((u) => u.id === "resolution_audit").outcome, "needs_human");
  assert.equal(report.resolution_audit.buckets.cant_tell, report.resolution_audit.claimed,
    "nothing may be judged when the basis is timing");
  assert.equal(report.resolution_audit.buckets.contradicted, 0);
  assert.equal(report.resolution_audit.buckets.not_contradicted, 0);
});

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

// ----------------------------------------------------------- column name matching
const HEADERS = JSON.parse(readFileSync(new URL("./fixtures/headers.json", import.meta.url))).cases;

for (const [name, c] of Object.entries(HEADERS)) {
  test(`headers ${name}: maps as expected`, () => {
    assert.deepEqual(mapColumns({ headers: c.headers, rules }).map, c.expect);
  });
}

// A header can mean one thing. Two fields sharing a column would double-count it.
test("no column is ever mapped to two fields", () => {
  for (const [name, c] of Object.entries(HEADERS)) {
    const used = Object.values(mapColumns({ headers: c.headers, rules }).map);
    assert.equal(new Set(used).size, used.length, name);
  }
});

// Scoring must not depend on the order headers happen to arrive in.
test("matching does not depend on header order", () => {
  for (const [name, c] of Object.entries(HEADERS)) {
    const forward = mapColumns({ headers: c.headers, rules }).map;
    const back = mapColumns({ headers: [...c.headers].reverse(), rules }).map;
    assert.deepEqual(back, forward, name);
  }
});

test("header normalisation produces the forms we match on", () => {
  const has = (raw, want) => assert.ok(headerVariants(raw).includes(want), `${raw} -> ${want}, got ${JSON.stringify(headerVariants(raw))}`);
  has("CreatedDate", "created date");
  has("caseId", "case id");
  has("CSATScore", "csat score");
  has("Priority__c", "priority");
  has("Date/Time Opened", "opened");
  has("Date/Time Opened", "date time opened");
  has("Cust. Wait (mins)", "cust wait");
  has("ticket.status", "status");
});

// ----------------------------------------------------- inference from column values
// Opaque headers, recognisable contents. Only a column whose values fit exactly one
// field's shape is guessed, and a guess is always labelled as one.
const opaque = (n = 60) => Array.from({ length: n }, (_, i) => ({
  a: `REF-${10000 + i}`,
  b: `2026-0${(i % 9) + 1}-12 09:${String(i % 60).padStart(2, "0")}`,
  c: ["Billing", "Login issue", "Rota sync", "Payroll"][i % 4],
  d: `Customer ${i} reports the rota export failing every morning for their whole team`,
}));

test("values give away a column when its name doesn't", () => {
  const { map, confidence } = mapColumns({ headers: ["a", "b", "c", "d"], rules, records: opaque() });
  assert.equal(map.case_id, "a", "near-unique short tokens are an id");
  assert.equal(map.created_at, "b", "parseable dates are a date");
  assert.equal(map.subject, "d", "long varied prose is free text");
  for (const k of ["case_id", "created_at", "subject"]) assert.equal(confidence[k], "guess", k);
});

// parseDate ends in Date.parse, which reads "CASE-42" as the year 2042. Inference must
// not take that as evidence a column holds dates.
test("id-shaped values are not mistaken for dates", () => {
  const recs = Array.from({ length: 40 }, (_, i) => ({ a: `CASE-${i}`, b: `ACC-${1000 + i}` }));
  const { map } = mapColumns({ headers: ["a", "b"], rules, records: recs });
  assert.ok(!Object.keys(map).some((k) => rules.fields[k].shape === "date"), JSON.stringify(map));
});

// Two columns of the same shape carry no signal about which is which.
test("an ambiguous shape is left unmapped rather than guessed", () => {
  const recs = Array.from({ length: 40 }, (_, i) => ({
    a: `2026-01-${String((i % 27) + 1).padStart(2, "0")}`,
    b: `2026-05-${String((i % 27) + 1).padStart(2, "0")}`,
  }));
  assert.deepEqual(mapColumns({ headers: ["a", "b"], rules, records: recs }).map, {});
});

test("a guess never takes a column a name already claimed", () => {
  const headers = ["case_id", "a", "b", "c", "d"];
  const recs = opaque().map((r, i) => ({ ...r, case_id: `LS-${i}` }));
  const { map, confidence } = mapColumns({ headers, rules, records: recs });
  assert.equal(map.case_id, "case_id");
  assert.equal(confidence.case_id, "name");
  const used = Object.values(map);
  assert.equal(new Set(used).size, used.length);
});

test("autoMap never guesses, because it is given no values", () => {
  const { map } = mapColumns({ headers: ["a", "b", "c", "d"], rules });
  assert.deepEqual(map, {});
  assert.deepEqual(autoMap(["a", "b", "c", "d"], rules), {});
});

// ------------------------------------------------------- the demo mapping is pinned
// A better column matcher must not quietly remap the demo exports. If it does, every
// expected verdict in expected.json is measuring something other than it used to.
const PIN = JSON.parse(readFileSync(new URL("./fixtures/demo-mapping.json", import.meta.url))).demo;
const SNAPSHOT_DROP = ["reopens", "assignee_stations", "group_stations", "requester_wait_minutes"];

test("the demo exports map exactly as pinned", () => {
  const wh = load("larkspur_with_history.csv");
  const got = {
    "larkspur_snapshot (history cols dropped)": autoMap(wh.headers.filter((h) => !SNAPSHOT_DROP.includes(h)), rules),
    "larkspur_with_history": autoMap(wh.headers, rules),
    larkspur_bot_snapshot: autoMap(load("larkspur_bot_snapshot.csv").headers, rules, "bot"),
    larkspur_bot_with_history: autoMap(load("larkspur_bot_with_history.csv").headers, rules, "bot"),
  };
  for (const [file, want] of Object.entries(PIN)) assert.deepEqual(got[file], want, file);
});

// ----------------------------------------------------------- B11 and the audit

const truthByConversation = () => new Map(load("larkspur_bot_truth.csv").records.map((t) => [t.bot_conversation_id, t]));
const B11 = rules.checks.find((c) => c.id === "B11");

for (const [which, f] of Object.entries(BOT_FILES)) {
  const bot = botFile(f);
  const { report } = audit("snapshot", bot);
  const want = expected.bot[which];
  const a = report.resolution_audit;

  test(`bot ${which}: B11 is ${want.B11}`, () => assert.equal(report.checks.B11.outcome, want.B11, report.checks.B11.detail));
  test(`bot ${which}: B11 reports the rules' own wording`, () => assert.equal(report.checks.B11.detail, B11.outcomes[want.B11]));
  test(`bot ${which}: use resolution_audit is ${want.use}`, () =>
    assert.equal(report.uses.find((u) => u.id === "resolution_audit").outcome, want.use));
  test(`bot ${which}: audit works from ${want.basis}`, () => assert.equal(a.basis, want.basis));

  // Amber must not read as "aren't linked": the account and the timings are there.
  test(`bot ${which}: B11 titles the ${want.B11} outcome from the rules`, () => {
    const want_title = want.B11 === "pass" ? B11.title : want.B11 === "warn" ? B11.warn_title : B11.failure_title;
    assert.ok(want_title, "the rules must carry a title for this outcome");
    assert.equal(report.checks.B11.title, want_title);
    assert.equal(report.checks.B11.rule_title, B11.title);
  });

  test(`bot ${which}: totals match generation_stats.json`, () => {
    const e = stats.bot.expected_audit[which];
    assert.deepEqual(a.buckets, { contradicted: e.contradicted, not_contradicted: e.not_contradicted, cant_tell: e.cant_tell });
    assert.equal(a.claimed, stats.bot.claimed_resolved);
    assert.equal(a.out_of_scope, stats.bot.not_claimed.handoff + stats.bot.not_claimed.abandoned);
    assert.equal(a.conversations, stats.bot.conversations);
  });

  test(`bot ${which}: every conversation lands in its planted bucket`, () => {
    const T = truthByConversation();
    const key = which === "snapshot" ? "audit_snapshot" : "audit_with_history";
    const wrong = a.by_conversation
      .filter((c) => T.get(c.id)[key] !== c.bucket)
      .map((c) => `${c.id} (${T.get(c.id).planted}): want ${T.get(c.id)[key]}, got ${c.bucket}`);
    assert.deepEqual(wrong, []);
    assert.equal(a.by_conversation.length, stats.bot.claimed_resolved, "only claimed conversations are judged");
  });

  test(`bot ${which}: no link goes unresolved and no theme unread`, () => {
    assert.equal(a.unresolved_links, 0);
    assert.equal(a.unreadable_theme_cases, 0);
  });
}

// The link path, in detail. Only the with-history bot export has case links.
{
  const bot = botFile(BOT_FILES.with_history);
  const a = audit("snapshot", bot).report.resolution_audit;
  const p = stats.bot.planted, cum = stats.bot.same_theme_cumulative;
  const immediate = p.reopened + p.escalated; // both happen at once, so they fall in every window

  test("contradicted is reported cumulatively at 7, 14 and 30 days", () => {
    assert.deepEqual(a.contradicted_cumulative, [
      { days: 7, contradicted: immediate + cum.within_7 },
      { days: 14, contradicted: immediate + cum.within_14 },
      { days: 30, contradicted: immediate + cum.within_30 },
    ]);
    assert.equal(a.contradicted_cumulative.at(-1).contradicted, a.buckets.contradicted);
  });

  test("each contradiction is attributed to the planted reason", () => {
    assert.deepEqual(a.contradicted_by, { reopened: p.reopened, escalated: p.escalated, same_theme: cum.within_30 });
  });

  test(`the ${p.unrelated} unrelated repeat contacts are not contradicted`, () => {
    const T = truthByConversation();
    const un = a.by_conversation.filter((c) => T.get(c.id).planted === "unrelated");
    assert.equal(un.length, p.unrelated);
    assert.deepEqual([...new Set(un.map((c) => c.bucket))], ["not_contradicted"]);
  });

  test("every near-duplicate follow-up is matched, not missed", () => {
    const T = truthByConversation();
    const reason = new Map(load("larkspur_snapshot.csv").records.map((c) => [c.case_id, c.reason]));
    const intent = new Map(load(BOT_FILES.with_history).records.map((b) => [b.bot_conversation_id, b.intent]));
    const conv = new Map(a.by_conversation.map((c) => [c.id, c]));
    // A planted follow-up whose reason isn't spelled the way the bot's intent is.
    const nd = [...T.values()].filter((t) => t.audit_with_history === "contradicted" && t.follow_up_case_id &&
      reason.get(t.follow_up_case_id) !== intent.get(t.bot_conversation_id));
    const E = expected.resolution_audit;
    assert.equal(nd.length, E.near_duplicate_follow_ups);
    assert.deepEqual([...new Set(nd.map((t) => conv.get(t.bot_conversation_id).bucket))], ["contradicted"]);
    const why = nd.map((t) => conv.get(t.bot_conversation_id).why);
    assert.equal(why.filter((w) => w === "same_theme").length, E.near_duplicate_follow_ups_matched_by_theme);
    assert.equal(why.filter((w) => w === "escalated").length, E.near_duplicate_follow_ups_matched_by_timing);
  });

  test("normalising reasons is what recovers the near-duplicate returns", () => {
    const plain = JSON.parse(JSON.stringify(rules));
    plain.resolution_audit.params.normalise_reasons = false;
    const got = audit("snapshot", bot, plain).report.resolution_audit.buckets.contradicted;
    const E = expected.resolution_audit;
    assert.equal(got, E.contradicted_without_normalising);
    assert.equal(a.buckets.contradicted - got, E.near_duplicate_follow_ups_matched_by_theme);
  });
}

// The escalation and return windows are adjacent. Planted lags sit well clear of
// the boundary, so this one is hand-built to land in it.
test("a same-theme case three hours after the bot ended is contradicted", () => {
  const cases = parseCSV([
    "case_id,created_at,closed_at,status,reason,account_id",
    "LS-1,2026-01-01 12:00,2026-01-02 12:00,Solved,Login Issues,ACC-1",   // same theme, near-duplicate spelling
    "LS-2,2026-01-01 12:00,2026-01-02 12:00,Solved,Billing question,ACC-2", // different theme
    "LS-3,2026-01-01 09:30,2026-01-02 09:30,Solved,Billing question,ACC-3", // 30 minutes: a handover
  ].join("\n"));
  const conversations = parseCSV([
    "bot_conversation_id,started_at,ended_at,account_id,intent,claimed_resolved,linked_case_ids",
    "BOT-1,2026-01-01 08:30,2026-01-01 09:00,ACC-1,Login issue,Yes,LS-1",
    "BOT-2,2026-01-01 08:30,2026-01-01 09:00,ACC-2,Login issue,Yes,LS-2",
    "BOT-3,2026-01-01 08:30,2026-01-01 09:00,ACC-3,Login issue,Yes,LS-3",
  ].join("\n"));
  const report = runAudit({
    records: cases.records, mapping: autoMap(cases.headers, rules), rules,
    bot: { records: conversations.records, mapping: autoMap(conversations.headers, rules, "bot") },
  });
  assert.equal(report.checks.B11.outcome, "pass");
  const c = Object.fromEntries(report.resolution_audit.by_conversation.map((x) => [x.id, x]));
  assert.equal(c["BOT-1"].bucket, "contradicted", "three hours is past the escalation window, so it is a return");
  assert.equal(c["BOT-1"].why, "same_theme");
  assert.equal(c["BOT-2"].bucket, "not_contradicted", "a different theme at three hours is just another case");
  assert.equal(c["BOT-3"].why, "escalated", "inside the escalation window, theme isn't asked");
});

test("the engine reads no files, least of all the answer key", () => {
  const src = readFileSync(new URL("../src/engine.js", import.meta.url), "utf8");
  assert.match(src, /^\/\/ Support Signal engine/, "wrong file");
  for (const forbidden of [/larkspur_bot_truth/, /generation_stats/, /node:fs/, /readFileSync/, /\bfetch\s*\(/, /\brequire\s*\(/])
    assert.doesNotMatch(src, forbidden);
});
