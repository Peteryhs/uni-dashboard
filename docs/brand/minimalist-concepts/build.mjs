import { writeFileSync } from 'node:fs';

// Original geometry. No image generation, external artwork, fonts, or filters in the marks.
const concepts = [
  {
    id: 'next-u', name: 'Next U',
    idea: 'A U with a lifted terminal. A little momentum for what comes next.',
    geometry: '<path d="M20 18h16v42c0 10 6 16 14 16s14-6 14-16V40l16-8v28c0 20-12 32-30 32S20 80 20 60V18Z"/><path d="M64 18h16v6l-16 8V18Z"/>',
  },
  {
    id: 'ring-route', name: 'Ring Route',
    idea: 'One campus loop, with a single point of focus. A nod to Ring Road.',
    geometry: '<path d="M52 20H40c-14 0-24 10-24 24v16c0 14 10 24 24 24h20c14 0 24-10 24-24V48" fill="none" stroke="currentColor" stroke-width="14" stroke-linecap="round"/><circle cx="80" cy="22" r="9"/>',
  },
  {
    id: 'campus-goose', name: 'Campus Goose',
    idea: 'A quiet Waterloo reference. Reduced to one bold silhouette.',
    geometry: '<path d="M12 82c0-17 13-29 32-29h10V28c0-12 8-20 20-20 11 0 18 7 18 17l8 6-22 4v25c0 15-11 26-27 26H12v-4Z"/><path d="M18 66h26c10 0 18-5 18-15" fill="none" stroke="var(--cutout, #fff)" stroke-width="5" stroke-linecap="round"/>',
  },
  {
    id: 'daystack', name: 'Daystack',
    idea: 'Three daily layers form a compact D. A whole day, brought into order.',
    geometry: '<path d="M18 16h44l22 22H18V16ZM18 46h66v16H18V46ZM18 70h66L62 92H18V70Z"/>',
  },
];

const dir = new URL('./', import.meta.url);
const wrap = (body, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
// Goose's wing is an actual transparent cutout, including on arbitrary backgrounds.
concepts[2].geometry = '<path fill-rule="evenodd" d="M12 82c0-17 13-29 32-29h10V28c0-12 8-20 20-20 11 0 18 7 18 17l8 6-22 4v25c0 15-11 26-27 26H12v-4ZM18 63.5v5h26c11.5 0 20.5-6 20.5-17.5h-5c0 8.5-6.5 12.5-15.5 12.5H18Z"/>';

for (const c of concepts) {
  for (const [suffix, color] of [['', '#1d1f23'], ['-white', '#f5f6f7']]) {
    writeFileSync(new URL(`${c.id}${suffix}.svg`, dir), wrap(
      `<title>${c.name} — Uni Dashboard logo</title><g fill="currentColor">${c.geometry}</g>`,
      `viewBox="0 0 100 100" fill="none" color="${color}" role="img"`));
  }
}

const icon = (c, x, y, size, color) => `<g transform="translate(${x} ${y}) scale(${size / 100})" color="${color}" fill="currentColor">${c.geometry}</g>`;
const panels = concepts.map((c, i) => {
  const x = 52 + (i % 2) * 680, y = 170 + Math.floor(i / 2) * 402;
  const dark = i === 1 || i === 2;
  const bg = dark ? '#1d1f23' : '#ffffff', ink = dark ? '#f5f6f7' : '#1d1f23';
  const muted = dark ? '#b4bac2' : '#626973', line = dark ? '#41454c' : '#e6e8eb';
  return `<g transform="translate(${x} ${y})">
    <rect width="656" height="378" rx="4" fill="${bg}"/>
    ${icon(c, 52, 63, 132, ink)}
    <text x="218" y="124" font-size="34" font-weight="600" letter-spacing="-1.2" fill="${ink}">Uni Dashboard</text>
    <text x="220" y="156" font-size="15" fill="${muted}">Your campus day, together.</text>
    <path d="M36 232h584" stroke="${line}"/>
    <text x="36" y="269" font-size="21" font-weight="600" letter-spacing="-.4" fill="${ink}">${c.name}</text>
    <text x="36" y="296" font-size="14" fill="${muted}">${c.idea.split('. ')[0]}.</text>
    <text x="36" y="318" font-size="14" fill="${muted}">${c.idea.split('. ').slice(1).join('. ')}</text>
    <rect x="490" y="260" width="54" height="54" rx="13" fill="${ink}"/>
    ${icon(c, 499, 269, 36, bg)}
    ${icon(c, 565, 275, 24, ink)}
    ${icon(c, 605, 279, 16, ink)}
  </g>`;
}).join('');

const board = wrap(`<title>Uni Dashboard — four minimalist vector logo concepts</title>
<rect width="1440" height="1030" fill="#e8eaed"/>
<g font-family="Inter, Segoe UI, Arial, sans-serif">
<text x="52" y="78" font-size="43" font-weight="600" letter-spacing="-1.8" fill="#1d1f23">Uni Dashboard</text>
<text x="53" y="115" font-size="18" fill="#626973">Four minimal directions for a Waterloo campus companion.</text>
<text x="1388" y="81" text-anchor="end" font-size="15" fill="#626973">Vector logo studies</text>
${panels}
<text x="52" y="1003" font-size="13" fill="#626973">Original SVG geometry. Transparent marks. One colour. Shown at 132, 36, 24 and 16 px.</text>
</g>`, 'width="1440" height="1030" viewBox="0 0 1440 1030"');
writeFileSync(new URL('overview.svg', dir), board);

writeFileSync(new URL('preview.html', dir), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Uni Dashboard — logo concepts</title><style>@font-face{font-family:Inter;src:url('../../../apps/web/node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2')}@font-face{font-family:Inter;font-weight:600;src:url('../../../apps/web/node_modules/@fontsource/inter/files/inter-latin-600-normal.woff2')}*{box-sizing:border-box}body{margin:0;background:#e8eaed;font-family:Inter,'Segoe UI',sans-serif}svg{width:100%;height:auto;display:block}a{color:inherit}footer{padding:20px 4%;font-size:14px;line-height:2}footer a{margin-right:24px}</style>${board}<footer>Download SVGs: ${concepts.map(c => `<a href="${c.id}.svg" download>${c.name}</a>`).join('')}</footer></html>`);

writeFileSync(new URL('README.md', dir), `# Uni Dashboard logo studies\n\nFour original vector directions based on the project's daily student dashboard, Waterloo setting, and existing neutral palette. These are proposals; the app icons have not been changed.\n\n- **Next U** — a U monogram with a detached, angled upper terminal, suggesting the next item in the day. Recommended for its simplicity and connection to the existing U icon.\n- **Ring Route** — an open campus loop and focus point, referencing Waterloo's Ring Road.\n- **Campus Goose** — a single silhouette with a transparent wing cutout, a Waterloo reference.\n- **Daystack** — three horizontal layers forming a compact D, representing the app's connected sources.\n\nOpen preview.html for the comparison and download links, or overview.svg for the vector presentation. Each standalone SVG has a transparent background, a square 100-unit viewBox, and no font or external asset dependencies. The default files are charcoal; files ending in -white are for dark backgrounds. Change the root color attribute to recolour a mark. The overview uses live text with a system font fallback; the marks themselves are entirely vector geometry.\n\nThe comparison includes 16 and 24 px specimens. For a production favicon, Next U and Ring Route retain the clearest silhouettes; the goose wing and Daystack gaps are finer at 16 px. Preview PNGs are raster exports for review only.\n\nRebuild SVG assets with node docs/brand/minimalist-concepts/build.mjs.\n`);
