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
| `collector/scrape-page.js` | Runs inside a signed-in Google Maps page and returns the newest reviews of one park. |
| `collector/process.js` | Merges one raw scrape into `data/reviews.json`, skipping reviews already counted. |
| `collector/state.json` | Review ids already counted (created on first run). |

## Weekly update

A scheduled Claude task runs once a week on the computer where the Claude desktop app is signed in to Google:

1. For each park in `data/parks.json`, open `https://www.google.com/maps/search/<mapsQuery>?hl=en`, then start `collector/scrape-page.js` **without awaiting it** (`window.__rc=null; (<script>)("5 weeks",1500).then(r=>window.__rc=r)`), because a browser tool call times out after 45 s and a busy park takes several minutes. Poll `window.__rc` until it is set, then save the results to `collector/raw/YYYY-MM-DD.json`. Reviews of 4★ and 5★ only need id, stars and date; keep the text of 3★ and lower.
   For each park with at least 3 critical reviews (3★ or lower) in the last 4 weeks, add `"summary": {"en": "...", "es": "..."}`: 2–3 sentences on what guests complain about, in Claude's own words, never quoting reviewers.
2. Run `node collector/process.js collector/raw/YYYY-MM-DD.json`.
3. Commit `data/reviews.json` and `collector/state.json` and push. GitHub Pages republishes the site.

Raw scrapes (which contain review text) are not committed: `collector/raw/` is in `.gitignore`.

## Publishing on GitHub Pages

Repository → Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/ (root)`. The site appears at `https://<user>.github.io/<repo>/`.

## Limits

- Google only. Tripadvisor, Facebook and Instagram block automated reading; Trustpilot has too few park reviews to be useful.
- Google shows older reviews with relative dates ("2 months ago"). Dates within the last few weeks are close to exact; older ones are estimates.
- History starts when collection starts. Periods that begin before the first collection are marked ◔ until enough weeks have accumulated.
