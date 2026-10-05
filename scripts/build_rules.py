"""Compile rules/rules.yaml to dist/rules.json and check internal references."""
import json, sys, yaml
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
# Every vendor we claim to have sourced column names from must point at a real ref.
errs += [f"column_name_sources {v} -> {k}" for v, k in r.get("column_name_sources", {}).items()
         if k not in r["refs"]]
errs += [f"comment_column_sources {v} -> {k}" for v, k in r.get("comment_column_sources", {}).items()
         if k not in r["refs"]]
# Citing a source for comment columns while carrying no comment-level field would be
# a citation for something that isn't there.
if r.get("comment_column_sources") and not any(f.get("level") == "comment" for f in r["fields"].values()):
    errs.append("comment_column_sources is set but no field is level: comment")
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
