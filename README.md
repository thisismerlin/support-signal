# Support Signal

**Before you buy the AI, check what you're feeding it.**

Vendors tell you what their AI can do. Support Signal tells you whether your own
data can answer the questions you're about to spend money on. Point it at a
support case export and it reads the columns, not the sales deck.

It answers per question, never "your data is good". Resolution time, transfers,
CSAT, churn, AI self-help readiness and the bot resolution audit each get their
own verdict — ready, usable with care, not ready, not in this export, can't tell
yet — and each names the checks holding it back and how to fix them.

Signals stay locked until the data supports them. If an export can't tell slow
cases from cases waiting on the customer, the signal that needs that doesn't
appear, with the reason given. You never get a number the data can't carry.

**The driver test.** Busier accounts raise more cases, so almost anything tied to
case volume looks like it causes churn. The page shows the raw odds for a dozen
flags, then controls for product and case volume and lets you watch most of them
fall away.

**One row per comment.** Real exports are often one row per case comment or
email, with the case fields repeated on every row. Support Signal names that as
the file's shape rather than failing it as duplicates: it collapses to one row
per case before any check runs, and tells you what it read — rows, cases,
comments per case, and anything dropped or disagreeing. Only rows identical in
every column count as duplicates. The comment rows are then used, not discarded:
the wording checks read comment text, and the last update is taken from the
latest public comment when no column carries it.

**The bot resolution audit.** When an AI agent says it resolved something, the
only honest check is what the customer did next. Given a bot conversations
export, it sorts each claimed resolution into contradicted, not contradicted, or
can't tell. "Not contradicted" means silence, not success.

### Before you read any number

- **It runs entirely in your browser.** Your file is read by the page and never
  leaves your machine. Nothing is uploaded, stored or sent anywhere, and there is
  no server.
- **A saved mapping is column names only.** The page can save which of your columns
  goes to which field, so next month's export doesn't have to be mapped from
  scratch. That file holds column names and the date order you chose, nothing
  else — no case data and no values. It is a file you keep rather than anything
  stored in your browser, which still persists nothing.
- **The report quotes a little of your data back, so check it before sharing.**
  Running in the browser is only half of it: a report you paste elsewhere has to
  be safe to paste. The report quotes only short labels from the columns you
  mapped as contact reason and group or queue — at most three of them, clipped to
  40 characters, and never from a column holding prose. Nothing else from your
  export is quoted anywhere, and case and conversation IDs are not echoed at all.
  But the rule is about the shape of a value, not what it means: a column of
  customer or agent names mapped to reason or group would be quoted under it. So
  check those two columns before you share a report. All of this holds for the
  copied JSON as well as the page, which is where it mattered most — the JSON
  carried values the page never showed.
- **The demo company is invented.** Larkspur is fictional. Every row, flaw and
  count in it was planted deliberately by a generator with a fixed seed, so the
  checks can be tested against known answers. None of its numbers describe real
  support teams, real customers or real AI agents. The
  [datasheet](data/DATASHEET.md) lists what was planted.
- **Thresholds marked provisional are starting points**, to be calibrated against
  real exports. They are not evidence, and shouldn't be quoted as such.
- **The rules are the documentation.** Every check, threshold, parameter and
  source is in [`rules/rules.yaml`](rules/rules.yaml). The engine, the tests and
  the page all read that one file.

Verdicts sit in three bands, after Lawrence's *Data Readiness Levels*: **C** can
it be read, **B** is it faithful, **A** is it fit for a named use. Open
`dist/index.html` in a browser to try it — the demo company is already loaded,
with a switch to run your own CSV instead.

## Setup
The Python scripts need PyYAML and numpy. Create a virtualenv and install them:
```
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
npm test
```
`npm test` and `npm run build` shell out to `python3`, so the virtualenv has to be
active in the shell you run them from.

## Develop
```
npm run data    # regenerate the demo dataset (fixed seed)
npm test        # every planted flaw must trigger its expected verdict
npm run build   # build dist/index.html, a single self-contained page
```

## Status
Draft. Thresholds marked provisional are starting points to be calibrated on real exports.

## Use it
Free to use on your own exports, for anything, including commercially. The page
reads your file in the browser and nothing is uploaded, stored or sent anywhere,
so there is no account to make and nothing to agree to.

The code is [MIT licensed](LICENSE) — use it, change it, ship it, with the
copyright notice kept. The embedded Inter typeface is third-party material under
the SIL Open Font License 1.1; see [NOTICE](NOTICE).

Built by Merlin Iles-Jonas.
