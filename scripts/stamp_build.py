"""Stamp the commit SHA into the built page, so a pasted report says which build made it.

Run after `npm run build` and after the dist-staleness check, never before: the check
compares dist against a fresh build, and a real SHA in dist would fail it on every run
(a commit cannot contain its own SHA). The deploy workflow calls this between the two.

    python3 scripts/stamp_build.py <sha>

Replaces the placeholder in dist/rules.json and in the two pages that inline it. Safe to
run twice: the second run finds no placeholder and says so.
"""
import sys
from pathlib import Path

PLACEHOLDER = "unstamped"
TARGETS = ("dist/rules.json", "dist/index.html", "dist/artifact.html")

sha = (sys.argv[1] if len(sys.argv) > 1 else "").strip()
if not sha:
    sys.exit("usage: stamp_build.py <sha>")
# Quoted on both sides so this can only ever hit the JSON string it is meant to, never
# the word "unstamped" in a comment or in the demo data inlined alongside it.
needle, replacement = f'"build": "{PLACEHOLDER}"', f'"build": "{sha[:12]}"'

root = Path(__file__).resolve().parent.parent
stamped = 0
for rel in TARGETS:
    p = root / rel
    if not p.exists():
        sys.exit(f"{rel} is missing: run the build first")
    text = p.read_text()
    n = text.count(needle)
    if n > 1:
        sys.exit(f"{rel} carries {n} build placeholders; expected one")
    if n:
        p.write_text(text.replace(needle, replacement))
        stamped += 1
    print(f"{rel}: {'stamped' if n else 'no placeholder found'}")
if not stamped:
    sys.exit("nothing was stamped: the build placeholder is missing from every target")
print(f"build {sha[:12]} stamped into {stamped} file(s)")
