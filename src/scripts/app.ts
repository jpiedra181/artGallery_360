/**
 * Inside the Frame — client entry.
 *
 * Upgrades the server-rendered document into the immersive experience:
 * WebGL panorama viewer, painting hotspots, transitions between rooms
 * without page reloads, procedural audio and all accessibility plumbing.
 * If WebGL2 is unavailable the page stays a readable document.
 */

import { Soundscape, type SoundId } from "./audio/soundscape";
import { ViewController } from "./engine/camera";
import { chooseTier, decode, fetchBlob, prefetch, resolveUrl, supportsAvif, type SceneAssets } from "./engine/loader";
import {
	DEG,
	angleDelta,
	clamp,
	dirFromAngles,
	easeInOutCubic,
	easeInOutSine,
	lerp,
	project,
	rotation,
	screenRay,
	toWorld,
	type Projection,
} from "./engine/math";
import { PanoRenderer, emptyFx, type FxUniforms, type SceneTextures } from "./engine/renderer";

// ─── Config from the page ─────────────────────────────────────────────────────

type RoomSlug = "wave" | "rain" | "stillness" | "moonlight";
type SceneId = "hub" | RoomSlug;

interface Effects {
	water?: { height: number; strength: number; scale: number; speed: number; drips?: number };
	rain?: { density: number; angle: number; speed: number };
	flicker?: { strength: number };
	sky?: { shimmer: number };
	grade?: { vignette: number; grain: number };
	boat?: { pitch: number; roll: number; period: number };
}

interface RoomConfig {
	slug: RoomSlug;
	numeral: string;
	theme: string;
	title: string;
	artist: string;
	view: { yaw: number; pitch: number };
	effects: Effects;
	audio: SoundId;
	accent: string;
}

interface PaintingGeometry {
	id: RoomSlug;
	yaw: number;
	pitch: number;
	halfWidth: number;
	top: number;
	bottom: number;
	frameBottom: number;
	distance: number;
	width: number;
	height: number;
	centerY: number;
}

interface Config {
	base: string;
	route: SceneId;
	hub: { title: string; effects: Effects; geometry: { water: number; paintings: PaintingGeometry[] } };
	rooms: RoomConfig[];
	scenes: Record<string, SceneAssets>;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];

const config: Config = JSON.parse($("#config").textContent || "{}");
const root = document.documentElement;
const roomBySlug = Object.fromEntries(config.rooms.map((r) => [r.slug, r])) as Record<RoomSlug, RoomConfig>;
const paintingBySlug = Object.fromEntries(config.hub.geometry.paintings.map((p) => [p.id, p])) as Record<RoomSlug, PaintingGeometry>;

const reducedMotionQuery = matchMedia("(prefers-reduced-motion: reduce)");
const store = {
	get(key: string) {
		try {
			return localStorage.getItem(`itf:${key}`);
		} catch {
			return null;
		}
	},
	set(key: string, value: string) {
		try {
			localStorage.setItem(`itf:${key}`, value);
		} catch {
			/* storage unavailable: preference lasts for this visit only */
		}
	},
};

// ─── Boot ─────────────────────────────────────────────────────────────────────

function fallback(reason: unknown) {
	console.warn("[inside-the-frame] staying in document mode:", reason);
	root.classList.remove("immersive", "is-intro", "gl-ready", "is-moving");
}

let renderer: PanoRenderer;

/** First scene, downloaded and decoded during the title screen (no GPU yet). */
const predecoded = new Map<SceneId, Promise<{ bitmap: ImageBitmap; mask: ImageBitmap | null }>>();
const firstProgress = { value: 0, listeners: new Set<() => void>() };

if (typeof createImageBitmap !== "function" || !("WebGL2RenderingContext" in window)) {
	fallback("WebGL2 or createImageBitmap unavailable");
} else {
	prepare();
}

/**
 * Title screen. Nothing touches the GPU yet: the still image is on screen
 * and the first panorama downloads and decodes in the background. WebGL is
 * only created when the visitor chooses to enter, which keeps the first
 * paint fast and leaves low-end devices alone until they ask for more.
 */
function prepare() {
	root.classList.add("immersive", "is-intro");
	(window as Window & { __itfBooted?: boolean }).__itfBooted = true;
	const id = config.route;
	const assets = config.scenes[id] ?? config.scenes.hub;
	const tier = chooseTier(8192) === "2k" ? "2k" : "4k";
	predecoded.set(
		id,
		(async () => {
			const url = config.base + resolveUrl(assets, tier, await supportsAvif());
			const maskUrl = assets.mask ? config.base + assets.mask : null;
			const [blob, maskBlob] = await Promise.all([
				fetchBlob(url, (f) => {
					firstProgress.value = f;
					for (const l of firstProgress.listeners) l();
				}),
				maskUrl ? fetchBlob(maskUrl) : null,
			]);
			const [bitmap, mask] = await Promise.all([decode(blob), maskBlob ? decode(maskBlob) : null]);
			return { bitmap, mask };
		})(),
	);
	predecoded.get(id)!.catch(() => {});

	const bar = $("#intro-progress .progress");
	const show = () => {
		const pct = Math.round(firstProgress.value * 100);
		bar.style.setProperty("--progress", String(firstProgress.value));
		bar.setAttribute("aria-valuenow", String(pct));
	};
	firstProgress.listeners.add(show);
	predecoded.get(id)!.then(() => {
		firstProgress.value = 1;
		show();
	}, () => {});

	// nothing behind the title screen is reachable until the visitor enters
	for (const el of [$("#stage"), $("#bar"), $("#hub"), ...$$("article.room")]) el.inert = true;

	const actions = $("#intro-actions");
	// remember a previous choice: offer it first
	if (store.get("sound") === "off") {
		const silent = actions.querySelector<HTMLButtonElement>('[data-enter="silent"]')!;
		const loud = actions.querySelector<HTMLButtonElement>('[data-enter="sound"]')!;
		actions.prepend(silent);
		silent.classList.replace("btn-quiet", "btn-primary");
		loud.classList.replace("btn-primary", "btn-quiet");
	}
	let launched = false;
	for (const btn of $$<HTMLButtonElement>("[data-enter]")) {
		btn.addEventListener("click", () => {
			if (launched) return;
			launched = true;
			launch(btn.dataset.enter === "sound");
		});
	}
}

function launch(withSound: boolean) {
	try {
		renderer = new PanoRenderer($<HTMLCanvasElement>("#canvas"));
	} catch (err) {
		// no hardware-accelerated WebGL2: carry on as a readable document
		fallback(err);
		for (const el of $$("[inert]")) el.inert = false;
		$("#intro").hidden = false;
		$("#content").focus();
		return;
	}
	start(withSound);
}

function start(withSound: boolean) {

	// ─── Elements ───────────────────────────────────────────────────────────
	const look = $("#look");
	const spots = $$<HTMLAnchorElement>(".spot");
	const spotsNav = $("#spots");
	const intro = $("#intro");
	const hint = $("#hint");
	const live = $("#live");
	const pageTitle = $("#page-title");
	const wordmarkRoom = $("#wordmark-room");
	const guide = $<HTMLDialogElement>("#guide");
	const btnSound = $<HTMLButtonElement>("#btn-sound");
	const btnMotion = $<HTMLButtonElement>("#btn-motion");
	const btnGyro = $<HTMLButtonElement>("#btn-gyro");
	const btnFullscreen = $<HTMLButtonElement>("#btn-fullscreen");
	const btnGuide = $<HTMLButtonElement>("#btn-guide");
	const hubSection = $("#hub");
	const roomSections = $$("article.room");

	// The look-around surface is an interactive widget only in this mode.
	look.tabIndex = 0;
	look.setAttribute("role", "application");
	look.setAttribute("aria-roledescription", "360° view");
	look.setAttribute("aria-describedby", "look-help");
	const behindIntro = [$("#stage"), $("#bar"), ...roomSections, hubSection];

	// Room descriptions start collapsed; the room card stays visible.
	for (const details of $$(".details")) {
		details.dataset.open = "false";
	}
	for (const btn of $$<HTMLButtonElement>("[data-details]")) btn.setAttribute("aria-expanded", "false");

	// ─── State ──────────────────────────────────────────────────────────────
	const view = new ViewController(look);
	const audio = new Soundscape();
	const avif = supportsAvif();
	// Scenes always open at 4k at most, so transitions never wait on a big
	// download; capable screens then upgrade to 8k once the visitor settles.
	const bestTier = chooseTier(renderer.maxTextureSize);
	const tier = bestTier === "8k" ? "4k" : bestTier;
	const upgraded = new Set<SceneId>();

	let current: SceneId = config.route;
	let busy = false;
	let entered = false;
	let motion = store.get("motion") ? store.get("motion") === "on" : !reducedMotionQuery.matches;
	let time = 0;
	let needsRender = true;
	let hovered: RoomSlug | null = null;
	let hoverAmount = 0;
	let fxA: FxUniforms = emptyFx();
	let fxB: FxUniforms = emptyFx();
	let mix = 0;
	let trans: { rotA: Float32Array; rotB: Float32Array; ripple: boolean } | null = null;
	const rotA = new Float32Array(9);
	const drips = new Float32Array(16);
	let dripIndex = 0;
	let boatAmount = 0;
	let rockPitch = 0;
	let nextDrip = 2;
	const center: [number, number] = [0, 0];

	const reduced = () => reducedMotionQuery.matches;
	const href = (id: SceneId) => (id === "hub" ? config.base : `${config.base}${id}/`);
	const sceneTitle = (id: SceneId) => (id === "hub" ? config.hub.title : `Room ${roomBySlug[id].numeral} — ${roomBySlug[id].theme}`);

	function fxFor(id: SceneId): FxUniforms {
		const e = id === "hub" ? config.hub.effects : roomBySlug[id].effects;
		const fx = emptyFx();
		if (e.water) {
			fx.water = [e.water.strength, e.water.height, e.water.scale, e.water.speed];
			fx.grade[2] = e.water.drips ? 1 : 0;
		}
		if (e.rain) fx.rain = [e.rain.density, e.rain.angle * DEG, e.rain.speed, 1];
		if (e.flicker) fx.light[0] = e.flicker.strength;
		if (e.sky) fx.light[1] = e.sky.shimmer;
		if (e.grade) {
			fx.grade[0] = e.grade.vignette;
			fx.grade[1] = e.grade.grain;
		}
		return fx;
	}

	// ─── Scene loading ──────────────────────────────────────────────────────
	const loaded = new Map<SceneId, SceneTextures>();
	const loading = new Map<SceneId, Promise<SceneTextures>>();
	const progress = new Map<SceneId, number>();
	const progressListeners = new Set<() => void>();

	function sceneAssets(id: SceneId): SceneAssets {
		// During development a room may not be rendered yet: show the hub.
		return config.scenes[id] ?? config.scenes.hub;
	}

	function load(id: SceneId): Promise<SceneTextures> {
		const done = loaded.get(id);
		if (done) return Promise.resolve(done);
		const pending = loading.get(id);
		if (pending) return pending;
		const p = (async () => {
			const ready = await predecoded.get(id)?.catch(() => null);
			predecoded.delete(id);
			let bitmap: ImageBitmap;
			let maskBitmap: ImageBitmap | null;
			if (ready && ready.bitmap.width <= renderer.maxTextureSize) {
				({ bitmap, mask: maskBitmap } = ready);
			} else {
				const assets = sceneAssets(id);
				const url = config.base + resolveUrl(assets, tier, await avif);
				const maskUrl = assets.mask ? config.base + assets.mask : null;
				const report = (f: number) => {
					progress.set(id, f);
					for (const l of progressListeners) l();
				};
				const [blob, maskBlob] = await Promise.all([fetchBlob(url, report), maskUrl ? fetchBlob(maskUrl) : null]);
				[bitmap, maskBitmap] = await Promise.all([decode(blob), maskBlob ? decode(maskBlob) : null]);
			}
			const pano = await renderer.uploadTexture(bitmap, { srgb: true, mipmaps: true });
			const mask = maskBitmap ? await renderer.uploadTexture(maskBitmap, { srgb: false, mipmaps: true, stripRows: 4096 }) : null;
			const textures: SceneTextures = { pano, mask, width: bitmap.width };
			bitmap.close();
			maskBitmap?.close();
			loaded.set(id, textures);
			return textures;
		})();
		loading.set(id, p);
		p.catch(() => {}).finally(() => loading.delete(id));
		return p;
	}

	/** Swap the scene on screen for its 8k version, quietly, when idle. */
	async function upgrade(id: SceneId) {
		if (bestTier !== "8k" || upgraded.has(id)) return;
		const assets = sceneAssets(id);
		if (!assets.tiers["8k"]) return;
		upgraded.add(id);
		try {
			const url = config.base + resolveUrl(assets, "8k", await avif);
			const bitmap = await decode(await fetchBlob(url, undefined, "low"));
			if (current !== id || busy) {
				bitmap.close();
				upgraded.delete(id);
				return;
			}
			const pano = await renderer.uploadTexture(bitmap, { srgb: true, mipmaps: true });
			bitmap.close();
			const old = loaded.get(id);
			if (current !== id || busy || !old) {
				renderer.deleteTexture(pano);
				upgraded.delete(id);
				return;
			}
			const sharper: SceneTextures = { pano, mask: old.mask, width: 8192 };
			loaded.set(id, sharper);
			if (renderer.getSlot(0) === old) renderer.setSlot(0, sharper);
			renderer.deleteTexture(old.pano);
			needsRender = true;
		} catch {
			upgraded.delete(id);
		}
	}

	function release(id: SceneId) {
		if (id === "hub") return; // the hub is home: keep it resident
		const t = loaded.get(id);
		if (!t) return;
		renderer.deleteTexture(t.pano);
		renderer.deleteTexture(t.mask);
		loaded.delete(id);
		upgraded.delete(id);
	}

	function prefetchScene(id: SceneId) {
		if (loaded.has(id)) return;
		avif.then((a) => prefetch(config.base + resolveUrl(sceneAssets(id), tier, a)));
	}

	renderer.onRestored = () => {
		// GPU textures were lost with the context: reload what is on screen.
		loaded.clear();
		load(current).then((t) => {
			renderer.setSlot(0, t);
			needsRender = true;
		});
	};

	// ─── Tweens ─────────────────────────────────────────────────────────────
	interface Tween {
		start: number;
		duration: number;
		ease: (t: number) => number;
		update: (v: number) => void;
		resolve: () => void;
	}
	const tweens = new Set<Tween>();
	function animate(seconds: number, ease: (t: number) => number, update: (v: number) => void): Promise<void> {
		if (seconds <= 0) {
			update(1);
			return Promise.resolve();
		}
		return new Promise((resolve) => tweens.add({ start: performance.now(), duration: seconds * 1000, ease, update, resolve }));
	}
	const wait = (seconds: number) => new Promise((r) => setTimeout(r, seconds * 1000));

	// ─── Rendering loop ─────────────────────────────────────────────────────
	let last = performance.now();
	let perfAcc = 0;
	let perfFrames = 0;
	let perfGood = 0;
	let renderScale = 1;

	function aspect() {
		return Math.max(look.clientWidth, 1) / Math.max(look.clientHeight, 1);
	}

	function currentProjection(): Projection {
		return view.projection(aspect());
	}

	function frame(now: number) {
		requestAnimationFrame(frame);
		const dt = Math.min((now - last) / 1000, 0.1);
		last = now;
		if (motion) time += dt;

		for (const tw of tweens) {
			const t = clamp((now - tw.start) / tw.duration, 0, 1);
			tw.update(tw.ease(t));
			if (t >= 1) {
				tweens.delete(tw);
				tw.resolve();
			}
		}

		// slow drift while the title screen is up
		if (!entered && motion && !busy) view.yaw += dt * 0.022;

		const moved = view.update(dt);
		// ease the rocking in after arriving, and out while transitions run
		const rockTarget = motion && !trans && !busy ? 1 : 0;
		boatAmount += (rockTarget - boatAmount) * Math.min(1, dt * 0.8);
		const hoverTarget = hovered && current === "hub" && !trans ? 1 : 0;
		const hoverChanging = Math.abs(hoverAmount - hoverTarget) > 0.001;
		hoverAmount += (hoverTarget - hoverAmount) * Math.min(1, dt * 8);

		if (current === "hub" && motion) updateDrips();

		const animating = motion || tweens.size > 0 || hoverChanging || !entered;
		if (moved || animating || needsRender) {
			draw();
			needsRender = false;
			perfAcc += dt;
			perfFrames++;
		}
		updateSpots();
		updatePois();
		audio.setListener(view.yaw, view.pitch);
		adaptResolution();
	}

	function draw() {
		if (renderer.resize()) needsRender = true;
		const proj = currentProjection();
		if (!trans) {
			// the gentle rocking of a boat, for rooms set on the water
			const boat = current === "hub" ? undefined : roomBySlug[current].effects.boat;
			let dp = 0, roll = 0;
			if (boat) {
				const w = (2 * Math.PI) / boat.period;
				dp = boat.pitch * DEG * Math.sin(time * w) * boatAmount;
				roll = boat.roll * DEG * Math.sin(time * w * 0.83 + 1.3) * boatAmount;
			}
			rockPitch = dp;
			rotation(view.yaw, view.pitch + dp, rotA, roll);
		}
		const fx = fxA;
		if (current === "hub" && !trans && hovered) {
			const g = paintingBySlug[hovered];
			fx.hover = [g.yaw * DEG, g.distance, g.width / 2, g.height / 2];
			fx.hover2 = [g.centerY, hoverAmount, 0, 0];
		} else if (fx.hover2[1] > 0) {
			fx.hover2 = [fx.hover2[0], current === "hub" && !trans ? hoverAmount : 0, 0, 0];
		}
		renderer.render({
			rotA: trans ? trans.rotA : rotA,
			rotB: trans ? trans.rotB : rotA,
			fxA: fx,
			fxB,
			fovV: proj.fovV,
			stereo: proj.stereo,
			mix,
			ripple: trans?.ripple ?? false,
			center,
			time,
			drips,
		});
	}

	/** Keep the frame rate smooth on weaker GPUs by rendering fewer pixels. */
	function adaptResolution() {
		if (perfFrames < 30 || perfAcc < 1) return;
		const avg = perfAcc / perfFrames;
		perfAcc = 0;
		perfFrames = 0;
		if (avg > 1 / 40 && renderScale > 0.6) {
			renderScale = Math.max(0.6, renderScale - 0.1);
			perfGood = 0;
		} else if (avg < 1 / 56 && renderScale < 1) {
			if (++perfGood >= 4) {
				renderScale = Math.min(1, renderScale + 0.05);
				perfGood = 0;
			}
		} else {
			return;
		}
		renderer.setRenderScale(renderScale);
		needsRender = true;
	}

	new ResizeObserver(() => {
		needsRender = true;
		measureSpots();
	}).observe(look);

	// ─── Drops falling into the flooded hub ─────────────────────────────────
	function updateDrips() {
		if (time < nextDrip) return;
		nextDrip = time + 1.8 + Math.random() * 4.5;
		let x = 0, z = 0;
		do {
			x = (Math.random() * 2 - 1) * 3.6;
			z = (Math.random() * 2 - 1) * 3.6;
		} while (Math.abs(x) < 1.1 && Math.abs(z) < 1.1);
		const i = dripIndex++ % 4;
		drips.set([x, z, time, 0.6 + Math.random() * 0.6], i * 4);
		audio.drip(x, -config.hub.geometry.water, z);
	}

	// ─── Hub hotspots ───────────────────────────────────────────────────────
	const spotWidth = new Map<HTMLElement, number>();
	function measureSpots() {
		for (const s of spots) spotWidth.set(s, s.offsetWidth);
	}
	document.fonts?.ready.then(measureSpots);

	function updateSpots() {
		const show = current === "hub" && !trans && entered;
		if (!show) return;
		const proj = currentProjection();
		const w = look.clientWidth;
		const h = look.clientHeight;
		for (const s of spots) {
			const yaw = Number(s.dataset.yaw) * DEG;
			const pitch = (Number(s.dataset.pitch) - 2.2) * DEG;
			const ndc = project(dirFromAngles(yaw, pitch), view.yaw, view.pitch, proj);
			const visible = !!ndc && Math.abs(ndc[0]) < 1.05 && ndc[1] > -1.05 && ndc[1] < 1.05;
			s.dataset.visible = String(visible);
			if (!ndc) continue;
			const x = (ndc[0] * 0.5 + 0.5) * w - (spotWidth.get(s) ?? 0) / 2;
			const y = (0.5 - ndc[1] * 0.5) * h;
			s.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
			s.classList.toggle("is-hot", hovered === s.dataset.room);
		}
	}

	/** Which painting (if any) is under a screen point. Exact plane test. */
	function pickPainting(clientX: number, clientY: number): RoomSlug | null {
		const rect = look.getBoundingClientRect();
		const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
		const ny = 1 - ((clientY - rect.top) / rect.height) * 2;
		const d = toWorld(rotation(view.yaw, view.pitch), screenRay(nx, ny, currentProjection()));
		for (const g of config.hub.geometry.paintings) {
			const a = g.yaw * DEG;
			const dn = d[0] * Math.sin(a) + d[2] * Math.cos(a);
			if (dn < 0.05) continue;
			const k = g.distance / dn;
			const u = (d[0] * Math.cos(a) - d[2] * Math.sin(a)) * k;
			const v = d[1] * k - g.centerY;
			if (Math.abs(u) <= g.width / 2 + 0.06 && Math.abs(v) <= g.height / 2 + 0.06) return g.id;
		}
		return null;
	}

	function setHovered(slug: RoomSlug | null) {
		if (slug === hovered) return;
		hovered = slug;
		look.classList.toggle("is-pointing", !!slug);
		if (slug) prefetchScene(slug);
	}

	let down: { x: number; y: number; t: number; id: number } | null = null;
	look.addEventListener("pointerdown", (e) => {
		down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
		interacted();
	});
	look.addEventListener("pointermove", (e) => {
		if (current !== "hub" || busy || !entered) return setHovered(null);
		if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return setHovered(null);
		if (e.pointerType === "mouse" || !down) setHovered(pickPainting(e.clientX, e.clientY));
	});
	look.addEventListener("pointerleave", () => setHovered(null));
	look.addEventListener("pointerup", (e) => {
		const d = down;
		down = null;
		if (!d || d.id !== e.pointerId || busy || !entered || current !== "hub") return;
		const tap = Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8 && performance.now() - d.t < 600;
		if (!tap) return;
		const slug = pickPainting(e.clientX, e.clientY);
		if (slug) navigate(slug);
	});

	for (const s of spots) {
		const slug = s.dataset.room as RoomSlug;
		s.addEventListener("pointerenter", () => setHovered(slug));
		s.addEventListener("pointerleave", () => setHovered(null));
		// keyboard users: bring the painting into view when its label gets focus
		s.addEventListener("focus", () => {
			if (current !== "hub" || busy) return;
			setHovered(slug);
			const g = paintingBySlug[slug];
			bringIntoView(g.yaw * DEG, g.pitch * DEG);
		});
		s.addEventListener("blur", () => setHovered(null));
	}

	/** Keyboard users: turn the view so whatever just got focus is on screen. */
	function bringIntoView(yaw: number, pitch: number) {
		if (busy) return;
		const ndc = project(dirFromAngles(yaw, pitch), view.yaw, view.pitch, currentProjection());
		if (ndc && Math.abs(ndc[0]) < 0.6 && Math.abs(ndc[1]) < 0.6) return;
		const y0 = view.yaw, p0 = view.pitch, dy = angleDelta(y0, yaw);
		view.locked = true;
		animate(reduced() ? 0 : 0.7, easeInOutCubic, (t) => {
			view.yaw = y0 + dy * t;
			view.pitch = lerp(p0, pitch, t);
		}).then(() => {
			view.locked = false;
			view.set({});
		});
	}

	// ─── Points of interest inside the rooms ────────────────────────────────
	const pois = $$<HTMLElement>(".poi");
	for (const card of $$(".poi-card")) card.classList.add("is-collapsed");
	for (const btn of $$<HTMLButtonElement>(".poi-dot")) btn.setAttribute("aria-expanded", "false");
	let openPoi: HTMLElement | null = null;

	function setPoi(poi: HTMLElement | null) {
		openPoi = poi;
		for (const p of pois) {
			const open = p === poi;
			p.querySelector(".poi-card")!.classList.toggle("is-collapsed", !open);
			p.querySelector(".poi-dot")!.setAttribute("aria-expanded", String(open));
		}
	}
	for (const p of pois) {
		const btn = p.querySelector<HTMLButtonElement>(".poi-dot")!;
		btn.addEventListener("click", () => setPoi(openPoi === p ? null : p));
		btn.addEventListener("focus", () => bringIntoView(Number(p.dataset.yaw) * DEG, Number(p.dataset.pitch) * DEG));
	}
	look.addEventListener("pointerdown", () => setPoi(null));
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && openPoi) {
			const btn = openPoi.querySelector<HTMLButtonElement>(".poi-dot")!;
			setPoi(null);
			btn.focus();
		}
	});

	function updatePois() {
		if (current === "hub" || trans || !entered) return;
		const proj = currentProjection();
		const w = look.clientWidth;
		const h = look.clientHeight;
		for (const p of pois) {
			if ((p.closest("article") as HTMLElement).hidden) continue;
			const ndc = project(dirFromAngles(Number(p.dataset.yaw) * DEG, Number(p.dataset.pitch) * DEG), view.yaw, view.pitch + rockPitch, proj);
			const visible = !!ndc && Math.abs(ndc[0]) < 0.97 && Math.abs(ndc[1]) < 0.95;
			p.dataset.visible = String(visible);
			if (!ndc) continue;
			const x = (ndc[0] * 0.5 + 0.5) * w;
			const y = (0.5 - ndc[1] * 0.5) * h;
			p.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
			p.dataset.align = x < 170 ? "left" : x > w - 170 ? "right" : "center";
			p.dataset.below = String(y < h * 0.4);
			if (!visible && openPoi === p) setPoi(null);
		}
	}

	// ─── Navigation ─────────────────────────────────────────────────────────
	document.addEventListener("click", (e) => {
		const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[data-nav], a.spot");
		if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		const target = (a.dataset.nav ?? a.dataset.room) as SceneId;
		e.preventDefault();
		if (guide.open) guide.close();
		navigate(target);
	});

	window.addEventListener("popstate", () => {
		const path = location.pathname.slice(config.base.length).replace(/\/$/, "");
		const target = (path && path in roomBySlug ? path : "hub") as SceneId;
		navigate(target, false);
	});

	function zoomToFit(g: PaintingGeometry) {
		const a = aspect();
		const vNeeded = ((g.top - g.bottom) / 0.8) * DEG;
		const hNeeded = ((2 * g.halfWidth) / 0.86) * DEG;
		const vFromH = 2 * Math.atan(Math.tan(hNeeded / 2) / a);
		const fov = Math.max(vNeeded, vFromH, 16 * DEG);
		return fov / ViewController.baseFov(a);
	}

	function setLoadingHint(id: SceneId | null) {
		if (!id) {
			hint.hidden = true;
			return;
		}
		const update = () => {
			const p = Math.round((progress.get(id) ?? 0) * 100);
			hint.textContent = `Stepping into ${sceneTitle(id)}… ${p}%`;
		};
		hint.classList.remove("is-faded");
		hint.hidden = false;
		update();
		progressListeners.add(update);
		return () => {
			progressListeners.delete(update);
		};
	}

	// a request that arrives mid-transition (a click, the browser's back
	// button) is remembered and carried out as soon as the transition ends
	let queued: { target: SceneId; push: boolean } | null = null;

	async function navigate(target: SceneId, push = true) {
		if (busy) {
			queued = { target, push };
			return;
		}
		if (target === current) return;
		busy = true;
		root.classList.add("is-moving");
		spotsNav.inert = true;
		setHovered(null);
		closeAllDetails();
		setPoi(null);
		if (push) history.pushState({ scene: target }, "", href(target));
		const from = current;
		const keyboardFocus = document.activeElement !== document.body && document.activeElement !== look;
		let stopHint: (() => void) | undefined;
		const slow = window.setTimeout(() => {
			if (!loaded.has(target)) stopHint = setLoadingHint(target) || undefined;
		}, 350);

		let ok = true;
		try {
			if (from === "hub" && target !== "hub") await dive(target);
			else if (from !== "hub" && target === "hub") await surface(from);
			else await crossfade(target);
		} catch (err) {
			// stay where we were; the experience remains usable
			console.error(err);
			ok = false;
			renderer.setSlot(1, null);
			view.locked = false;
			if (push) history.replaceState({ scene: from }, "", href(from));
		} finally {
			window.clearTimeout(slow);
			stopHint?.();
			hint.hidden = true;
		}

		const arrived = ok ? target : from;
		current = arrived;
		trans = null;
		mix = 0;
		busy = false;
		root.classList.remove("is-moving");
		spotsNav.inert = false;
		updateDocument(arrived);
		audio.setScene(soundFor(arrived));
		needsRender = true;
		if (keyboardFocus) look.focus({ preventScroll: true });
		live.textContent = !ok
			? `Sorry, ${sceneTitle(target)} could not be loaded.`
			: arrived === "hub"
				? `${config.hub.title}. Four paintings hang around you; press Tab to reach their labels and step inside.`
				: `${sceneTitle(arrived)}: ${roomBySlug[arrived as RoomSlug].title}, by ${roomBySlug[arrived as RoomSlug].artist}.`;
		if (ok && from !== "hub") release(from);
		if (arrived === "hub") showHint();
		window.setTimeout(() => {
			if (current === arrived && !busy) upgrade(arrived);
		}, 2500);
		if (queued) {
			const next = queued;
			queued = null;
			if (next.target !== current) navigate(next.target, next.push);
			else if (!next.push) updateDocument(current);
		}
	}

	async function fly(yaw: number, pitch: number, zoom: number) {
		const y0 = view.yaw, p0 = view.pitch, z0 = view.zoom;
		const dy = angleDelta(y0, yaw);
		const seconds = reduced() ? 0 : clamp(0.75 + (Math.abs(dy) / Math.PI) * 0.7 + Math.abs(p0 - pitch) * 0.4, 0.75, 1.6);
		await animate(seconds, easeInOutCubic, (t) => {
			view.yaw = y0 + dy * t;
			view.pitch = lerp(p0, pitch, t);
			view.zoom = Math.exp(lerp(Math.log(z0), Math.log(zoom), t));
		});
	}

	async function blend(to: SceneId, rotFrom: Float32Array, rotTo: Float32Array, seconds: number, zoomFrom: number, zoomTo: number) {
		trans = { rotA: rotFrom, rotB: rotTo, ripple: !reduced() };
		mix = 0;
		audio.setScene(soundFor(to));
		const rm = reduced();
		await Promise.all([
			animate(rm ? 0.6 : seconds, rm ? easeInOutSine : (t) => t, (t) => (mix = t)),
			(async () => {
				if (rm) {
					view.zoom = zoomTo;
					return;
				}
				await wait(seconds * 0.3);
				await animate(seconds * 1.35, easeInOutCubic, (t) => (view.zoom = Math.exp(lerp(Math.log(zoomFrom), Math.log(zoomTo), t))));
			})(),
		]);
		renderer.promote();
		fxA = fxB;
		fxB = emptyFx();
	}

	/** Hub → room: glide up to the painting, then fall into it. */
	async function dive(slug: RoomSlug) {
		const g = paintingBySlug[slug];
		const room = roomBySlug[slug];
		view.locked = true;
		view.stop();
		const fit = zoomToFit(g);
		const tex = load(slug);
		await fly(g.yaw * DEG, g.pitch * DEG, fit);
		renderer.setSlot(1, await tex);
		fxB = fxFor(slug);
		const fromRot = rotation(g.yaw * DEG, g.pitch * DEG);
		const toRot = rotation(room.view.yaw * DEG, room.view.pitch * DEG);
		await blend(slug, fromRot, toRot, 1.7, fit, 1);
		view.set({ yaw: room.view.yaw * DEG, pitch: room.view.pitch * DEG, zoom: 1 });
		view.locked = false;
	}

	/** Room → hub: the world shrinks back into its frame on the wall. */
	async function surface(from: RoomSlug) {
		const g = paintingBySlug[from];
		const room = roomBySlug[from];
		view.locked = true;
		view.stop();
		const fit = zoomToFit(g);
		const tex = load("hub");
		await fly(room.view.yaw * DEG, room.view.pitch * DEG, fit);
		renderer.setSlot(1, await tex);
		fxB = fxFor("hub");
		const fromRot = rotation(room.view.yaw * DEG, room.view.pitch * DEG);
		const toRot = rotation(g.yaw * DEG, g.pitch * DEG);
		await blend("hub", fromRot, toRot, 1.5, fit, 1);
		view.set({ yaw: g.yaw * DEG, pitch: g.pitch * DEG, zoom: 1 });
		view.locked = false;
	}

	/** Room → room (from the guide or pager): a ripple crossfade. */
	async function crossfade(to: SceneId) {
		view.locked = true;
		view.stop();
		const tex = await load(to);
		renderer.setSlot(1, tex);
		fxB = fxFor(to);
		const v = to === "hub" ? { yaw: 0, pitch: 0 } : roomBySlug[to].view;
		const fromRot = rotation(view.yaw, view.pitch);
		const toRot = rotation(v.yaw * DEG, v.pitch * DEG);
		const z = view.zoom;
		await blend(to, fromRot, toRot, 1.5, z, 1);
		view.set({ yaw: v.yaw * DEG, pitch: v.pitch * DEG, zoom: 1 });
		view.locked = false;
	}

	function soundFor(id: SceneId): SoundId {
		return id === "hub" ? "hub" : roomBySlug[id].audio;
	}

	// ─── Document state per route ───────────────────────────────────────────
	function updateDocument(id: SceneId) {
		const room = id === "hub" ? null : roomBySlug[id];
		document.title = room ? `${room.theme}: ${room.title} — Inside the Frame` : "Inside the Frame — Vol. I — Water";
		pageTitle.textContent = room ? `Room ${room.numeral} — ${room.theme}: ${room.title}` : `Inside the Frame — ${config.hub.title}`;
		wordmarkRoom.textContent = room ? `Room ${room.numeral} — ${room.theme}` : "Vol. I — Water";
		look.setAttribute(
			"aria-label",
			room ? `Room ${room.numeral}, ${room.theme}: 360° view inside ${room.title}` : `${config.hub.title}: 360° view of the gallery`,
		);
		hubSection.hidden = id !== "hub";
		spotsNav.hidden = id !== "hub";
		for (const s of roomSections) s.hidden = s.dataset.route !== id;
		for (const a of $$<HTMLAnchorElement>(".guide-rooms a")) {
			if (a.dataset.nav === id) a.setAttribute("aria-current", "page");
			else a.removeAttribute("aria-current");
		}
		root.style.setProperty("--accent", room ? room.accent : "#e3c48f");
		root.dataset.scene = id;
		if (id === "hub") requestAnimationFrame(measureSpots);
	}

	// ─── Details panel ──────────────────────────────────────────────────────
	function setDetails(slug: string, open: boolean, focus = true) {
		const panel = document.getElementById(`details-${slug}`);
		const btn = document.querySelector<HTMLButtonElement>(`[data-details="${slug}"]`);
		if (!panel || !btn) return;
		panel.dataset.open = String(open);
		btn.setAttribute("aria-expanded", String(open));
		if (open && focus) panel.querySelector<HTMLElement>(".details-close")?.focus({ preventScroll: true });
		if (!open && focus) btn.focus({ preventScroll: true });
	}
	function closeAllDetails() {
		for (const p of $$(".details")) {
			if (p.dataset.open === "true") setDetails(p.id.replace("details-", ""), false, false);
		}
	}
	for (const btn of $$<HTMLButtonElement>("[data-details]")) {
		btn.addEventListener("click", () => setDetails(btn.dataset.details!, btn.getAttribute("aria-expanded") !== "true"));
	}
	for (const btn of $$<HTMLButtonElement>("[data-close-details]")) {
		btn.addEventListener("click", () => setDetails(btn.dataset.closeDetails!, false));
	}
	document.addEventListener("keydown", (e) => {
		if (e.key !== "Escape" || guide.open) return;
		const open = $$(".details").find((p) => p.dataset.open === "true");
		if (open) {
			e.preventDefault();
			setDetails(open.id.replace("details-", ""), false);
		}
	});

	// ─── Guide dialog ───────────────────────────────────────────────────────
	btnGuide.addEventListener("click", () => {
		guide.showModal();
		btnGuide.setAttribute("aria-expanded", "true");
	});
	guide.addEventListener("close", () => {
		btnGuide.setAttribute("aria-expanded", "false");
		needsRender = true;
	});
	guide.querySelector("[data-close-guide]")!.addEventListener("click", () => guide.close());
	guide.addEventListener("click", (e) => {
		// a click on the backdrop lands on the <dialog> itself
		if (e.target === guide) guide.close();
	});

	// ─── Settings ───────────────────────────────────────────────────────────
	function setMotion(on: boolean, save = true) {
		motion = on;
		btnMotion.setAttribute("aria-pressed", String(on));
		btnMotion.setAttribute("aria-label", on ? "Pause animation" : "Play animation");
		if (save) store.set("motion", on ? "on" : "off");
		needsRender = true;
	}
	btnMotion.hidden = false;
	setMotion(motion, false);
	btnMotion.addEventListener("click", () => setMotion(!motion));
	reducedMotionQuery.addEventListener("change", () => {
		if (!store.get("motion")) setMotion(!reducedMotionQuery.matches, false);
	});

	async function setSound(on: boolean) {
		btnSound.setAttribute("aria-pressed", String(on));
		btnSound.setAttribute("aria-label", on ? "Turn sound off" : "Turn sound on");
		store.set("sound", on ? "on" : "off");
		if (on) {
			audio.setScene(soundFor(current));
			try {
				await audio.enable();
			} catch (err) {
				console.warn("audio unavailable", err);
				btnSound.setAttribute("aria-pressed", "false");
			}
		} else audio.disable();
	}
	btnSound.hidden = false;
	btnSound.setAttribute("aria-label", "Turn sound on");
	btnSound.addEventListener("click", () => setSound(btnSound.getAttribute("aria-pressed") !== "true"));

	if (ViewController.gyroSupported()) {
		btnGyro.hidden = false;
		btnGyro.setAttribute("aria-label", "Look around by moving your device");
		btnGyro.addEventListener("click", async () => {
			if (view.gyroActive) {
				view.disableGyro();
				btnGyro.setAttribute("aria-pressed", "false");
			} else if (await view.enableGyro()) {
				btnGyro.setAttribute("aria-pressed", "true");
			}
		});
	}

	if (document.fullscreenEnabled) {
		btnFullscreen.hidden = false;
		const sync = () => {
			const on = !!document.fullscreenElement;
			btnFullscreen.setAttribute("aria-pressed", String(on));
			btnFullscreen.setAttribute("aria-label", on ? "Exit full screen" : "Full screen");
		};
		sync();
		btnFullscreen.addEventListener("click", () => {
			if (document.fullscreenElement) document.exitFullscreen();
			else root.requestFullscreen().catch(() => {});
		});
		document.addEventListener("fullscreenchange", sync);
	}

	document.addEventListener("visibilitychange", () => {
		audio.setPageVisible(!document.hidden);
		last = performance.now();
	});

	// ─── Hint ───────────────────────────────────────────────────────────────
	let hintTimer = 0;
	let hasInteracted = false;
	function showHint() {
		if (hasInteracted) return;
		const coarse = matchMedia("(pointer: coarse)").matches;
		hint.textContent = coarse ? "Swipe to look around · Tap a painting to step inside" : "Drag to look around · Select a painting to step inside";
		hint.hidden = false;
		hint.classList.remove("is-faded");
		window.clearTimeout(hintTimer);
		hintTimer = window.setTimeout(() => hint.classList.add("is-faded"), 7000);
	}
	function interacted() {
		if (hasInteracted || !entered) return;
		hasInteracted = true;
		window.setTimeout(() => hint.classList.add("is-faded"), 1200);
	}
	view.onInteract = interacted;

	// ─── Entering ───────────────────────────────────────────────────────────
	const first = load(current);
	const v0 = current === "hub" ? { yaw: 0, pitch: 0 } : roomBySlug[current].view;
	view.set({ yaw: v0.yaw * DEG, pitch: v0.pitch * DEG, zoom: 1 });
	view.locked = true;
	updateDocument(current);

	Promise.all([first, renderer.ready])
		.then(([tex]) => {
			renderer.setSlot(0, tex);
			fxA = fxFor(current);
			needsRender = true;
			// reveal the canvas once a frame with the panorama has been drawn
			requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add("gl-ready")));
			// warm the HTTP cache with the other scenes so every transition is
			// instant — unless the visitor asked to save data
			const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
			if (!conn?.saveData && !/2g/.test(conn?.effectiveType ?? "")) {
				window.setTimeout(() => {
					const order: SceneId[] = ["hub", ...config.rooms.map((r) => r.slug)];
					order.filter((id) => id !== current).forEach((id, i) => window.setTimeout(() => prefetchScene(id), i * 400));
				}, 2500);
			}
		})
		.catch((err) => {
			console.error(err);
			fallback(err);
			for (const el of behindIntro) el.inert = false;
			intro.hidden = false;
		});

	async function enter(withSound: boolean) {
		if (entered) return;
		entered = true;
		if (withSound) setSound(true);
		else btnSound.setAttribute("aria-pressed", "false");
		intro.classList.add("is-leaving");
		root.classList.remove("is-intro");
		for (const el of behindIntro) el.inert = false;
		window.setTimeout(() => (intro.hidden = true), 1000);
		await first.catch(() => {});
		view.locked = false;
		look.focus({ preventScroll: true });
		if (current === "hub") showHint();
		needsRender = true;
		window.setTimeout(() => upgrade(current), 3000);
	}

	enter(withSound);
	requestAnimationFrame(frame);
}
