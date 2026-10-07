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
 *   station names ("Hot Dish", "The Carvery") live in <h3 class="food_header food-menu_type">,
 *   placed before the dishes they serve
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
  // Each icon names itself in an SVG <title> ("vegan", "made without gluten"). Read only those, so
  // style class names inside the SVG cannot add a flag. Without titles, fall back to the raw block.
  let labels = '';
  for (let at = block.indexOf('<title>'); at !== -1; at = block.indexOf('<title>', at + 7)) {
    const close = block.indexOf('</title>', at);
    if (close === -1) break;
    labels += ' ' + block.substring(at + 7, close);
  }
  const lower = (labels || block).toLowerCase();
  const flags = [];
  // 'gluten' and 'dairy' mean "made without": the page only ever marks their absence.
  for (const key of ['vegetarian', 'vegan', 'halal', 'gluten', 'nuts', 'dairy', 'pork', 'beef', 'seafood']) {
    if (lower.indexOf(key) !== -1) flags.push(key);
  }
  return flags;
}

/**
 * @param {string} html
 * @returns {{outlets: Array<{name: string, dishes: Array<{dish: string, station: string, url: string, diet: string[]}>}>}}
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
    const stationAt = html.indexOf('food-menu_type"', i);

    // pick the earliest marker
    let kind = 0;
    let at = -1;
    for (const [k, pos] of [[1, outletAt], [2, dishAt], [3, dietAt], [4, stationAt]]) {
      if (pos !== -1 && (at === -1 || pos < at)) {
        at = pos;
        kind = k;
      }
    }
    if (at === -1) break;

    const gt = html.indexOf('>', at);
    if (gt === -1) break;

    if (kind === 3) {
      // Diet block: one inline-SVG icon per flag, each in its own <div>, so the block runs to the
      // next dish or heading rather than the first </div> (which would keep only the first icon).
      let stop = len;
      for (const marker of ['class="food_item"', 'class="food_link"', 'class="food_header']) {
        const next = html.indexOf(marker, gt);
        if (next !== -1 && next < stop) stop = next;
      }
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
        current = { name: text, station: '', dishes: [] };
        outlets.push(current);
      }
    } else if (kind === 4) {
      // A station heading ("Hot Dish", "The Carvery") applies to every dish until the next one.
      if (current) current.station = text;
    } else if (text) {
      let url = '';
      const hrefAt = html.lastIndexOf('href="', gt);
      if (hrefAt !== -1) {
        const close = html.indexOf('"', hrefAt + 6);
        if (close !== -1) url = html.substring(hrefAt + 6, close);
      }
      if (!current) {
        // dishes before any outlet heading: keep them under an explicit unknown bucket
        current = { name: 'Unknown outlet', station: '', dishes: [] };
        outlets.push(current);
      }
      const dish = { dish: text, station: current.station, url, diet: [] };
      current.dishes.push(dish);
      current.pendingDish = dish;
    }
    i = lt;
  }

  for (const o of outlets) {
    delete o.pendingDish;
    delete o.station;
  }
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
        // (tombstoning them, or silently moving them to the new date). The station is part of it
        // too: one outlet can serve the same dish name at two stations.
        external_id: `${serviceDate}::${outlet.name}::${d.station ?? ''}::${d.dish}`,
        observed_at: observedAt,
        valid_until: validUntil,
        outlet: outlet.name,
        station: d.station ?? '',
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
