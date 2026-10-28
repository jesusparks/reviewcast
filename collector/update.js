#!/usr/bin/env node
/*
 * GuestPulse data pipeline.
 *
 *   node collector/update.js <raw-file.json> [more raw files...]
 *   node collector/update.js --rebuild            (only rebuild data/reviews.json from the archive)
 *
 * 1. ARCHIVE. Every review ever collected is kept in data/history/<park>.csv, one row per review:
 *      hash,first_seen,when,date,stars,topics
 *    hash        anonymous hash of Google's review id (never the id itself, never the reviewer)
 *    first_seen  date the review was first collected
 *    when        Google's relative date at that moment, compact ("3w", "1m", "0d")
 *    date        estimated calendar date (middle of the range Google means)
 *    stars       1–5
 *    topics      complaint topics found in 3-star-or-lower reviews (letters, see data/parks.json "themes"), "x" = none
 *    Review text is not stored: the repository is public.
 *    A review already in the archive is never added twice, so overlapping or repeated runs are safe.
 *
 * 2. META. data/meta.json keeps the latest Google rating per park and the written summaries.
 *
 * 3. BUILD. data/reviews.json (what the website reads) is rebuilt from the archive + meta every time.
 *
 * Raw file formats accepted:
 *   weekly:   {"collectedAt": "YYYY-MM-DD", "parks": {"<id>": {"google": {...}, "items": "...", "summary": {"en","es"}}}}
 *   per park: {"id": "<id>", "collectedAt": "YYYY-MM-DD", "google": {...}, "items": "..."}   (browser RC.save files)
 *   items = "hash,stars,when,topics;..." as produced by collector/browser-run.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { relDate } = require("./process.js");

const ROOT = path.resolve(__dirname, "..");
const HIST = path.join(ROOT, "data", "history");
const META = path.join(ROOT, "data", "meta.json");
const OUT = path.join(ROOT, "data", "reviews.json");
const PARKS = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "parks.json"), "utf8")).parks.map(p => p.id);
const HEADER = "hash,first_seen,when,date,stars,topics";
const UNIT = { d: "day", w: "week", m: "month", y: "year" };

const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
const whenText = wc => { const m = /^(\d+)([dwmy])$/.exec(wc || ""); return m ? (m[1] === "0" ? "today" : m[1] + " " + UNIT[m[2]] + (m[1] === "1" ? "" : "s") + " ago") : ""; };

function loadHistory(id) {
  const f = path.join(HIST, id + ".csv");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").slice(1).filter(Boolean).map(l => {
    const [hash, first_seen, when, date, stars, topics] = l.split(",");
    return { hash, first_seen, when, date, stars: stars === "" ? null : +stars, topics: topics || "" };
  });
}
function saveHistory(id, rows) {
  fs.mkdirSync(HIST, { recursive: true });
  rows.sort((a, b) => (b.date || "").localeCompare(a.date || "") || a.hash.localeCompare(b.hash));
  fs.writeFileSync(path.join(HIST, id + ".csv"), HEADER + "\n" + rows.map(r => [r.hash, r.first_seen, r.when, r.date, r.stars ?? "", r.topics].join(",")).join("\n") + "\n");
}

function ingest(files, report) {
  const meta = readJSON(META, { google: {}, summaries: {} });
  const touched = {};
  const add = (id, ref, pr) => {
    if (!PARKS.includes(id)) { report.push(`${id}: unknown park, skipped`); return; }
    if (pr.google && pr.google.rating != null) {
      const old = meta.google[id];
      if (!old || old.checked <= ref) meta.google[id] = { rating: +pr.google.rating, count: +pr.google.count || 0, checked: ref };
    }
    if (pr.summary && (pr.summary.en || pr.summary.es)) {
      const clip = s => String(s || "").replace(/\s+/g, " ").trim().slice(0, 700);
      meta.summaries[id] = { en: clip(pr.summary.en), es: clip(pr.summary.es), from: addDays(ref, -27), to: ref };
    }
    const rows = touched[id] || (touched[id] = loadHistory(id));
    const known = new Set(rows.map(r => r.hash));
    let added = 0, dup = 0, skipped = 0;
    // A run that read on until Google's "a year ago" has every review of the last ~12 months
    // ("11 months ago" covers roughly days 335-365), so the park's 12-month window counts as complete.
    if (/(^|;)[^,;]*,[^,;]*,\d+y(,|;|$)/.test(String(pr.items || ""))) {
      meta.complete = meta.complete || {};
      if (!meta.complete[id] || meta.complete[id] < ref) meta.complete[id] = ref;
    }
    for (const s of String(pr.items || "").split(";").filter(Boolean)) {
      const [hash, st, wc, tp] = s.split(",");
      if (!hash) continue;
      if (known.has(hash)) { dup++; continue; }
      // "a year ago" covers 365–729 days: too vague, and a run that stops there only reads part of it.
      if (/y$/.test(wc || "")) { skipped++; continue; }
      const date = relDate(whenText(wc), ref);
      if (!date) { skipped++; continue; }
      known.add(hash);
      rows.push({ hash, first_seen: ref, when: wc, date, stars: st === "" ? null : Math.min(5, Math.max(1, +st)), topics: tp || "" });
      added++;
    }
    report.push(`${id}: +${added} new, ${dup} already archived${skipped ? `, ${skipped} skipped` : ""}`);
  };
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    if (raw.id) add(raw.id, raw.collectedAt, raw);
    else for (const [id, pr] of Object.entries(raw.parks || {})) add(id, raw.collectedAt, pr);
  }
  for (const [id, rows] of Object.entries(touched)) saveHistory(id, rows);
  fs.writeFileSync(META, JSON.stringify(meta, null, 1));
}

function addDays(s, n) { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

function build() {
  const meta = readJSON(META, { google: {}, summaries: {} });
  const prev = readJSON(OUT, {});
  const out = { generated: new Date().toISOString(), asOf: null, source: "Google Maps reviews", settings: prev.settings || { threshold: 0.05, minN: 5 }, parks: {} };
  for (const id of PARKS) {
    const rows = loadHistory(id);
    // Park not archived yet (e.g. during the first backfill): keep its previously published figures.
    if (!rows.length && prev.parks && prev.parks[id] && !prev.parks[id].fromArchive) { out.parks[id] = prev.parks[id]; continue; }
    const P = { days: {}, themes: {}, fromArchive: true };
    let first = null, lastSeen = null;
    for (const r of rows) {
      if (!r.date) continue;
      const a = ((P.days[r.date] = P.days[r.date] || {}).g = (P.days[r.date].g || [0, 0, 0, 0]));
      if (r.stars != null) { a[0] = Math.round((a[0] + r.stars) * 100) / 100; a[1]++; }
      a[2]++;
      if (r.stars != null && r.stars <= 3) {
        a[3]++;
        const t = ((P.themes[r.date] = P.themes[r.date] || {}).g = (P.themes[r.date].g || {}));
        for (const k of (r.topics || "x").split("")) t[k] = (t[k] || 0) + 1;
      }
      if (!first || r.date < first) first = r.date;
      if (!lastSeen || r.first_seen > lastSeen) lastSeen = r.first_seen;
    }
    if (first) P.coverageFrom = first;
    // complete 12 months (see ingest): report coverage from 12 months before that collection
    if (meta.complete && meta.complete[id]) { const c = addDays(meta.complete[id], -365); if (!P.coverageFrom || c < P.coverageFrom) P.coverageFrom = c; }
    if (meta.google[id]) P.google = meta.google[id];
    if (meta.summaries[id]) P.summary = meta.summaries[id];
    P.reviews = rows.length;
    out.parks[id] = P;
    if (lastSeen && (!out.asOf || lastSeen > out.asOf)) out.asOf = lastSeen;
  }
  fs.writeFileSync(OUT, JSON.stringify(out));
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const report = [];
  const files = args.filter(a => a !== "--rebuild");
  if (files.length) ingest(files, report);
  const out = build();
  const total = Object.values(out.parks).reduce((s, p) => s + (p.reviews || 0), 0);
  console.log(report.join("\n") + (report.length ? "\n" : "") + `Built data/reviews.json: ${total} archived reviews, data up to ${out.asOf}`);
}
if (require.main === module) main();
module.exports = { build, ingest };
