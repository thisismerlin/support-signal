# Support Signal redesign (version 2, product-page style): porting notes

Three files replace the presentation layer. The engine, rules and data are untouched.

1. `fonts.css` : embedded Inter (OFL 1.1), used only where Apple's system font is not available.
                 Put at the top of the page <style>. Remove the Google Fonts <link> tags: no external requests remain.
2. `style.css` : the whole stylesheet. Replaces the existing <style> block in src/page.html.
3. `body.html` : the static markup. Replaces the existing `<div class="wrap">...</div>` in src/page.html.
                 Every ID the script uses is unchanged (#uses, #fix, #signals, #drivers-body, #drivers-toggle, #checks, #vendor,
                 #run-meta, #stamp, #report, #upload-panel, #summary and the upload inputs). The nav button reuses data-src="upload".

## Changes needed in src/app.js (strings only, no logic)
- run-meta line: join parts with ", " instead of " · ".
- stamp line: "Rules X (status), engine Y, run Z" (commas instead of " · ").
- renderChecks bands: [["C","Can it be read?"],["B","Is it faithful?"],["A","Is it fit for use?"]]
  and the heading becomes `<h3>${h} <span class="band-id">Band ${b}</span></h3>`.
- refs: join with ", " instead of " · ".
- Rule line: `${c.id}, ${esc(d.dimension)}`.

## Rules of the system
- Blue is for actions only. Status colours are for verdicts only. Pink-red means risk.
- State is carried by shape first, colour second: filled circle = green, half = amber, square = red,
  dashed ring = not in export, outlined square = needs a human.
- Bands alternate white and light grey. The driver test is the only black band.
- New screens (the resolution audit) follow the same pattern: centred headline, one grey supporting line, tiles with 24px radius.
- Motion: one load sequence in the hero, scroll reveals via CSS view timelines, all disabled under prefers-reduced-motion.
