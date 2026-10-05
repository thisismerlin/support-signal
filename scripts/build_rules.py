"""Compile rules/rules.yaml to dist/rules.json and check internal references."""
import json, re, sys, yaml
from pathlib import Path
root = Path(__file__).resolve().parent.parent
r = yaml.safe_load((root / "rules/rules.yaml").read_text())
ids = {c["id"] for c in r["checks"]}
errs = []
for u in r["uses"]:
    errs += [f"use {u['id']} -> {x}" for x in u["required"] + u.get("optional", []) if x not in ids]
for c in r["checks"]:
    errs += [f"check {c['id']} ref {x}" for x in c.get("refs", []) if x not in r["refs"]]
for s in r["signals"]:
    errs += [f"signal {s['id']} -> {x}" for x in s.get("unlocked_by_any_check", []) if x not in ids]
# Field scopes: a typo here would silently stop a column mapping rather than fail.
SCOPES = {"case", "bot", "both"}
# `reads:` tags declared in engine code rather than in rules.yaml: the churn driver
# flags are defined there, so a tag they use need not appear on a check or signal.
ENGINE_READS = {"comment_text", "comment_count",
                # Matched against a signal's requires_fields, not against a `reads:` tag.
                "conflicting_field"}
errs += [f"field {k} file: {f['file']}" for k, f in r["fields"].items()
         if f.get("file", "case") not in SCOPES]
errs += [f"use {u['id']} needs_file: {u['needs_file']}" for u in r["uses"]
         if u.get("needs_file", "case") not in SCOPES]
# A synonym repeated inside one scope is a first-match race; across scopes it is
# the point. "both" shares a namespace with each of the other two.
for scope in ("case", "bot"):
    seen = {}
    for k, f in r["fields"].items():
        if f.get("file", "case") not in (scope, "both"):
            continue
        for s in {k.replace("_", " "), *f.get("synonyms", [])}:
            if seen.get(s, k) != k:
                errs.append(f"synonym {s!r} claimed by both {seen[s]} and {k} in {scope} files")
            seen[s] = k
# A field's level decides whether the collapser lets it vary between rows of one case.
# A typo here would turn a comment column into a case-level field and report every
# one-to-many export as a pile of conflicts.
LEVELS = {"case", "comment"}
errs += [f"field {k} level: {f['level']}" for k, f in r["fields"].items()
         if f.get("level", "case") not in LEVELS]
# A comment-level field only makes sense in a case export: the bot file has one row
# per conversation and is never collapsed.
errs += [f"field {k} is level: comment but file: {f.get('file')}" for k, f in r["fields"].items()
         if f.get("level") == "comment" and f.get("file", "case") != "case"]
# Value inference switches on these; a typo would silently stop a field being guessable.
SHAPES = {"id", "date", "category", "text", "number", "flag"}
errs += [f"field {k} shape: {f['shape']}" for k, f in r["fields"].items()
         if "shape" in f and f["shape"] not in SHAPES]
errs += [f"field {k} has no shape" for k, f in r["fields"].items() if "shape" not in f]
# Every optional field the mapping table offers must say what it is and what it
# unlocks. Required fields are the four the page already explains; bot fields are not
# in the table. A field added without these would show as a bare label, which is the
# state this replaced: a row offering "Follow-up of" and no way to know what it wants.
for k, f in r["fields"].items():
    if f.get("required") or f.get("file") == "bot":
        continue
    errs += [f"optional field {k} has no {key}" for key in ("means", "unlocks") if not f.get(key)]
# A signal's requires_values names fields, and the engine locks the signal when one is
# mapped but empty. A misspelt name here would silently never lock.
for s in r["signals"]:
    errs += [f"signal {s['id']} requires_values {v!r}, which is not a field" for v in s.get("requires_values", [])
             if v not in r["fields"]]
# Every vendor we claim to have sourced column names from must point at a real ref.
errs += [f"column_name_sources {v} -> {k}" for v, k in r.get("column_name_sources", {}).items()
         if k not in r["refs"]]
errs += [f"comment_column_sources {v} -> {k}" for v, k in r.get("comment_column_sources", {}).items()
         if k not in r["refs"]]
# Citing a source for comment columns while carrying no comment-level field would be
# a citation for something that isn't there.
if r.get("comment_column_sources") and not any(f.get("level") == "comment" for f in r["fields"].values()):
    errs.append("comment_column_sources is set but no field is level: comment")
# Conflicts are scoped by what each check reads, so an undeclared or misspelt field
# name would silently widen or narrow what a conflict holds back.
for c in r["checks"]:
    if "reads_fields" not in c:
        errs.append(f"check {c['id']} does not say which fields it reads")
        continue
    errs += [f"check {c['id']} reads_fields {f!r}, which is not a field" for f in c["reads_fields"]
             if f not in r["fields"]]
# The engine matches guess_requires_word against single lowercase words split out of a
# header, so a capitalised or multi-word entry here would never match anything.
for k, f in r["fields"].items():
    w = f.get("guess_requires_word")
    if w is None:
        continue
    if not isinstance(w, list) or not w:
        errs.append(f"field {k} guess_requires_word must be a non-empty list")
        continue
    errs += [f"field {k} guess_requires_word {x!r} is not one lowercase word" for x in w
             if not isinstance(x, str) or not x.islower() or " " in x]
# A check the engine can report as empty needs a title for it: the pass and failure
# titles are both claims about the values, and neither is true of a column with none.
for c in r["checks"]:
    if c.get("empty_title") is not None and not str(c["empty_title"]).strip():
        errs.append(f"check {c['id']} has an empty empty_title")
# C4 names the dirty-collapse case separately, and the engine reports both.
for key in ("conflict_title", "conflict_fix"):
    if not next(c for c in r["checks"] if c["id"] == "C4").get(key):
        errs.append(f"C4 has no {key}")
# No caution may claim another check's outcome: it cannot know it, and saying so is how
# "C4 passes" ended up printed on a run where C4 was failing.
for name, c in r.get("cautions", {}).items():
    if re.search(r"\b(C\d+|B\d+|AI\d+)\b.{0,24}\b(pass|passes|fail|fails|green|red|amber)\b", c.get("text", ""), re.I):
        errs.append(f"caution {name} asserts another check's outcome in its text")

# Cautions attach by `reads:` tag, so a tag nothing declares, or a declared tag no
# caution covers, is a caution that will never fire or a reader that will never hear.
cautions = r.get("cautions", {})
covered = {t for c in cautions.values() for t in c.get("applies_to_reads", [])}
declared = set()
for group in ("checks", "signals"):
    for item in r.get(group, []):
        declared |= set(item.get("reads", []))
errs += [f"caution tag {t!r} is declared by no check or signal" for t in sorted(covered - declared)
         if t not in ENGINE_READS]
errs += [f"reads tag {t!r} on a check or signal matches no caution" for t in sorted(declared - covered)]
for name, c in cautions.items():
    errs += [f"caution {name} has no {k}" for k in ("applies_to_reads", "title", "text") if not c.get(k)]

# The engine reads these by name; a rename here must not fail silently at runtime.
params = r.get("resolution_audit", {}).get("params", {})
errs += [f"resolution_audit.params missing {p}" for p in
         ("return_windows_days", "escalation_within_minutes", "normalise_reasons") if p not in params]
if errs:
    sys.exit("Rule errors:\n" + "\n".join(errs))
(root / "dist").mkdir(exist_ok=True)
(root / "dist/rules.json").write_text(json.dumps(r, default=str))
comment_fields = sum(1 for f in r["fields"].values() if f.get("level") == "comment")
print(f"rules {r['meta']['version']}: {len(r['checks'])} checks, {len(r['uses'])} uses, "
      f"{len(r['signals'])} signals, {comment_fields} comment fields")
