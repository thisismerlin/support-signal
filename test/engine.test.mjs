// Every planted flaw in the demo data must produce the verdict it was planted for.
// Expected verdicts live in data/expected.json, which DATASHEET.md documents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCSV, autoMap, mapColumns, headerVariants, runAudit, evalThreshold, nearDuplicate, collapseRows, readSummary, looksLikeSameFile } from "../src/engine.js";

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

// A fixture carrying `rows` is matched with its values, because what it pins down
// cannot be decided from the column names alone.
const fixtureMap = (c, headers = c.headers) =>
  mapColumns({ headers, rules, records: c.rows ?? null });

for (const [name, c] of Object.entries(HEADERS)) {
  test(`headers ${name}: maps as expected`, () => {
    assert.deepEqual(fixtureMap(c).map, c.expect);
  });
}

// A header can mean one thing. Two fields sharing a column would double-count it.
test("no column is ever mapped to two fields", () => {
  for (const [name, c] of Object.entries(HEADERS)) {
    const used = Object.values(fixtureMap(c).map);
    assert.equal(new Set(used).size, used.length, name);
  }
});

// Scoring must not depend on the order headers happen to arrive in.
test("matching does not depend on header order", () => {
  for (const [name, c] of Object.entries(HEADERS)) {
    const forward = fixtureMap(c).map;
    const back = fixtureMap(c, [...c.headers].reverse()).map;
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
// The report deliberately carries no conversation id: nothing out of the export is
// echoed, and an identifier is not a category label. `by_conversation[i].n` is a
// position among the claimed conversations in file order, so a test that supplied the
// file can recover which conversation each row describes. Identifiers stay on this
// side of the boundary, where they came from, instead of in the report.
const claimedIdsInOrder = (b) => {
  const claimedCol = b.mapping.bot_claimed_resolved;
  const idCol = b.mapping.bot_conversation_id;
  return b.records
    .filter((r) => /^(y|yes|true|1|t)$/i.test(String(r[claimedCol] ?? "").trim()))
    .map((r) => String(r[idCol] ?? ""));
};
// by_conversation keyed by the conversation id the test knows it fed in.
const auditById = (a, b) => {
  const ids = claimedIdsInOrder(b);
  assert.equal(ids.length, a.by_conversation.length, "position join needs the same count");
  return Object.fromEntries(a.by_conversation.map((c, i) => [ids[i], c]));
};
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

  // Joined by position, not by identifier. The report carries no conversation id by
  // design -- nothing out of the export is echoed, and an id is not a category label --
  // so `n` is a position among the claimed conversations in file order. The test knows
  // that order because it supplied the file, which keeps this assertion exactly as
  // strong as it was while the report itself stays free of identifiers.
  test(`bot ${which}: every conversation lands in its planted bucket`, () => {
    const T = truthByConversation();
    const key = which === "snapshot" ? "audit_snapshot" : "audit_with_history";
    const byId = auditById(a, bot);
    const wrong = Object.entries(byId)
      .filter(([id, c]) => T.get(id)[key] !== c.bucket)
      .map(([id, c]) => `#${c.n} (${T.get(id).planted}): want ${T.get(id)[key]}, got ${c.bucket}`);
    assert.deepEqual(wrong, []);
    assert.equal(a.by_conversation.length, stats.bot.claimed_resolved, "only claimed conversations are judged");
    // `n` is a plain 1-based position, which is what makes the join above valid.
    assert.deepEqual(a.by_conversation.map((c) => c.n), a.by_conversation.map((_, i) => i + 1));
  });

  // The whole point of removing the ids: a pasted report must not carry them.
  test(`bot ${which}: the audit carries no identifier out of the export`, () => {
    const ids = new Set(bot.records.map((r) => String(r[bot.mapping.bot_conversation_id] ?? "")).filter(Boolean));
    for (const c of a.by_conversation) {
      assert.equal(c.id, undefined, "a conversation id reached the report");
      for (const m of c.matched) assert.equal(m.case_id, undefined, "a case id reached the report");
      for (const m of c.matched) assert.equal(m.reason, undefined, "a reason value reached the report");
    }
    // And nowhere else in the audit either.
    const blob = JSON.stringify(a);
    const leaked = [...ids].filter((id) => id.length > 3 && blob.includes(id));
    assert.deepEqual(leaked, [], "conversation ids appear somewhere in the audit");
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
    const byId = auditById(a, bot);
    const un = Object.entries(byId).filter(([id]) => T.get(id).planted === "unrelated").map(([, c]) => c);
    assert.equal(un.length, p.unrelated);
    assert.deepEqual([...new Set(un.map((c) => c.bucket))], ["not_contradicted"]);
  });

  test("every near-duplicate follow-up is matched, not missed", () => {
    const T = truthByConversation();
    const reason = new Map(load("larkspur_snapshot.csv").records.map((c) => [c.case_id, c.reason]));
    const intent = new Map(load(BOT_FILES.with_history).records.map((b) => [b.bot_conversation_id, b.intent]));
    const conv = new Map(Object.entries(auditById(a, bot)));
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
  const c = auditById(report.resolution_audit,
    { records: conversations.records, mapping: autoMap(conversations.headers, rules, "bot") });
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

// --------------------------------------- a real Salesforce cases-with-comments export
// Four faults a real export hit. Of its column names only "Case Comments" is a real
// header; the rest are illustrative, and none came from Salesforce documentation. So
// nothing here leans on a vendor synonym list: every mapping below is reached from the
// column's shape and from whether it varies within a case.
const SF = HEADERS.salesforce_comment_rows;
const sfMap = () => mapColumns({ headers: SF.headers, rules, records: SF.rows });

// 1. The comment body. "Case Comments" is long free text that differs between the rows
// of one case, so it is not a case field whatever its name half-matches. It was refused
// for follow_up_of by name and then handed straight back to subject by shape, which is
// how the customer's own words went unread in an export full of them.
test("long free text varying within a case is the comment body, not the subject", () => {
  const { map, confidence } = sfMap();
  assert.equal(map.comment_body, "Case Comments");
  assert.equal(confidence.comment_body, "guess");
  assert.equal(map.subject, undefined, "subject must not take a per-comment column");
  assert.equal(map.description, undefined);
  assert.equal(map.resolution_note, undefined);
});

// The same rule on both paths. Before this, the guess pass ignored it: `escalated` was
// refused IsPublished by name and then guessed onto the very same column.
test("a column refused for a case field by name is not guessed back onto it", () => {
  const { map } = sfMap();
  for (const k of Object.keys(rules.fields)) {
    if (k === "case_id" || (rules.fields[k].level || "case") === "comment") continue;
    assert.notEqual(map[k], "Case Comments", `${k} took a per-comment column`);
    assert.notEqual(map[k], "IsPublished", `${k} took a per-comment column`);
    assert.notEqual(map[k], "CommentCreatedDate", `${k} took a per-comment column`);
  }
});

// A refusal and a mapping for one field contradict each other, and the mapping table
// prints both. Whichever is true, the pair cannot be.
test("no field is reported as refused and mapped at once", () => {
  const { map, refused } = sfMap();
  for (const k of Object.keys(refused)) assert.equal(map[k], undefined, `${k} is both`);
});

// And the other half: a refusal names a column, and the banner built from it tells the
// reader to go and map that column. Once something else has taken it, that is stale
// advice about a column already in use, so the refusal has to clear.
test("a refusal clears once its column is mapped elsewhere", () => {
  const { map, refused } = sfMap();
  const used = new Set(Object.values(map));
  for (const [k, r] of Object.entries(refused))
    assert.ok(!used.has(r.header), `${k} still refuses ${r.header}, which is mapped`);
  // IsPublished was turned down for the escalated flag and then read as comment_public.
  assert.equal(map.comment_public, "IsPublished");
  assert.equal(refused.escalated, undefined, "stale refusal for a mapped column");
});

// 2. Shape gates a loose name match. "CommentCreatedDate" overlaps comment_id's own
// name by a word, scoring a partial match, and a column of dates became the comment ID
// while the comment timestamp went unmapped.
test("a date column does not become the comment ID", () => {
  const { map } = sfMap();
  assert.equal(map.comment_at, "CommentCreatedDate", "the timestamp field gets it");
  assert.equal(map.comment_id, undefined, "the ID field does not");
});

// The refusal itself, where the column really is left with nowhere to go: comment_at
// is already taken by name, and every other date field is case-level, so nothing can
// pick this column up. A gap with a reason must not look like a plain gap.
test("a refused column is reported when nothing else can take it", () => {
  const headers = ["case_id", "comment_created_at", "Comment Identifier"];
  const rows = Array.from({ length: 12 }, (_, i) => ({
    case_id: `0000${1000 + (i % 4)}`,
    comment_created_at: `2026-03-1${i % 4} 1${i % 3}:00:00`,
    "Comment Identifier": `2026-04-0${(i % 3) + 1} 09:00:00`,
  }));
  const { map, refused } = mapColumns({ headers, rules, records: rows });
  assert.equal(map.comment_at, "comment_created_at");
  assert.equal(map.comment_id, undefined);
  assert.equal(refused.comment_id?.header, "Comment Identifier");
  assert.equal(refused.comment_id?.reason, "shape_mismatch");
});

test("a yes/no column does not become the comment body", () => {
  const headers = ["case_id", "comment_created_at", "Has Comment Body"];
  const rows = Array.from({ length: 12 }, (_, i) => ({
    case_id: `0000${1000 + (i % 4)}`,
    comment_created_at: `2026-03-1${i % 4} 1${i % 3}:00:00`,
    "Has Comment Body": i % 3 === 1 ? "false" : "true",
  }));
  assert.equal(mapColumns({ headers, rules, records: rows }).map.comment_body, undefined,
    "a yes/no column is not the comment body");
});

// The gate is for loose matches only. A column named exactly as the field is taken on
// its name: the owner of the export gets to say what their column is.
test("an exact name match is trusted even where the values look wrong", () => {
  const headers = ["case_id", "comment body"];
  const rows = Array.from({ length: 12 }, (_, i) => ({
    case_id: `0000${1000 + (i % 4)}`, "comment body": i % 3 === 1 ? "false" : "true",
  }));
  assert.equal(mapColumns({ headers, rules, records: rows }).map.comment_body, "comment body");
});

// --------------------------------------------------------------- 3. no empty passes
// A column that is present and holds nothing. Every check that read its values to
// judge something else passed on it: B3 was green off "0 distinct reasons", and AI2
// printed "Reasons describe customer needs" about a column with no reasons in it.
// Nearly empty is the case that actually turned up: reason filled on 2 cases out of
// 543. Zero is the easy end of the same problem, so both are asserted.
function thinReason(keepCases) {
  const { headers, records } = load("larkspur_snapshot.csv");
  const byCase = new Map();
  for (const r of records) if (!byCase.has(r.case_id)) byCase.set(r.case_id, r);
  const keep = new Set([...byCase.keys()].slice(0, keepCases));
  const thinned = records.map((r) => (keep.has(r.case_id) ? r : { ...r, reason: "" }));
  const mapping = autoMap(headers, rules);
  assert.equal(mapping.reason, "reason", "the column is still mapped");
  return runAudit({ records: thinned, mapping, headers, rules });
}

for (const id of ["B3", "AI2", "AI3", "AI5"]) {
  test(`${id} reports too few to judge when the reason column is nearly empty`, () => {
    const c = thinReason(2).checks[id];
    assert.equal(c.outcome, "too_few", c.detail);
    assert.equal(c.too_few_field, "reason");
    // The counts, so the reader can see how far short it fell.
    assert.match(c.detail, /on 2 of 5,083 cases/);
    assert.match(c.detail, /at least 30 cases and 5%/);
  });

  test(`${id} reports too few to judge when the reason column is empty`, () => {
    const c = thinReason(0).checks[id];
    assert.equal(c.outcome, "too_few", c.detail);
    assert.match(c.detail, /every value is blank/);
  });
}

// The floor is declared, not buried, and both halves of it bite.
test("the evidence floor is declared as a count and a share, and marked provisional", () => {
  const f = rules.evidence_floor;
  assert.ok(Number.isInteger(f.min_cases) && f.min_cases > 0, "min_cases");
  assert.ok(f.min_share > 0 && f.min_share < 1, "min_share");
  assert.equal(f.provisional, true, "a starting point, not evidence");
});

// Enough cases but too small a share, and enough share but too few cases, are each
// below the floor on their own. One floor doing the work of two would miss one.
test("each half of the floor is enough to hold a judgement back", () => {
  const { min_cases, min_share } = rules.evidence_floor;
  const build = (n, total) => {
    const { headers, records } = load("larkspur_snapshot.csv");
    const rows = records.slice(0, total).map((r, i) => ({ ...r, reason: i < n ? "Billing" : "" }));
    return runAudit({ records: rows, mapping: autoMap(headers, rules), headers, rules });
  };
  // Comfortably over min_cases, far under min_share.
  const wideThin = build(min_cases * 2, Math.ceil((min_cases * 2) / (min_share / 4)));
  assert.equal(wideThin.checks.AI2.outcome, "too_few", "share floor did not bite");
  // 100% share, under min_cases.
  const narrowFull = build(min_cases - 1, min_cases - 1);
  assert.equal(narrowFull.checks.AI2.outcome, "too_few", "count floor did not bite");
});

// B2 and B1 count how many values there are, so they keep their verdicts whatever the
// floor says: 100% blank is B2's answer, not a reason it can't answer. Turning these
// into "can't tell" would hide the very fault the floor exists to stop being hidden.
test("the checks that count values still report their verdicts", () => {
  for (const keep of [0, 2]) {
    const r = thinReason(keep);
    assert.equal(r.checks.B2.outcome, "fail", `B2 at ${keep}`);
    assert.match(r.checks.B2.detail, /of cases sit in blank or catch-all reasons/);
    assert.equal(r.checks.B1.outcome, "fail", `B1 at ${keep}`);
  }
  // And they declare no requires_values, which is what keeps the floor off them.
  for (const id of ["B1", "B2"])
    assert.equal(rules.checks.find((c) => c.id === id).requires_values, undefined, id);
});

test("signals grouped by reason report too few rather than a finding", () => {
  const r = thinReason(2);
  for (const id of ["theme_movers", "self_help", "keep_human"]) {
    const s = r.signals.find((x) => x.id === id);
    assert.equal(s.state, "too_few", id);
    assert.match(s.reason, /on only 2 of 5,083 cases/, id);
    assert.equal(s.headline, undefined, `${id} must not report a headline`);
  }
});

// "Stable" and "0 candidate reasons" both read as findings. They were the absence of
// anything to find, which is a different thing and has to say so.
test("theme movers does not call a nearly empty reason column stable", () => {
  for (const keep of [0, 2]) {
    const s = thinReason(keep).signals.find((x) => x.id === "theme_movers");
    assert.notEqual(s.headline, "Stable");
  }
});

// The other way to have nothing to compare: plenty of reasons, none of them common
// enough for a move in its share to mean anything. "Stable" is just as wrong here.
test("theme movers reports too few when no reason reaches its case minimum", () => {
  const { headers, records } = load("larkspur_snapshot.csv");
  const spread = records.map((r, i) => ({ ...r, reason: `Reason ${i % 400}` }));
  const r = runAudit({ records: spread, mapping: autoMap(headers, rules), headers, rules });
  const min = rules.signals.find((x) => x.id === "theme_movers").params.min_cases_per_reason;
  const s = r.signals.find((x) => x.id === "theme_movers");
  assert.equal(s.state, "too_few", s.headline ?? s.reason);
  assert.match(s.reason, new RegExp(`${min} or more cases`));
  assert.match(s.reason, /The most common, \u201cReason \d+\u201d, has \d+\./, "says how many it had");
  // The column itself is full, so this is the per-reason minimum biting, not the floor.
  assert.equal(r.checks.B1.outcome, "pass");
});

test("the AI readiness verdict says the text is there and the reason too thin", () => {
  const u = thinReason(2).uses.find((x) => x.id === "ai");
  assert.deepEqual(u.too_few_fields, ["reason"]);
  assert.match(u.too_few_note, /contact reason/, "names the thin field");
  assert.match(u.too_few_note, /only 2 of 5,083 cases/, "says how many");
  assert.match(u.too_few_note, /subject|description/, "says the wording is there");
  assert.notEqual(u.outcome, "pass");
});

// A use whose declared fields all clear the floor says nothing, or the note is wallpaper.
test("a use with nothing short carries no note", () => {
  const { report } = audit("history");
  for (const u of report.uses) assert.equal(u.too_few_note, undefined, u.id);
});

// A share that rounds to 0.0% next to a count of 2 invites the reader to disbelieve
// one of the two numbers.
test("a share too small to print is not shown as zero", () => {
  assert.match(thinReason(2).checks.AI2.detail, /under 0\.1%/);
});

// ------------------------------------------- 4. what an optional column is, and buys
// An optional field is a choice, and the label alone does not say enough to make it.
test("every optional field says what it is and what it unlocks", () => {
  const optional = Object.entries(rules.fields)
    .filter(([, f]) => !f.required && (f.file || "case") !== "bot");
  assert.ok(optional.length >= 25, `${optional.length} optional fields`);
  for (const [k, f] of optional) {
    assert.ok(f.means, `${k} has no means`);
    assert.ok(f.unlocks, `${k} has no unlocks`);
    // A sentence, not a word, and not an essay in a table cell.
    assert.ok(f.means.length >= 8 && f.means.length <= 80, `${k} means: ${f.means}`);
    assert.ok(f.unlocks.length >= 12 && f.unlocks.length <= 160, `${k} unlocks: ${f.unlocks}`);
    // Both render mid-sentence: `means` inside the label's brackets, `unlocks` after
    // "Unlocks". A trailing full stop would double up against the one the page adds.
    assert.ok(!/[.]$/.test(f.means), `${k} means ends in a full stop`);
    assert.ok(!/[.]$/.test(f.unlocks), `${k} unlocks ends in a full stop`);
  }
});

test("the follow-up field says it wants the ID of the original case", () => {
  assert.equal(rules.fields.follow_up_of.label, "Follow-up of");
  assert.equal(rules.fields.follow_up_of.means, "ID of the original case");
});

// The title shown next to an empty column, in the check list and in the blocker list
// on the use. Both the pass and the failure title are claims about the values, so on a
// column with none they are each false: the blocker line read "Reasons describe teams,
// not customers" about an export with no reasons in it at all.
test("a column too thin to judge is not titled with a claim about its values", () => {
  const r = thinReason(2);
  for (const id of ["B3", "AI2", "AI3", "AI5"]) {
    const def = rules.checks.find((c) => c.id === id);
    assert.ok(def.too_few_title, `${id} has no too_few_title`);
    assert.equal(r.checks[id].title, def.too_few_title, id);
    assert.notEqual(r.checks[id].title, def.title, `${id} claims the pass case`);
    assert.notEqual(r.checks[id].title, def.failure_title, `${id} claims the failure case`);
  }
});

// ------------------------------------------------- guessing a visibility polarity
// comment_public and comment_private are the same shape and opposite meanings, so a
// column of yes/no values fits both and the winner was whichever was declared first.
// Read the wrong way round it inverts every "latest public comment" in silence, which
// is the single mistake the pair of fields exists to prevent.
test("a polarity field is guessed only onto a header that carries the polarity", () => {
  const rows = (name) => Array.from({ length: 12 }, (_, i) => ({
    case_id: `0000${1000 + (i % 4)}`,
    comment_created_at: `2026-03-1${i % 4} 1${i % 3}:00:00`,
    [name]: i % 3 === 1 ? "false" : "true",
  }));
  const mapOf = (name) => mapColumns({ headers: ["case_id", "comment_created_at", name], rules, records: rows(name) }).map;

  // Says which polarity it is, so the guess is safe to make.
  assert.equal(mapOf("IsPublished").comment_public, "IsPublished");
  assert.equal(mapOf("Visible To Customer").comment_public, "Visible To Customer");
  assert.equal(mapOf("Internal Only").comment_private, "Internal Only");

  // Says nothing. A visible gap beats a coin toss that silently inverts the answer.
  for (const name of ["Flag 2", "Comment Attribute", "Custom Checkbox"]) {
    const m = mapOf(name);
    assert.equal(m.comment_public, undefined, `${name} guessed as public`);
    assert.equal(m.comment_private, undefined, `${name} guessed as private`);
  }
});

// The guard is on guessing only. A header that names the field is taken on its name.
test("a polarity field still matches a header that names it", () => {
  const headers = ["case_id", "comment_created_at", "comment public"];
  const rows = Array.from({ length: 12 }, (_, i) => ({
    case_id: `0000${1000 + (i % 4)}`,
    comment_created_at: `2026-03-1${i % 4} 1${i % 3}:00:00`,
    "comment public": i % 3 === 1 ? "false" : "true",
  }));
  const { map, confidence } = mapColumns({ headers, rules, records: rows });
  assert.equal(map.comment_public, "comment public");
  assert.equal(confidence.comment_public, "name");
});

// Only the two polarity fields carry the guard, or it becomes a general brake on
// inference: the demo's opaque-column test relies on a guess with no word to go on.
test("the polarity guard is declared, and only where polarity is the risk", () => {
  const guarded = Object.entries(rules.fields).filter(([, f]) => f.guess_requires_word).map(([k]) => k);
  assert.deepEqual(guarded.sort(), ["comment_private", "comment_public"]);
  for (const k of guarded)
    for (const w of rules.fields[k].guess_requires_word)
      assert.match(w, /^[a-z]+$/, `${k}: ${w} must be one lowercase word`);
});

// ------------------------------------------ the file in the bot slot is a bot export
// B11 passed on the case export loaded into the bot slot. Bot-scope matching finds a
// column for nearly every bot field in almost any export -- here bot_claimed_resolved
// landed on a prose resolution note and bot_reopens on a CSAT score -- and the green
// path asked only whether a linked-cases column existed. Nothing checked there was
// anything to audit: 5,108 conversations, 0 claimed resolutions, green.
const botSlot = (p) => ({ records: p.records, headers: p.headers,
  mapping: mapColumns({ headers: p.headers, rules, scope: "bot", records: p.records }).map });

function withBot(bot) {
  const { headers, records } = load("larkspur_snapshot.csv");
  return runAudit({ records, mapping: autoMap(headers, rules), headers, bot, rules });
}

test("the case export in the bot slot is recognised as the same file", () => {
  const cases = load("larkspur_snapshot.csv");
  const r = withBot(botSlot(cases));
  assert.equal(r.checks.B11.outcome, "warn");
  assert.equal(r.checks.B11.bot_same_as_cases, true);
  assert.equal(r.meta.bot_same_as_cases, true);
  assert.equal(r.checks.B11.title, rules.checks.find((c) => c.id === "B11").same_file_title);
  assert.match(r.checks.B11.detail, /same file as the case export/);
  // And it is not reported as a usable basis for the audit.
  assert.equal(r.resolution_audit.basis, "none");
  assert.equal(r.uses.find((u) => u.id === "resolution_audit").outcome, "needs_human");
});

test("a file with no claimed resolutions cannot pass B11", () => {
  const cases = load("larkspur_snapshot.csv");
  // A row short, so the same-file branch cannot be what catches it.
  const r = withBot(botSlot({ ...cases, records: cases.records.slice(0, -1) }));
  assert.equal(r.meta.bot_same_as_cases, false, "must be caught on its own merits");
  assert.equal(r.checks.B11.outcome, "too_few");
  assert.equal(r.meta.bot_claimed, 0);
  assert.match(r.checks.B11.detail, /nothing for the audit to check/);
  assert.match(r.checks.B11.detail, /probably not one/, "says it probably isn't a bot export");
  assert.equal(r.uses.find((u) => u.id === "resolution_audit").outcome, "needs_human");
});

// The guard must not cost a real bot export its verdict. Both demo bot files keep the
// outcome they had, and the audit still runs on the one that can be audited.
test("a genuine bot export still passes and is still audited", () => {
  const full = withBot(botSlot(load("larkspur_bot_with_history.csv")));
  assert.equal(full.checks.B11.outcome, "pass");
  assert.equal(full.resolution_audit.basis, "case_links");
  assert.ok(full.resolution_audit.claimed > 0, "claimed resolutions were counted");
  assert.equal(full.meta.bot_claimed, full.resolution_audit.claimed, "one count, two readers");
  assert.equal(full.uses.find((u) => u.id === "resolution_audit").outcome, "pass");

  const snap = withBot(botSlot(load("larkspur_bot_snapshot.csv")));
  assert.equal(snap.checks.B11.outcome, "warn");
  assert.equal(snap.resolution_audit.basis, "account_and_timing");
  assert.equal(snap.checks.B11.title, rules.checks.find((c) => c.id === "B11").warn_title,
    "the amber that means account-and-timing keeps its own title");
});

// Same-file detection compares structure and three rows, so a file that merely looks
// similar is judged on its own merits rather than dismissed.
test("a different bot file is not mistaken for the case file", () => {
  const cases = load("larkspur_snapshot.csv");
  for (const f of ["larkspur_bot_snapshot.csv", "larkspur_bot_with_history.csv"])
    assert.equal(looksLikeSameFile(cases.records, cases.headers, botSlot(load(f))), false, f);
  // Identical content in a new array is still the same file.
  const copy = { records: cases.records.map((r) => ({ ...r })), headers: [...cases.headers], mapping: {} };
  assert.equal(looksLikeSameFile(cases.records, cases.headers, copy), true, "a copy is the same file");
  // One changed cell in a checked row is not.
  const edited = { ...copy, records: copy.records.map((r, i) => (i === 0 ? { ...r, case_id: "CHANGED" } : r)) };
  assert.equal(looksLikeSameFile(cases.records, cases.headers, edited), false);
});

// ------------------------------------------------- which build produced this report
// Three behaviour changes shipped under one engine/rules version pair, so a pasted
// report could not say which build produced it. The versions are bumped by hand; what
// is testable is that the report carries all three identifiers and that the build id
// reaches it.
test("the report says which engine, rules and build produced it", () => {
  const { report } = audit("history");
  assert.match(report.meta.engine, /^\d+\.\d+\.\d+$/, "engine version");
  assert.match(String(report.meta.rules), /^\d+\.\d+\.\d+$/, "rules version");
  assert.ok(report.meta.build, "no build id in the report");
});

// The committed build id must be the placeholder. A real SHA here would mean dist no
// longer matches a fresh build, and the workflow's staleness gate would fail forever.
test("the committed build id is a placeholder, not a commit", () => {
  const compiled = JSON.parse(readFileSync(new URL("../dist/rules.json", import.meta.url)));
  assert.equal(compiled.meta.build, "unstamped");
  assert.equal(audit("history").report.meta.build, "unstamped");
});

// The stamp has to run after the staleness check and before the upload. Reordering
// these silently breaks either the gate or the traceability it exists to allow.
test("the deploy workflow stamps the build after checking dist is fresh", () => {
  const wf = readFileSync(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
  const stale = wf.indexOf("Fail if dist is stale");
  const stamp = wf.indexOf("npm run stamp");
  const upload = wf.indexOf("upload-pages-artifact");
  assert.ok(stale > 0 && stamp > 0 && upload > 0, "a step is missing from the workflow");
  assert.ok(stale < stamp, "stamping before the staleness check would break the check");
  assert.ok(stamp < upload, "stamping after the upload would deploy an unstamped page");
});

// A signal state the panel doesn't know about renders as "On" with an empty headline,
// which is how too_few first reached the page looking like a reported finding with
// nothing in it. Both halves of that are asserted: the engine never reports a state
// without something to show, and the panel handles every state the engine emits.
test("a signal either reports a number or says why it cannot", () => {
  for (const r of [thinReason(2), thinReason(0), audit("history").report, audit("comments").report]) {
    for (const s of r.signals) {
      if (s.state === "on" || s.state === "caution") {
        assert.ok(s.headline, `${s.id} is ${s.state} with no headline`);
      } else {
        assert.ok(s.reason, `${s.id} is ${s.state} with no reason`);
        assert.equal(s.headline, undefined, `${s.id} is ${s.state} but reports a headline`);
      }
    }
  }
});

test("the page handles every signal state the engine can emit", () => {
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const seen = new Set();
  for (const r of [thinReason(2), audit("history").report, audit("comments").report])
    for (const s of r.signals) seen.add(s.state);
  assert.ok(seen.size >= 3, `only saw ${[...seen]}`);
  for (const state of seen)
    assert.ok(app.includes(state), `src/app.js never mentions the signal state "${state}"`);
});

// ============================================================ nothing echoes the export
// The page promises the export never leaves the browser. It kept that promise and then
// handed the reader a report to paste elsewhere: with a free-text column mapped to
// contact reason, AI2's detail and the copied JSON carried hundreds of complete case
// summaries, names and email addresses among them.
//
// The test maps one long free-text column to each field that echoes, in turn, and walks
// the whole report. Each cell carries a marker past the cap, so any value reproduced
// beyond it is caught wherever in the report it surfaced -- including places nothing
// renders, like the audit's by_conversation, which the copy button serialises anyway.
const CAP = rules.echo.max_chars;

// Every string in the report, with the path that reached it, so a failure names the site.
function walkStrings(node, path = "report", out = []) {
  if (typeof node === "string") out.push([path, node]);
  else if (Array.isArray(node)) node.forEach((v, i) => walkStrings(v, `${path}[${i}]`, out));
  else if (node && typeof node === "object")
    for (const [k, v] of Object.entries(node)) walkStrings(v, `${path}.${k}`, out);
  return out;
}

// A prose cell: a short readable head, then a marker and a tail that must never appear.
// The marker sits beyond the cap, so a clipped value keeps the head and loses the rest.
const LEAK = "NEVER-ECHO-THIS";
const proseCell = (i) => `Customer ${i} reports the overnight export has failed again since Tuesday `
  + `${LEAK} and asks to be called back on 07700 900${String(i).padStart(3, "0")} or at person${i}@example.com`;

// The fields a value can reach the report through, from the echo inventory: the
// category and id fields quoted in a detail, a signal row, a headline or an extra.
const ECHOING_FIELDS = ["reason", "group", "owner", "account_id", "exit_event", "channel", "priority", "account_size", "segment"];

for (const field of ECHOING_FIELDS) {
  test(`no report string echoes a long ${field} value past the cap`, () => {
    const { headers, records } = load("larkspur_snapshot.csv");
    const col = headers.find((h) => h === field) ?? field;
    const rows = records.map((r, i) => ({ ...r, [col]: proseCell(i) }));
    const mapping = autoMap(headers, rules);
    // Mapped by hand, which is one of the three routes a column can arrive by and the
    // one no matcher gate can stop.
    mapping[field] = col;
    const report = runAudit({ records: rows, mapping, headers, rules });

    const strings = walkStrings(report);
    assert.ok(strings.length > 50, "the walk found almost nothing, so it proves nothing");

    // 1. The marker, and anything after it, must appear nowhere at all.
    const leaked = strings.filter(([, v]) => v.includes(LEAK) || v.includes("@example.com") || /07700 900\d{3}/.test(v));
    assert.deepEqual(leaked.map(([p]) => p), [], `a value leaked past the cap into: ${leaked.map(([p]) => p).join(", ")}`);

    // 2. And no run of any source value longer than the cap, marker or not. This is the
    //    general form: it catches a site that quotes the readable head at full length.
    const sources = [...new Set(rows.map((r) => r[col]))];
    const tooLong = [];
    for (const [path, v] of strings) {
      for (const src of sources) {
        for (let start = 0; start + CAP + 1 <= src.length; start += 8) {
          const run = src.slice(start, start + CAP + 1);
          if (v.includes(run)) { tooLong.push(`${path}: ${run.slice(0, 30)}...`); break; }
        }
        if (tooLong.length) break;
      }
      if (tooLong.length) break;
    }
    assert.deepEqual(tooLong, [], `a value exceeded ${CAP} characters at ${tooLong[0]}`);
  });
}

// The guard must not be satisfied by emitting nothing anywhere: a report that says
// nothing passes a leak test trivially. On a genuine short-label column the quotes
// still appear, so the cap is doing the work rather than a blanket silence.
test("a genuine category column is still quoted, so the guard is not blanket silence", () => {
  const { report } = audit("snapshot");
  const quotes = walkStrings(report).filter(([, v]) => /“[^”]+”/.test(v));
  assert.ok(quotes.length > 0, "no value is quoted anywhere, so the leak tests prove nothing");
  for (const [path, v] of quotes)
    for (const m of v.matchAll(/“([^”]*)”/g))
      assert.ok(m[1].length <= CAP, `${path} quotes ${m[1].length} characters: ${m[1].slice(0, 50)}`);
});

// The leak tests above are satisfied by refusal: a prose column is turned down
// outright, so they never exercise the character cap. This one does. The values are
// single-token labels, short enough on average for the column to count as a category
// and so to be quotable, but each one longer than the cap on its own.
test("a quotable value longer than the cap is clipped, not refused", () => {
  const { headers, records } = load("larkspur_snapshot.csv");
  const LABELS = [
    "Billing-and-invoicing-escalation-tier-two-queue-alpha",
    "Login-and-single-sign-on-failure-after-the-upgrade-bravo",
    "Payroll-run-blocked-by-a-stale-scheduled-credential-charlie",
  ];
  const rows = records.map((r, i) => ({ ...r, reason: LABELS[i % LABELS.length] }));
  const report = runAudit({ records: rows, mapping: autoMap(headers, rules), headers, rules });

  // Quotable: one word each, so this is a category as far as the guard is concerned.
  assert.notEqual(report.checks.B3.outcome, "free_text", "these are labels, not prose");

  const strings = walkStrings(report);
  const quotes = [];
  for (const [path, v] of strings)
    for (const m of v.matchAll(/“([^”]*)”/g)) quotes.push([path, m[1]]);
  assert.ok(quotes.length > 0, "nothing was quoted, so the clip is still untested");
  for (const [path, q] of quotes) assert.ok(q.length <= CAP, `${path} quotes ${q.length} chars`);

  // At least one quote is a clipped label rather than a short placeholder, or this
  // test would pass on a report that only ever quoted "(blank)".
  const clipped = quotes.filter(([, q]) => q.endsWith("…"));
  assert.ok(clipped.length > 0, `no quote was clipped; saw ${JSON.stringify(quotes.slice(0, 4))}`);
  // And the clip keeps the readable head, so it is still worth printing.
  for (const [, q] of clipped) assert.ok(LABELS.some((l) => l.startsWith(q.slice(0, -1))), q);

  // No full label survives anywhere, including the signal rows and the JSON-only extras.
  for (const [path, v] of strings)
    for (const l of LABELS) assert.ok(!v.includes(l), `${path} carries a whole label`);
});

// ---------------------------------------- a category field holding free text
// 468 distinct values over 543 cases, sentences long, was accepted as contact reason
// and judged as a reason taxonomy: near-duplicate pairs, team-type wording, demand
// concentration, all computed over prose. However the column arrived -- by name, by
// guess, or mapped by hand, which no matcher gate can stop -- it is not a category.
function proseReason() {
  const { headers, records } = load("larkspur_snapshot.csv");
  const rows = records.map((r, i) => ({
    ...r,
    reason: `Customer ${i} could not complete the overnight export and asked us to look at the scheduled job`,
  }));
  const mapping = autoMap(headers, rules);
  mapping.reason = "reason";
  return runAudit({ records: rows, mapping, headers, rules });
}

for (const id of ["B2", "B3", "AI2", "AI3", "AI5"]) {
  test(`${id} refuses to judge a free-text column as categories`, () => {
    const c = proseReason().checks[id];
    assert.equal(c.outcome, "free_text", c.detail);
    assert.equal(c.free_text_field, "reason");
    // What it found, and where the column probably belongs.
    assert.match(c.detail, /distinct values across/);
    assert.match(c.detail, /averaging \d+(\.\d+)? words/);
    assert.match(c.detail, /Resolution note/, "says where to put it instead");
    // And a title that does not assert the check's own ordinary conclusion.
    const def = rules.checks.find((x) => x.id === id);
    assert.notEqual(c.title, def.title, `${id} claims its pass case`);
    assert.notEqual(c.title, def.failure_title, `${id} claims its failure case`);
  });
}

test("signals grouped by reason refuse a free-text column too", () => {
  const r = proseReason();
  for (const id of ["theme_movers", "self_help", "keep_human"]) {
    const s = r.signals.find((x) => x.id === id);
    assert.equal(s.state, "free_text", id);
    assert.match(s.reason, /Resolution note/, id);
    assert.equal(s.headline, undefined, `${id} must not report a headline`);
    assert.deepEqual(s.rows ?? [], [], `${id} must not table prose`);
  }
});

// The floor comes first. Two long values are too few to tell anything about, including
// whether they are free text, so a confident shape diagnosis would be the wrong answer.
test("too few to judge beats looks-like-free-text", () => {
  const { headers, records } = load("larkspur_snapshot.csv");
  const byCase = new Map();
  for (const r of records) if (!byCase.has(r.case_id)) byCase.set(r.case_id, r);
  const keep = new Set([...byCase.keys()].slice(0, 2));
  const rows = records.map((r) => (keep.has(r.case_id)
    ? { ...r, reason: "Customer could not complete the overnight export and asked us to look at the job" }
    : { ...r, reason: "" }));
  const r = runAudit({ records: rows, mapping: autoMap(headers, rules), headers, rules });
  assert.equal(r.checks.AI2.outcome, "too_few", r.checks.AI2.detail);
  assert.equal(r.checks.B3.outcome, "too_few");
});

// And a real taxonomy is untouched: the demo exports keep every verdict they had, which
// the pinned expectations already assert. This pins the gate's own silence on them.
test("a genuine category column is not called free text", () => {
  for (const which of ["snapshot", "history", "comments"]) {
    const { report } = audit(which);
    for (const id of ["B2", "B3", "AI2", "AI3", "AI5"])
      assert.notEqual(report.checks[id].outcome, "free_text", `${which} ${id}`);
    for (const s of report.signals) assert.notEqual(s.state, "free_text", `${which} ${s.id}`);
  }
});

// The thresholds are declared, provisional, and generous enough that the case which
// prompted them sits well clear of both.
test("the free-text thresholds are declared and marked provisional", () => {
  const ft = rules.category_free_text;
  assert.ok(ft.max_unique_share > 0 && ft.max_unique_share <= 1);
  assert.ok(ft.max_avg_words >= 1);
  assert.equal(ft.provisional, true);
  // 468 distinct over 543 cases is 0.86 unique: comfortably past the line, as it should be.
  assert.ok(468 / 543 > ft.max_unique_share, "the reported case must trip the share test");
});

// The page and the README both promise that the report quotes only short labels from
// the columns mapped as contact reason and group. That is a promise about this code,
// so it is held here: add a quote site for any other field and this fails, before the
// promise quietly becomes false.
test("only contact reason and group are ever quoted back", () => {
  const cases = load("larkspur_with_history.csv");
  const history = load("larkspur_history_log.csv").records;
  // Two fields are left alone because overwriting them breaks the run rather than
  // testing it: status decides whether a case reads as closed, and marking it locks
  // the group signals; case_id is the key the cases are grouped by, and marking it
  // collapses 5,083 cases into six. Either way nothing is quoted and the test passes
  // while proving nothing, which is the failure mode this assertion exists to avoid.
  const SKIP = new Set(["status", "case_id"]);
  const FIELDS = Object.entries(rules.fields)
    .filter(([k, f]) => (f.file || "case") !== "bot" && ["category", "id"].includes(f.shape) && !SKIP.has(k))
    .map(([k]) => k);
  const mark = (f, i) => `MK-${f.toUpperCase()}-${i % 6}`;
  const rows = cases.records.map((r, i) => {
    const o = { ...r };
    for (const f of FIELDS) if (f in o) o[f] = mark(f, i);
    return o;
  });
  const bot = load("larkspur_bot_with_history.csv");
  const report = runAudit({
    records: rows, mapping: autoMap(cases.headers, rules), headers: cases.headers, rules, history,
    bot: { records: bot.records, headers: bot.headers,
      mapping: mapColumns({ headers: bot.headers, rules, scope: "bot", records: bot.records }).map },
  });
  const blob = JSON.stringify(report);
  const quoted = FIELDS.filter((f) => blob.includes(`MK-${f.toUpperCase()}-`));
  assert.deepEqual(quoted.sort(), ["group", "reason"],
    "the promise in the page and the README names reason and group only");

  // And the promise is not vacuous: both really are quoted here, so a change that
  // stopped quoting them would show up as a wording problem rather than pass silently.
  const signals = report.signals.filter((s) => (s.rows || []).length);
  assert.ok(signals.length >= 2, "no signal tabled anything, so this proves nothing");
});
