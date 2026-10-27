/*
 * ReviewCast browser collector. Injected ONCE into a signed-in Google Maps tab opened with ?hl=en.
 * It stays alive across parks because it moves between places with the Maps search box
 * instead of reloading the page.
 *
 *   RC.runAll([{id, q}, ...], "5 weeks", 1500)   start; runs in the background
 *   RC.state                                      progress: {current, done, total, finished, log}
 *   RC.pack(id)                                   compact JSON for collector/process.js
 *   RC.crit(id)                                   critical review texts of the last 4 weeks (for the written summary)
 *
 * The weekly job builds the injected text with `node collector/build-browser.js`, which fills
 * the topic lists from collector/process.js so both use the same topic lists.
 */
(() => {
  const THEMES = __THEMES__;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ø/g, "o").replace(/æ/g, "ae").replace(/ß/g, "ss");
  const RE = Object.fromEntries(Object.entries(THEMES).map(([k, list]) => {
    const alt = [...new Set(list.map(norm))].sort((a, b) => b.length - a.length).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")).join("|");
    return [k, new RegExp("(?:^|[^\\p{L}\\p{N}])(?:" + alt + ")(?=$|[^\\p{L}\\p{N}])", "u")];
  }));
  const topicsOf = text => { const n = norm(text); return Object.keys(RE).filter(k => RE[k].test(n)).join(""); };
  const unitDays = { minute: 0, hour: 0, day: 1, week: 7, month: 30, year: 365 };
  const parseWhen = t => {
    const s = String(t || "").toLowerCase();
    const m = s.match(/(\d+|an?|one)\s+(minute|hour|day|week|month|year)s?/);
    if (!m) return /now/.test(s) ? { q: 0, u: "d" } : null;
    return { q: /^\d+$/.test(m[1]) ? +m[1] : 1, u: m[2] === "minute" || m[2] === "hour" ? "d" : m[2][0], days: (/^\d+$/.test(m[1]) ? +m[1] : 1) * unitDays[m[2]] };
  };
  const ageDays = t => { const p = parseWhen(t); return p ? (p.days == null ? 0 : p.days) : null; };
  const isScroller = el => el && el.scrollHeight > el.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(el).overflowY);
  const scrollerOf = el => { while (el && !isScroller(el)) el = el.parentElement; return el; };
  const fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); };
  const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(400); } return null; };
  const title = () => { const h = document.querySelector('[role="main"] h1, h1'); return h ? h.textContent.trim() : ""; };

  async function openPlace(query) {
    const before = title();
    const box = document.querySelector("#searchboxinput") || document.querySelector('input[name="q"]');
    if (!box) throw new Error("search box not found");
    box.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(box, query);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(300);
    const btn = document.querySelector("#searchbox-searchbutton") || document.querySelector('button[aria-label="Search"]');
    if (btn) btn.click(); else box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
    // wait for a new place page, or a result list to pick from
    const got = await until(() => {
      const t = title();
      const tabs = document.querySelector('button[role="tab"]');
      if (tabs && t && t !== before) return "place";
      const first = document.querySelector('[role="feed"] a[href*="/maps/place/"]');
      if (first) return "list";
      return null;
    }, 15000);
    if (got === "list") {
      document.querySelector('[role="feed"] a[href*="/maps/place/"]').click();
      if (!await until(() => document.querySelector('button[role="tab"]') && title() !== before, 12000)) throw new Error("place page did not open");
    } else if (!got) throw new Error("search gave no place");
    await sleep(1500);
    return title();
  }

  async function scrape(STOP_AFTER, MAX_REVIEWS) {
    const stopDays = ageDays(STOP_AFTER) || 35;
    const google = {};
    const main = document.querySelector('[role="main"]');
    const mtxt = main ? main.innerText : "";
    const mr = mtxt.match(/(\d[.,]\d)\s*\n?[\s★☆]*\(?([\d.,\s]{1,})\)?\s*reviews?/i) || mtxt.match(/(\d[.,]\d)\s*\n?\s*\(([\d.,]+)\)/);
    if (mr) { google.rating = parseFloat(mr[1].replace(",", ".")); google.count = parseInt(mr[2].replace(/[^\d]/g, ""), 10) || null; }
    const tab = [...document.querySelectorAll('button[role="tab"]')].find(b => /review/i.test((b.getAttribute("aria-label") || "") + b.innerText));
    if (!tab) return { error: "no Reviews tab", google, reviews: [] };
    if (tab.getAttribute("aria-selected") !== "true") { tab.click(); await sleep(2500); }
    const sortBtn = await until(() => [...document.querySelectorAll("button")].find(b => /^sort/i.test(((b.getAttribute("aria-label") || "") + " " + (b.innerText || "")).trim()) && b.offsetParent), 8000);
    if (!sortBtn) return { error: "no Sort button (signed out?)", google, reviews: [] };
    sortBtn.click(); await sleep(1500);
    const opt = [...document.querySelectorAll('[role="menuitemradio"],[role="menuitem"],[role="option"]')].find(e => /newest/i.test(e.innerText));
    if (!opt) return { error: "no Newest option", google, reviews: [] };
    opt.click(); await sleep(3000);
    const feed = scrollerOf(sortBtn);
    if (!feed) return { error: "no scrolling list", google, reviews: [] };
    const seen = new Map();
    const read = () => {
      document.querySelectorAll("[data-review-id]").forEach(el => {
        const id = el.getAttribute("data-review-id");
        if (!id || seen.has(id)) return;
        const card = el.closest(".jJc9Ad");
        if (!card) return;
        const starEl = card.querySelector('[role="img"][aria-label*="star" i]');
        if (!starEl) return;
        const whenEl = card.querySelector(".rsqaWe");
        const body = card.querySelector(".wiI7pd");
        seen.set(id, { id, stars: parseFloat(starEl.getAttribute("aria-label")) || null, when: whenEl ? whenEl.textContent.trim() : "", text: body ? body.textContent.trim().slice(0, 1200) : "" });
      });
      return [...seen.values()];
    };
    let last = -1, still = 0, reachedEnd = false, reviews = [];
    for (let i = 0; i < 4000; i++) {
      feed.scrollTop = feed.scrollHeight;
      await sleep(1000 + Math.random() * 500);
      reviews = read();
      const oldest = reviews.length ? ageDays(reviews[reviews.length - 1].when) : 0;
      if (reviews.length >= MAX_REVIEWS || (oldest != null && oldest > stopDays)) break;
      if (reviews.length === last) { if (++still >= 8) { reachedEnd = true; break; } } else { still = 0; last = reviews.length; }
    }
    reviews = read();
    // drop the cards Google keeps for the previous place, if any slipped in
    return { google, reachedEnd, reviews };
  }

  const RC = window.RC = {
    state: { done: 0, total: 0, finished: false, log: [] },
    results: {},
    async runAll(list, stop, max) {
      RC.state = { done: 0, total: list.length, finished: false, log: [], started: Date.now() };
      for (const p of list) {
        RC.state.current = p.id;
        const t0 = Date.now();
        try {
          const name = await openPlace(p.q);
          const r = await scrape(stop, max);
          r.place = name;
          RC.results[p.id] = r;
          RC.state.log.push(`${p.id}: ${r.error || r.reviews.length + " reviews"} (${name}, ${Math.round((Date.now() - t0) / 1000)}s)`);
        } catch (e) {
          RC.results[p.id] = { error: String(e && e.message || e), reviews: [] };
          RC.state.log.push(`${p.id}: ERROR ${e && e.message || e}`);
        }
        RC.state.done++;
        await sleep(1500);
      }
      RC.state.finished = true;
      RC.state.current = null;
    },
    // compact: "hash,stars,when,topics;..."  when = <n><d|w|m|y>, topics only for 3 stars or lower
    pack(id) {
      const r = RC.results[id];
      if (!r) return null;
      const items = r.reviews.map(x => {
        const w = parseWhen(x.when);
        const wc = w ? (w.u === "d" && w.days === 0 ? "0d" : w.q + w.u) : "";
        const t = x.stars != null && x.stars <= 3 ? (topicsOf(x.text) || "x") : "";
        return [fnv(x.id), x.stars == null ? "" : x.stars, wc, t].join(",");
      }).join(";");
      return JSON.stringify({ place: r.place, error: r.error, google: r.google, reachedEnd: r.reachedEnd, items });
    },
    crit(id, max = 40) {
      const r = RC.results[id];
      if (!r) return null;
      return r.reviews.filter(x => x.stars != null && x.stars <= 3 && x.text && (ageDays(x.when) ?? 99) <= 27)
        .slice(0, max).map(x => `[${x.stars}★, ${x.when}] ${x.text.replace(/\s+/g, " ").slice(0, 260)}`);
    }
  };
  return "RC ready";
})()
