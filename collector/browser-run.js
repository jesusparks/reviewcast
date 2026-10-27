/*
 * GuestPulse browser collector. Injected ONCE into a signed-in Google Maps tab opened with ?hl=en.
 * It stays alive across parks because it moves between places with the Maps search box
 * instead of reloading the page.
 *
 *   RC.runAll([{id, q}, ...], "5 weeks", 1500)   start; runs in the background
 *   RC.state                                      progress: {current, done, total, finished, log}
 *   RC.packNew(id)                                compact JSON of reviews not sent before, for collector/process.js
 *   RC.pack(id)                                   the same for every review read
 *   RC.crit(id)                                   critical review texts of the last 4 weeks (for the written summary)
 *
 * The weekly job builds the injected text with `node collector/build-browser.js`, which fills
 * the topic lists from collector/process.js so both use the same topic lists.
 */
(() => {
  const THEMES = __THEMES__;
  // Timers in a hidden tab are throttled to about once a minute; a worker-based timer is not.
  const timerWorker = new Worker(URL.createObjectURL(new Blob(["onmessage=e=>setTimeout(()=>postMessage(e.data.id),e.data.ms)"], { type: "text/javascript" })));
  const waiting = new Map(); let tid = 0;
  timerWorker.onmessage = e => { const f = waiting.get(e.data); waiting.delete(e.data); if (f) f(); };
  const sleep = ms => new Promise(r => { const id = ++tid; waiting.set(id, r); timerWorker.postMessage({ id, ms }); });
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
    }, 40000);
    if (got === "list") {
      document.querySelector('[role="feed"] a[href*="/maps/place/"]').click();
      if (!await until(() => document.querySelector('button[role="tab"]') && title() !== before, 30000)) throw new Error("place page did not open");
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
    // Attractions show a "Sort" button; places Google lists as lodging (Tropical Islands, Slagharen) show a "Most relevant" dropdown.
    const sortBtn = await until(() => [...document.querySelectorAll("button")].find(b => b.offsetParent && (/^sort/i.test(((b.getAttribute("aria-label") || "") + " " + (b.innerText || "")).trim()) || /^most relevant$/i.test((b.getAttribute("aria-label") || "").trim()))), 10000);
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
        let stars = null;
        const starEl = card.querySelector('[role="img"][aria-label*="star" i]');
        if (starEl) stars = parseFloat(starEl.getAttribute("aria-label"));
        else { const f = card.querySelector(".fzvQIb"); const m = f && f.textContent.match(/([\d.]+)\s*\/\s*(\d+)/); if (m) stars = Math.round(+m[1] * 5 / +m[2] * 100) / 100; }
        if (stars == null || isNaN(stars)) return;
        const whenEl = card.querySelector(".rsqaWe") || card.querySelector(".xRkPPb");
        const whenRaw = whenEl ? whenEl.textContent.trim() : "";
        if (/ on /.test(whenRaw) && !/ on Google/i.test(whenRaw)) { seen.set(id, null); return; } // lodging pages mix in other travel sites
        const body = card.querySelector(".MyEned .wiI7pd"); // review text only, not the owner reply
        // Keep text only where it is used (3 stars or lower) and drop the card's images: long runs read thousands of cards.
        seen.set(id, { id, stars, when: whenRaw.replace(/ on .*/, ""), text: body && stars <= 3 ? body.textContent.trim().slice(0, 1200) : "" });
        card.querySelectorAll("img").forEach(i => i.remove());
      });
      return [...seen.values()].filter(Boolean);
    };
    let last = -1, still = 0, reachedEnd = false, reviews = [];
    for (let i = 0; i < 30000; i++) {
      feed.scrollTop = feed.scrollHeight;
      await sleep(1000 + Math.random() * 500);
      reviews = read();
      const oldest = reviews.length ? ageDays(reviews[reviews.length - 1].when) : 0;
      if (reviews.length >= MAX_REVIEWS || (oldest != null && oldest > stopDays)) break;
      // Google sometimes stops loading; nudge the list up and down before giving up.
      if (seen.size === last) { still++; if (still % 5 === 0) { feed.scrollTop = Math.max(0, feed.scrollTop - 1500); await sleep(1500); } if (still >= 25) { reachedEnd = true; break; } } else { still = 0; last = seen.size; }
    }
    reviews = read();
    // drop the cards Google keeps for the previous place, if any slipped in
    return { google, reachedEnd, reviews };
  }

  const RC = window.RC = {
    state: { done: 0, total: 0, finished: false, log: [] },
    results: {},
    // opts.save: after each park, hand the browser a JSON file with every review read (for long backfills).
    async runAll(list, stop, max, opts = {}) {
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
          if (opts.save && !r.error) { RC.save(p.id, opts.tag || "backfill"); RC.state.saved = (RC.state.saved || 0) + 1; r.reviews = []; } // saved: free the memory
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
    // Hashes of reviews already sent are kept in this browser profile, so each weekly run only sends new reviews.
    seen(id) { try { return new Set((localStorage.getItem("reviewcast-seen-" + id) || "").split(" ").filter(Boolean)); } catch (e) { return new Set(); } },
    packNew(id) {
      const raw = RC.pack(id); if (!raw) return null;
      const o = JSON.parse(raw); const seen = RC.seen(id); const all = o.items ? o.items.split(";") : [];
      const fresh = all.filter(s => !seen.has(s.split(",")[0]));
      all.forEach(s => seen.add(s.split(",")[0]));
      try { localStorage.setItem("reviewcast-seen-" + id, [...seen].slice(-20000).join(" ")); } catch (e) {}
      o.items = fresh.join(";"); o.read = all.length; o.fresh = fresh.length;
      return JSON.stringify(o);
    },
    save(id, tag) {
      const raw = RC.pack(id); if (!raw) return false;
      const o = JSON.parse(raw); o.id = id; o.collectedAt = new Date().toISOString().slice(0, 10); o.tag = tag;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(o)], { type: "application/json" }));
      a.download = `guestpulse-${tag}-${id}-${o.collectedAt}.json`;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
      return a.download;
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
