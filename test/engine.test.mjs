// Every planted flaw in the demo data must produce the verdict it was planted for.
// Expected verdicts live in data/expected.json, which DATASHEET.md documents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCSV, autoMap, mapColumns, headerVariants, runAudit, evalThreshold, nearDuplicate, collapseRows, readSummary } from "../src/engine.js";

const rules = JSON.parse(readFileSync(new URL("../dist/rules.json", import.meta.url)));
const expected = JSON.parse(readFileSync(new URL("../data/expected.json", import.meta.url)));
const stats = JSON.parse(readFileSync(new URL("../data/generation_stats.json", import.meta.url)));
const load = (f) => parseCSV(readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));

const FILES = { snapshot: "larkspur_snapshot.csv", history: "larkspur_with_history.csv",
  comments: "larkspur_comment_rows.csv", comment_dups: "larkspur_comment_rows_with_duplicates.csv" };

function audit(which, bot = null, withRules = rules) {
  const { headers, records } = load(FILES[which] || FILES.history);
  const history = which === "history" ? load("larkspur_history_log.csv").records : null;
  const mapping = autoMap(headers, withRules);
  return { report: runAudit({ records, mapping, headers, history, bot, rules: withRules }), headers, mapping };
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

// ------------------------------------------------- one row per case comment
// A real export is often one row per comment, with the case fields repeated. That
// is a shape, not a fault: it must be named, collapsed, and then judged exactly as
// the ordinary export is. The generator writes the same Larkspur cases in that
// shape, so the two can be compared verdict for verdict.

const commentRows = () => {
  const { headers, records } = load(FILES.comments);
  const mapping = autoMap(headers, rules);
  return { headers, records, mapping, report: runAudit({ records, mapping, headers, rules }) };
};

test("the comment-rows export maps every column, comment fields included", () => {
  const { headers, mapping } = commentRows();
  assert.deepEqual(headers.filter((h) => !Object.values(mapping).includes(h)), []);
  for (const k of ["comment_id", "comment_body", "comment_at", "comment_author", "comment_author_type", "comment_public"])
    assert.ok(mapping[k], `${k} should map in a one-row-per-comment export`);
  // The case's own created_at must not be stolen by the comment timestamp, or every
  // duration in the report is measured from the wrong end.
  assert.equal(mapping.created_at, "created_at");
  assert.equal(mapping.comment_at, "comment_created_at");
});

test("the file's shape is reported as one row per comment, not as a failure", () => {
  const { report } = commentRows();
  const s = stats.comments;
  assert.equal(report.load.shape, "one_row_per_comment");
  assert.equal(report.meta.shape, "one_row_per_comment");
  assert.equal(report.load.rows, s.rows);
  assert.equal(report.load.cases, s.cases);
  assert.equal(report.load.multi_row_cases > 0, true);
  assert.deepEqual(report.load.comments_per_case, s.comments_per_case);
  assert.deepEqual(report.load.conflicts, [], "the case fields are repeated, so nothing conflicts");
  assert.equal(report.load.conflict_cases, 0);
  // C4 judges the cases, and they collapse cleanly, so the shape passes it. The
  // identical rows are still counted and still said, just not held against the cases.
  assert.equal(report.checks.C4.outcome, "pass");
  assert.equal(report.checks.C4.conflict_cases, 0);
  assert.equal(report.checks.C4.duplicate_rows, s.exact_duplicate_rows);
  assert.match(report.checks.C4.detail, /one row per comment/);
  assert.match(report.checks.C4.detail, /collapse is clean/);
  assert.match(report.checks.C4.detail, /don't count here/);
});

test("collapsing gives the same verdicts as the ordinary export", () => {
  const { report } = commentRows();
  const want = expected.comments;
  // Pinned against the snapshot's own expectations, so the two can never drift, bar
  // the exceptions named in expected.json. C4 is one: the snapshot's repeated case
  // rows are a duplicate there and the file's shape here, which is the whole point.
  const differ = expected.comments_differ_from_snapshot;
  assert.deepEqual({ ...want.checks, ...differ }, { ...expected.snapshot.checks, ...differ },
    "the comment file must expect the snapshot's verdicts apart from the named exceptions");
  for (const [id, outcome] of Object.entries(differ))
    assert.notEqual(outcome, expected.snapshot.checks[id], `${id} is listed as differing but matches the snapshot`);
  for (const [id, outcome] of Object.entries({ ...want.checks, ...differ }))
    assert.equal(report.checks[id].outcome, outcome, `${id}: ${report.checks[id].detail}`);
  for (const [id, outcome] of Object.entries(expected.snapshot.uses))
    assert.equal(report.uses.find((u) => u.id === id).outcome, outcome, `use ${id}`);
  for (const [id, state] of Object.entries(expected.snapshot.signals))
    assert.equal(report.signals.find((s) => s.id === id).state, state, `signal ${id}`);
  const holds = report.drivers.results.filter((r) => r.holds).map((r) => r.id).sort();
  assert.deepEqual(holds, [...expected.snapshot.drivers_hold].sort());
});

test("the collapsed case count equals the ordinary export's", () => {
  const { report } = commentRows();
  const plain = audit("snapshot").report;
  assert.equal(report.load.cases, plain.load.cases);
  assert.equal(report.meta.cases, plain.meta.cases);
  assert.ok(report.load.rows > plain.load.rows, "the comment file has more rows for the same cases");
});

// The point of reading the comment rows rather than discarding them.
test("last update is derived from the latest public comment when no column carries it", () => {
  const { headers, records, mapping, report } = commentRows();
  assert.equal(mapping.last_update_at, undefined, "the fixture drops the column on purpose");
  const d = report.load.derived.find((x) => x.field === "last_update_at");
  assert.ok(d, "the derivation must be reported, not silent");
  assert.equal(d.from, "latest_public_comment");
  assert.equal(d.cases, report.load.cases);

  // Re-derive it from the raw rows: the latest *public* comment, which for a case
  // that ends on an internal note is not the latest comment.
  // Read as UTC, the way the engine reads it. Date.parse would read these as local
  // time and drift by an hour over summer, which would be the test's bug, not the
  // engine's, and would hide a real one.
  const utc = (s) => Date.parse(`${s.replace(" ", "T")}Z`);
  const latest = new Map(), latestAny = new Map();
  for (const r of records) {
    const t = utc(r.comment_created_at);
    if (r.comment_public === "Yes") latest.set(r.case_id, Math.max(latest.get(r.case_id) ?? 0, t));
    latestAny.set(r.case_id, Math.max(latestAny.get(r.case_id) ?? 0, t));
  }
  const L = collapseRows({ records, headers, map: mapping, rules });
  let checked = 0, differ = 0;
  for (const c of L.cases) {
    const want = latest.get(c.case_id);
    const pub = c._comments.filter((cm) => cm.public === true);
    const got = Math.max(...pub.map((cm) => cm._at));
    assert.equal(got, want, c.case_id);
    checked++;
    if (want !== latestAny.get(c.case_id)) differ++;
  }
  assert.equal(checked, report.load.cases);
  assert.equal(differ, stats.comments.cases_ending_on_internal_note);
  assert.ok(differ > 0, "if no case ended on an internal note, public-only would prove nothing");
});

test("the text checks read comment bodies as well as subject and description", () => {
  const { report } = commentRows();
  // Every case here has at least one comment, so none is left without wording, and
  // the detail line says how many only have it in the comments.
  assert.equal(report.checks.AI1.outcome, expected.snapshot.checks.AI1);
  assert.ok(report.checks.AI1.value >= audit("snapshot").report.checks.AI1.value,
    "comment text can only add usable wording, never remove it");
  assert.match(report.checks.AI1.detail, /only in the comment text/);
});

test("a comment body with no subject or description still counts as usable wording", () => {
  const csv = parseCSV([
    "case_id,created_at,closed_at,status,subject,description,comment_created_at,comment_body,comment_public",
    "LS-1,2026-01-01 09:00,2026-01-02 09:00,Solved,Help,,2026-01-01 10:00,\"The payroll export failed this morning for our whole Leeds team\",Yes",
  ].join("\n"));
  const mapping = autoMap(csv.headers, rules);
  const report = runAudit({ records: csv.records, mapping, headers: csv.headers, rules });
  // "Help" is junk and the description is empty, so only the comment can carry it.
  assert.equal(report.checks.AI1.value, 1);
  assert.match(report.checks.AI1.detail, /1 of them only in the comment text/);
});

// Duplicates inside a one-to-many export. They are dropped and said out loud, but
// they are a thinned comment log, not a case counted twice, so C4 is not where they
// land: 529 identical rows of 15,689 still collapse to the same 5,083 clean cases.
test("a repeated comment row is dropped and reported, and does not fail C4", () => {
  const { headers, records } = load(FILES.comment_dups);
  const mapping = autoMap(headers, rules);
  const report = runAudit({ records, mapping, headers, rules });
  const s = stats.comments;
  const want = expected.comment_duplicates;
  assert.equal(report.load.shape, "one_row_per_comment");
  assert.equal(report.load.rows, s.rows_with_duplicates);
  assert.equal(report.load.duplicate_rows, s.exact_duplicate_rows_with_duplicates);
  assert.equal(report.load.cases, s.cases, "duplicates must not invent cases");
  assert.equal(report.load.conflict_cases, 0, "the collapse is clean, which is why C4 passes");

  // 1. Case level only: the collapse is clean, so this passes.
  assert.equal(report.checks.C4.outcome, want.C4);

  // 2. Still dropped, still counted, and the likely cause named.
  assert.equal(report.load.dropped[0].rows, s.exact_duplicate_rows_with_duplicates);
  assert.match(report.load.dropped[0].note, /no comment ID or timestamp/);
  assert.match(report.load.dropped[0].note, /floor rather than a count/);

  // 3. A caution on whatever reads comment text or counts, and on nothing else.
  assert.deepEqual(report.cautions.map((c) => c.id), want.cautions);
  assert.equal(report.cautions[0].rows, s.exact_duplicate_rows_with_duplicates);
  const cautioned = Object.values(report.checks).filter((c) => c.cautions).map((c) => c.id);
  assert.deepEqual(cautioned, want.cautioned_checks);
  assert.deepEqual(report.drivers.results.filter((r) => r.cautions).map((r) => r.id), want.cautioned_drivers);

  // A caution is not a block: the cautioned check keeps the verdict it earned, and
  // nothing is locked by it.
  assert.equal(report.checks.AI1.outcome, expected.snapshot.checks.AI1);
  for (const [id, state] of Object.entries(expected.snapshot.signals))
    assert.equal(report.signals.find((x) => x.id === id).state, state, `signal ${id}`);
});

// Requirement 4, stated as its own test rather than left implicit in the snapshot's
// expectations: the new rule must not soften a plain export that repeats a case.
test("a one-row-per-case export with repeated rows still fails C4", () => {
  const row = "LS-1,2026-01-01 09:00,2026-01-02 09:00,Solved,Agent A,Login issue";
  const csv = parseCSV(["case_id,created_at,closed_at,status,owner,reason", row, row,
    "LS-2,2026-01-01 09:00,2026-01-02 09:00,Solved,Agent B,Billing question"].join("\n"));
  const mapping = autoMap(csv.headers, rules);
  const report = runAudit({ records: csv.records, mapping, headers: csv.headers, rules });
  assert.equal(report.load.shape, "one_row_per_case", "no case spans two distinct rows");
  assert.equal(report.load.duplicate_rows, 1);
  // Two of three rows share a case ID, which is nowhere near the amber band.
  assert.equal(report.checks.C4.outcome, "fail");
  assert.equal(report.checks.C4.value, 2 / 3);
  assert.match(report.checks.C4.detail, /share a case ID/);
  // No comment columns, so nothing is cautioned and no drop note is invented.
  assert.deepEqual(report.cautions, []);
  assert.equal(report.load.dropped[0].note, undefined);
});

// Rows with no case ID at all counted towards C4 before this change and still do:
// nothing tells them apart, which is the same fault by a different route. They are
// named separately, because "shares an ID" and "has no ID" are different things to fix.
test("rows with no case ID still count towards C4, and are named as their own cause", () => {
  const head = "case_id,created_at,closed_at,status,owner,reason";
  const run = (rows) => {
    const csv = parseCSV([head, ...rows].join("\n"));
    return runAudit({ records: csv.records, mapping: autoMap(csv.headers, rules), headers: csv.headers, rules });
  };
  const a = "LS-1,2026-01-01 09:00,2026-01-02 09:00,Solved,Agent A,Login issue";
  const blank = ",2026-01-03 09:00,2026-01-04 09:00,Solved,Agent B,Billing question";
  const c = "LS-2,2026-01-05 09:00,2026-01-06 09:00,Solved,Agent C,SSO";

  const blankOnly = run([a, blank, c]);
  assert.equal(blankOnly.load.no_id_rows, 1);
  assert.equal(blankOnly.checks.C4.value, 1 / 3);
  assert.match(blankOnly.checks.C4.detail, /carries no case ID/);
  assert.doesNotMatch(blankOnly.checks.C4.detail, /shares? a case ID/);

  // Both causes at once are added together and both said, in singular English.
  const both = run([a, a, blank, c]);
  assert.equal(both.checks.C4.value, 3 / 4);
  assert.match(both.checks.C4.detail, /2 rows share a case ID/);
  assert.match(both.checks.C4.detail, /1 row carries no case ID/);
  assert.doesNotMatch(both.checks.C4.detail, /1 rows|carry no case ID/, "no \"1 rows\"");

  // A clean file says so, and nothing is invented about drops that didn't happen.
  const clean = run([a, c]);
  assert.equal(clean.checks.C4.outcome, "pass");
  assert.equal(clean.checks.C4.detail, "No repeated case IDs.");
});

// And the same shape at the scale the demo plants it, against the expectation the
// ordinary exports already carry.
for (const which of ["snapshot", "history"]) {
  test(`${which}: repeated case rows still land on C4 as before`, () => {
    const { report } = audit(which);
    assert.equal(report.load.shape, "one_row_per_case");
    assert.equal(report.checks.C4.outcome, expected[which].checks.C4);
    assert.match(report.checks.C4.detail, /share a case ID/);
    assert.deepEqual(report.cautions, []);
  });
}

// Hand-built, so each of the three causes of a repeated case ID is present once and
// can be told apart by name.
test("true duplicates, comment rows and a case-level conflict are told apart", () => {
  const csv = parseCSV([
    "case_id,created_at,closed_at,status,owner,reason,comment_created_at,comment_body,comment_public",
    // LS-1: three comment rows, case fields agreeing. The file's shape.
    "LS-1,2026-01-01 09:00,2026-01-04 09:00,Solved,Agent A,Login issue,2026-01-01 10:00,First reply to the customer about this,Yes",
    "LS-1,2026-01-01 09:00,2026-01-04 09:00,Solved,Agent A,Login issue,2026-01-02 10:00,Customer came back with more detail here,Yes",
    "LS-1,2026-01-01 09:00,2026-01-04 09:00,Solved,Agent A,Login issue,2026-01-03 10:00,Internal note before closing this one,No",
    // LS-2: one row, then the very same row again. A redundant copy.
    "LS-2,2026-01-01 09:00,2026-01-02 09:00,Solved,Agent B,Billing question,2026-01-01 11:00,Only comment on this case at all,Yes",
    "LS-2,2026-01-01 09:00,2026-01-02 09:00,Solved,Agent B,Billing question,2026-01-01 11:00,Only comment on this case at all,Yes",
    // LS-3: two comment rows whose owner disagrees. A conflict, named and counted.
    "LS-3,2026-01-01 09:00,2026-01-05 09:00,Solved,Agent C,SSO,2026-01-01 12:00,Picked this up from the queue today,Yes",
    "LS-3,2026-01-01 09:00,2026-01-05 09:00,Solved,Agent D,SSO,2026-01-02 12:00,Taking this over from my colleague,Yes",
    // LS-4: case fields blanked on the second row, which is not disagreement.
    "LS-4,2026-01-01 09:00,2026-01-03 09:00,Solved,Agent E,Add users,2026-01-01 13:00,Answered the question for them,Yes",
    "LS-4,,,,,,2026-01-02 13:00,Confirmed they are happy with that,Yes",
  ].join("\n"));
  const mapping = autoMap(csv.headers, rules);
  const report = runAudit({ records: csv.records, mapping, headers: csv.headers, rules });
  const L = report.load;

  assert.equal(L.rows, 9);
  assert.equal(L.cases, 4, "four case IDs, whatever the row count");
  assert.equal(L.shape, "one_row_per_comment");
  assert.equal(L.duplicate_rows, 1, "only LS-2's repeat is identical in every column");
  assert.deepEqual(L.comments_per_case, { min: 1, median: 2, max: 3 });

  // The conflict names the field and counts the cases, and only the real one.
  assert.deepEqual(L.conflicts, [{ field: "owner", label: "Owner", cases: 1 }]);

  // Blanked repeats take the first real value rather than becoming a conflict.
  const byId = new Map(collapseRows({ records: csv.records, headers: csv.headers, map: mapping, rules })
    .cases.map((c) => [c.case_id, c]));
  assert.equal(byId.get("LS-4").status, "Solved");
  assert.equal(byId.get("LS-4").reason, "Add users");
  assert.equal(byId.get("LS-4")._comments.length, 2);
  // First row in file order wins a genuine disagreement, and it is reported.
  assert.equal(byId.get("LS-3").owner, "Agent C");

  // C4 fails here, but on the conflict rather than the copy: one case of four
  // collapsed dirty, which is 25%. The redundant copy is still counted and reported,
  // and on its own it would not have failed anything.
  assert.equal(report.checks.C4.outcome, "fail");
  assert.equal(report.checks.C4.conflict_cases, 1);
  assert.equal(report.checks.C4.value, 1 / 4);
  assert.equal(report.checks.C4.duplicate_rows, 1);
  assert.match(report.checks.C4.detail, /disagree about a case field/);
  // Each case counted once: four cases, not nine.
  assert.equal(report.meta.cases, 4);
  assert.equal(report.meta.rows, 9);
});

// ------------------------------- a comment column mapped as a case field
// From a real comment-row export that needed one mapping corrected by hand. Three
// faults, one cause: `parent_case` holds a value per comment, so it was auto-mapped to
// the case field follow_up_of, the collapse then reported a conflict, and the conflict
// turned resolution time red and was described as cases appearing more than once.

const COMMENT_CONFLICT = [
  "case_id,created_at,closed_at,status,owner,reason,parent_case,comment_created_at,comment_body,comment_public",
  "LS-1,2026-01-01 09:00,2026-01-04 09:00,Solved,Agent A,Login issue,LS-900,2026-01-01 10:00,First reply to the customer about this,Yes",
  "LS-1,2026-01-01 09:00,2026-01-04 09:00,Solved,Agent A,Login issue,LS-901,2026-01-02 10:00,Customer came back with more detail here,Yes",
  // An identical repeated row as well, so the drop note fires on the same run.
  "LS-2,2026-01-01 09:00,2026-01-02 09:00,Solved,Agent B,Billing question,LS-902,2026-01-01 11:00,Only comment on this case at all,Yes",
  "LS-2,2026-01-01 09:00,2026-01-02 09:00,Solved,Agent B,Billing question,LS-902,2026-01-01 11:00,Only comment on this case at all,Yes",
].join("\n");

test("a column that changes between a case's comments is not mapped to a case field", () => {
  const csv = parseCSV(COMMENT_CONFLICT);
  const m = mapColumns({ headers: csv.headers, rules, records: csv.records });
  assert.equal(m.shape, "one_row_per_comment");
  assert.equal(m.map.follow_up_of, undefined, "parent_case varies within a case, so it is not follow_up_of");
  assert.ok(!Object.values(m.map).includes("parent_case"), "and no other case field takes it either");

  // The refusal is reported, with the column named, so the How column can explain it.
  assert.deepEqual(m.refused.follow_up_of, { header: "parent_case", reason: "varies_within_case" });

  // Columns that stay the same across a case's rows are mapped as before.
  for (const k of ["case_id", "created_at", "closed_at", "status", "owner", "reason"])
    assert.ok(m.map[k], `${k} should still map`);
  // And the comment columns still win their own headers.
  assert.equal(m.map.comment_body, "comment_body");
  assert.equal(m.map.comment_at, "comment_created_at");

  // With nothing mis-mapped there is no conflict left to report at all.
  const report = runAudit({ records: csv.records, mapping: m.map, headers: csv.headers, rules });
  assert.deepEqual(report.load.conflicts, []);
  assert.equal(report.checks.C4.outcome, "pass");
});

test("a one-row-per-case export is unaffected by the varying-column rule", () => {
  // Same rule, no grouping to judge: every case is one row, so nothing can vary.
  const csv = parseCSV(["case_id,created_at,closed_at,status,owner,reason,parent_case",
    "LS-1,2026-01-01 09:00,2026-01-02 09:00,Solved,Agent A,Login issue,LS-900",
    "LS-2,2026-01-03 09:00,2026-01-04 09:00,Solved,Agent B,Billing question,LS-901"].join("\n"));
  const m = mapColumns({ headers: csv.headers, rules, records: csv.records });
  assert.equal(m.shape, null);
  assert.equal(m.map.follow_up_of, "parent_case", "a case export's parent_case is still follow_up_of");
  assert.deepEqual(m.refused, {});
});

for (const f of Object.values(FILES)) {
  test(`${f}: the varying-column rule changes no mapping in the demo exports`, () => {
    const { headers, records } = load(f);
    const m = mapColumns({ headers, rules, records });
    assert.deepEqual(m.refused, {}, "no demo column is offered a case field and refused");
    assert.deepEqual(m.map, autoMap(headers, rules), "and the map is what it always was");
  });
}

// A conflict is a fault in named fields, so it reaches only as far as those fields are
// read. These two cases are the same conflict machinery seen from both ends.
test("a conflict only holds back the uses that read the conflicting field", () => {
  const csv = parseCSV(COMMENT_CONFLICT);
  // Forced, as a person would after correcting the mapping by hand.
  const mapping = { ...mapColumns({ headers: csv.headers, rules, records: csv.records }).map, follow_up_of: "parent_case" };
  const report = runAudit({ records: csv.records, mapping, headers: csv.headers, rules });
  assert.deepEqual(report.load.conflicts.map((c) => c.field), ["follow_up_of"]);
  assert.equal(report.checks.C4.outcome, "fail", "the export does have a problem, and C4 still says so");

  // follow_up_of reaches resolution only through B6, which is optional there, so it
  // costs the use its green and nothing more. Red is what this test exists to prevent.
  const res = report.uses.find((u) => u.id === "resolution");
  assert.notEqual(res.outcome, "fail", "a follow-up-of conflict must not turn resolution time red");
  assert.equal(res.outcome, "warn");
  assert.deepEqual(res.conflicts_set_aside, ["follow_up_of"]);
  assert.equal(res.conflicts_are_context_only, true);

  // 3. Named as what it is, not as duplicate cases, on the check and in the blocker.
  assert.equal(report.checks.C4.title, "A column mapped as a case field changes between comments");
  assert.deepEqual(report.checks.C4.conflict_labels, ["Follow-up of"]);
  assert.match(report.checks.C4.fix, /Map that column to a comment field/);
  assert.doesNotMatch(report.checks.C4.title, /appear more than once/);
});

test("a conflict in a field the use does read still holds it back", () => {
  const csv = parseCSV(["case_id,created_at,closed_at,status,owner,reason,comment_created_at,comment_body,comment_public",
    "LS-1,2026-01-01 09:00,2026-01-04 09:00,Solved,Agent A,Login issue,2026-01-01 10:00,First reply to the customer about this,Yes",
    "LS-1,2026-01-01 09:00,2026-01-09 09:00,Solved,Agent A,Login issue,2026-01-02 10:00,Customer came back with more detail here,Yes",
    "LS-2,2026-01-01 09:00,2026-01-02 09:00,Solved,Agent B,Billing question,2026-01-01 11:00,Only comment on this case at all,Yes",
  ].join("\n"));
  // Forced past the mapping rule, which would otherwise refuse a varying closed_at.
  const mapping = { ...mapColumns({ headers: csv.headers, rules, records: csv.records }).map, closed_at: "closed_at" };
  const report = runAudit({ records: csv.records, mapping, headers: csv.headers, rules });
  assert.deepEqual(report.load.conflicts.map((c) => c.field), ["closed_at"]);
  // Resolution time is built on closed_at, through C1 and B4, both required.
  const res = report.uses.find((u) => u.id === "resolution");
  assert.equal(res.outcome, "fail");
  assert.ok(res.blockers.includes("C4"));
  assert.equal(res.conflicts_set_aside, undefined, "not set aside: this use reads the field");
});

test("nothing on a run with a failing C4 claims that C4 passes", () => {
  const csv = parseCSV(COMMENT_CONFLICT);
  const mapping = { ...mapColumns({ headers: csv.headers, rules, records: csv.records }).map, follow_up_of: "parent_case" };
  const report = runAudit({ records: csv.records, mapping, headers: csv.headers, rules });
  assert.equal(report.checks.C4.outcome, "fail");
  assert.ok(report.load.duplicate_rows > 0, "and a row was dropped, which is what used to print the claim");

  // Everything the "What was read" box is built from, plus every caution it can show.
  const said = [JSON.stringify(report.load), JSON.stringify(report.cautions)].join(" ");
  assert.doesNotMatch(said, /C4 passes/i);
  // Nothing may assert any check's outcome: a summary of what was read cannot know one.
  assert.doesNotMatch(said, /\b(C\d+|B\d+|AI\d+)\b.{0,24}\b(passes|fails|is green|is red)\b/i);
});

test("a signal built on a conflicting field is cautioned, never locked", () => {
  // open_risk requires last_update_at, so a conflict there is its business.
  const csv = parseCSV(["case_id,created_at,closed_at,status,owner,reason,last_update_at,comment_created_at,comment_body,comment_public",
    "LS-1,2026-01-01 09:00,2026-01-04 09:00,Solved,Agent A,Login issue,2026-01-04 09:00,2026-01-01 10:00,First reply to the customer about this,Yes",
    "LS-1,2026-01-01 09:00,2026-01-04 09:00,Solved,Agent A,Login issue,2026-01-06 09:00,2026-01-02 10:00,Customer came back with more detail here,Yes",
    "LS-2,2026-01-01 09:00,2026-01-02 09:00,Solved,Agent B,Billing question,2026-01-02 09:00,2026-01-01 11:00,Only comment on this case at all,Yes",
  ].join("\n"));
  const mapping = { ...mapColumns({ headers: csv.headers, rules, records: csv.records }).map, last_update_at: "last_update_at" };
  const report = runAudit({ records: csv.records, mapping, headers: csv.headers, rules });
  assert.deepEqual(report.load.conflicts.map((c) => c.field), ["last_update_at"]);
  const sig = report.signals.find((x) => x.id === "open_risk");
  assert.ok(sig.cautions && sig.cautions.some((c) => c.id === "conflicting_case_field"));
  assert.notEqual(sig.state, "locked", "a caveat on a number is not a reason to withhold it");
});

// The page shows what was read twice: beside the file picker before a run, and
// under the verdicts after one. They must be the same summary, or the first one
// reports counts the second contradicts.
test("the before-run summary matches the report's own, field for field", () => {
  for (const f of Object.values(FILES)) {
    const { headers, records } = load(f);
    const mapping = autoMap(headers, rules);
    const before = readSummary({ records, headers, map: mapping, rules });
    const after = runAudit({ records, mapping, headers, rules }).load;
    assert.deepEqual(before, after, f);
    // Counts, not arrays: the page formats these with toLocaleString.
    assert.equal(typeof before.cases, "number", f);
    assert.equal(typeof before.rows, "number", f);
    assert.equal(typeof before.comments, "number", f);
    assert.ok(Array.isArray(before.comment_fields), f);
  }
});

test("a one-row-per-case export is still reported as one row per case", () => {
  for (const which of ["snapshot", "history"]) {
    const { report } = audit(which);
    assert.equal(report.load.shape, "one_row_per_case", which);
    assert.equal(report.load.multi_row_cases, 0, which);
    assert.deepEqual(report.load.conflicts, [], which);
    assert.equal(report.load.comments, 0, which);
    assert.deepEqual(report.load.derived, [], `${which}: nothing to derive without comments`);
  }
});

// The polarity trap: Freshdesk publishes `private`, Zendesk publishes `public`, and
// reading one as the other inverts every "latest public comment".
test("an internal-note column is read as the opposite of a public column", () => {
  const rows = (flagCol, a, b) => parseCSV([
    `case_id,created_at,closed_at,status,comment_created_at,comment_body,${flagCol}`,
    `LS-1,2026-01-01 09:00,2026-01-05 09:00,Solved,2026-01-02 09:00,The customer asked us about this one,${a}`,
    `LS-1,2026-01-01 09:00,2026-01-05 09:00,Solved,2026-01-03 09:00,Note to self before closing this off,${b}`,
  ].join("\n"));
  // public=Yes then public=No: the latest public comment is the earlier row.
  const asPublic = rows("comment_public", "Yes", "No");
  // private=No then private=Yes: the same two comments, spelled the other way.
  const asPrivate = rows("comment_private", "No", "Yes");
  const run = (csv) => {
    const mapping = autoMap(csv.headers, rules);
    return { mapping, report: runAudit({ records: csv.records, mapping, headers: csv.headers, rules }) };
  };
  const p = run(asPublic), q = run(asPrivate);
  assert.equal(p.mapping.comment_public, "comment_public");
  assert.equal(q.mapping.comment_private, "comment_private");
  for (const r of [p.report, q.report]) {
    assert.equal(r.load.derived[0].from, "latest_public_comment");
    assert.equal(r.load.derived[0].cases, 1);
  }
  const at = (m, csv) => collapseRows({ records: csv.records, headers: csv.headers, map: m.mapping, rules })
    .cases[0]._comments.filter((c) => c.public === true).map((c) => c.at);
  assert.deepEqual(at(p, asPublic), ["2026-01-02 09:00"]);
  assert.deepEqual(at(q, asPrivate), ["2026-01-02 09:00"], "private=Yes must not read as public");
});

test("with no public or internal column, the last update says it used every comment", () => {
  const csv = parseCSV([
    "case_id,created_at,closed_at,status,comment_created_at,comment_body",
    "LS-1,2026-01-01 09:00,2026-01-05 09:00,Solved,2026-01-02 09:00,The customer asked us about this one",
    "LS-1,2026-01-01 09:00,2026-01-05 09:00,Solved,2026-01-03 09:00,Note to self before closing this off",
  ].join("\n"));
  const mapping = autoMap(csv.headers, rules);
  const report = runAudit({ records: csv.records, mapping, headers: csv.headers, rules });
  const d = report.load.derived[0];
  assert.equal(d.from, "latest_comment");
  assert.match(d.detail, /Internal notes count towards it/);
});

// A mapped column stays mapped: deriving must never quietly overrule the export.
test("a mapped last update column is used as given, not derived", () => {
  const csv = parseCSV([
    "case_id,created_at,closed_at,status,last_update_at,comment_created_at,comment_body,comment_public",
    "LS-1,2026-01-01 09:00,2026-01-05 09:00,Solved,2026-02-01 09:00,2026-01-02 09:00,The customer asked us about this one,Yes",
  ].join("\n"));
  const mapping = autoMap(csv.headers, rules);
  assert.equal(mapping.last_update_at, "last_update_at");
  const report = runAudit({ records: csv.records, mapping, headers: csv.headers, rules });
  assert.deepEqual(report.load.derived, []);
  const c = collapseRows({ records: csv.records, headers: csv.headers, map: mapping, rules }).cases[0];
  assert.equal(c.last_update_at, "2026-02-01 09:00");
});

// Comment columns are case-export columns. A bot file is one row per conversation
// and is never collapsed, so no comment field may reach into bot scope.
test("no comment field is offered a bot export's columns", () => {
  for (const f of Object.values(BOT_FILES))
    assert.deepEqual(Object.keys(autoMap(load(f).headers, rules, "bot")).filter((k) => k.startsWith("comment_")), [], f);
  for (const [k, f] of Object.entries(rules.fields))
    if (f.level === "comment") assert.equal(f.file ?? "case", "case", k);
});

// Every comment column name in the rules was read from a vendor's documentation.
test("every comment column source points at a real reference", () => {
  const sources = rules.comment_column_sources;
  assert.ok(sources && Object.keys(sources).length >= 5, "at least five vendors");
  for (const [vendor, ref] of Object.entries(sources))
    assert.ok(rules.refs[ref], `${vendor} -> ${ref}`);
  assert.ok(Object.values(rules.fields).some((f) => f.level === "comment"));
});

test("the engine reads no files, least of all the answer key", () => {
  const src = readFileSync(new URL("../src/engine.js", import.meta.url), "utf8");
  assert.match(src, /^\/\/ Support Signal engine/, "wrong file");
  for (const forbidden of [/larkspur_bot_truth/, /generation_stats/, /node:fs/, /readFileSync/, /\bfetch\s*\(/, /\brequire\s*\(/])
    assert.doesNotMatch(src, forbidden);
});
