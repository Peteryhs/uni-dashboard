/**
 * Food menu parser. Marker scanner only: indexOf + slice, no DOM, no regex on the hot path.
 *
 * Why this shape: Cloudflare Workers Free allows 10 ms of CPU per invocation. Measured on the
 * real 289 KB page (docs/MEASUREMENTS.md): this parser 0.468 ms, cheerio/parse5 30.2 ms. A DOM
 * parser here converts a $0 deployment into a $5/month one, so the import graph of this module
 * must stay dependency-free. test/food-parser.test.mjs enforces that.
 *
 * Page structure it reads (verified 2026-09-21):
 *   <div class="food_item">
 *     <div class="food_title"><a class="food_link" href="/food-services/daily-menu/<slug>">Dish</a></div>
 *     <div class="food_diet"> ...inline svg icons... </div>
 *   </div>
 *   outlet names live in class="food_header_title"
 */

const ENTITIES = {
  '&amp;': '&',
  '&#039;': "'",
  '&#39;': "'",
  '&quot;': '"',
  '&nbsp;': ' ',
  '&lt;': '<',
  '&gt;': '>',
  '&rsquo;': '\u2019',
  '&lsquo;': '\u2018',
  '&eacute;': '\u00e9',
  '&amp;amp;': '&',
};

export function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(?:amp|#0?39|quot|nbsp|lt|gt|rsquo|lsquo|eacute);/g, (m) => ENTITIES[m] ?? m);
}

function clean(s) {
  let out = '';
  let prevSpace = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 60) {
      // '<' inside the captured text: skip any nested tag
      const gt = s.indexOf('>', i);
      i = gt === -1 ? s.length : gt;
      continue;
    }
    const isSpace = c === 32 || c === 10 || c === 9 || c === 13;
    if (isSpace) {
      if (!prevSpace) {
        out += ' ';
        prevSpace = true;
      }
    } else {
      out += s[i];
      prevSpace = false;
    }
  }
  return decodeEntities(out.trim());
}

/**
 * Diet/allergen hints. The icons are inline SVG, so the honest read is the icon class names and
 * any text labels in the block; we return lowercase keywords and never invent nutrition data
 * (none exists). Unknown icon sets degrade to an empty list, not a crash.
 */
function dietFlags(block) {
  const flags = [];
  const lower = block.toLowerCase();
  for (const key of ['vegetarian', 'vegan', 'halal', 'gluten', 'nuts', 'dairy', 'pork', 'beef', 'seafood']) {
    if (lower.indexOf(key) !== -1) flags.push(key);
  }
  return flags;
}

/**
 * @param {string} html
 * @returns {{outlets: Array<{name: string, dishes: Array<{dish: string, url: string, diet: string[]}>}>}}
 */
export function parseFoodPage(html) {
  const outlets = [];
  let current = null;
  let i = 0;
  const len = html.length;

  while (i < len) {
    const outletAt = html.indexOf('class="food_header_title"', i);
    const dishAt = html.indexOf('class="food_link"', i);
    const dietAt = html.indexOf('class="food_diet"', i);

    // pick the earliest marker
    let kind = 0;
    let at = -1;
    for (const [k, pos] of [[1, outletAt], [2, dishAt], [3, dietAt]]) {
      if (pos !== -1 && (at === -1 || pos < at)) {
        at = pos;
        kind = k;
      }
    }
    if (at === -1) break;

    const gt = html.indexOf('>', at);
    if (gt === -1) break;

    if (kind === 3) {
      // diet block: read a bounded window, then jump past the inline SVG
      const end = html.indexOf('</div>', gt);
      const stop = end === -1 ? Math.min(len, gt + 2000) : end;
      const block = html.substring(gt + 1, stop);
      if (current && current.pendingDish) {
        current.pendingDish.diet = dietFlags(block);
        current.pendingDish = null;
      }
      i = stop;
      continue;
    }

    const lt = html.indexOf('<', gt + 1);
    if (lt === -1) break;
    const text = clean(html.substring(gt + 1, lt));

    if (kind === 1) {
      if (text) {
        current = { name: text, dishes: [] };
        outlets.push(current);
      }
    } else if (text) {
      let url = '';
      const hrefAt = html.lastIndexOf('href="', gt);
      if (hrefAt !== -1) {
        const close = html.indexOf('"', hrefAt + 6);
        if (close !== -1) url = html.substring(hrefAt + 6, close);
      }
      if (!current) {
        // dishes before any outlet heading: keep them under an explicit unknown bucket
        current = { name: 'Unknown outlet', dishes: [] };
        outlets.push(current);
      }
      const dish = { dish: text, url, diet: [] };
      current.dishes.push(dish);
      current.pendingDish = dish;
    }
    i = lt;
  }

  for (const o of outlets) delete o.pendingDish;
  return { outlets };
}

/** Flatten to canonical menu_item rows. `serviceDate` is YYYY-MM-DD in the feed's own zone. */
export function toMenuItems(parsed, { sourceId, serviceDate, observedAt, validUntil, baseUrl }) {
  const rows = [];
  for (const outlet of parsed.outlets) {
    for (const d of outlet.dishes) {
      rows.push({
        source_id: sourceId,
        // The service date is part of the identity: the same dish appears on many days, and
        // without the date a poll for one day rewrites the other day's rows under the same key
        // (tombstoning them, or silently moving them to the new date).
        external_id: `${serviceDate}::${outlet.name}::${d.dish}`,
        observed_at: observedAt,
        valid_until: validUntil,
        outlet: outlet.name,
        station: '',
        dish: d.dish,
        service_date: serviceDate,
        diet: d.diet ?? [],
        allergens: [],
        url: d.url ? new URL(d.url, baseUrl).toString() : '',
      });
    }
  }
  return rows;
}
