// Fair-benchmark v2: real structure of the UW food page.
// Page markup (verified): <div class="food_item"><div class="food_title"><a class="food_link" href="...">Yakisoba</a></div><div class="food_diet">...inline svg...</div></div>
// Outlet names live in class="food_header_title". The page is 289 KB mostly because of inline SVG icons.
import fs from 'node:fs';

const file = process.argv[2] ?? 'fixtures/food-2026-09-21.html';
const html = fs.readFileSync(file, 'utf8');
const ITER = Number(process.argv[3] || 500);

const ENT = { '&amp;': '&', '&#039;': "'", '&#39;': "'", '&quot;': '"', '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&eacute;': 'e' };
function unent(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&[a-zA-Z#0-9]{2,8};/g, (m) => ENT[m] ?? m);
}

// Cheap parser: marker scan + slice. No DOM, no regex on the hot path.
function scan(html) {
  const dishes = [], outlets = [], diets = [];
  const len = html.length;
  let i = 0;
  while (i < len) {
    const a = html.indexOf('class="food_link"', i);
    const b = html.indexOf('class="food_header_title"', i);
    const d = html.indexOf('class="food_diet"', i);
    let next = -1, kind = 0;
    if (a !== -1 && (next === -1 || a < next)) { next = a; kind = 1; }
    if (b !== -1 && (next === -1 || b < next)) { next = b; kind = 2; }
    if (d !== -1 && (next === -1 || d < next)) { next = d; kind = 3; }
    if (next === -1) break;
    const gt = html.indexOf('>', next);
    if (gt === -1) break;
    if (kind === 3) {
      // diet block: grab just enough to count icon hints, skip the inline svg
      const end = html.indexOf('</div>', gt);
      const block = html.substring(gt + 1, end === -1 ? gt + 400 : end);
      const n = (block.match(/uw-icon|diet|vegetarian|vegan|halal|gluten/gi) || []).length;
      diets.push(n);
      i = end === -1 ? gt + 1 : end;
    } else {
      const lt = html.indexOf('<', gt + 1);
      if (lt === -1) break;
      const text = unent(html.substring(gt + 1, lt));
      if (kind === 1) dishes.push(text); else outlets.push(text);
      i = lt;
    }
  }
  return { dishes, outlets, diets };
}

const check = scan(html);
console.log(`marker scan found: ${check.dishes.length} dishes, ${check.outlets.length} outlets, ${check.diets.length} diet blocks`);
console.log(`sample dishes: ${JSON.stringify(check.dishes.slice(0, 4))}`);
console.log(`sample outlets: ${JSON.stringify(check.outlets.slice(0, 4))}`);

function bench(label, fn, iterations) {
  for (let k = 0; k < 30; k++) fn();          // warmup
  const cpu0 = process.cpuUsage();
  const w0 = process.hrtime.bigint();
  for (let k = 0; k < iterations; k++) fn();
  const w1 = process.hrtime.bigint();
  const cpu1 = process.cpuUsage(cpu0);
  const cpuMsPerRun = (cpu1.user + cpu1.system) / 1000 / iterations;
  const wallMsPerRun = Number(w1 - w0) / 1e6 / iterations;
  console.log(`${label.padEnd(24)} CPU ${cpuMsPerRun.toFixed(4)} ms/run   wall ${wallMsPerRun.toFixed(4)} ms/run   (${iterations} runs)`);
  return cpuMsPerRun;
}

console.log('');
const cheap = bench('cheap marker scan', () => scan(html), ITER);

try {
  const { load } = await import('cheerio');
  const dom = bench('cheerio DOM parse', () => {
    const $ = load(html);
    const dishes = $('a.food_link').map((_, el) => $(el).text()).get();
    const outlets = $('.food_header_title').map((_, el) => $(el).text()).get();
    return dishes.length + outlets.length;
  }, 30);
  console.log('');
  console.log(`DOM is ${(dom / cheap).toFixed(1)}x the CPU of the marker scan`);
} catch {
  console.log('cheerio not installed, DOM comparison skipped');
}
