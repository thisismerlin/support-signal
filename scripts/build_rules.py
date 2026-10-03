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
if errs:
    sys.exit("Rule errors:\n" + "\n".join(errs))
(root / "dist").mkdir(exist_ok=True)
(root / "dist/rules.json").write_text(json.dumps(r, default=str))
print(f"rules {r['meta']['version']}: {len(r['checks'])} checks, {len(r['uses'])} uses, {len(r['signals'])} signals")
