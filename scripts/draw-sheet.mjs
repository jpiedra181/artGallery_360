/**
 * Print a drawn world to a picture, for the stills and the making-of page.
 * The site draws it live; this is the same drawing (src/scripts/worlds/).
 *
 *   node scripts/draw-sheet.mjs wave [t ...]     t: moment of the cycle, 0 to 1
 *   node scripts/draw-sheet.mjs rain [t ...]     t: seconds everyone has run
 *
 * Output blender/renders/<scene>/drawing-<t>.png (transparent, in the
 * drawing's own Mercator sheet) and drawing.json (where that sheet hangs).
 * 0, the default, is the instant of the print.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const SHEETS = { wave: "great-wave", rain: "sudden-shower" };
const [scene, ...times] = process.argv.slice(2);
if (!SHEETS[scene]) throw new Error(`usage: draw-sheet.mjs ${Object.keys(SHEETS).join("|")} [t ...]`);
const { COLOURS, PLACE, draw, pose } = await import(`../src/scripts/worlds/${SHEETS[scene]}.ts`);

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "blender", "renders", scene);
const SCALE = 2; // pixels per sheet pixel in the finished picture
const FINE = 2; // and how much finer it is drawn, without antialiasing, to keep shared edges closed

const drawing = draw();
const points = new Float32Array(drawing.offset.length);
const w = PLACE.right - PLACE.left, h = PLACE.bottom - PLACE.top;

for (const t of times.length ? times.map(Number) : [0]) {
	pose(drawing, new Array(32).fill(t), points);
	const { index, colour } = drawing;
	const paths = [];
	let d = "", ink = -1;
	const flush = () => d && paths.push(`<path fill="${COLOURS[ink]}" d="${d}"/>`);
	const at = (v) => `${(points[v * 2] - PLACE.left).toFixed(2)} ${(points[v * 2 + 1] - PLACE.top).toFixed(2)}`;
	for (let i = 0; i < index.length; i += 3) {
		const c = colour[index[i]];
		if (c !== ink) {
			flush();
			d = "";
			ink = c;
		}
		d += `M${at(index[i])}L${at(index[i + 1])}L${at(index[i + 2])}Z`;
	}
	flush();
	const k = SCALE * FINE;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * k}" height="${h * k}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${paths.join("")}</svg>`;
	await sharp(Buffer.from(svg), { limitInputPixels: false, unlimited: true })
		.resize({ width: w * SCALE, height: h * SCALE, kernel: "mitchell" })
		.png()
		.toFile(path.join(OUT, `drawing-${t}.png`));
	console.log(`${scene} drawing-${t}.png`);
}
await writeFile(path.join(OUT, "drawing.json"), JSON.stringify(PLACE));
