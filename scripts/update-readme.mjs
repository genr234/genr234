// Rebuilds the generated parts of README.md from genr234.com and Hackatime.
// Every card is a self-contained SVG (GitHub won't load external resources inside
// SVGs), so photos, icons and fonts are fetched, shrunk with sharp and inlined.
// Runs in CI (.github/workflows/update-readme.yml).
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import sharp from "sharp";

const SITE = process.env.SITE_URL ?? "https://www.genr234.com";
const PROJECTS_URL = process.env.PROJECTS_URL ?? `${SITE}/projects.json`;
const HACKATIME_USER = process.env.HACKATIME_USER ?? "U07JEDAMFV3";
const HACKATIME_URL = `https://hackatime.hackclub.com/api/v1/users/${HACKATIME_USER}/stats`;
const DM_SANS_CSS = "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;650";
const CUTTA_URL = `${SITE}/fonts/cutta-bold.otf`;

// Section headings, each with a pixelarticons icon.
const TAGS = {
	coding: { label: "Coding", icon: "code" },
	hackathons: { label: "Hackathons", icon: "users" },
};
const PIXELARTICONS = "https://unpkg.com/pixelarticons@2.4.2/svg";
const CARD_DIR = "assets/projects";
const ICON_DIR = "assets/icons";
// GitHub's text colors, so the icons sit with the headings in either theme.
const ICON_THEMES = { light: "#1f2328", dark: "#f0f6fc" };

// Colors from the site's Projects window (projects-window.scss).
const C = { bg: "#f9f8f6", navy: "#001666", orange: "#ff5900", grey: "#666666", border: "#e4e2de" };

async function get(url, init) {
	const res = await fetch(url, init);
	if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
	return res;
}
const getJson = async (url) => (await get(url, { headers: { Accept: "application/json" } })).json();
const getBuffer = async (url) => Buffer.from(await (await get(url)).arrayBuffer());
const dataUri = (mime, buf) => `data:${mime};base64,${buf.toString("base64")}`;

const esc = (s) =>
	String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function formatHours(seconds) {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Google only serves woff2 to browsers it recognises.
async function dmSansFont() {
	const css = await (await get(DM_SANS_CSS, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" } })).text();
	const latin = css.split("@font-face").find((block) => block.includes("U+0000-00FF"));
	const url = latin?.match(/url\((https:[^)]+\.woff2)\)/)?.[1];
	if (!url) throw new Error("Could not find the DM Sans latin woff2");
	return dataUri("font/woff2", await getBuffer(url));
}

const photo = async (url) =>
	dataUri(
		"image/jpeg",
		await sharp(await getBuffer(url)).resize(800, 500, { fit: "cover" }).jpeg({ quality: 78, mozjpeg: true }).toBuffer(),
	);

const icon = async (url) =>
	dataUri(
		"image/png",
		await sharp(await getBuffer(url), { density: 300 })
			.resize(48, 48, { fit: "contain", background: "#0000" })
			.png()
			.toBuffer(),
	);

// Rough DM Sans advance widths (in em), good enough to wrap and clamp two lines.
function textWidth(text, size) {
	let em = 0;
	for (const ch of text) {
		if (" ilI.,:;'!|".includes(ch)) em += 0.27;
		else if ("mwMW@".includes(ch)) em += 0.82;
		else if (ch >= "A" && ch <= "Z") em += 0.66;
		else if (ch >= "0" && ch <= "9") em += 0.56;
		else em += 0.53;
	}
	return em * size;
}

// Mirrors the site's `-webkit-line-clamp: 2` on .project-desc.
function clampLines(text, size, maxWidth, maxLines) {
	const lines = [];
	let line = "";
	for (const word of text.split(/\s+/)) {
		const next = line ? `${line} ${word}` : word;
		if (textWidth(next, size) <= maxWidth || !line) line = next;
		else {
			lines.push(line);
			line = word;
		}
	}
	if (line) lines.push(line);
	if (lines.length <= maxLines) return lines;

	let last = lines[maxLines - 1];
	while (textWidth(`${last}…`, size) > maxWidth) last = last.replace(/\s*\S+$/, "");
	return [...lines.slice(0, maxLines - 1), `${last}…`];
}

// Like the site's card carousel: one slide every few seconds with a soft fade.
function carouselCss(count, period) {
	const slot = 100 / count;
	const fade = 4;
	const rules = [];
	for (let k = 0; k < count; k++) {
		const start = k * slot;
		const end = start + slot;
		const frames =
			k === 0
				? `0%,${end - fade}%{opacity:1}${end}%,${100 - fade}%{opacity:0}100%{opacity:1}`
				: `0%,${start - fade}%{opacity:0}${start}%,${end - fade}%{opacity:1}${end}%,100%{opacity:0}`;
		rules.push(`@keyframes s${k}{${frames}}.s${k}{animation:s${k} ${period}s infinite}`);
		rules.push(
			`@keyframes d${k}{0%,${start}%{opacity:.5}${start + 0.01}%,${end}%{opacity:1}${end + 0.01}%,100%{opacity:.5}}.d${k}{animation:d${k} ${period}s infinite}`,
		);
	}
	return rules.join("\n");
}

async function renderCard(project, font) {
	const W = 400;
	const shot = { x: 16, y: 16, w: 368, h: 230 };
	const slides = await Promise.all(project.images.map(photo));
	const iconHref = project.icon ? await icon(project.icon) : null;
	const stack = await Promise.all(
		(project.stack ?? []).map(async (s) => ({ ...s, href: dataUri("image/svg+xml", await getBuffer(s.icon)) })),
	);

	const desc = clampLines(project.description, 14, shot.w, 2);
	const nameY = shot.y + shot.h + 33;
	const descY = nameY + 24;
	// Always reserve two description lines so cards in a row line up.
	const metaY = descY + 20 * 2 + 14;
	const H = metaY + 18;
	const titleX = iconHref ? shot.x + 24 : shot.x;
	const multi = slides.length > 1;

	const slideEls = slides
		.map(
			(href, k) =>
				`<image${multi ? ` class="s${k}"` : ""} href="${href}" x="${shot.x}" y="${shot.y}" width="${shot.w}" height="${shot.h}" preserveAspectRatio="xMidYMid slice"/>`,
		)
		.join("\n");
	const dots = multi
		? slides
				.map((_, k) => {
					const cx = W / 2 + (k - (slides.length - 1) / 2) * 12;
					return `<circle class="d${k}" cx="${cx}" cy="${shot.y + shot.h - 14}" r="3.2" fill="#fff" stroke="${C.navy}" stroke-opacity=".2"/>`;
				})
				.join("")
		: "";
	const stackEls = stack
		.map(
			(s, i) =>
				`<image href="${s.href}" x="${W - 32 - (stack.length - 1 - i) * 22}" y="${metaY - 12}" width="16" height="16"><title>${esc(s.name)}</title></image>`,
		)
		.join("");

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(project.title)}: ${esc(project.description)}">
<defs><clipPath id="shot"><rect x="${shot.x}" y="${shot.y}" width="${shot.w}" height="${shot.h}" rx="16"/></clipPath></defs>
<style>@font-face{font-family:"DM Sans";font-weight:100 1000;src:url(${font}) format("woff2")}
text{font-family:"DM Sans",-apple-system,"Segoe UI",Helvetica,sans-serif}
${multi ? carouselCss(slides.length, slides.length * 3.5) : ""}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}</style>
<rect width="${W}" height="${H}" rx="22" fill="${C.bg}"/>
<g clip-path="url(#shot)"><rect x="${shot.x}" y="${shot.y}" width="${shot.w}" height="${shot.h}" fill="#fff"/>
${slideEls}</g>
${dots}
<rect x="${shot.x + 0.5}" y="${shot.y + 0.5}" width="${shot.w - 1}" height="${shot.h - 1}" rx="15.5" fill="none" stroke="${C.border}"/>
${iconHref ? `<image href="${iconHref}" x="${shot.x}" y="${nameY - 13}" width="16" height="16"/>` : ""}
<text x="${titleX}" y="${nameY}" font-size="17" font-weight="650" fill="${C.navy}">${esc(project.title)}</text>
${desc.map((line, i) => `<text x="${shot.x}" y="${descY + i * 20}" font-size="14" fill="${C.grey}">${esc(line)}</text>`).join("\n")}
<text x="${shot.x}" y="${metaY}" font-size="12" font-weight="650" fill="${C.orange}" letter-spacing=".3">${esc(project.year)}</text>
${stackEls}
</svg>
`;
}

// Images can't inherit text color, so write a light and a dark copy and let <picture> pick.
async function sectionIcon(name) {
	const source = new TextDecoder().decode(await (await get(`${PIXELARTICONS}/${name}.svg`)).arrayBuffer());
	await mkdir(ICON_DIR, { recursive: true });
	for (const [theme, color] of Object.entries(ICON_THEMES)) {
		const svg = source
			.replace(/\s(width|height)="\d+"/g, "")
			.replace('fill="currentColor"', `width="24" height="24" fill="${color}" shape-rendering="crispEdges"`);
		await writeFile(`${ICON_DIR}/${name}-${theme}.svg`, svg);
	}
	return `<picture><source media="(prefers-color-scheme: dark)" srcset="./${ICON_DIR}/${name}-dark.svg"><img src="./${ICON_DIR}/${name}-light.svg" width="24" height="24" align="top" alt=""></picture>`;
}

async function renderProjects(projects, font) {
	await rm(CARD_DIR, { recursive: true, force: true });
	await mkdir(CARD_DIR, { recursive: true });

	const sections = [];
	for (const [tag, { label, icon }] of Object.entries(TAGS)) {
		const items = projects.filter((p) => p.tag === tag);
		if (items.length === 0) continue;

		const links = [];
		for (const project of items) {
			const file = `${CARD_DIR}/${project.id}.svg`;
			await writeFile(file, await renderCard(project, font));
			const href = project.href ?? project.github ?? SITE;
			links.push(`<a href="${esc(href)}"><img src="./${file}" alt="${esc(project.title)}" width="49%"></a>`);
		}
		sections.push(`<h3>${await sectionIcon(icon)} ${label}</h3>\n<p>\n${links.join("\n")}\n</p>`);
	}
	return sections.join("\n");
}

// Purple window like the site's default chrome, headline in the music player's Cutta.
function renderStatsSvg(stats, week, fonts) {
	const W = 495;
	const langs = (stats.languages ?? []).filter((l) => l.name !== "Other").slice(0, 6);
	const langTotal = langs.reduce((sum, l) => sum + l.total_seconds, 0) || 1;
	const streak = stats.streak ? `${stats.streak} day streak` : "";

	let x = 24;
	const bar = langs
		.map((l) => {
			const w = ((W - 48) * l.total_seconds) / langTotal;
			const rect = `<rect x="${x.toFixed(1)}" y="128" width="${Math.max(w - 2, 1).toFixed(1)}" height="8" fill="${esc(l.color)}"/>`;
			x += w;
			return rect;
		})
		.join("");

	const legend = langs
		.map((l, i) => {
			const lx = 24 + (i % 3) * 152;
			const ly = 162 + Math.floor(i / 3) * 22;
			return `<circle cx="${lx + 4}" cy="${ly - 4}" r="4" fill="${esc(l.color)}"/><text x="${lx + 14}" y="${ly}" class="small">${esc(l.name)} <tspan class="dim">${esc(l.text)}</tspan></text>`;
		})
		.join("");

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="220" viewBox="0 0 ${W} 220" role="img" aria-label="Coding stats: ${esc(stats.human_readable_total)} total">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5129a0"/><stop offset="1" stop-color="#5a16b8"/></linearGradient>
<clipPath id="win"><rect width="${W}" height="220" rx="16"/></clipPath>
<clipPath id="bar"><rect x="24" y="128" width="${W - 48}" height="8" rx="4"/></clipPath>
</defs>
<style>@font-face{font-family:"DM Sans";font-weight:100 1000;src:url(${fonts.dmSans}) format("woff2")}
@font-face{font-family:Cutta;src:url(${fonts.cutta}) format("opentype")}
text{font-family:"DM Sans",-apple-system,"Segoe UI",Helvetica,sans-serif;fill:#f3ecff}.small{font-size:12px}.dim{fill:#cdb8f0}.label{font-size:11px;letter-spacing:1.5px;fill:#cdb8f0}.big{font-family:Cutta,"DM Sans",sans-serif;font-size:34px}</style>
<g clip-path="url(#win)">
<rect width="${W}" height="220" fill="url(#bg)"/>
<rect width="${W}" height="38" fill="#5626a1"/>
<text x="24" y="24" class="label">CODING STATS</text>
<text x="${W - 50}" y="25" class="small">—</text><text x="${W - 28}" y="25" class="small">×</text>
<text x="24" y="92" class="big">${esc(formatHours(stats.total_seconds))}</text>
<text x="24" y="112" class="small dim">all time on Hackatime</text>
<text x="${W - 24}" y="92" class="small" text-anchor="end">${esc(formatHours(week.total_seconds))} this week</text>
<text x="${W - 24}" y="112" class="small dim" text-anchor="end">${esc(streak)}</text>
<rect x="24" y="128" width="${W - 48}" height="8" rx="4" fill="#ffffff22"/>
<g clip-path="url(#bar)">${bar}</g>
${legend}
</g>
</svg>
`;
}

function replaceBlock(readme, name, content) {
	const pattern = new RegExp(`(<!-- ${name}:START -->)[\\s\\S]*?(<!-- ${name}:END -->)`);
	if (!pattern.test(readme)) throw new Error(`README.md is missing the ${name} markers`);
	return readme.replace(pattern, `$1\n${content}\n$2`);
}

const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
const [{ projects }, { data: stats }, { data: week }, dmSans, cutta] = await Promise.all([
	getJson(PROJECTS_URL),
	getJson(`${HACKATIME_URL}?features=languages`),
	getJson(`${HACKATIME_URL}?start_date=${weekAgo}`),
	dmSansFont(),
	getBuffer(CUTTA_URL).then((buf) => dataUri("font/otf", buf)),
]);

let readme = await readFile("README.md", "utf8");
readme = replaceBlock(readme, "PROJECTS", await renderProjects(projects, dmSans));
await writeFile("README.md", readme);
await writeFile("assets/coding-stats.svg", renderStatsSvg(stats, week, { dmSans, cutta }));

console.log(`rendered ${projects.length} project cards, ${formatHours(stats.total_seconds)} coded`);
