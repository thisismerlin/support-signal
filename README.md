# Support Signal

**Before you buy the AI, check what you're feeding it.**

Support Signal checks whether a support case export can answer the questions support leaders are about to spend money on: resolution time, transfers, CSAT, churn, and AI self-help readiness. Each check that passes unlocks the support signals that data can honestly carry. Checks that fail keep their signals locked, with the reason.

- Runs entirely in your browser. No data is uploaded, stored or sent anywhere.
- Every rule, threshold and source is in [`rules/rules.yaml`](rules/rules.yaml). The rules are the documentation.
- Ships with a fictional demo company with deliberately planted flaws ([datasheet](data/DATASHEET.md)).

## How it judges
Three bands, after Lawrence's *Data Readiness Levels*:
- **C, readable**: core columns, history or snapshot, duplicates.
- **B, faithful**: real fill rates, catch-all reasons, sprawl, impossible dates, flags that are never set, AI readiness of reasons and text.
- **A, fit for a named use**: one verdict per use, never "in general".

Outcomes: green, amber, red, *not in export* (the export lacks it; not a judgement on your system) and *needs a human*.

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

Built by Merlin.
