/**
 * Encode the rendered panoramas and artwork images for the web.
 *
 *   node scripts/build-assets.mjs [scene ...] [--depth-only | --mask-only]
 *
 * Input  blender/renders/<scene>/{final|beauty}.png, mask.png, still.png, depth.png
 *        blender/sources/tex/<room>.jpg (artwork images)
 *        blender/renders/process/*.png (making-of pictures)
 * Output public/scenes/<scene>/…, public/art/…, public/process/…, public/og.jpg
 *        src/data/assets.json (manifest read by the site)
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RENDERS = path.join(ROOT, "blender", "renders");
const PUBLIC = path.join(ROOT, "public");
const MANIFEST = path.join(ROOT, "src", "data", "assets.json");
const SCENES = ["hub", "wave", "rain", "stillness", "moonlight"];
const ROOMS = SCENES.slice(1);
const DEPTH_ONLY = process.argv.includes("--depth-only");
const MASK_ONLY = process.argv.includes("--mask-only");

sharp.concurrency(4);

const TIERS = [
	{ tier: "8k", width: 8192, formats: ["avif"] },
	{ tier: "4k", width: 4096, formats: ["avif", "webp"] },
	{ tier: "2k", width: 2048, formats: ["avif", "webp"] },
];

const AVIF = { quality: 72, effort: 7, chromaSubsampling: "4:2:0" };
/** Broken colour from edge to edge: it costs more to store, and hides more of what is lost. */
const SCENE_QUALITY = { stillness: { avif: 58, webp: 78 }, moonlight: { avif: 64, webp: 80 } };
const WEBP = { quality: 86, effort: 6, smartSubsample: true };

const rel = (p) => path.relative(PUBLIC, p).split(path.sep).join("/");
const size = async (p) => (await stat(p)).size;

// Depth map for parallax: 2k is plenty, the eye only ever moves a few centimetres.
const DEPTH_W = 2048;
const DEPTH_H = 1024;
/** Foreground grows by this many pixels, so its silhouette moves with it instead of tearing. */
const DEPTH_DILATE = 7;
const DEPTH_BLUR = 2.5;

/**
 * Turn the depth pass (blender/scripts/common.py: 1 / (1 + d / 20), written
 * through the Standard view transform, background transparent) into an 8-bit
 * disparity map: near / distance, 1 at the nearest surface and 0 at the sky.
 * Parallax shifts are proportional to disparity, so 8 bits spread evenly.
 */
async function buildDepth(src, out) {
	const { data, info } = await sharp(src, { limitInputPixels: false })
		.toColourspace("rgb16") // keep all 16 bits: near surfaces differ by very little
		.resize({ width: DEPTH_W, height: DEPTH_H, fit: "fill", kernel: "linear" })
		.ensureAlpha()
		.raw({ depth: "ushort" })
		.toBuffer({ resolveWithObject: true });
	const px = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
	const n = DEPTH_W * DEPTH_H;
	const ch = info.channels;
	const inverse = new Float32Array(n); // 1 / distance (per metre), 0 = background
	const sample = [];
	for (let i = 0; i < n; i++) {
		const v = px[i * ch] / 65535;
		const alpha = px[i * ch + ch - 1] / 65535;
		const linear = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
		const distance = 20 * (1 / Math.max(linear, 1e-6) - 1);
		inverse[i] = alpha / Math.max(distance, 0.05);
		if (alpha > 0.99 && i % 7 === 0) sample.push(distance);
	}
	// nearest surface, ignoring a few stray pixels
	sample.sort((a, b) => a - b);
	const near = Number(sample[Math.floor(sample.length * 0.002)].toFixed(3));

	// dilate (separable max): wraps around the panorama horizontally, clamps at the poles
	const r = DEPTH_DILATE;
	const tmp = new Float32Array(n);
	for (let y = 0; y < DEPTH_H; y++) {
		for (let x = 0; x < DEPTH_W; x++) {
			let m = 0;
			for (let k = -r; k <= r; k++) m = Math.max(m, inverse[y * DEPTH_W + ((x + k + DEPTH_W) % DEPTH_W)]);
			tmp[y * DEPTH_W + x] = m;
		}
	}
	const grey = Buffer.alloc(n);
	for (let y = 0; y < DEPTH_H; y++) {
		for (let x = 0; x < DEPTH_W; x++) {
			let m = 0;
			for (let k = -r; k <= r; k++) m = Math.max(m, tmp[Math.min(DEPTH_H - 1, Math.max(0, y + k)) * DEPTH_W + x]);
			grey[y * DEPTH_W + x] = Math.round(Math.min(1, m * near) * 255);
		}
	}
	await sharp(grey, { raw: { width: DEPTH_W, height: DEPTH_H, channels: 1 } })
		.blur(DEPTH_BLUR)
		.webp({ quality: 88, effort: 6 })
		.toFile(out);
	return { url: rel(out), near };
}

async function encode(input, out, format, resize, quality) {
	let img = (input.raw ? sharp(input.data, { raw: input.raw, limitInputPixels: false }) : sharp(input, { limitInputPixels: false })).toColourspace("srgb");
	if (resize) img = img.resize(resize);
	img = format === "avif" ? img.avif({ ...AVIF, ...(quality && { quality }) }) : format === "webp" ? img.webp({ ...WEBP, ...(quality && { quality }) }) : img.jpeg({ quality: 84, mozjpeg: true });
	await img.toFile(out);
	return { url: rel(out), bytes: await size(out) };
}

/**
 * Resize a panorama as the ring it is. A filter that stops at the edges of the
 * picture leaves a faint vertical line behind the viewer, where they meet: so
 * resize a copy that runs on past both edges, then cut the margins off.
 */
const RING = 128; // columns of the master added on each side; divides evenly into every tier
async function wrapPano(master, width) {
	const { width: w, height: h, channels } = master.raw;
	const ring = await sharp(master.data, { raw: master.raw, limitInputPixels: false })
		.extend({ left: RING, right: RING, extendWith: "repeat" })
		.raw()
		.toBuffer();
	const margin = (RING * width) / w;
	const { data, info } = await sharp(ring, { raw: { width: w + RING * 2, height: h, channels }, limitInputPixels: false })
		.resize({ width: width + margin * 2, height: width / 2, fit: "fill" })
		.extract({ left: margin, top: 0, width, height: width / 2 })
		.raw()
		.toBuffer({ resolveWithObject: true });
	return { data, raw: { width: info.width, height: info.height, channels: info.channels } };
}

/**
 * In the prints every shape has an ink outline that lies outside it, over the
 * water. Draw the water back from anything that is not water, or the ripples
 * would pull that line about and leave it with teeth.
 */
/** …and so it would with the painted rail of the boat on the moonlit river. */
const PRINTS = ["wave", "rain", "moonlight"];
const WATER_MARGIN = 3; // pixels of the 2k mask
function pullWaterBack(m, w, h, ch) {
	const min = (get, set, n, stride, wrap) => {
		const line = new Uint8Array(n);
		for (let i = 0; i < n; i++) {
			let v = 255;
			for (let k = -WATER_MARGIN; k <= WATER_MARGIN; k++) {
				const j = wrap ? (i + k + n) % n : Math.min(n - 1, Math.max(0, i + k));
				v = Math.min(v, get(j * stride));
			}
			line[i] = v;
		}
		for (let i = 0; i < n; i++) set(i * stride, line[i]);
	};
	for (let y = 0; y < h; y++) min((o) => m[(y * w + o) * ch], (o, v) => (m[(y * w + o) * ch] = v), w, 1, true);
	for (let x = 0; x < w; x++) min((o) => m[(o + x) * ch], (o, v) => (m[(o + x) * ch] = v), h, w, false);
}

async function buildSceneDepth(scene, entry) {
	const depthSrc = path.join(RENDERS, scene, "depth.png");
	if (!existsSync(depthSrc)) return;
	const out = path.join(PUBLIC, "scenes", scene);
	await mkdir(out, { recursive: true });
	const depthOut = path.join(out, "depth.webp");
	entry.depth = await buildDepth(depthSrc, depthOut);
	console.log(`  ${scene} depth ${((await size(depthOut)) / 1024).toFixed(0)} KB, nearest surface ${entry.depth.near} m`);
}

async function buildSceneMask(scene, entry) {
	const out = path.join(PUBLIC, "scenes", scene);
	const maskSrc = path.join(RENDERS, scene, "mask.png");
	if (existsSync(maskSrc)) {
		const maskOut = path.join(out, "mask.webp");
		// G (sky) is wherever the mask render saw the background: alpha 0
		const { data: m } = await sharp(maskSrc).resize({ width: 2048, height: 1024 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		for (let i = 0; i < m.length; i += 4) m[i + 1] = Math.max(m[i + 1], 255 - m[i + 3]);
		if (PRINTS.includes(scene)) pullWaterBack(m, 2048, 1024, 4);
		// soft masks survive lossy compression well; 2k is plenty for effect regions
		await sharp(m, { raw: { width: 2048, height: 1024, channels: 4 } })
			.removeAlpha()
			.webp({ quality: 90, effort: 6 })
			.toFile(maskOut);
		entry.mask = rel(maskOut);
		console.log(`  ${scene} mask ${((await size(maskOut)) / 1024).toFixed(0)} KB`);
	}
}

async function buildScene(scene, manifest) {
	const dir = path.join(RENDERS, scene);
	if (DEPTH_ONLY) {
		// add or refresh the depth map without re-encoding the panoramas
		if (manifest.scenes[scene]) await buildSceneDepth(scene, manifest.scenes[scene]);
		return;
	}
	if (MASK_ONLY) {
		if (manifest.scenes[scene]) await buildSceneMask(scene, manifest.scenes[scene]);
		return;
	}
	const source = ["final.png", "beauty.png"].map((f) => path.join(dir, f)).find(existsSync);
	if (!source) {
		console.log(`· ${scene}: no render yet`);
		return;
	}
	const out = path.join(PUBLIC, "scenes", scene);
	await mkdir(out, { recursive: true });
	// decode the master once, reuse the raw 8-bit pixels for every variant
	const { data, info } = await sharp(source, { limitInputPixels: false })
		.toColourspace("srgb")
		.removeAlpha()
		.raw({ depth: "uchar" })
		.toBuffer({ resolveWithObject: true });
	const master = { data, raw: { width: info.width, height: info.height, channels: info.channels } };
	const entry = { tiers: {}, mask: null, still: null };

	for (const { tier, width, formats } of TIERS) {
		entry.tiers[tier] = {};
		const pano = await wrapPano(master, width);
		for (const f of formats) {
			const r = await encode(pano, path.join(out, `pano-${tier}.${f}`), f, undefined, SCENE_QUALITY[scene]?.[f]);
			entry.tiers[tier][f] = r.url;
			entry.tiers[tier].bytes = Math.max(entry.tiers[tier].bytes ?? 0, r.bytes);
			console.log(`  ${scene} ${tier}.${f} ${(r.bytes / 1024).toFixed(0)} KB`);
		}
	}

	await buildSceneMask(scene, entry);

	const stillSrc = path.join(dir, "still.png");
	if (existsSync(stillSrc)) {
		entry.still = { widths: [960, 1920], avif: {}, webp: {} };
		for (const w of entry.still.widths) {
			for (const f of ["avif", "webp"]) {
				const r = await encode(stillSrc, path.join(out, `still-${w}.${f}`), f, { width: w });
				entry.still[f][w] = r.url;
			}
		}
		const lqip = await sharp(stillSrc).resize({ width: 32 }).webp({ quality: 50 }).toBuffer();
		entry.still.lqip = `data:image/webp;base64,${lqip.toString("base64")}`;
	}
	const og = path.join(dir, "og.png");
	if (existsSync(og)) await encode(og, path.join(PUBLIC, "og.jpg"), "jpeg");

	await buildSceneDepth(scene, entry);

	manifest.scenes[scene] = entry;
}

async function buildArt(manifest) {
	const out = path.join(PUBLIC, "art");
	await mkdir(out, { recursive: true });
	for (const room of ROOMS) {
		const src = path.join(ROOT, "blender", "sources", "tex", `${room}.jpg`);
		if (!existsSync(src)) continue;
		const meta = await sharp(src).metadata();
		const entry = { width: meta.width, height: meta.height, avif: {}, webp: {} };
		for (const w of [480, 960]) {
			for (const f of ["avif", "webp"]) {
				const r = await encode(src, path.join(out, `${room}-${w}.${f}`), f, { width: w });
				entry[f][w] = r.url;
			}
		}
		manifest.art[room] = entry;
	}
}

/** Pictures for the making-of page (scripts/make_process.py), plus frames captured from the site. */
async function buildProcess(manifest) {
	const dir = path.join(RENDERS, "process");
	if (!existsSync(dir)) return;
	const out = path.join(PUBLIC, "process");
	await mkdir(out, { recursive: true });
	manifest.process = {};
	for (const file of (await readdir(dir)).filter((f) => f.endsWith(".png")).sort()) {
		const name = path.basename(file, ".png");
		const src = path.join(dir, file);
		const meta = await sharp(src).metadata();
		const widths = [800, 1600].filter((w) => w <= meta.width);
		if (!widths.length) widths.push(meta.width);
		const entry = { width: meta.width, height: meta.height, avif: {}, webp: {} };
		for (const w of widths) {
			for (const f of ["avif", "webp"]) {
				const r = await encode(src, path.join(out, `${name}-${w}.${f}`), f, { width: w });
				entry[f][w] = r.url;
			}
		}
		manifest.process[name] = entry;
		console.log(`  process ${name}`);
	}
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const manifest = existsSync(MANIFEST) ? JSON.parse(await readFile(MANIFEST, "utf8")) : { scenes: {}, art: {} };
for (const scene of SCENES) {
	if (only.length && !only.includes(scene)) continue;
	console.log(`▸ ${scene}`);
	await buildScene(scene, manifest);
}
if (!DEPTH_ONLY && !MASK_ONLY && (!only.length || only.includes("art"))) await buildArt(manifest);
if (!DEPTH_ONLY && !MASK_ONLY && (!only.length || only.includes("process"))) await buildProcess(manifest);
await writeFile(MANIFEST, JSON.stringify(manifest, null, "\t") + "\n");
console.log("manifest written");
