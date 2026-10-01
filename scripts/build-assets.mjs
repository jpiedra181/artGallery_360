/**
 * Encode the rendered panoramas and artwork images for the web.
 *
 *   node scripts/build-assets.mjs [scene ...]
 *
 * Input  blender/renders/<scene>/{final|beauty}.png, mask.png, still.png
 *        blender/sources/tex/<room>.jpg (artwork images)
 * Output public/scenes/<scene>/…, public/art/…, public/og.jpg
 *        src/data/assets.json (manifest read by the site)
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RENDERS = path.join(ROOT, "blender", "renders");
const PUBLIC = path.join(ROOT, "public");
const MANIFEST = path.join(ROOT, "src", "data", "assets.json");
const SCENES = ["hub", "wave", "rain", "stillness", "moonlight"];
const ROOMS = SCENES.slice(1);

sharp.concurrency(4);

const TIERS = [
	{ tier: "8k", width: 8192, formats: ["avif"] },
	{ tier: "4k", width: 4096, formats: ["avif", "webp"] },
	{ tier: "2k", width: 2048, formats: ["avif", "webp"] },
];

const AVIF = { quality: 72, effort: 7, chromaSubsampling: "4:2:0" };
const WEBP = { quality: 86, effort: 6, smartSubsample: true };

const rel = (p) => path.relative(PUBLIC, p).split(path.sep).join("/");
const size = async (p) => (await stat(p)).size;

async function encode(input, out, format, resize) {
	let img = (input.raw ? sharp(input.data, { raw: input.raw, limitInputPixels: false }) : sharp(input, { limitInputPixels: false })).toColourspace("srgb");
	if (resize) img = img.resize(resize);
	img = format === "avif" ? img.avif(AVIF) : format === "webp" ? img.webp(WEBP) : img.jpeg({ quality: 84, mozjpeg: true });
	await img.toFile(out);
	return { url: rel(out), bytes: await size(out) };
}

async function buildScene(scene, manifest) {
	const dir = path.join(RENDERS, scene);
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
		for (const f of formats) {
			const r = await encode(master, path.join(out, `pano-${tier}.${f}`), f, { width, height: width / 2 });
			entry.tiers[tier][f] = r.url;
			entry.tiers[tier].bytes = Math.max(entry.tiers[tier].bytes ?? 0, r.bytes);
			console.log(`  ${scene} ${tier}.${f} ${(r.bytes / 1024).toFixed(0)} KB`);
		}
	}

	const maskSrc = path.join(dir, "mask.png");
	if (existsSync(maskSrc)) {
		const maskOut = path.join(out, "mask.webp");
		// G (sky) is wherever the mask render saw the background: alpha 0
		const { data: m } = await sharp(maskSrc).resize({ width: 2048, height: 1024 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		for (let i = 0; i < m.length; i += 4) m[i + 1] = Math.max(m[i + 1], 255 - m[i + 3]);
		// soft masks survive lossy compression well; 2k is plenty for effect regions
		await sharp(m, { raw: { width: 2048, height: 1024, channels: 4 } })
			.removeAlpha()
			.webp({ quality: 90, effort: 6 })
			.toFile(maskOut);
		entry.mask = rel(maskOut);
		console.log(`  ${scene} mask ${((await size(maskOut)) / 1024).toFixed(0)} KB`);
	}

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

const only = process.argv.slice(2);
const manifest = existsSync(MANIFEST) ? JSON.parse(await readFile(MANIFEST, "utf8")) : { scenes: {}, art: {} };
for (const scene of SCENES) {
	if (only.length && !only.includes(scene)) continue;
	console.log(`▸ ${scene}`);
	await buildScene(scene, manifest);
}
if (!only.length || only.includes("art")) await buildArt(manifest);
await writeFile(MANIFEST, JSON.stringify(manifest, null, "\t") + "\n");
console.log("manifest written");
