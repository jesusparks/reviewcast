/*
 * ReviewCast: runs inside a Google Maps place page (signed-in browser, ?hl=en).
 * Opens the Reviews tab, sorts by newest, scrolls until reviews are older than STOP_AFTER
 * or MAX_REVIEWS is reached, and returns { google, reachedEnd, reviews[] } for process.js.
 *
 * The weekly run pastes this into the browser's JavaScript tool and calls it, e.g.
 *   await (<this file>)("5 weeks", 1500)     normal week
 *   await (<this file>)("13 months", 6000)   first backfill
 * Google changes its markup from time to time; the selectors lean on stable attributes
 * (data-review-id, role, aria-label) and fall back to known class names.
 * Tested against Google Maps markup on 27 Oct 2026.
 */
(async (STOP_AFTER = "5 weeks", MAX_REVIEWS = 1500) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const unitDays = { day: 1, week: 7, month: 30, year: 365 };
  const ageDays = t => {
    const s = String(t || "").toLowerCase();
    const m = s.match(/(\d+|an?|one)\s+(minute|hour|day|week|month|year)s?/);
    if (!m) return /now|minute|hour/.test(s) ? 0 : null;
    return (/^\d+$/.test(m[1]) ? +m[1] : 1) * (unitDays[m[2]] || 0);
  };
  const stopDays = ageDays(STOP_AFTER) || 35;
  const isScroller = el => el && el.scrollHeight > el.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(el).overflowY);
  const scrollerOf = el => { while (el && !isScroller(el)) el = el.parentElement; return el; };

  // overall rating and count
  const google = {};
  const main = document.querySelector('[role="main"]');
  const mtxt = main ? main.innerText : "";
  const mr = mtxt.match(/(\d[.,]\d)\s*\n?[\s★☆]*\(?([\d.,\s]{2,})\)?\s*reviews/i) || mtxt.match(/(\d[.,]\d)\s*\n?\s*\(([\d.,]+)\)/);
  if (mr) { google.rating = parseFloat(mr[1].replace(",", ".")); google.count = parseInt(mr[2].replace(/[^\d]/g, ""), 10) || null; }

  // reviews tab
  const tab = [...document.querySelectorAll('button[role="tab"]')].find(b => /review/i.test((b.getAttribute("aria-label") || "") + b.innerText));
  if (!tab) return { error: "No Reviews tab on this page.", google };
  if (tab.getAttribute("aria-selected") !== "true") { tab.click(); await sleep(2500); }

  // sort by newest
  const sortBtn = [...document.querySelectorAll("button")].find(b => /^sort/i.test(((b.getAttribute("aria-label") || "") + " " + (b.innerText || "")).trim()) && b.offsetParent);
  let sorted = false;
  if (sortBtn) {
    sortBtn.click(); await sleep(1500);
    const opt = [...document.querySelectorAll('[role="menuitemradio"],[role="menuitem"],[role="option"]')].find(e => /newest/i.test(e.innerText));
    if (opt) { opt.click(); sorted = true; await sleep(3000); }
  }
  if (!sorted) return { error: "Could not sort by newest (signed out, or Google changed the page).", google };

  const feed = scrollerOf(sortBtn);
  if (!feed) return { error: "Could not find the scrolling review list.", google };

  const cardOf = el => { let c = el; for (let i = 0; i < 8 && c; i++) { if (c.querySelector('[role="img"][aria-label*="star" i]') && c.querySelector(".d4r55, [class*='fontTitle']")) return c; c = c.parentElement; } return null; };
  const read = () => {
    const out = new Map();
    document.querySelectorAll("[data-review-id]").forEach(el => {
      const id = el.getAttribute("data-review-id");
      if (!id || out.has(id)) return;
      const card = el.closest(".jJc9Ad") || cardOf(el);
      if (!card) return;
      const starEl = card.querySelector('[role="img"][aria-label*="star" i]');
      if (!starEl) return;
      const stars = parseFloat(starEl.getAttribute("aria-label"));
      const whenEl = card.querySelector(".rsqaWe") || [...card.querySelectorAll("span")].find(s => /\bago\b/i.test(s.textContent) && s.textContent.length < 40);
      const more = [...card.querySelectorAll("button")].find(b => /^(more|see more)$/i.test((b.innerText || b.getAttribute("aria-label") || "").trim()));
      if (more) more.click();
      const body = card.querySelector(".wiI7pd");
      out.set(id, { id, stars: isNaN(stars) ? null : stars, when: whenEl ? whenEl.textContent.trim() : "", text: body ? body.textContent.trim().slice(0, 1500) : "" });
    });
    return [...out.values()];
  };

  let last = -1, still = 0, reachedEnd = false, reviews = [];
  for (let i = 0; i < 2000; i++) {
    feed.scrollTop = feed.scrollHeight;
    await sleep(1100 + Math.random() * 600);
    reviews = read();
    const oldest = reviews.length ? ageDays(reviews[reviews.length - 1].when) : 0;
    if (reviews.length >= MAX_REVIEWS || (oldest != null && oldest > stopDays)) break;
    if (reviews.length === last) { if (++still >= 6) { reachedEnd = true; break; } } else { still = 0; last = reviews.length; }
  }
  await sleep(600);
  reviews = read();
  return { google, reachedEnd, count: reviews.length, oldest: reviews.length ? reviews[reviews.length - 1].when : null, reviews };
})
