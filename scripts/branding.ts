// Generates the Warcon logo set into branding/. Text is traced to outlines from Barlow Condensed
// (OFL, see branding/src/OFL.txt) so the SVGs render identically everywhere.
//   bun run scripts/branding.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import opentype from 'opentype.js';

const OUT = 'branding';
const BRASS = '#D4A843';
const INK = '#0F0F12';
const MIST = '#E8E8E8';

const font = opentype.parse(
	readFileSync('branding/src/BarlowCondensed-SemiBold.ttf').buffer.slice(0)
);

// --- mark: a brass plate with two cut corners and a reticle, 64x64 -----------------------------
const PLATE = 'M0 0H48L64 16V64H16L0 48Z';
function reticle(color: string) {
	return `<g fill="none" stroke="${color}" stroke-width="5.5" stroke-linecap="square">
    <circle cx="32" cy="32" r="14.5"/>
    <path d="M32 6.5v9M32 48.5v9M6.5 32h9M48.5 32h9"/>
  </g>
  <circle cx="32" cy="32" r="3.6" fill="${color}"/>`;
}
const markColour = (plate = BRASS, glyph = INK) =>
	`<path d="${PLATE}" fill="${plate}"/>\n  ${reticle(glyph)}`;
/** Single colour: the reticle is punched out of the plate. */
const markMono = (
	color: string,
	id: string
) => `<mask id="${id}"><rect width="64" height="64" fill="#fff"/>${reticle('#000')}</mask>
  <path d="${PLATE}" fill="${color}" mask="url(#${id})"/>`;

const svg = (w: number, h: number, body: string, title: string) =>
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${title}">\n  ${body}\n</svg>\n`;

// --- wordmark ----------------------------------------------------------------------------------
const TEXT = 'WARCON';
const CAP = 40; // cap height in the 64px lockup
const size = (CAP * font.unitsPerEm) / (font.tables.os2.sCapHeight || 700);
// Glyph by glyph: font.getPath() can emit a NaN coordinate for some kerned pairs.
const TRACKING = 0.06 * size;
const scale = size / font.unitsPerEm;
const path = new opentype.Path();
let pen = 0;
const glyphs = font.stringToGlyphs(TEXT);
glyphs.forEach((g, i) => {
	const gp = g.getPath(pen, 0, size);
	path.extend(
		gp.commands.filter(
			(c) => !Object.values(c).some((v) => typeof v === 'number' && Number.isNaN(v))
		)
	);
	pen += (g.advanceWidth ?? 0) * scale + TRACKING;
	if (i < glyphs.length - 1) pen += font.getKerningValue(g, glyphs[i + 1]) * scale;
});
const bb = path.getBoundingBox();
// Own serialiser: opentype's toPathData() emitted a NaN for this font.
const n = (v: number) => (Math.round(v * 100) / 100).toString();
const pathData = path.commands
	.map((c) => {
		switch (c.type) {
			case 'M':
			case 'L':
				return `${c.type}${n(c.x)} ${n(c.y)}`;
			case 'Q':
				return `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`;
			case 'C':
				return `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`;
			default:
				return 'Z';
		}
	})
	.join('');
if (pathData.includes('NaN')) throw new Error('NaN in wordmark path');
const wordW = Math.ceil(bb.x2 - bb.x1);
const wordmarkPath = (color: string, dx: number, dy: number) =>
	`<path transform="translate(${(dx - bb.x1).toFixed(2)} ${dy.toFixed(2)})" fill="${color}" d="${pathData}"/>`;

// --- lockups -----------------------------------------------------------------------------------
const GAP = 18;
const H = 64;
const baseline = (H + CAP) / 2; // caps vertically centred on the mark
function horizontal(mark: string, text: string) {
	const w = 64 + GAP + wordW;
	return svg(w, H, `${mark}\n  ${wordmarkPath(text, 64 + GAP, baseline)}`, 'Warcon');
}
function stacked(mark: string, text: string) {
	const scale = 1.6;
	const markSize = 64 * scale;
	const w = Math.max(markSize, wordW) + 32;
	const h = markSize + 28 + CAP + 32;
	return svg(
		w,
		h,
		`<g transform="translate(${((w - markSize) / 2).toFixed(2)} 16) scale(${scale})">${mark}</g>\n  ${wordmarkPath(text, (w - wordW) / 2, 16 + markSize + 28 + CAP)}`,
		'Warcon'
	);
}

mkdirSync(OUT, { recursive: true });
const files: Record<string, string> = {
	'warcon-mark.svg': svg(64, 64, markColour(), 'Warcon mark'),
	'warcon-mark-mono-black.svg': svg(64, 64, markMono(INK, 'r'), 'Warcon mark'),
	'warcon-mark-mono-white.svg': svg(64, 64, markMono('#FFFFFF', 'r'), 'Warcon mark'),
	'warcon-logo-on-dark.svg': horizontal(markColour(), MIST),
	'warcon-logo-on-light.svg': horizontal(markColour(), INK),
	'warcon-logo-mono-black.svg': horizontal(markMono(INK, 'r'), INK),
	'warcon-logo-mono-white.svg': horizontal(markMono('#FFFFFF', 'r'), '#FFFFFF'),
	'warcon-stacked-on-dark.svg': stacked(markColour(), MIST),
	'warcon-stacked-on-light.svg': stacked(markColour(), INK),
	'warcon-wordmark-on-dark.svg': svg(wordW, CAP + 2, wordmarkPath(MIST, 0, CAP), 'Warcon'),
	'warcon-wordmark-on-light.svg': svg(wordW, CAP + 2, wordmarkPath(INK, 0, CAP), 'Warcon')
};
for (const [name, body] of Object.entries(files)) writeFileSync(`${OUT}/${name}`, body);
// The app favicon is the mark.
writeFileSync('static/favicon.svg', svg(64, 64, markColour(), 'Warcon'));
console.log(
	`wrote ${Object.keys(files).length} files to ${OUT}/ (wordmark ${wordW}px wide at cap ${CAP})`
);
