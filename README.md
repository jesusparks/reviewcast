# GuestPulse

Guest review tracker for 29 Parques Reunidos parks. For each park it shows the average Google rating for the last 12 months, 3 months and 4 weeks, coloured against that park's own normal, plus the three most repeated complaints of the last 4 weeks.

## How the colours work

| Period | Compared with |
|---|---|
| Last 4 weeks | Average of the last 3 months |
| Last 3 months | Average of the last 12 months |
| Last 12 months | All-time Google rating of the park |

Green: more than 0.05 stars above the reference. Red: more than 0.05 below. White: in line (normal). Grey: fewer than 5 rated reviews. Striped: closed for the season. Both values are in `data/reviews.json` → `settings`.

A toolbar switch changes what counts as normal: the accumulated average (above) or the **same period last year** (4 weeks vs the same 4 weeks a year earlier, 3 months vs the same 3 months). The second is fairer for seasonal parks.

## Other features

- **Season mode.** `openMonths` in `data/parks.json` lists the months each park normally operates (null = all year). Outside those months the 4-week tile shows "Closed for the season" and is not judged. Checked against the 2026 calendars in October 2026; review them each season.
- **Written summaries.** Each week the collector writes a 2–3 sentence summary of the critical reviews per park, in English and Spanish, without quoting guests. Stored in `data/meta.json` → `summaries`.
- **PDF report.** "Download PDF report" builds an A4 landscape report of the current selection (summary, colour table, notes per park) in the chosen language.
- **English / Spanish** switch in the header; the choice is remembered per browser.

## Files

| Path | What it is |
|---|---|
| `index.html` | The whole site. Static, no build step. |
| `data/parks.json` | Parks, countries, park types, issue topic names. Edit here to add or rename a park. |
| `data/history/<park>.csv` | **The archive.** One row per review ever collected: anonymous hash, date first seen, Google's relative date, estimated date, stars, complaint topics. No review text, no reviewer names. Only grows. |
| `data/meta.json` | Latest Google rating per park and the written summaries. |
| `data/reviews.json` | What the site reads: daily ratings and issue counts per park, rebuilt from the archive on every update. |
| `collector/update.js` | Adds a collection to the archive (skipping reviews already there) and rebuilds `data/reviews.json`. `--rebuild` only rebuilds. |
| `collector/browser-run.js` | Runs inside the signed-in Google Maps tab: visits every park, reads the newest reviews and tags complaint topics. |
| `collector/build-browser.js` | Fills the topic lists into `browser-run.js` before it is injected. |
| `collector/process.js` | Date and topic helpers used by `update.js` (and the first, pre-archive pipeline). |
| `collector/scrape-page.js` | Older single-park version, kept for manual checks. |

Everything the site needs lives in this repository, so the page works from any device even when the collecting computer is off.

## Weekly update

A scheduled Claude task runs every Monday. It uses the built-in browser of the Claude desktop app on the computer where that browser is signed in to Google, and does the processing and the GitHub push from the cloud:

1. Build the browser script: `node collector/build-browser.js > /tmp/rc-inject.js`.
2. In the built-in browser open `https://www.google.com/maps/search/Parque+Warner+Madrid?hl=en` and run the contents of `/tmp/rc-inject.js` with the JavaScript tool (it defines `window.RC`).
3. Start the run without waiting for it: `RC.runAll(list, "5 weeks", 1500)`, where `list` is `[{id, q: mapsQuery}]` from `data/parks.json`. A browser tool call times out after about 45 s, so poll `RC.state` until `finished` is true.
4. For each park read `RC.pack(id)` (review hash, stars, relative date, complaint topics) and `RC.crit(id)` (critical reviews of the last 4 weeks). Write `collector/raw/YYYY-MM-DD.json` as `{"collectedAt": "YYYY-MM-DD", "parks": {"<id>": {"google", "items", "summary": {"en", "es"}}}}`. The summary is 2–3 sentences in Claude's own words; never quote reviewers.
5. `node collector/update.js collector/raw/YYYY-MM-DD.json`: only reviews not yet in the archive are added.
6. Commit `data/history/`, `data/meta.json` and `data/reviews.json`, and push. GitHub Pages republishes the site.

**Long backfills.** `RC.runAll(list, "11 months", 12000, {save: true, tag: "backfill12m"})` reads back to about a year per park and, after each park, saves a `guestpulse-<tag>-<id>-<date>.json` file through the browser's downloads. Pass those files to `update.js`.

Raw scrapes are not committed: `collector/raw/` is in `.gitignore`.

## Publishing on GitHub Pages

Repository → Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/ (root)`. The site appears at `https://<user>.github.io/<repo>/`.

## Limits

- Google only. Tripadvisor, Facebook and Instagram block automated reading; Trustpilot has too few park reviews to be useful.
- Google shows older reviews with relative dates ("2 months ago"). Dates within the last few weeks are close to exact; older ones are estimates.
- Google dates anything older than 11 months as "a year ago", so the archive starts about 11½ months back. Google shows the all-time rating with one decimal only (e.g. 4.2), so the 12-month comparison carries up to ±0.05 of rounding. The prior-12-month figures (`p12`) are still computed in `index.html`, ready for a "12 months vs previous 12 months" view once two full years are archived.
