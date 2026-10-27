# ReviewCast

Guest review tracker for 27 Parques Reunidos attractions. For each park it shows the average Google rating for the last 12 months, 3 months and 4 weeks, coloured against that park's own normal, plus the three most repeated complaints of the last 4 weeks.

## How the colours work

| Period | Compared with |
|---|---|
| Last 4 weeks | Average of the last 3 months |
| Last 3 months | Average of the last 12 months |
| Last 12 months | Average of the 12 months before |

Green: more than 0.05 stars above the reference. Red: more than 0.05 below. White: in line (normal). Grey: fewer than 5 rated reviews. Striped: closed for the season. Both values are in `data/reviews.json` → `settings`.

A toolbar switch changes what counts as normal: the accumulated average (above) or the **same period last year** (4 weeks vs the same 4 weeks a year earlier, 3 months vs the same 3 months). The second is fairer for seasonal parks.

## Other features

- **Season mode.** `openMonths` in `data/parks.json` lists the months each attraction normally operates (null = all year). Outside those months the 4-week tile shows "Closed for the season" and is not judged. The values are approximate: adjust them to each year's calendar.
- **Written summaries.** Each week the collector writes a 2–3 sentence summary of the critical reviews per park, in English and Spanish, without quoting guests. Stored in `data/reviews.json` → `parks.<id>.summary`.
- **PDF report.** "Download PDF report" builds an A4 landscape report of the current selection (summary, colour table, notes per attraction) in the chosen language.
- **CSV export** of the current selection.
- **English / Spanish** switch in the header; the choice is remembered per browser.

## Files

| Path | What it is |
|---|---|
| `index.html` | The whole site. Static, no build step. |
| `data/parks.json` | Parks, countries, attraction types, issue topic names. Edit here to add or rename a park. |
| `data/reviews.json` | Aggregated daily ratings and issue counts per park. Written by the collector, read by the site. Contains no review text. |
| `collector/browser-run.js` | Runs inside the signed-in Google Maps tab: visits every park, reads the newest reviews and tags complaint topics. |
| `collector/build-browser.js` | Fills the topic lists into `browser-run.js` before it is injected. |
| `collector/scrape-page.js` | Older single-park version, kept for manual checks. |
| `collector/process.js` | Merges one raw scrape into `data/reviews.json`, skipping reviews already counted. |
| `collector/state.json` | Review ids already counted (created on first run). |

## Weekly update

A scheduled Claude task runs once a week. It uses the built-in browser of the Claude desktop app on the computer where that browser is signed in to Google, and does the processing and the GitHub push from the cloud:

1. Build the browser script: `node collector/build-browser.js > /tmp/rc-inject.js`.
2. In the built-in browser open `https://www.google.com/maps/search/Parque+Warner+Madrid?hl=en` and run the contents of `/tmp/rc-inject.js` with the JavaScript tool (it defines `window.RC`).
3. Start the run without waiting for it: `RC.runAll(list, "5 weeks", 1500)`, where `list` is `[{id, q: mapsQuery}]` from `data/parks.json`. It moves from park to park with the Maps search box, so the page is never reloaded. A browser tool call times out after about 45 s, so poll `RC.state` until `finished` is true (roughly 15–30 minutes for 27 parks).
4. For each park read `RC.pack(id)` (compact list: review hash, stars, relative date, complaint topics) and `RC.crit(id)` (critical reviews of the last 4 weeks). Write `collector/raw/YYYY-MM-DD.json` as `{"collectedAt": "YYYY-MM-DD", "parks": {"<id>": <pack> + "summary": {"en", "es"}}}`. The summary is 2–3 sentences per park, in Claude's own words, written from `RC.crit(id)`; never quote reviewers.
5. Run `node collector/process.js collector/raw/YYYY-MM-DD.json`.
6. Commit `data/reviews.json` and `collector/state.json` and push. GitHub Pages republishes the site.

Raw scrapes are not committed: `collector/raw/` is in `.gitignore`. Review hashes in `collector/state.json` make re-runs and overlapping weeks safe: a review is only counted once.

## Publishing on GitHub Pages

Repository → Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/ (root)`. The site appears at `https://<user>.github.io/<repo>/`.

## Limits

- Google only. Tripadvisor, Facebook and Instagram block automated reading; Trustpilot has too few park reviews to be useful.
- Google shows older reviews with relative dates ("2 months ago"). Dates within the last few weeks are close to exact; older ones are estimates.
- History starts when collection starts. Periods that begin before the first collection are marked ◔ until enough weeks have accumulated.
