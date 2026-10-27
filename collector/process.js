#!/usr/bin/env node
/*
 * ReviewCast collector: merges one raw Google Maps scrape into data/reviews.json.
 *
 * Usage:  node collector/process.js collector/raw/2026-10-26.json
 *
 * Raw file shape (written by the weekly browser run):
 * {
 *   "collectedAt": "2026-10-26",
 *   "parks": {
 *     "pwm": {
 *       "google": { "rating": 4.2, "count": 90743 },
 *       "reachedEnd": false,                       // true if scrolling stopped because the list ended
 *       "summary": { "en": "2–3 sentences…", "es": "2–3 frases…" },   // optional, about the last 4 weeks
 *       "reviews": [ { "id": "Ci9DQUlR...", "stars": 5, "when": "3 weeks ago", "text": "..." } ]
 *     }
 *   }
 * }
 *
 * Only aggregates are written to data/reviews.json (no review text), so the public site
 * shows ratings and issue counts but never republishes guests' words.
 * collector/state.json keeps the review ids already counted, so re-running a raw file
 * or overlapping weekly scrapes never double counts.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "data", "reviews.json");
const STATE = path.join(ROOT, "collector", "state.json");
const PARKS = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "parks.json"), "utf8")).parks.map(p => p.id);
const MAX_SEEN = 20000;

/* ---------- dates ---------- */
const pd = s => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fd = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = pd(s); d.setUTCDate(d.getUTCDate() + n); return fd(d); };

const NUM = { a: 1, an: 1, one: 1, un: 1, una: 1, uno: 1, ein: 1, eine: 1, einem: 1, einer: 1, een: 1 };
/** Google shows relative dates. Convert to an estimated calendar day (midpoint of the range Google means). */
function relDate(when, ref) {
  const s = String(when || "").toLowerCase().replace(/^(edited|editado|bearbeitet|bewerkt)\s*:?\s*/, "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/(just now|minute|hour|ahora|minuto|hora|minute|stunde|uur|minuut)/.test(s)) return ref;
  if (/^(yesterday|ayer|gestern|gisteren)$/.test(s)) return addDays(ref, -1);
  const m = s.match(/(\d+|an?|one|una?|uno|eine?[mr]?|een)\s+(day|days|week|weeks|month|months|year|years|d[ií]as?|semanas?|mes|meses|años?|anos?|tag|tagen|tage|woche|wochen|monat|monaten|jahr|jahren|dag|dagen|weken|week|maand|maanden|jaar)/);
  if (!m) return null;
  const q = /^\d+$/.test(m[1]) ? +m[1] : (NUM[m[1]] || 1);
  const u = m[2];
  if (/^(day|d[ií]a|tag|dag)/.test(u)) return addDays(ref, -q);
  if (/^(week|semana|woche|weken)/.test(u)) return addDays(ref, -(7 * q + 3));          // "3 weeks ago" = 21–27 days
  if (/^(month|mes|monat|maand)/.test(u)) return addDays(ref, -(Math.round(30.4 * q) + 15)); // "2 months ago" = 2–3 months
  return addDays(ref, -(365 * q + 182));                                                  // "a year ago" = 1–2 years
}

/* ---------- issue topics ---------- */
const THEMES = {
  q: ["queue","queues","queuing","queueing","waiting","waited","wait time","wait times","long lines","long line","cola","colas","espera","esperas","esperar","esperando","fila","filas","warteschlange","schlange","wartezeit","wartezeiten","warten","gewartet","wachtrij","wachtrijen","wachttijd","wachttijden","wachten","in coda","coda","attesa","attese","aspettare","aspettato","ko","koer","ventetid","ventetider","ventet"],
  c: ["crowded","overcrowded","packed","too many people","too busy","masificado","masificada","abarrotado","abarrotada","demasiada gente","mucha gente","uberfullt","zu voll","zu viele leute","overvol","te druk","veel te druk","affollato","affollata","troppa gente","overfylt","altfor mye folk","overfyldt","proppet"],
  p: ["expensive","overpriced","pricey","price","prices","rip off","ripoff","rip-off","value for money","caro","cara","caros","caras","precio","precios","abusivo","abusivos","un robo","carisimo","carisima","teuer","preis","preise","uberteuert","abzocke","duur","prijs","prijzen","prijzig","prezzo","prezzi","costoso","costosi","carissimo","dyrt","pris","priser","overpris"],
  f: ["food","restaurant","restaurants","meal","meals","burger","pizza","fries","drinks","snack","snacks","comida","restaurante","restaurantes","bocadillo","hamburguesa","bebida","bebidas","essen","gastronomie","pommes","getranke","imbiss","eten","friet","horeca","cibo","ristorante","ristoranti","mangiare","panino","panini","mat","mad","maden"],
  h: ["dirty","filthy","toilet","toilets","bathroom","bathrooms","restroom","restrooms","hygiene","smell","smelly","rubbish","litter","sucio","sucia","sucios","sucias","suciedad","limpieza","bano","banos","aseo","aseos","olor","basura","dreckig","schmutzig","toilette","toiletten","mull","vies","smerig","wc","sporco","sporca","sporchi","pulizia","bagno","bagni","igiene","skitten","skittent","toalett","toaletter","beskidt","toiletter"],
  s: ["staff","employee","employees","rude","unfriendly","customer service","manager","lifeguard","lifeguards","attitude","personal","empleado","empleados","empleada","trabajadores","maleducado","maleducada","borde","atencion al cliente","trato","socorrista","socorristas","mitarbeiter","unfreundlich","personeel","medewerker","medewerkers","onvriendelijk","personale","scortese","maleducato","ansatte","personalet","uhoflig"],
  r: ["closed","broken","out of order","maintenance","broke down","not working","shut","cerrada","cerradas","cerrado","cerrados","averiada","averiadas","averiado","averia","averias","mantenimiento","no funcionaba","no funcionaban","fuera de servicio","geschlossen","defekt","kaputt","ausser betrieb","wartung","ausfall","gesloten","defect","kapot","storing","onderhoud","chiusa","chiuse","chiuso","chiusi","guasto","guasta","manutenzione","stengt","ute av drift","odelagt","lukket","ude af drift","i stykker"],
  w: ["cold water","water was cold","pool","pools","slide","slides","wave pool","heating","agua fria","piscina","piscinas","tobogan","toboganes","kaltes wasser","becken","rutsche","rutschen","koud water","zwembad","glijbaan","glijbanen","acqua fredda","piscine","scivolo","scivoli","kaldt vann","basseng","sklie","sklier","koldt vand","bassin","rutsjebane","rutsjebaner"],
  a: ["shade","sun lounger","sun loungers","sunbeds","sunbed","loungers","lockers","locker","changing rooms","changing room","showers","seating","benches","sombra","sombras","hamacas","tumbonas","taquillas","vestuarios","vestuario","duchas","schatten","liegestuhle","schliessfacher","umkleide","umkleiden","duschen","schaduw","ligbedden","kluisjes","kleedkamers","douches","ombra","lettini","armadietti","spogliatoi","docce","skygge","solsenger","garderobe","dusj","liggestole","omklaedning"],
  k: ["ticket","tickets","booking","booked","refund","refunds","voucher","fast pass","fastpass","entrada","entradas","reserva","reembolso","devolucion","taquilla","eintritt","eintrittskarte","buchung","erstattung","kaartje","kaartjes","reservering","terugbetaling","biglietto","biglietti","prenotazione","rimborso","billett","billetter","refusjon","billet","refusion"],
  v: ["parking","car park","traffic","shuttle","aparcamiento","aparcar","trafico","autobus","parkplatz","parken","parkgebuhr","parkgebuhren","anfahrt","parkeren","parkeerplaats","parkeerkosten","parcheggio","navetta","parkering"],
  z: ["animals","enclosure","enclosures","cage","cages","welfare","cruel","animales","jaula","jaulas","recinto","recintos","maltrato","tiere","gehege","kafig","tierqualerei","dieren","kooi","kooien","verblijven","animali","gabbia","gabbie","recinti","maltrattati","dyrene","bur"],
  d: ["wheelchair","wheelchairs","disability","disabilities","disabled","accessibility","accessible","reduced mobility","height restriction","height limit","silla de ruedas","discapacidad","discapacitado","discapacitada","discapacitados","movilidad reducida","accesibilidad","rollstuhl","behinderung","behindert","barrierefrei","rolstoel","handicap","beperking","toegankelijk","sedia a rotelle","disabilita","disabile","disabili","accessibilita","rullestol","funksjonshemmet","korestol","handicappet"],
  y: ["unsafe","dangerous","accident","injured","injury","security","peligroso","peligrosa","accidente","herido","herida","seguridad","gefahrlich","unfall","verletzt","sicherheit","gevaarlijk","ongeluk","gewond","veiligheid","pericoloso","incidente","ferito","sicurezza","farlig","ulykke","skadet"]
};
const norm = s => String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ø/g, "o").replace(/æ/g, "ae").replace(/ß/g, "ss");
const RE = Object.fromEntries(Object.entries(THEMES).map(([k, list]) => {
  const alt = [...new Set(list.map(norm))].sort((a, b) => b.length - a.length)
    .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")).join("|");
  return [k, new RegExp("(?:^|[^\\p{L}\\p{N}])(?:" + alt + ")(?=$|[^\\p{L}\\p{N}])", "u")];
}));
function topicsOf(text) {
  const n = norm(text);
  const hits = Object.keys(RE).filter(k => RE[k].test(n));
  return hits.length ? hits : ["x"];
}

/* ---------- merge ---------- */
function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; } }

function main() {
  const rawFile = process.argv[2];
  if (!rawFile) { console.error("Usage: node collector/process.js <raw.json>"); process.exit(1); }
  const raw = JSON.parse(fs.readFileSync(rawFile, "utf8"));
  const ref = raw.collectedAt;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ref || "")) throw new Error("raw.collectedAt must be YYYY-MM-DD");

  const out = readJSON(OUT, { source: "Google Maps reviews", settings: { threshold: 0.05, minN: 5 }, parks: {} });
  out.parks = out.parks || {};
  const state = readJSON(STATE, { parks: {} });
  const report = [];

  for (const [pid, pr] of Object.entries(raw.parks || {})) {
    if (!PARKS.includes(pid)) { report.push(`${pid}: unknown park id, skipped`); continue; }
    const P = (out.parks[pid] = out.parks[pid] || { days: {}, themes: {} });
    const st = (state.parks[pid] = state.parks[pid] || { seen: [] });
    const seen = new Set(st.seen);
    if (pr.google && pr.google.rating != null) P.google = { rating: +pr.google.rating, count: +pr.google.count || 0, checked: ref };
    // Weekly written summary of the last 4 weeks' critical reviews, in English and Spanish.
    // Written by the weekly run after reading the reviews; it must not quote guests verbatim.
    if (pr.summary && (pr.summary.en || pr.summary.es)) {
      const clip = s => String(s || "").replace(/\s+/g, " ").trim().slice(0, 700);
      P.summary = { en: clip(pr.summary.en), es: clip(pr.summary.es), from: addDays(ref, -27), to: ref };
    }

    let added = 0, dup = 0, undated = 0, oldest = null;
    for (const r of pr.reviews || []) {
      const id = r.id || norm((r.author || "") + "|" + (r.when || "") + "|" + (r.text || "").slice(0, 120));
      if (seen.has(id)) { dup++; continue; }
      const day = relDate(r.when, ref);
      if (!day) { undated++; continue; }
      seen.add(id); st.seen.push(id); added++;
      if (!oldest || day < oldest) oldest = day;
      const stars = r.stars == null || r.stars === "" ? null : Math.min(5, Math.max(1, Number(r.stars)));
      const plat = "g"; // Google is the only source; the key keeps room for others later
      const d = (P.days[day] = P.days[day] || {});
      const a = (d[plat] = d[plat] || [0, 0, 0, 0]);
      if (stars != null && !isNaN(stars)) { a[0] = Math.round((a[0] + stars) * 100) / 100; a[1]++; }
      a[2]++;
      if (stars != null && stars <= 3) {
        a[3]++;
        const t = (P.themes[day] = P.themes[day] || {});
        const tp = (t[plat] = t[plat] || {});
        for (const k of topicsOf(r.text || "")) tp[k] = (tp[k] || 0) + 1;
      }
    }
    if (oldest && (!P.coverageFrom || oldest < P.coverageFrom)) P.coverageFrom = oldest;
    if (st.seen.length > MAX_SEEN) st.seen = st.seen.slice(-MAX_SEEN);
    st.lastRun = ref;
    report.push(`${pid}: +${added} new, ${dup} already counted${undated ? `, ${undated} without a readable date` : ""}${P.google ? `, Google ${P.google.rating} (${P.google.count})` : ""}`);
  }

  out.generated = new Date().toISOString();
  out.asOf = !out.asOf || ref > out.asOf ? ref : out.asOf;
  fs.writeFileSync(OUT, JSON.stringify(out));
  fs.writeFileSync(STATE, JSON.stringify(state));
  console.log(report.join("\n"));
}

if (require.main === module) main();
module.exports = { relDate, topicsOf };
