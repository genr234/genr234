// Renders the static README pieces that mimic genr234.com:
//   assets/hello.svg            the "hello i'm genr234" WordArt, redone in the site's fonts
//   assets/site-link.svg        a small preview of the site linking to it
//   assets/projects-header.svg  the Projects window's title bar
// Text is converted to outlines so it can be measured and centred exactly.
// Only needs re-running when the design changes: `npm run banners`.
import { readFile, writeFile } from "node:fs/promises";
import opentype from "opentype.js";
import sharp from "sharp";

const SITE = process.env.SITE_URL ?? "https://www.genr234.com";
const PIXELARTICONS = "https://unpkg.com/pixelarticons@2.4.2/svg";
// Without a browser User-Agent, Google Fonts serves static TTFs that opentype.js can read.
const DM_SANS_CSS = "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600";

async function fetchBuffer(url) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url} -> ${res.status}`);
	return res.arrayBuffer();
}
const fetchText = async (url) => new TextDecoder().decode(await fetchBuffer(url));
const fetchFont = async (url) => opentype.parse(await fetchBuffer(url));

async function dmSans() {
	const css = await fetchText(DM_SANS_CSS);
	const weights = {};
	for (const block of css.split("@font-face").slice(1)) {
		const weight = block.match(/font-weight:\s*(\d+)/)?.[1];
		const url = block.match(/url\((https:[^)]+\.ttf)\)/)?.[1];
		if (weight && url) weights[weight] = await fetchFont(url);
	}
	if (!weights[400] || !weights[600]) throw new Error("Could not load DM Sans 400/600");
	return weights;
}

// The site's animated Nyan Cat (music player seek bar), recovered at its native pixel size.
// The GIF is the 35px-wide sprite upscaled by ~14.29 with each frame resampled separately,
// so its cell edges wobble by a pixel or two. A plain resize drops rows and columns; instead
// lay a fixed grid over it (aligned to frame 0's first edges) and sample each cell's centre.
const NYAN_COLUMNS = 35;

async function nyanCat() {
	const gif = Buffer.from(await fetchBuffer(`${SITE}/nyanimated.gif`));
	const { pages } = await sharp(gif, { animated: true }).metadata();
	const raws = await Promise.all(
		Array.from({ length: pages }, (_, page) =>
			sharp(gif, { page }).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
		),
	);
	const { width: W, height: H } = raws[0].info;
	const pitch = W / NYAN_COLUMNS;

	const first = raws[0].data;
	const px = (x, y) => first.readUInt32LE((y * W + x) * 4);
	let firstX = W;
	let firstY = H;
	for (let y = 0; y < H; y++)
		for (let x = 1; x < W; x++) {
			if (px(x, y) !== px(x - 1, y)) firstX = Math.min(firstX, x);
			if (y > 0 && px(x, y) !== px(x, y - 1)) firstY = Math.min(firstY, y);
		}
	const centres = (firstEdge, size) => {
		const offset = firstEdge % pitch;
		const out = [];
		for (let c = offset - pitch / 2; c < size; c += pitch) if (c >= 0) out.push(Math.floor(c));
		return out;
	};
	const cols = centres(firstX, W);
	const rows = centres(firstY, H);

	const frames = await Promise.all(
		raws.map(async ({ data }) => {
			const out = Buffer.alloc(cols.length * rows.length * 4);
			rows.forEach((y, r) =>
				cols.forEach((x, c) => data.copy(out, (r * cols.length + c) * 4, (y * W + x) * 4, (y * W + x) * 4 + 4)),
			);
			const png = await sharp(out, { raw: { width: cols.length, height: rows.length, channels: 4 } }).png().toBuffer();
			return `data:image/png;base64,${png.toString("base64")}`;
		}),
	);
	return { frames, width: cols.length, height: rows.length };
}

async function pixelIcon(name) {
	const svg = await fetchText(`${PIXELARTICONS}/${name}.svg`);
	return [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]).join("");
}

const [gentle, jack, sans, background, externalLink, folder, nyanFrames] = await Promise.all([
	fetchFont(`${SITE}/fonts/gentle.otf`),
	fetchFont(`${SITE}/fonts/jack.ttf`),
	dmSans(),
	readFile("assets/site-background.jpg"),
	pixelIcon("external-link"),
	pixelIcon("folder"),
	nyanCat(),
]);

// Text as a path, positioned by its left edge with its cap height centred on centerY.
// Outlines are drawn at the origin and moved with a transform.
function textPath(font, text, size, x, centerY) {
	const capHeight = (font.tables.os2.sCapHeight / font.unitsPerEm) * size;
	const d = font.getPath(text, 0, 0, size).toPathData(2);
	if (d.includes("NaN")) throw new Error(`Bad outline for "${text}"`);
	return {
		el: (attrs) => `<path transform="translate(${x.toFixed(2)} ${(centerY + capHeight / 2).toFixed(2)})" d="${d}" ${attrs}/>`,
		width: font.getAdvanceWidth(text, size),
	};
}
const measure = (font, text, size) => font.getAdvanceWidth(text, size);
const icon = (paths, x, y, fill) =>
	`<path transform="translate(${Math.round(x)} ${Math.round(y)})" d="${paths}" fill="${fill}" shape-rendering="crispEdges"/>`;

const W = 840;

function siteLink() {
	const H = 180;
	const PAD = 28;
	const HEADER_Y = 36;

	const name = textPath(jack, "GENR234", 19, PAD, HEADER_Y);

	const navSize = 17;
	const navGap = 26;
	const navItems = ["About", "Projects", "Contact"];
	const navWidth =
		navItems.reduce((sum, item) => sum + measure(gentle, item, navSize), 0) + navGap * (navItems.length - 1);
	let navX = W - PAD - navWidth;
	const nav = navItems.map((item) => {
		const p = textPath(gentle, item, navSize, navX, HEADER_Y);
		navX += p.width + navGap;
		return p;
	});

	// Button: [padding][label][gap][24px pixel icon][padding], centred in the space below the header.
	const ctaSize = 24;
	const ICON = 24;
	const GAP = 14;
	const BTN_PAD = 26;
	const label = "Check out my personal website!";
	const labelWidth = measure(gentle, label, ctaSize);
	const btn = { w: Math.round(BTN_PAD + labelWidth + GAP + ICON + BTN_PAD), h: 60 };
	btn.x = Math.round((W - btn.w) / 2);
	btn.y = Math.round(HEADER_Y + (H - HEADER_Y - btn.h) / 2 + 6);
	const centerY = btn.y + btn.h / 2;
	const cta = textPath(gentle, label, ctaSize, btn.x + BTN_PAD, centerY);

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Check out my personal website! genr234.com">
<defs>
<clipPath id="frame"><rect width="${W}" height="${H}" rx="22"/></clipPath>
<filter id="soften"><feGaussianBlur stdDeviation="0.8"/></filter>
<filter id="lift" x="-20%" y="-50%" width="140%" height="220%"><feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#0b0f05" flood-opacity=".5"/></filter>
<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b0f05" stop-opacity=".5"/><stop offset=".4" stop-color="#0b0f05" stop-opacity=".1"/><stop offset="1" stop-color="#0b0f05" stop-opacity=".2"/></linearGradient>
<linearGradient id="window" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5129a0"/><stop offset="1" stop-color="#5a16b8"/></linearGradient>
</defs>
<g clip-path="url(#frame)">
<image href="data:image/jpeg;base64,${background.toString("base64")}" x="-4" y="-4" width="${W + 8}" height="${H + 8}" preserveAspectRatio="xMidYMid slice" filter="url(#soften)"/>
<rect width="${W}" height="${H}" fill="url(#fade)"/>
${name.el('fill="#fff" fill-opacity=".7"')}
${nav.map((p) => p.el('fill="#efe9cf"')).join("")}
<g filter="url(#lift)"><rect x="${btn.x}" y="${btn.y}" width="${btn.w}" height="${btn.h}" rx="16" fill="url(#window)"/></g>
<rect x="${btn.x + 0.5}" y="${btn.y + 0.5}" width="${btn.w - 1}" height="${btn.h - 1}" rx="15.5" fill="none" stroke="#fff" stroke-opacity=".16"/>
${cta.el('fill="#f6f0dc"')}
${icon(externalLink, btn.x + BTN_PAD + labelWidth + GAP, centerY - ICON / 2, "#f6f0dc")}
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="21.5" fill="none" stroke="#fff" stroke-opacity=".08"/>
</g>
</svg>
`;
}

// The Projects window's title bar (windowConfigs: #F9F8F6 header, #001666 text).
function projectsHeader() {
	const H = 64;
	const PAD = 22;
	const NAVY = "#001666";
	const GREY = "#666666";
	const cy = H / 2;

	const title = textPath(sans[600], "Projects", 18, PAD + 24 + 12, cy);
	const subtitle = textPath(sans[400], "some projects i've been working on", 15, PAD + 24 + 12 + title.width + 12, cy);

	// Window controls, as on the site: two 24px buttons, 8px apart.
	const BTN = 24;
	const closeX = W - PAD - BTN;
	const minX = closeX - 8 - BTN;
	const glyph = (char, boxX) => {
		const width = measure(sans[400], char, 18);
		return textPath(sans[400], char, 18, boxX + (BTN - width) / 2, cy).el(`fill="${NAVY}"`);
	};

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Projects: some projects i've been working on">
<rect width="${W}" height="${H}" rx="22" fill="#f9f8f6"/>
${icon(folder, PAD, cy - 12, NAVY)}
${title.el(`fill="${NAVY}"`)}
${subtitle.el(`fill="${GREY}"`)}
${glyph("–", minX)}
${glyph("×", closeX)}
</svg>
`;
}

// A nod to the old WordArt header: rainbow "hello i'm" with its slanted shadow, and the
// site's Nyan Cat flying after it, over a flat "GENR234" in the logo font.
function hello({ face = "#f6f0dc", shadow = "#5626a1" } = {}) {
	const W = 640;
	const H = 210;

	const word = "GENR234";
	const wordSize = Math.floor(540 / measure(jack, word, 1));
	const wordWidth = measure(jack, word, wordSize);
	const wordPath = jack.getPath(word, 0, 0, wordSize).toPathData(2);
	const left = (W - wordWidth) / 2;
	const right = left + wordWidth;
	const wordAt = `translate(${left.toFixed(2)} 176)`;

	const greetSize = 56;
	const greetBaseline = 82;
	const greetWidth = measure(gentle, "hello i'm", greetSize);
	const greetPath = gentle.getPath("hello i'm", 0, 0, greetSize).toPathData(2);
	const greetBox = gentle.getPath("hello i'm", 0, 0, greetSize).getBoundingBox();
	const mid = greetBaseline + (greetBox.y1 + greetBox.y2) / 2;

	// Same proportions as the site's seek bar: cat and rainbow share one pixel grid.
	const PX = 2;
	const cat = { w: nyanFrames.width * PX, h: nyanFrames.height * PX };
	cat.x = right - cat.w;
	cat.y = Math.round(mid - cat.h / 2);
	// The slanted shadow reaches past the text; find its right edge by running the glyph
	// outline through the same translate/skew/squash.
	const SHADOW = { dx: 14, skew: 52, squash: 0.42 };
	const slant = Math.tan((SHADOW.skew * Math.PI) / 180) * SHADOW.squash;
	const shadowRight = Math.max(
		...gentle
			.getPath("hello i'm", 0, 0, greetSize)
			.commands.flatMap((c) => [[c.x, c.y], [c.x1, c.y1], [c.x2, c.y2]])
			.filter(([x, y]) => x !== undefined && y !== undefined)
			.map(([x, y]) => x + SHADOW.dx - slant * y),
	);
	const trail = { x: Math.round(left + shadowRight + 12), y: Math.round(mid - (19 * PX) / 2) };
	trail.w = Math.round(cat.x + cat.w * 0.35 - trail.x);

	// Two 8px columns of six 3px stripes, the second dropped by a pixel, like the site's tile.
	const STRIPES = ["#ff0000", "#ff9900", "#ffff00", "#33ff00", "#0099ff", "#6633ff"];
	const columns = Math.ceil(trail.w / (8 * PX)) + 2;
	const rainbow = Array.from({ length: columns }, (_, col) =>
		STRIPES.map(
			(color, i) =>
				`<rect x="${trail.x + col * 8 * PX}" y="${trail.y + (i * 3 + (col % 2)) * PX}" width="${8 * PX}" height="${3 * PX}" fill="${color}"/>`,
		).join(""),
	).join("");

	const frames = nyanFrames.frames
		.map(
			(href, i) =>
				`<image class="cat" style="animation-delay:${(i * 0.07).toFixed(2)}s" href="${href}" x="${cat.x}" y="${cat.y}" width="${cat.w}" height="${cat.h}"/>`,
		)
		.join("\n");
	const period = (nyanFrames.frames.length * 0.07).toFixed(2);

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="hello i'm genr234">
<defs>
<linearGradient id="greet" gradientUnits="userSpaceOnUse" x1="${greetBox.x1}" y1="0" x2="${greetBox.x2}" y2="0">
<stop offset="0" stop-color="#ff3b6b"/><stop offset=".22" stop-color="#ff8a3d"/><stop offset=".42" stop-color="#ffd23f"/><stop offset=".6" stop-color="#3ccf73"/><stop offset=".8" stop-color="#3a8dff"/><stop offset="1" stop-color="#8b5cf6"/>
</linearGradient>
<clipPath id="trail"><rect x="${trail.x}" y="${trail.y - PX}" width="${trail.w}" height="${(19 + 2) * PX}"/></clipPath>
</defs>
<style>
image{image-rendering:pixelated;image-rendering:crisp-edges}
.wave{animation:wave .36s steps(2) infinite}
@keyframes wave{to{transform:translateX(-${16 * PX}px)}}
.cat{opacity:0;animation:cat ${period}s steps(1,end) infinite}
@keyframes cat{0%{opacity:1}${(100 / nyanFrames.frames.length).toFixed(3)}%,100%{opacity:0}}
@media (prefers-reduced-motion:reduce){.wave,.cat{animation:none}.cat:first-of-type{opacity:1}}
</style>
<path transform="${wordAt} translate(6 6)" d="${wordPath}" fill="${shadow}"/>
<path transform="${wordAt}" d="${wordPath}" fill="${face}" stroke="${shadow}" stroke-width="1.5" stroke-linejoin="round"/>
<g transform="translate(${left.toFixed(2)} ${greetBaseline})">
<path transform="translate(${SHADOW.dx} 0) skewX(-${SHADOW.skew}) scale(1 ${SHADOW.squash})" d="${greetPath}" fill="#8b949e" fill-opacity=".32"/>
<path d="${greetPath}" fill="url(#greet)"/>
</g>
<g clip-path="url(#trail)"><g class="wave" shape-rendering="crispEdges">${rainbow}</g></g>
${frames}
</svg>
`;
}

for (const [file, svg] of [
	["assets/hello.svg", hello()],
	["assets/site-link.svg", siteLink()],
	["assets/projects-header.svg", projectsHeader()],
]) {
	await writeFile(file, svg);
	console.log(`wrote ${file} (${Math.round(svg.length / 1024)}KB)`);
}
