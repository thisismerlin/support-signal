"""Build the single-file page.

dist/index.html     full HTML document (for GitHub Pages or running offline)
dist/artifact.html  page content without the document wrapper (for hosts that add one)
"""
import re
from pathlib import Path

root = Path(__file__).resolve().parent.parent
page = (root / "src/page.html").read_text()
engine = (root / "src/engine.js").read_text()
engine = re.sub(r"^export\s+", "", engine, flags=re.M)  # classic script: drop ES module exports
app = (root / "src/app.js").read_text()
rules = (root / "dist/rules.json").read_text()
cases = (root / "data/larkspur_with_history.csv").read_text()
history = (root / "data/larkspur_history_log.csv").read_text()
# One bot export per case export, so the existing source switch drives both.
bot_snapshot = (root / "data/larkspur_bot_snapshot.csv").read_text()
bot_history = (root / "data/larkspur_bot_with_history.csv").read_text()
for blob in (cases, history, bot_snapshot, bot_history):
    assert "</script" not in blob.lower()

body = (page.replace("{{RULES}}", rules).replace("{{ENGINE}}", engine).replace("{{APP}}", app)
        .replace("{{DEMO_CASES}}", cases).replace("{{DEMO_HISTORY}}", history)
        .replace("{{DEMO_BOT_SNAPSHOT}}", bot_snapshot).replace("{{DEMO_BOT_HISTORY}}", bot_history))
(root / "dist/artifact.html").write_text(body)
full = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        '</head>\n<body>\n' + body + "\n</body>\n</html>\n")
(root / "dist/index.html").write_text(full)
print(f"dist/index.html {len(full) / 1e6:.2f} MB")
