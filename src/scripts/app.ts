/**
 * Inside the Frame — client entry.
 *
 * Upgrades the server-rendered document into the immersive experience:
 * WebGL panorama viewer, painting hotspots, transitions between rooms
 * without page reloads, procedural audio and all accessibility plumbing.
 * If WebGL2 is unavailable the page stays a readable document.
 */

import { Soundscape, type SoundId } from "./audio/soundscape";
import { ViewController, type ViewState } from "./engine/camera";
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
	type Vec3,
} from "./engine/math";
import type { Loose } from "./engine/loose";
import type { Overlay } from "./engine/overlay";
import { PanoRenderer, emptyFx, type FxUniforms, type SceneTextures } from "./engine/renderer";
import type { Feature } from "./engine/shaders";
import type { Life } from "./worlds/life";

// ─── Config from the page ─────────────────────────────────────────────────────

type RoomSlug = "wave" | "rain" | "stillness" | "moonlight";
type SceneId = "hub" | RoomSlug;

interface Effects {
	water?: { height: number; strength: number; scale: number; speed: number; drips?: number; float?: number; glints?: number };
	wind?: { amount: number; sun: number };
	rain?: { density: number; angle: number; speed: number };
	flicker?: { strength: number };
	sky?: { shimmer: number; run?: number; speed?: number };
	riding?: [number, number, number, number][];
	brush?: number;
	seam?: boolean;
	grade?: { vignette: number; grain: number };
	boat?: { pitch: number; roll: number; period: number };
	depth?: { amount: number; curve: number };
}

/** Camera move on arriving: where it starts, relative to the scene's opening view, and how long it takes to settle. */
interface Entrance {
	yaw: number; // degrees
	pitch: number;
	dolly: number; // metres travelled forwards
	seconds: number;
}

interface RoomConfig {
	slug: RoomSlug;
	numeral: string;
	theme: string;
	title: string;
	artist: string;
	view: { yaw: number; pitch: number; zoom?: number };
	entrance?: Entrance;
	effects: Effects;
	audio: SoundId;
	pigment: string;
	act?: { hint?: string; caught?: string };
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
	hub: { title: string; effects: Effects; entrance?: Entrance; opening?: Entrance; returning?: Entrance; pigment: string; view: { yaw: number; pitch: number; zoom: number }; geometry: { water: number; paintings: PaintingGeometry[] } };
	rooms: RoomConfig[];
	scenes: Record<string, SceneAssets>;
	registration: Partial<Record<RoomSlug, number[]>>;
	art: Record<RoomSlug, { width: number; avif: string; webp: string }>;
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

/** What lasts for this visit only: whether the prologue has played, which rooms have been seen. */
const visit = {
	get(key: string) {
		try {
			return sessionStorage.getItem(`itf:${key}`);
		} catch {
			return null;
		}
	},
	set(key: string, value: string) {
		try {
			sessionStorage.setItem(`itf:${key}`, value);
		} catch {
			/* storage unavailable: it lasts until the page is left */
		}
	},
};

// ─── Turning the view without dragging ────────────────────────────────────────

/** One click of the look buttons (radians), as [yaw, pitch]; yaw grows to the right, pitch upwards. */
const LOOK_STEP_YAW = 45 * DEG;
const LOOK_STEP_PITCH = 25 * DEG;
const LOOK_STEPS: Record<string, [number, number]> = {
	left: [-LOOK_STEP_YAW, 0],
	right: [LOOK_STEP_YAW, 0],
	up: [0, LOOK_STEP_PITCH],
	down: [0, -LOOK_STEP_PITCH],
};
/** One click of the zoom buttons: the field of view shrinks or grows by this factor. */
const ZOOM_STEP = 1.25;
const LOOK_STEP_SECONDS = 0.45;
const BRING_INTO_VIEW_SECONDS = 0.7;
/** Something with focus counts as comfortably in view inside the central 60 % of the clear area. */
const COMFORT_MARGIN = 0.2;
/** Points-of-interest notes: distance from the point (as `--poi-gap` in global.css), and room kept free around them. */
const NOTE_GAP_REM = 1.9;
const NOTE_MARGIN = 8;
/** Below this height (px) a note that fits neither above nor below its point covers the point instead of shrinking further. */
const NOTE_MIN_HEIGHT = 112;

// ─── Parallax ─────────────────────────────────────────────────────────────────

/** The eyes sit in front of the point the head turns about (metres): turning the view moves them. */
const NECK = 0.1;
/** How far the eye follows the mouse to each side, and up and down (metres). */
const SWAY_X = 0.11;
const SWAY_Y = 0.06;
/** Mirrors MAX_SHIFT in the shader. */
const MAX_SHIFT = 0.14;
/** Used where a scene sets no depth of its own. */
const DEFAULT_DEPTH = { amount: 1, curve: 1 };

// ─── Boot ─────────────────────────────────────────────────────────────────────

function fallback(reason: unknown) {
	console.warn("[inside-the-frame] staying in document mode:", reason);
	root.classList.remove("immersive", "is-intro", "gl-ready", "is-moving");
}

let renderer: PanoRenderer;

/** First scene, downloaded and decoded during the title screen (no GPU yet). */
const predecoded = new Map<SceneId, Promise<{ bitmap: ImageBitmap; mask: ImageBitmap | null; depth: ImageBitmap | null }>>();
const firstProgress = { value: 0, listeners: new Set<() => void>() };

const SETTLE_IDLE_TIMEOUT_MS = 1500;
// Pages loaded in a background tab never report their largest paint.
const MAIN_PAINT_TIMEOUT_MS = 2500;

function pageLoaded(): Promise<void> {
	if (document.readyState === "complete") return Promise.resolve();
	return new Promise((resolve) => addEventListener("load", () => resolve(), { once: true }));
}

/** First paint of the title screen's main content, where the browser reports it. */
function mainContentPainted(): Promise<void> {
	if (!PerformanceObserver.supportedEntryTypes?.includes("largest-contentful-paint")) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			observer.disconnect();
			clearTimeout(timer);
			resolve();
		};
		const observer = new PerformanceObserver(done);
		const timer = setTimeout(done, MAIN_PAINT_TIMEOUT_MS);
		observer.observe({ type: "largest-contentful-paint", buffered: true });
	});
}

function browserIdle(): Promise<void> {
	return new Promise((resolve) => {
		if ("requestIdleCallback" in window) requestIdleCallback(() => resolve(), { timeout: SETTLE_IDLE_TIMEOUT_MS });
		else setTimeout(resolve, 0);
	});
}

/**
 * Resolves once the title screen is on screen with its fonts and the browser
 * is idle. On a slow phone, a panorama fetched any earlier holds back the
 * title itself: Stillness's 4k panorama is 640 KB.
 */
function titleScreenSettled(): Promise<void> {
	return Promise.all([pageLoaded(), document.fonts.ready, mainContentPainted()]).then(browserIdle);
}

if (typeof createImageBitmap !== "function" || !("WebGL2RenderingContext" in window)) {
	fallback("WebGL2 or createImageBitmap unavailable");
} else {
	prepare();
}

/**
 * Title screen. Nothing touches the GPU yet: the still image is on screen
 * and, once it has settled, the first panorama downloads and decodes in the
 * background. WebGL is
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
			await titleScreenSettled();
			const url = config.base + resolveUrl(assets, tier, await supportsAvif());
			const maskUrl = assets.mask ? config.base + assets.mask : null;
			const depthUrl = assets.depth ? config.base + assets.depth.url : null;
			const [blob, maskBlob, depthBlob] = await Promise.all([
				fetchBlob(url, (f) => {
					firstProgress.value = f;
					for (const l of firstProgress.listeners) l();
				}),
				maskUrl ? fetchBlob(maskUrl) : null,
				depthUrl ? fetchBlob(depthUrl) : null,
			]);
			const [bitmap, mask, depth] = await Promise.all([
				decode(blob),
				maskBlob ? decode(maskBlob) : null,
				// the scene works without it, only flatter
				depthBlob ? decode(depthBlob).catch(() => null) : null,
			]);
			return { bitmap, mask, depth };
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
	const bar = $("#bar");
	const lookControls = $("#look-controls");
	const lookPad = $("#look-pad");
	const btnLook = $<HTMLButtonElement>("#btn-look");
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
	/** The last painting pointed at, while its light goes down. */
	let hoveredLast: RoomSlug | null = null;
	let hoverAmount = 0;
	let fxA: FxUniforms = emptyFx();
	let fxB: FxUniforms = emptyFx();
	let mix = 0;
	let match: { amount: number; worldIsB: boolean; plane: [number, number, number, number]; y: number; grid: Float32Array } | null = null;
	let trans: { to: SceneId; rotA: Float32Array; rotB: ReturnType<typeof rotation>; ripple: boolean; close: boolean } | null = null;
	/** Pigment for the transition under way: linear rgb and strength. */
	let ink: [number, number, number, number] = [0, 0, 0, 0];
	const rotA = new Float32Array(9);
	const eyeA = new Float32Array([0, 0, 0, 1]);
	const eyeB = new Float32Array([0, 0, 0, 1]);
	/** Where the mouse is over the page (-1..1), and the eye's eased position towards it. */
	const sway = { x: 0, y: 0, goalX: 0, goalY: 0 };
	/** 0..1: parallax eases out when animation is paused, so nothing moves on its own or with the pointer. */
	let parallaxAmount = 0;
	/** Metres still to travel in the arriving scene, along dollyDir. */
	let dolly = 0;
	let dollyDir: Vec3 = [0, 0, 1];
	let heave = 0;
	const drips = new Float32Array(32);
	const rocks = new Float32Array(28);
	let dripIndex = 0;
	let boatAmount = 0;
	let nextDrip = 2;
	/** The prologue holds the camera on the water. */
	let holding = false;
	/** The closing note is up and the visitor has not moved yet. */
	let turning = false;
	/** Until this time (scene seconds) drops fall thick and fast. */
	let downpour = 0;
	const center: [number, number] = [0, 0];

	const reduced = () => reducedMotionQuery.matches;
	/** How close a scene opens (1 is the widest comfortable view). */
	const zoomFor = (id: SceneId) => (id === "hub" ? config.hub.view.zoom : (roomBySlug[id].view.zoom ?? 1));
	const href = (id: SceneId) => (id === "hub" ? config.base : `${config.base}${id}/`);
	const sceneTitle = (id: SceneId) => (id === "hub" ? config.hub.title : `Room ${roomBySlug[id].numeral} — ${roomBySlug[id].theme}`);

	function fxFor(id: SceneId): FxUniforms {
		const e = id === "hub" ? config.hub.effects : roomBySlug[id].effects;
		const fx = emptyFx();
		if (e.water) {
			fx.water = [e.water.strength, e.water.height, e.water.scale, e.water.speed];
			fx.grade[2] = e.water.drips ?? 0;
			fx.live[2] = e.water.float ?? 0;
			fx.air[2] = e.water.glints ?? 0;
		}
		if (e.rain) fx.rain = [e.rain.density, e.rain.angle * DEG, e.rain.speed, 1];
		if (e.flicker) fx.light[0] = e.flicker.strength;
		if (e.sky) {
			fx.light[1] = e.sky.shimmer;
			fx.live[1] = (e.sky.run ?? 0) * DEG;
		}
		if (e.wind) {
			fx.live[0] = e.wind.amount * DEG;
			fx.air[1] = e.wind.sun;
		}
		fx.air[0] = e.riding ? 1 : 0;
		fx.air[3] = sceneAssets(id).depth?.near ?? 1;
		fx.darks[3] = e.brush ?? 0;
		// what the sky turns about: the moon, or nothing (it goes by)
		fx.mood = id === "moonlight" ? [0, 0, -10 * DEG, 20.5 * DEG] : [0, 0, Math.PI, -1];
		if (e.seam) fx.light[2] = 1;
		if (e.grade) {
			fx.grade[0] = e.grade.vignette;
			fx.grade[1] = e.grade.grain;
		}
		return fx;
	}

	/** What each scene asks of the shader (see shaders.ts). */
	const FEATURES: Record<SceneId, readonly Feature[]> = {
		hub: ["GALLERY", "DRIPS"],
		wave: ["SHEET", "SKY"],
		rain: ["SHEET", "RAIN"],
		stillness: ["WIND", "HOUR", "DRIPS", "GLINTS"],
		moonlight: ["SHEET", "SKY", "RIDE", "FIRES", "DRIPS", "GLINTS", "SEAM"],
	};

	// ─── Scene loading ──────────────────────────────────────────────────────
	const loaded = new Map<SceneId, SceneTextures>();
	const loading = new Map<SceneId, Promise<SceneTextures>>();
	const progress = new Map<SceneId, number>();
	const progressListeners = new Set<() => void>();
	let hintTimer = 0;

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
			// the driver can start on its program while the pictures come
			renderer.prepare(FEATURES[id]);
			const ready = await predecoded.get(id)?.catch(() => null);
			predecoded.delete(id);
			let bitmap: ImageBitmap;
			let maskBitmap: ImageBitmap | null;
			let depthBitmap: ImageBitmap | null;
			if (ready && ready.bitmap.width <= renderer.maxTextureSize) {
				({ bitmap, mask: maskBitmap, depth: depthBitmap } = ready);
			} else {
				const assets = sceneAssets(id);
				const url = config.base + resolveUrl(assets, tier, await avif);
				const maskUrl = assets.mask ? config.base + assets.mask : null;
				const depthUrl = assets.depth ? config.base + assets.depth.url : null;
				const report = (f: number) => {
					progress.set(id, f);
					for (const l of progressListeners) l();
				};
				const [blob, maskBlob, depthBlob] = await Promise.all([
					fetchBlob(url, report),
					maskUrl ? fetchBlob(maskUrl) : null,
					depthUrl ? fetchBlob(depthUrl).catch(() => null) : null,
				]);
				[bitmap, maskBitmap, depthBitmap] = await Promise.all([
					decode(blob),
					maskBlob ? decode(maskBlob) : null,
					depthBlob ? decode(depthBlob).catch(() => null) : null,
				]);
			}
			const pano = await renderer.uploadTexture(bitmap, { srgb: true, mipmaps: true });
			const mask = maskBitmap ? await renderer.uploadTexture(maskBitmap, { srgb: false, mipmaps: true, stripRows: 4096 }) : null;
			const depth = depthBitmap ? await renderer.uploadTexture(depthBitmap, { srgb: false, mipmaps: true, stripRows: 4096, grey: true }) : null;
			if (depthBitmap) measurePoiDepths(id, depthBitmap);
			const overlay = await makeOverlay(id);
			const features = FEATURES[id];
			await renderer.prepare(features).ready;
			const textures: SceneTextures = { pano, mask, depth, overlay, features, near: sceneAssets(id).depth?.near ?? 1, width: bitmap.width };
			bitmap.close();
			maskBitmap?.close();
			depthBitmap?.close();
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
			const sharper: SceneTextures = { ...old, pano, width: 8192 };
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
		renderer.deleteTexture(t.depth);
		t.overlay?.dispose();
		if (t.overlay && t.overlay === overlayNow) {
			overlayNow = null;
			crowd = null;
			drawnRoom = null;
		}
		loaded.delete(id);
		upgraded.delete(id);
	}

	// ─── Time runs ──────────────────────────────────────────────────────────
	// What moves in a room starts at the instant of the picture, and runs by
	// itself: the wave comes down and rises again, the people in the rain run,
	// a day goes by over the pond, the fires on the river rise and sink. Where
	// there is one clock, it stands a while each time it comes back to the
	// instant the painter chose. Pausing the animation stops all of it.
	let overlayNow: Overlay | null = null;
	let crowd: typeof import("./worlds/sudden-shower") | null = null;
	/** Seconds each party in the rain has run, and how fast its clock is going (0..1). */
	let clocks = new Float32Array(0);
	let paces = new Float32Array(0);
	/** Where the clock of the room stands (0 is the picture), how fast it goes (0..1), and how long it still rests there. */
	const tide = { t: 0, rate: 0, rest: 0, home: false };
	/** How long the picture is left to be looked at: on arriving, and each time round. */
	const REST_FIRST = 2.2;
	const REST = { wave: 5, stillness: 9 } as const;
	/** Between scenes, or before anything has been entered, nothing starts. */
	const running = () => motion && entered && !trans && !busy && root.classList.contains("gl-ready");
	/** Seconds from one wave to the next, and from one afternoon to the next. */
	const tideSeconds = () => (current === "stillness" ? 24 : 12);
	/** One clock runs the room on screen: the wave's, or the day's. */
	const clocked = () => current === "stillness" || drawnRoom === "wave";
	/** This close to the instant of the picture (fraction of the cycle), it slows down to stand on it. */
	const TIDE_CATCH = 0.06;

	/** Seconds the keelmen have worked, how fast they go, and the two lights of their river. */
	const river = { seconds: 0, pace: 0, fire: 0, moon: 0 };
	let drawnRoom: SceneId | null = null;
	const sheetState = () => (crowd ? clocks : drawnRoom === "moonlight" ? [river.seconds, aliveFor] : [tide.t]);

	// ─── What is loose in the air ───────────────────────────────────────────
	// Leaves, smoke, spray: strokes drawn over the panorama (engine/loose.ts).
	let loose: Loose | null = null;
	let hours: typeof import("./worlds/hours") | null = null;
	let wave: typeof import("./worlds/great-wave") | null = null;
	const lives = new Map<SceneId, Life>();
	/** Seconds the room on screen has been alive, how far its air has come in, and the clock of its sky. */
	let aliveFor = 0;
	let presence = 0;
	let skyClock = 0;

	async function makeLife(id: SceneId) {
		if (id !== "wave" && id !== "stillness" && id !== "moonlight") return;
		const [engine, worlds, light] = await Promise.all([
			import("./engine/loose"),
			import("./worlds/life"),
			id === "stillness" ? import("./worlds/hours") : null,
		]);
		hours = light ?? hours;
		loose ??= new engine.Loose(renderer.gl);
		lives.set(id, id === "wave" ? worlds.spray() : id === "stillness" ? worlds.garden() : worlds.river());
	}

	function drawLoose(dt: number) {
		const here = entered && !trans && !busy;
		presence = here && !motion ? 1 : presence + ((here ? 1 : 0) - presence) * Math.min(1, dt * (here ? 0.9 : 5));
		const life = lives.get(current);
		if (!life || !loose || presence < 0.004) return;
		const proj = currentProjection();
		const rot = trans ? trans.rotA : rotA;
		const count = life(loose.data, {
			time: aliveFor,
			dt: motion ? dt : 0,
			presence,
			clock: tide.t,
			fire: river.fire,
			lights: fxA.lights,
			drop: (x, z, strength) => dropAt(x, z, strength),
		});
		const tex = renderer.getSlot(0);
		loose.draw(count, { rot, eye: eyeA, near: tex?.near ?? 1, depth: tex?.depth ?? null, aspect: renderer.canvas.width / renderer.canvas.height, fovV: proj.fovV, stereo: proj.stereo });
	}

	/** The light over the pond at the hour it has come to. */
	function lightHour(fx: FxUniforms) {
		if (!hours) return;
		const h = hours.hour(tide.t);
		const still = fxFor("stillness");
		fx.lights = [...h.lights, h.saturation];
		fx.darks = [...h.darks, 0];
		fx.mist = [...h.mist, h.fog];
		fx.live[0] = still.live[0] * h.wind;
		fx.air[1] = h.sun;
		fx.air[2] = h.glints;
		fx.light[3] = h.calm;
		if (Math.abs(h.calm - calmHeard) > 0.02) audio.setCalm((calmHeard = h.calm));
	}
	let calmHeard = 0;

	async function makeOverlay(id: SceneId): Promise<Overlay | null> {
		await makeLife(id).catch(() => {});
		if (id !== "wave" && id !== "rain" && id !== "moonlight") return null;
		const [{ Overlay }, sheet] = await Promise.all([
			import("./engine/overlay"),
			id === "wave" ? import("./worlds/great-wave") : id === "rain" ? import("./worlds/sudden-shower") : import("./worlds/keelmen"),
		]);
		const wanted = bestTier === "8k" ? 4096 : bestTier === "2k" ? 2048 : matchMedia("(pointer: coarse)").matches ? 2560 : 3072;
		const before = crowd, beforeRoom = drawnRoom;
		crowd = "PARTIES" in sheet ? sheet : null;
		if (id === "wave") wave = sheet as typeof import("./worlds/great-wave");
		drawnRoom = id;
		Object.assign(river, { seconds: 0, pace: 0, fire: 0, moon: 0 });
		clocks = new Float32Array(crowd?.PARTIES.length ?? 0);
		paces = new Float32Array(clocks.length);
		resetTide();
		try {
			// the men on the river are touches of paint: no sharper than the paint round them
			const width = id === "moonlight" ? Math.min(wanted, 2500) : wanted;
			const made = await Overlay.create(renderer.gl, Math.min(width, renderer.maxTextureSize), sheet, sheetState());
			overlayNow = made;
			return made;
		} catch (err) {
			crowd = before;
			drawnRoom = beforeRoom;
			throw err;
		}
	}

	function resetTide() {
		Object.assign(tide, { t: 0, rate: 0, rest: REST_FIRST, home: false });
	}

	function updateTide(dt: number): boolean {
		if (!clocked()) {
			if (crowd) return updateCrowd(dt);
			return drawnRoom === "moonlight" && updateRiver(dt);
		}
		const before = tide.t;
		if (tide.home) {
			// back to the instant of the picture, for leaving the room
			const toPicture = tide.t > 0.5 ? 1 - tide.t : -tide.t;
			tide.rate = 0;
			tide.t += toPicture * Math.min(1, dt * 5);
			if (Math.abs(toPicture) < 0.0005) tide.t = 0;
		} else if (!running()) {
			tide.rate = 0;
		} else if (tide.rest > 0) {
			tide.rest -= dt;
		} else {
			// time gathers way, and slows as it comes round
			tide.rate += (1 - tide.rate) * Math.min(1, dt * 2.4);
			tide.t += ((tide.rate * dt) / tideSeconds()) * clamp((1 - tide.t) / TIDE_CATCH, 0.14, 1);
			if (tide.t >= 1) {
				Object.assign(tide, { t: 0, rate: 0, rest: current === "stillness" ? REST.stillness : REST.wave });
				sayOnce("caught");
			}
		}
		if (tide.t >= 1) tide.t -= 1;
		if (tide.t < 0) tide.t += 1;
		// what is heard: the lip gathering, then the break
		if (current === "wave" && tide.rate > 0) {
			if (before < 0.07 && tide.t >= 0.07) audio.gather(-14, tideSeconds() * 0.2);
			if (before < 0.285 && tide.t >= 0.285) audio.breaker(-10);
		}
		return tide.t !== before;
	}

	// The river has two lights, and the men are always at work between them. In turn the fires blaze up
	// and the men heave harder; then the fires sink, the work slows, and the road of the moon runs bright
	// over the water. Looked at, either of them holds.
	const RIVER_SECONDS = 24;
	function updateRiver(dt: number): boolean {
		const here = current === "moonlight" && running();
		const toward = (yaw: number, pitch: number) => Math.hypot(angleDelta(view.yaw, yaw * DEG) * Math.cos(view.pitch), view.pitch - pitch * DEG) / DEG;
		const lookFires = here ? 1 - clamp((toward(37, 0) - 13) / 12, 0, 1) : 0;
		const lookMoon = here ? 1 - clamp((toward(-10, 17) - 9) / 12, 0, 1) : 0;
		const turn = here ? Math.sin(((aliveFor - 3) * 2 * Math.PI) / RIVER_SECONDS) : 0;
		const atFires = Math.max(lookFires, clamp(turn * 1.6, 0, 1) * (1 - lookMoon));
		const atMoon = Math.max(lookMoon, clamp(-turn * 1.6, 0, 1) * (1 - lookFires));
		// paused, it all stays as it is
		if (!motion) return false;
		const before = river.pace + river.fire + river.moon;
		const ease = Math.min(1, dt * 1.6);
		const pace = atFires > 0.4 ? 1 : here ? 0.6 - 0.42 * atMoon : 0;
		river.pace += (pace - river.pace) * Math.min(1, dt * 2.4);
		if (river.pace < 0.003) river.pace = 0;
		river.fire += (atFires * 0.85 - atMoon * 0.6 - river.fire) * ease;
		river.moon += (atMoon - river.moon) * ease;
		const heaved = Math.floor(river.seconds / 1.15);
		if (Math.abs(river.fire - fireHeard) > 0.02) audio.setFire((fireHeard = river.fire));
		river.seconds += river.pace * dt;
		if (river.pace > 0.8 && Math.floor(river.seconds / 1.15) !== heaved) audio.shovel(30 + Math.random() * 20);
		return river.pace > 0 || Math.abs(river.pace + river.fire + river.moon - before) > 1e-5;
	}

	function updateCrowd(dt: number): boolean {
		// paused, they are caught again in mid-stride
		if (!motion) return false;
		let moved = false;
		const here = current === "rain" && running();
		if (here && tide.rest > -9) tide.rest -= dt;
		for (let i = 0; i < clocks.length; i++) {
			// not all of them at once
			const goal = here && tide.rest <= -0.22 * ((i * 5) % 9) ? 1 : 0;
			paces[i] += (goal - paces[i]) * Math.min(1, dt * 3.2);
			if (paces[i] < 0.004) paces[i] = 0;
			if (paces[i] > 0) {
				const before = clocks[i];
				clocks[i] += paces[i] * dt;
				moved = true;
				// a foot comes down twice in each swing of the legs
				const p = crowd!.PARTIES[i];
				const beats = (s: number) => Math.floor((s * p.pace * 2.6 + 1) / Math.PI);
				if (beats(before) !== beats(clocks[i])) {
					const [yaw, pitch] = crowd!.bearing(i, clocks[i]);
					audio.step(yaw, pitch, 18 / Math.max(0.2, Math.sin(-pitch)));
				}
			}
		}
		return moved;
	}

	/** The room's words for this, the first time on a visit. */
	function sayOnce(which: "hint" | "caught") {
		const text = current === "hub" ? undefined : roomBySlug[current].act?.[which];
		const key = `${which}:${current}`;
		if (!text || visit.get(key) === "yes") return;
		visit.set(key, "yes");
		say(text, which === "hint" ? 5000 : 4200);
		live.textContent = text;
	}

	/** A line over the view for a while. */
	function say(text: string, ms: number) {
		hint.textContent = text;
		hint.hidden = false;
		hint.classList.remove("is-faded");
		window.clearTimeout(hintTimer);
		hintTimer = window.setTimeout(() => hint.classList.add("is-faded"), ms);
	}

	// Lines read over the view come up word by word. The words are for the eye only: the text itself is
	// announced whole.
	for (const line of $$(".prologue-line")) {
		const words = line.textContent!.trim().split(/\s+/);
		line.textContent = "";
		words.forEach((w, i) => {
			const s = document.createElement("span");
			s.className = "word";
			s.style.setProperty("--i", String(i));
			const inner = document.createElement("span");
			inner.textContent = w;
			s.append(inner);
			line.append(s, " ");
		});
	}

	function prefetchScene(id: SceneId) {
		if (loaded.has(id)) return;
		const assets = sceneAssets(id);
		avif.then((a) => prefetch(config.base + resolveUrl(assets, tier, a)));
		if (assets.depth) prefetch(config.base + assets.depth.url);
	}

	renderer.onRestored = () => {
		// GPU textures were lost with the context: reload what is on screen.
		loaded.clear();
		loose = null;
		artTextures.clear();
		artSlug = artWanted = null;
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
		if (!entered && motion && !busy && !holding) view.yaw += dt * 0.022;
		// the closing note: the gallery turns slowly until the visitor takes over
		if (turning && motion && !busy) view.yaw += dt * 0.045;

		// in the gallery the paintings at the sides keep their shape; eased in and out around a crossing
		view.soften += ((current === "hub" && !busy ? 0.62 : 0) - view.soften) * Math.min(1, dt * 3);
		if (view.soften < 0.001) view.soften = 0;
		const moved = view.update(dt);
		// ease the rocking in after arriving, and out while transitions run
		const rockTarget = motion && !trans && !busy ? 1 : 0;
		boatAmount += (rockTarget - boatAmount) * Math.min(1, dt * 0.8);
		// the eye drifts after the mouse, and comes to rest when animation is paused
		const parallaxTarget = motion ? 1 : 0;
		const parallaxChanging = Math.abs(parallaxAmount - parallaxTarget) > 0.001;
		parallaxAmount += (parallaxTarget - parallaxAmount) * Math.min(1, dt * 3);
		const swaying = Math.abs(sway.goalX - sway.x) + Math.abs(sway.goalY - sway.y) > 0.0005;
		const k = Math.min(1, dt * 2.6);
		sway.x += (sway.goalX - sway.x) * k;
		sway.y += (sway.goalY - sway.y) * k;
		const hoverTarget = hovered && current === "hub" && !trans ? 1 : 0;
		const hoverChanging = Math.abs(hoverAmount - hoverTarget) > 0.001;
		hoverAmount += (hoverTarget - hoverAmount) * Math.min(1, dt * 8);

		if (current === "hub" && motion) updateDrips();
		updateStains(dt);
		if (current === "hub" || chordOn) {
			chordOn = current === "hub" && entered;
			audio.setChord(chordOn ? stainNow.map((v, i) => v * (0.55 + 0.75 * spreadNow[i])) : [0, 0, 0, 0]);
		}
		updateArt(dt);
		const tideMoved = updateTide(dt);

		if (motion) aliveFor += dt;
		const sky = current === "hub" ? undefined : roomBySlug[current].effects.sky;
		// over the wave the sky stands with it
		if (sky?.speed && !trans) skyClock += dt * sky.speed * (current === "wave" ? tide.rate : motion ? 1 : 0);

		const airComing = lives.has(current) && entered && !trans && !busy && presence < 0.99;
		const animating = motion || airComing || tideMoved || artChanging || tweens.size > 0 || hoverChanging || parallaxChanging || swaying || !entered;
		if (moved || animating || needsRender) {
			draw(dt);
			needsRender = false;
			perfAcc += dt;
			perfFrames++;
		}
		updateSpots();
		updatePois();
		audio.setListener(view.yaw, view.pitch);
		adaptResolution();
	}

	function draw(dt: number) {
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
			let lift = 0;
			if (current === "wave" && !reduced() && tide.t > 0.2) {
				// the water the wave throws out takes the boat up, and lets it down
				const beat = (at: number, w: number) => Math.exp(-(((tide.t - at) / w) ** 2));
				dp += DEG * (3.4 * beat(0.37, 0.05) - 2.6 * beat(0.47, 0.06) + 1.2 * beat(0.57, 0.05));
				roll += DEG * (-3.2 * beat(0.35, 0.05) + 3.6 * beat(0.44, 0.06) - 1.6 * beat(0.55, 0.06));
				lift = 0.3 * beat(0.41, 0.07) - 0.12 * beat(0.53, 0.06);
			}
			// the boat lifts and settles as it rocks
			heave = lift + (boat ? 0.035 * Math.sin(time * ((2 * Math.PI) / boat.period) * 0.83 + 0.4) * boatAmount : 0);
			rotation(view.yaw, view.pitch + dp, rotA, roll);
			setEye(eyeA, current, rotA, true);
		} else {
			// the camera of the scene arriving is live: its entrance has already begun
			rotation(view.yaw, view.pitch, trans.rotB);
			heave = 0;
			setEye(eyeA, current, trans.rotA, false);
			setEye(eyeB, trans.to, trans.rotB, true);
		}
		overlayNow?.print(sheetState());
		const fx = fxA;
		lightPainting(current === "hub" ? fxA : null, trans ? 0 : hoverAmount);
		if (current === "stillness") lightHour(fx);
		if (current === "moonlight") fx.mood = [river.fire, river.moon, -10 * DEG, 20.5 * DEG];
		fx.live[3] = skyClock;
		if (trans?.to === "hub") lightPainting(fxB, 0);
		const riding = roomBySlug[(trans && trans.to !== "hub" ? trans.to : current) as RoomSlug]?.effects.riding;
		for (let i = 0; i < 7; i++) {
			const r = riding?.[i];
			for (let k = 0; k < 4; k++) rocks[i * 4 + k] = r ? r[k] * (k < 3 ? DEG : 1) : 0;
		}
		renderer.render({
			rotA: trans ? trans.rotA : rotA,
			rotB: trans ? trans.rotB : rotA,
			eyeA,
			eyeB: trans ? eyeB : eyeA,
			fxA: fx,
			fxB,
			fovV: proj.fovV,
			stereo: proj.stereo,
			mix,
			ripple: trans?.ripple ?? false,
			center,
			ink,
			close: trans?.close ?? false,
			time,
			drips,
			rocks,
			stains,
			stainInks,
			stainGlow,
			match,
		});
		drawLoose(dt);
	}

	// ─── Parallax ───────────────────────────────────────────────────────────
	function depthFor(id: SceneId) {
		return (id === "hub" ? config.hub.effects.depth : roomBySlug[id].effects.depth) ?? DEFAULT_DEPTH;
	}

	/**
	 * Where the eye is, relative to the point the panorama was rendered from,
	 * for the shader: in units of the scene's nearest surface. It leads the
	 * turn of the head, leans after the mouse, rides the boat and, on
	 * arriving, travels the last stretch into the scene.
	 */
	function setEye(out: Float32Array, id: SceneId, rot: Float32Array, arriving: boolean) {
		const near = sceneAssets(id).depth?.near;
		const depth = depthFor(id);
		if (!near || parallaxAmount <= 0) {
			out[0] = out[1] = out[2] = 0;
			out[3] = 1;
			return;
		}
		const sx = sway.x * SWAY_X;
		const sy = sway.y * SWAY_Y;
		const travel = arriving ? dolly : 0;
		const k = (depth.amount * parallaxAmount) / near;
		// rot holds the camera's right, up and forward axes
		out[0] = (rot[6] * NECK + rot[0] * sx + rot[3] * sy - dollyDir[0] * travel) * k;
		out[1] = (rot[7] * NECK + rot[1] * sx + rot[4] * sy + (arriving ? heave : 0)) * k;
		out[2] = (rot[8] * NECK + rot[2] * sx + rot[5] * sy - dollyDir[2] * travel) * k;
		out[3] = depth.curve;
	}

	/** Direction in which the eye sees a point of the panorama, given the point's disparity (the shader's mapping, turned around). */
	function seenFrom(dir: Vec3, disparity: number): Vec3 {
		const s = Math.pow(disparity, eyeA[3]);
		let x = eyeA[0] * s, y = eyeA[1] * s, z = eyeA[2] * s;
		const soft = 1 / (1 + Math.hypot(x, y, z) / MAX_SHIFT);
		x = dir[0] - x * soft;
		y = dir[1] - y * soft;
		z = dir[2] - z * soft;
		const len = Math.hypot(x, y, z) || 1;
		return [x / len, y / len, z / len];
	}

	// Each point of interest moves with the surface it marks: read its
	// disparity from the depth map once, when the scene loads.
	const poiDisparity = new Map<HTMLElement, number>();
	function measurePoiDepths(id: SceneId, depth: ImageBitmap) {
		if (id === "hub") return;
		const points = $$<HTMLElement>(`#room-${id} .poi`);
		if (!points.length) return;
		if (id === "wave" || id === "rain") {
			// their points are on the drawing, which stands at one distance (PLACE.distance in worlds/)
			for (const p of points) poiDisparity.set(p, (sceneAssets(id).depth?.near ?? 0) / 34);
			return;
		}
		try {
			const canvas = document.createElement("canvas");
			canvas.width = canvas.height = 1;
			const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
			for (const p of points) {
				const u = Number(p.dataset.yaw) / 360 + 0.5;
				const v = 0.5 - Number(p.dataset.pitch) / 180;
				ctx.drawImage(depth, clamp(u * depth.width, 0, depth.width - 1), clamp(v * depth.height, 0, depth.height - 1), 1, 1, 0, 0, 1, 1);
				poiDisparity.set(p, ctx.getImageData(0, 0, 1, 1).data[0] / 255);
			}
		} catch {
			/* the points stay where the panorama has them */
		}
	}

	// the mouse leans the eye; touch and pen turn the head, which moves it too
	window.addEventListener("pointermove", (e) => {
		if (e.pointerType !== "mouse" || e.buttons !== 0) return;
		sway.goalX = clamp((e.clientX / window.innerWidth) * 2 - 1, -1, 1);
		sway.goalY = clamp(1 - (e.clientY / window.innerHeight) * 2, -1, 1);
	});
	document.documentElement.addEventListener("pointerleave", () => {
		sway.goalX = sway.goalY = 0;
	});

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
		nextDrip = time + (time < downpour ? 0.25 + Math.random() * 0.5 : 1.8 + Math.random() * 4.5);
		let x = 0, z = 0;
		do {
			x = (Math.random() * 2 - 1) * 4.2;
			z = Math.random() * 6.6 - 1.8;
			// not on the dais, nor on the walk to the door
		} while (Math.hypot(x, z) > 5 || (Math.abs(x) < 1.1 && Math.abs(z) < 1.1) || (Math.abs(x) < 0.7 && z < 0));
		dropAt(x, z, 0.6 + Math.random() * 0.6);
		audio.drip(x, -config.hub.geometry.water, z);
	}

	/** Rings spread from here on the water of the scene. */
	function dropAt(x: number, z: number, strength: number) {
		if (motion) drips.set([x, z, time, strength], (dripIndex++ % 8) * 4);
	}

	// The water answers whoever touches it: rings follow the pointer over it, and a tap drops on it.
	let lastTouch = { x: 0, z: 0, at: 0, heard: 0 };
	function touchWater(clientX: number, clientY: number, tapped: boolean) {
		const water = (current === "hub" ? config.hub.effects : roomBySlug[current].effects).water;
		if (!water?.drips || busy || trans || !entered || !motion) return;
		const rect = look.getBoundingClientRect();
		const d = toWorld(rotA, screenRay(((clientX - rect.left) / rect.width) * 2 - 1, 1 - ((clientY - rect.top) / rect.height) * 2, currentProjection()));
		if (d[1] > -0.06) return;
		const out = water.height / -d[1];
		const x = d[0] * out, z = d[2] * out, dist = Math.hypot(x, z);
		const now = performance.now();
		const gone = Math.hypot(x - lastTouch.x, z - lastTouch.z);
		if (dist > 16 || (!tapped && (gone < 0.1 + dist * 0.07 || now - lastTouch.at < 110))) return;
		dropAt(x, z, tapped ? 1.5 : 0.55);
		if (tapped || now - lastTouch.heard > 420) {
			audio.drip(x, -water.height, z, tapped ? 1 : 0.35);
			lastTouch.heard = now;
		}
		Object.assign(lastTouch, { x, z, at: now });
	}
	look.addEventListener("pointermove", (e) => touchWater(e.clientX, e.clientY, false));
	look.addEventListener("pointerdown", (e) => touchWater(e.clientX, e.clientY, true));

	// ─── The painting approached ────────────────────────────────────────────
	// The panorama gives a painting a few hundred pixels. The one pointed at,
	// or being entered or left, borrows the detail of its own picture.
	const artTextures = new Map<RoomSlug, Promise<WebGLTexture>>();
	let artSlug: RoomSlug | null = null;
	let artWanted: RoomSlug | null = null;
	let artAmount = 0;
	let artChanging = false;

	function wantArt(slug: RoomSlug) {
		if (artWanted === slug) return;
		artWanted = slug;
		let tex = artTextures.get(slug);
		if (!tex) {
			tex = (async () => {
				const a = config.art[slug];
				const bitmap = await decode(await fetchBlob(config.base + ((await avif) ? a.avif : a.webp), undefined, "low"));
				const t = await renderer.uploadTexture(bitmap, { srgb: true, mipmaps: true, stripRows: 4096 });
				bitmap.close();
				return t;
			})();
			artTextures.set(slug, tex);
			tex.catch(() => artTextures.delete(slug));
		}
		tex.then(
			(t) => {
				if (artWanted !== slug) return;
				artSlug = slug;
				artAmount = 0;
				renderer.art = t;
			},
			() => {},
		);
	}

	function updateArt(dt: number) {
		const goal = artSlug && artSlug === artWanted ? 1 : 0;
		artChanging = Math.abs(goal - artAmount) > 0.002;
		artAmount += (goal - artAmount) * Math.min(1, dt * 5);
	}

	function lightPainting(fx: FxUniforms | null, light: number) {
		if (!fx) return;
		const slug = hovered ?? artSlug ?? hoveredLast;
		if (!slug) return;
		const g = paintingBySlug[slug];
		fx.hover = [g.yaw * DEG, g.distance, g.width / 2, g.height / 2];
		// the mip of the picture that is as soft as the panorama shows it
		const across = ((2 * g.halfWidth) / 360) * (loaded.get("hub")?.width ?? 4096);
		const lod = Math.max(0, Math.log2(config.art[slug].width / across) + 0.35);
		fx.hover2 = [g.centerY, slug === hoveredLast || slug === hovered ? light : 0, slug === artSlug ? artAmount : 0, lod];
	}

	// ─── Pigment in the water ───────────────────────────────────────────────
	// Every room entered leaves its colour in the water under its painting;
	// at the end all four spread and meet.
	const stains = new Float32Array(16);
	const stainInks = new Float32Array(12);
	let stainGlow = 0;
	let chordOn = false;
	let fireHeard = 0;
	/** 0..1 per room: let into the water, and spread across the floor at the end. */
	const stainNow = new Float32Array(4);
	const spreadGoal = new Float32Array(4);
	const spreadNow = new Float32Array(4);
	config.rooms.forEach((r, i) => {
		const g = paintingBySlug[r.slug];
		const out = g.distance - 1.75;
		stains[i * 4] = Math.sin(g.yaw * DEG) * out;
		stains[i * 4 + 1] = Math.cos(g.yaw * DEG) * out;
		// let into black water, dark pigments need the light the pale one has of itself
		const ink = linearRgb(r.pigment);
		const light = 0.2126 * ink[0] + 0.7152 * ink[1] + 0.0722 * ink[2];
		const lift = Math.pow(0.17 / light, 0.72);
		stainInks.set(ink.map((c) => c * lift), i * 3);
	});

	function updateStains(dt: number) {
		const still = !motion || reduced();
		let most = 0, spread = 0;
		for (let i = 0; i < 4; i++) {
			// the pigment of the room just left is let in once the gallery is back
			const goal = visited.has(config.rooms[i].slug) && current === "hub" && !trans ? 1 : stainNow[i];
			const was = stainNow[i] + spreadNow[i];
			stainNow[i] += (goal - stainNow[i]) * (still ? 1 : Math.min(1, dt * 0.42));
			spreadNow[i] += (spreadGoal[i] - spreadNow[i]) * (still ? 1 : Math.min(1, dt * 0.3));
			if (stainNow[i] < 0.002) stainNow[i] = 0;
			stains[i * 4 + 2] = 0.12 + 1.5 * stainNow[i] + 6.4 * spreadNow[i];
			stains[i * 4 + 3] = Math.min(1, stainNow[i] * 2.2) * (0.62 + 0.2 * spreadNow[i]);
			most = Math.max(most, stainNow[i]);
			spread += spreadNow[i] / 4;
			if (Math.abs(stainNow[i] + spreadNow[i] - was) > 1e-5) needsRender = true;
		}
		stainGlow = most > 0 ? 0.34 + 0.3 * spread : 0;
	}

	// ─── Hub hotspots ───────────────────────────────────────────────────────
	const spotWidth = new Map<HTMLElement, number>();
	function measureSpots() {
		for (const s of spots) spotWidth.set(s, s.offsetWidth);
	}
	document.fonts?.ready.then(measureSpots);

	const hubNear = config.scenes.hub?.depth?.near ?? 0;
	function updateSpots() {
		const show = current === "hub" && !trans && entered;
		if (!show) return;
		const proj = currentProjection();
		const w = look.clientWidth;
		const h = look.clientHeight;
		for (const s of spots) {
			const yaw = Number(s.dataset.yaw) * DEG;
			const pitch = (Number(s.dataset.pitch) - 2.2) * DEG;
			// the label hangs on the wall under its painting
			const g = paintingBySlug[s.dataset.room as RoomSlug];
			const far = g.distance / Math.max(Math.cos(pitch), 0.2);
			const ndc = project(seenFrom(dirFromAngles(yaw, pitch), hubNear / far), view.yaw, view.pitch, proj);
			const visible = !!ndc && Math.abs(ndc[0]) < 1.05 && ndc[1] > -1.05 && ndc[1] < 1.05;
			s.dataset.visible = String(visible);
			if (!ndc) continue;
			const width = spotWidth.get(s) ?? 0;
			let x = (ndc[0] * 0.5 + 0.5) * w - width / 2;
			// a label whose painting is partly out of view stays whole while its middle can be seen
			if (Math.abs(ndc[0]) < 1) x = clamp(x, 8, Math.max(8, w - width - 8));
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
		if (!slug) return;
		hoveredLast = slug;
		prefetchScene(slug);
		wantArt(slug);
	}

	let down: { x: number; y: number; t: number; id: number } | null = null;
	/** Where on a painting the visitor clicked or tapped, as a direction in the gallery: the dive starts there. */
	let touch: { slug: RoomSlug; dir: Vec3 } | null = null;
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
		if (!slug) return;
		const rect = look.getBoundingClientRect();
		const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
		const ny = 1 - ((e.clientY - rect.top) / rect.height) * 2;
		touch = { slug, dir: toWorld(rotation(view.yaw, view.pitch), screenRay(nx, ny, currentProjection())) };
		navigate(slug);
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

	// ─── Scripted turns: focus, the look and zoom buttons, “Things to look for” ─
	// One at a time: a newer turn takes over from wherever the view is.
	let turnToken = 0;
	let turnGoal: ViewState | null = null;

	/** Glide to `goal`. Resolves true if it got there, false if a newer turn or a navigation took over. */
	function turnTo(goal: ViewState, seconds: number): Promise<boolean> {
		holdEntrance();
		const token = ++turnToken;
		const from: ViewState = { yaw: view.yaw, pitch: view.pitch, zoom: view.zoom };
		const to = ViewController.limit(goal);
		const dy = angleDelta(from.yaw, to.yaw);
		turnGoal = { ...to, yaw: from.yaw + dy };
		view.locked = true;
		return animate(reduced() ? 0 : seconds, easeInOutCubic, (t) => {
			if (token !== turnToken) return;
			view.yaw = from.yaw + dy * t;
			view.pitch = lerp(from.pitch, to.pitch, t);
			view.zoom = Math.exp(lerp(Math.log(from.zoom), Math.log(to.zoom), t));
		}).then(() => {
			if (token !== turnToken) return false;
			turnGoal = null;
			view.locked = false;
			view.set({});
			return true;
		});
	}

	/** Navigation takes the camera over: drop any turn still running. */
	function cancelTurn() {
		turnToken++;
		turnGoal = null;
		holdEntrance();
	}

	// ─── Entrances ──────────────────────────────────────────────────────────
	// Arriving somewhere is a camera move with an author: the view starts off
	// its mark and a little way back, and settles as the scene opens. It is
	// added to the view in steps, so dragging during it simply joins in.
	let entranceToken = 0;
	let entranceTurns = false;

	/** A scripted turn or a navigation takes over the direction; the last of the travel still plays out. */
	function holdEntrance() {
		entranceTurns = false;
	}

	/**
	 * Begin the entrance for a scene whose opening view the camera already
	 * holds. `heading` (radians) is the way it travels. Paused animation and
	 * reduced motion skip it: the view is simply there.
	 */
	function startEntrance(e: Entrance | undefined, heading: number) {
		const token = ++entranceToken;
		dolly = 0;
		entranceTurns = false;
		if (!e || !motion || reduced()) return;
		dollyDir = [Math.sin(heading), 0, Math.cos(heading)];
		entranceTurns = true;
		let left = 1;
		view.yaw += e.yaw * DEG;
		view.pitch += e.pitch * DEG;
		dolly = e.dolly;
		// quick while the scene is still opening, then a long, soft landing
		animate(e.seconds, (t) => 1 - Math.pow(1 - t, 2.5), (t) => {
			if (token !== entranceToken) return;
			const now = 1 - t;
			if (entranceTurns) {
				view.yaw += e.yaw * DEG * (now - left);
				view.pitch += e.pitch * DEG * (now - left);
			}
			left = now;
			dolly = e.dolly * now;
		});
	}

	/** Bottom edge of what the header shows (wordmark and buttons); the gradient under it is see-through. */
	function barBottom() {
		let bottom = 0;
		// layout offsets, not rects: the header slides in with a transform after the title screen
		for (const el of bar.children) bottom = Math.max(bottom, (el as HTMLElement).offsetTop + (el as HTMLElement).offsetHeight);
		return bar.offsetTop + bottom;
	}
	// the header grows when the wordmark wraps (narrow screens, larger text): what sits under it follows
	new ResizeObserver(() => root.style.setProperty("--bar-h", `${barBottom()}px`)).observe(bar);

	/** The part of the view nothing covers: under the header, clear of the room card and of a description beside it. */
	function clearArea() {
		const area = { left: 0, top: barBottom(), right: look.clientWidth, bottom: look.clientHeight };
		const room = current === "hub" ? null : document.getElementById(`room-${current}`);
		if (!room) return area;
		const panel = room.querySelector<HTMLElement>('.details[data-open="true"]');
		if (panel) {
			const r = panel.getBoundingClientRect();
			// beside the view on wide screens; on narrow ones it is a sheet and the points hide under it
			if (r.left > area.right / 4) area.right = Math.min(area.right, r.left);
		}
		const card = room.querySelector<HTMLElement>(".room-card");
		if (card && getComputedStyle(card).visibility !== "hidden") {
			const r = card.getBoundingClientRect();
			// the card sits bottom left: keep the larger free region, above it or beside it
			const above = (area.right - area.left) * (r.top - area.top);
			const beside = (area.right - Math.max(area.left, r.right)) * (area.bottom - area.top);
			if (above >= beside) area.bottom = Math.min(area.bottom, r.top);
			else area.left = Math.max(area.left, r.right);
		}
		return area;
	}

	/**
	 * Turn the view so whatever just got focus is on screen and not under the
	 * header, the room card or an open description. With `center` it always
	 * turns, even if the target is already in view.
	 */
	function bringIntoView(yaw: number, pitch: number, center = false): Promise<boolean> {
		if (busy) return Promise.resolve(false);
		const proj = currentProjection();
		const w = look.clientWidth;
		const h = look.clientHeight;
		const area = clearArea();
		const ndc = project(dirFromAngles(yaw, pitch), view.yaw, view.pitch, proj);
		if (ndc && !center) {
			const x = (ndc[0] * 0.5 + 0.5) * w;
			const y = (0.5 - ndc[1] * 0.5) * h;
			const mx = (area.right - area.left) * COMFORT_MARGIN;
			const my = (area.bottom - area.top) * COMFORT_MARGIN;
			if (x > area.left + mx && x < area.right - mx && y > area.top + my && y < area.bottom - my) return Promise.resolve(true);
		}
		// aim so the target lands in the middle of the clear area, not of the screen
		const ray = screenRay((area.left + area.right) / w - 1, 1 - (area.top + area.bottom) / h, proj);
		const across = Math.atan2(ray[0], ray[2]);
		const upward = Math.atan2(ray[1], Math.hypot(ray[0], ray[2]));
		return turnTo({ yaw: yaw - across, pitch: pitch - upward, zoom: view.zoom }, BRING_INTO_VIEW_SECONDS);
	}

	/** One click of the look or zoom buttons: what dragging and pinching do, with a single pointer and no drag. */
	function stepView(dYaw: number, dPitch: number, zoomFactor = 1) {
		if (busy || !entered) return;
		interacted();
		// a click during a step carries on from where that step is heading
		const base = turnGoal ?? { yaw: view.yaw, pitch: view.pitch, zoom: view.zoom };
		turnTo({ yaw: base.yaw + dYaw, pitch: base.pitch + dPitch, zoom: base.zoom * zoomFactor }, LOOK_STEP_SECONDS);
	}
	// folded behind one button; whoever needs the pad opens it once and it stays open on later visits
	function setLookPad(open: boolean, save = true) {
		lookControls.hidden = !open;
		btnLook.setAttribute("aria-expanded", String(open));
		if (save) store.set("lookpad", open ? "on" : "off");
	}
	lookPad.hidden = false;
	setLookPad(store.get("lookpad") === "on", false);
	btnLook.addEventListener("click", () => setLookPad(btnLook.getAttribute("aria-expanded") !== "true"));
	for (const btn of lookControls.querySelectorAll<HTMLButtonElement>("[data-look]")) {
		const [dYaw, dPitch] = LOOK_STEPS[btn.dataset.look!];
		btn.addEventListener("click", () => stepView(dYaw, dPitch));
	}
	for (const btn of lookControls.querySelectorAll<HTMLButtonElement>("[data-zoom]")) {
		const factor = btn.dataset.zoom === "in" ? 1 / ZOOM_STEP : ZOOM_STEP;
		btn.addEventListener("click", () => stepView(0, 0, factor));
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

	/** Picked from “Things to look for” on the room card: turn to the point, open its note and move focus to it. */
	async function showPoi(p: HTMLElement) {
		if (busy || !entered) return;
		setPoi(null);
		const arrived = await bringIntoView(Number(p.dataset.yaw) * DEG, Number(p.dataset.pitch) * DEG, true);
		if (!arrived || busy) return;
		setPoi(p);
		p.querySelector<HTMLButtonElement>(".poi-dot")!.focus({ preventScroll: true });
	}
	// “Look for” on the room card unfolds the list of points; open in one room, open in all
	const poiToggles = $$<HTMLButtonElement>("[data-pois]");
	function setPoiList(open: boolean, save = true) {
		for (const btn of poiToggles) {
			btn.hidden = false;
			btn.setAttribute("aria-expanded", String(open));
			document.getElementById(btn.getAttribute("aria-controls")!)!.hidden = !open;
		}
		if (save) store.set("pois", open ? "on" : "off");
	}
	setPoiList(store.get("pois") === "on", false);
	for (const btn of poiToggles) {
		btn.addEventListener("click", () => setPoiList(btn.getAttribute("aria-expanded") !== "true"));
	}

	for (const link of $$<HTMLButtonElement>("[data-show-poi]")) {
		const p = document.getElementById(link.dataset.showPoi!)!.closest<HTMLElement>(".poi")!;
		link.addEventListener("click", () => showPoi(p));
	}

	function updatePois() {
		if (current === "hub" || trans || !entered) return;
		const proj = currentProjection();
		const w = look.clientWidth;
		const h = look.clientHeight;
		for (const p of pois) {
			if ((p.closest("article") as HTMLElement).hidden) continue;
			let yaw = Number(p.dataset.yaw), pitch = Number(p.dataset.pitch);
			// on the wave they go where the water and the boat take them
			if (current === "wave" && wave && tide.t) [yaw, pitch] = wave.carry(p.querySelector(".poi-card")!.id.replace("poi-wave-", ""), yaw, pitch, tide.t);
			const dir = seenFrom(dirFromAngles(yaw * DEG, pitch * DEG), poiDisparity.get(p) ?? 0);
			const ndc = project(dir, view.yaw, view.pitch, proj, rotA);
			const visible = !!ndc && Math.abs(ndc[0]) < 0.97 && Math.abs(ndc[1]) < 0.95;
			p.dataset.visible = String(visible);
			if (!ndc) continue;
			const x = (ndc[0] * 0.5 + 0.5) * w;
			const y = (0.5 - ndc[1] * 0.5) * h;
			p.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
			if (!visible && openPoi === p) setPoi(null);
			else if (openPoi === p) placeNote(p, x, y, w, h);
			else p.dataset.below = String(y < h * 0.4);
		}
	}

	/**
	 * Keep an open note on screen and out from under the header, at any zoom:
	 * above or below its point (whichever fits, below first near the top), else
	 * beside it (short landscape screens have room across, not up and down), slid
	 * sideways instead of past the edge, and scrollable — and then focusable, so
	 * the keyboard can scroll it — when it is still too tall.
	 */
	function placeNote(p: HTMLElement, x: number, y: number, w: number, h: number) {
		const card = p.querySelector<HTMLElement>(".poi-card")!;
		const gap = NOTE_GAP_REM * parseFloat(getComputedStyle(root).fontSize);
		const top = barBottom() + NOTE_MARGIN;
		const bottom = h - NOTE_MARGIN;
		const natural = card.scrollHeight;
		const cw = card.offsetWidth;
		const above = y - gap - top;
		const below = bottom - y - gap;
		const leftOf = x - gap - NOTE_MARGIN;
		const rightOf = w - NOTE_MARGIN - x - gap;
		const preferBelow = y < h * 0.4;
		let height = Math.min(natural, bottom - top);
		let cardTop: number;
		let beside: number | null = null;
		if (height <= (preferBelow ? below : above)) cardTop = preferBelow ? y + gap : y - gap - height;
		else if (height <= (preferBelow ? above : below)) cardTop = preferBelow ? y - gap - height : y + gap;
		else if (Math.max(leftOf, rightOf) >= cw) {
			// beside the point, on the roomier side, level with it as far as the screen allows
			beside = rightOf >= leftOf ? x + gap : x - gap - cw;
			cardTop = clamp(y - height / 2, top, bottom - height);
		} else if (Math.max(above, below) >= NOTE_MIN_HEIGHT) {
			// the roomier side, scrolling
			height = Math.max(above, below);
			cardTop = below >= above ? y + gap : y - gap - height;
		} else {
			// no room on either side (very short screens): cover the point; Escape closes the note
			cardTop = clamp(y - height / 2, top, bottom - height);
		}
		const left = beside ?? clamp(x - cw / 2, NOTE_MARGIN, w - NOTE_MARGIN - cw);
		p.dataset.below = String(cardTop > y);
		card.style.maxHeight = natural > height ? `${Math.floor(height)}px` : "";
		card.style.setProperty("--poi-dx", `${(left - x).toFixed(1)}px`);
		card.style.setProperty("--poi-dy", `${(cardTop - y).toFixed(1)}px`);
		const scrolls = card.scrollHeight > card.clientHeight + 1;
		if (scrolls && card.tabIndex !== 0) card.tabIndex = 0;
		else if (!scrolls && card.hasAttribute("tabindex")) card.removeAttribute("tabindex");
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
	let arrivingTimer = 0;

	async function navigate(target: SceneId, push = true) {
		endCoda?.();
		interacted();
		if (busy) {
			queued = { target, push };
			return;
		}
		if (target === current) return;
		busy = true;
		cancelTurn();
		root.classList.remove("is-arriving");
		root.classList.add("is-moving");
		closeFinale(false);
		spotsNav.inert = true;
		setHovered(null);
		closeAllDetails();
		setPoi(null);
		tide.home = clocked();
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
		if (arrived !== current) {
			lives.delete(current);
			presence = 0;
			skyClock = 0;
			calmHeard = 0;
			resetTide();
		}
		current = arrived;
		trans = null;
		mix = 0;
		busy = false;
		root.classList.remove("is-moving");
		if (ok && arrived !== "hub" && motion && !reduced()) {
			// the world opens first; its caption follows
			root.classList.add("is-arriving");
			window.clearTimeout(arrivingTimer);
			arrivingTimer = window.setTimeout(() => root.classList.remove("is-arriving"), 1700);
		}
		spotsNav.inert = false;
		updateDocument(arrived);
		audio.setScene(soundFor(arrived));
		needsRender = true;
		if (keyboardFocus) look.focus({ preventScroll: true });
		live.textContent = !ok
			? `Sorry, ${sceneTitle(target)} could not be loaded.`
			: arrived === "hub"
				? `${config.hub.title}. Four paintings hang on the walls in front of you; press Tab to reach their labels and step inside.`
				: `${sceneTitle(arrived)}: ${roomBySlug[arrived as RoomSlug].title}, by ${roomBySlug[arrived as RoomSlug].artist}.`;
		if (ok && from !== "hub") release(from);
		if (arrived === "hub") showHint();
		showActHint(2400);
		if (ok) markVisited(arrived);
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

	/**
	 * Flood the next scene in. Its camera is the live view from the first
	 * frame, already at `arrive` and playing its entrance; the scene being
	 * left keeps the direction it had.
	 */
	async function blend(
		to: SceneId,
		rotFrom: Float32Array,
		arrive: { yaw: number; pitch: number },
		entrance: Entrance | undefined,
		seconds: number,
		zoomFrom: number,
		zoomTo: number,
		how: { close?: boolean; push?: number; origin?: [number, number]; through?: RoomSlug } = {},
	) {
		const rm = reduced();
		view.set({ yaw: arrive.yaw, pitch: arrive.pitch });
		startEntrance(entrance, arrive.yaw);
		trans = { to, rotA: rotFrom, rotB: rotation(view.yaw, view.pitch), ripple: !rm, close: !!how.close };
		center[0] = how.origin?.[0] ?? 0;
		center[1] = how.origin?.[1] ?? 0;
		ink = [...linearRgb(to === "hub" ? config.hub.pigment : roomBySlug[to].pigment), 0.92];
		mix = 0;
		match = !rm && how.through ? matchFor(how.through, to !== "hub") : null;
		audio.setScene(soundFor(to));
		if (!rm) audio.passage(how.close ? "out" : "in", seconds);
		const logZoom = (a: number, b: number) => (t: number) => (view.zoom = Math.exp(lerp(Math.log(a), Math.log(b), t)));
		await Promise.all([
			// The bloom gathers where the drop landed, runs out across the picture, and slows at the
			// edges. It has covered the screen before the view has opened far: the scene being left
			// never comes back into sight around it.
			animate(rm ? 0.6 : seconds * 0.76, rm ? easeInOutSine : spread, (t) => (mix = t)),
			// going in, what is painted becomes what is there, and only then opens into a place; coming out,
			// the place folds into the picture first
			match &&
				animate(seconds, (t) => t, (t) => {
					if (!match) return;
					match.amount = match.worldIsB ? 1 - easeInOutCubic(clamp((t - 0.3) / 0.6, 0, 1)) : easeInOutCubic(clamp(t / 0.6, 0, 1));
				}),
			(async () => {
				if (rm) {
					view.zoom = zoomTo;
					return;
				}
				// first further in, through the surface; then the view opens out on the other side
				const pushed = zoomFrom * (how.push ?? 1);
				if (how.push) await animate(seconds * 0.36, (t) => t * t, logZoom(zoomFrom, pushed));
				else await wait(seconds * 0.25);
				// the view opens as the picture does: no wider, sooner, than what was painted reaches
				await animate(seconds * (how.push ? 0.64 : 0.75), easeInOutCubic, logZoom(pushed, zoomTo));
			})(),
		]);
		match = null;
		renderer.promote();
		fxA = fxB;
		fxB = emptyFx();
	}

	/** What the shader needs to look at a world through its painting. */
	function matchFor(slug: RoomSlug, worldIsB: boolean): typeof match {
		const grid = config.registration[slug];
		if (!grid) return null;
		const g = paintingBySlug[slug];
		return { amount: worldIsB ? 1 : 0, worldIsB, plane: [g.yaw * DEG, g.distance, g.width / 2, g.height / 2], y: g.centerY, grid: Float32Array.from(grid, (v) => v * DEG) };
	}

	/** How far the bloom has spread, 0..1, over the time of a transition. */
	const spread = (t: number) => 0.45 * t + 0.55 * t * t * (3 - 2 * t);

	/** sRGB hex colour to linear rgb, as the shader mixes it. */
	function linearRgb(hex: string): [number, number, number] {
		const channel = (i: number) => {
			const c = parseInt(hex.slice(i, i + 2), 16) / 255;
			return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
		};
		return [channel(1), channel(3), channel(5)];
	}

	/**
	 * Hub → room: glide up to the painting, then go through it. The drop
	 * lands where the painting was touched (its middle, from the keyboard).
	 */
	async function dive(slug: RoomSlug) {
		const g = paintingBySlug[slug];
		const room = roomBySlug[slug];
		wantArt(slug);
		view.locked = true;
		view.stop();
		const fit = zoomToFit(g);
		const tex = load(slug);
		const touched = touch?.slug === slug ? touch.dir : null;
		touch = null;
		await fly(g.yaw * DEG, g.pitch * DEG, fit);
		renderer.setSlot(1, await tex);
		fxB = fxFor(slug);
		const fromRot = rotation(g.yaw * DEG, g.pitch * DEG);
		const origin = (touched && project(touched, g.yaw * DEG, g.pitch * DEG, currentProjection())) || undefined;
		await blend(slug, fromRot, { yaw: room.view.yaw * DEG, pitch: room.view.pitch * DEG }, room.entrance, 2.3, fit, zoomFor(slug), {
			push: 0.86,
			through: slug,
			origin: origin && [clamp(origin[0], -0.7, 0.7), clamp(origin[1], -0.7, 0.7)],
		});
		view.set({ zoom: zoomFor(slug) });
		view.locked = false;
	}

	/** Room → hub: the world shrinks back into its frame on the wall. */
	async function surface(from: RoomSlug) {
		const g = paintingBySlug[from];
		const room = roomBySlug[from];
		wantArt(from);
		view.locked = true;
		view.stop();
		const fit = zoomToFit(g);
		const tex = load("hub");
		await fly(room.view.yaw * DEG, room.view.pitch * DEG, fit);
		renderer.setSlot(1, await tex);
		fxB = fxFor("hub");
		const fromRot = rotation(room.view.yaw * DEG, room.view.pitch * DEG);
		// back in the gallery, the camera steps away from the painting it came out of
		await blend("hub", fromRot, { yaw: g.yaw * DEG, pitch: g.pitch * DEG }, config.hub.returning, 2.1, fit, zoomFor("hub"), { close: true, through: from });
		view.set({ zoom: zoomFor("hub") });
		view.locked = false;
	}

	/** Room → room (from the guide or pager): a ripple crossfade. */
	async function crossfade(to: SceneId) {
		view.locked = true;
		view.stop();
		const tex = await load(to);
		renderer.setSlot(1, tex);
		fxB = fxFor(to);
		const v = to === "hub" ? config.hub.view : roomBySlug[to].view;
		const fromRot = rotation(view.yaw, view.pitch);
		const z = view.zoom;
		await blend(to, fromRot, { yaw: v.yaw * DEG, pitch: v.pitch * DEG }, to === "hub" ? config.hub.entrance : roomBySlug[to].entrance, 1.5, z, zoomFor(to));
		view.set({ zoom: zoomFor(to) });
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

	// ─── Button labels ──────────────────────────────────────────────────────
	// The labels under the header buttons (and over the look buttons) show on
	// hover and keyboard focus. Escape hides the one showing without moving
	// focus or the pointer; it is the first thing Escape closes.
	const tools = $$<HTMLButtonElement>(".tool");
	const labelShowing = (tool: HTMLElement) =>
		!tool.classList.contains("tip-hidden") &&
		(tool.matches(":hover") || tool.matches(":focus-visible")) &&
		(tool.querySelector<HTMLElement>(".tool-label")?.offsetWidth ?? 0) > 1;
	window.addEventListener(
		"keydown",
		(e) => {
			if (e.key !== "Escape") return;
			const showing = tools.filter(labelShowing);
			if (!showing.length) return;
			for (const tool of showing) tool.classList.add("tip-hidden");
			e.preventDefault();
			e.stopPropagation();
		},
		true,
	);
	for (const tool of tools) {
		tool.addEventListener("pointerleave", () => {
			if (!tool.matches(":focus-visible")) tool.classList.remove("tip-hidden");
		});
		tool.addEventListener("blur", () => {
			if (!tool.matches(":hover")) tool.classList.remove("tip-hidden");
		});
	}

	// ─── Settings ───────────────────────────────────────────────────────────
	function setMotion(on: boolean, save = true) {
		motion = on;
		// CSS animations (the pulse around the points of interest) pause with the panorama
		root.classList.toggle("motion-off", !on);
		// it says what it does, not how things stand: pause while they move, play while they do not
		btnMotion.dataset.playing = String(on);
		$("#motion-label").textContent = on ? "Pause animation" : "Play animation";
		if (save) store.set("motion", on ? "on" : "off");
		needsRender = true;
	}
	btnMotion.hidden = false;
	setMotion(motion, false);
	btnMotion.addEventListener("click", () => setMotion(!motion));
	// the space bar over the view does the same, for this visit
	look.addEventListener("keydown", (e) => {
		if (e.key !== " " || !entered) return;
		e.preventDefault();
		if (e.repeat) return;
		setMotion(!motion, false);
		live.textContent = motion ? "Animation playing." : "Animation paused.";
	});
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

	// ─── Stepping back ──────────────────────────────────────────────────────
	// After a few seconds without input the controls fade and leave the view
	// to the painting. Any movement, touch or key brings them back. They do
	// not go while something is open, while the keyboard is on one of them or
	// the pointer over one, or with animation paused (nothing then changes on
	// its own). Faded, they are still in the tab order and read out as before.
	const IDLE_MS = 4500;
	let idleTimer = 0;
	let lastWake = 0;
	const chrome = [bar, lookPad, ...$$(".room-card")];

	function controlsInUse() {
		if (!entered || busy || !motion || guide.open || openPoi || !finale.hidden) return true;
		if ($$(".details").some((p) => p.dataset.open === "true")) return true;
		const active = document.activeElement;
		if (active && active !== document.body && active !== look && active.matches(":focus-visible")) return true;
		return chrome.some((el) => el.matches(":hover"));
	}

	function wake() {
		const now = performance.now();
		const idle = root.classList.contains("is-idle");
		if (!idle && now - lastWake < 250) return;
		lastWake = now;
		if (idle) root.classList.remove("is-idle");
		window.clearTimeout(idleTimer);
		idleTimer = window.setTimeout(() => {
			lastWake = 0;
			if (controlsInUse()) wake();
			else root.classList.add("is-idle");
		}, IDLE_MS);
	}
	for (const type of ["pointermove", "pointerdown", "keydown", "wheel", "focusin"]) {
		window.addEventListener(type, wake, { capture: true, passive: true });
	}

	// ─── Visited rooms and the closing note ─────────────────────────────────
	// The gallery remembers, for this visit, which paintings have been
	// entered: their labels fill in. Back in the gallery after the fourth,
	// a closing note comes up while drops fall thick on the water and the
	// room turns slowly; it leaves at the first sign the visitor wants to
	// carry on.
	const finale = $("#finale");
	const visited = new Set<string>((visit.get("visited") ?? "").split(",").filter((s) => s in roomBySlug));
	let finaleTimer = 0;

	function showVisited() {
		for (const s of spots) {
			const seen = visited.has(s.dataset.room!);
			s.dataset.visited = String(seen);
			const note = s.querySelector<HTMLElement>("[data-visited-note]");
			if (note) note.hidden = !seen;
		}
		requestAnimationFrame(measureSpots);
	}
	showVisited();

	function markVisited(id: SceneId) {
		if (id !== "hub") {
			if (visited.has(id)) return;
			visited.add(id);
			visit.set("visited", [...visited].join(","));
			showVisited();
			return;
		}
		if (visited.size < config.rooms.length || visit.get("finale") === "seen") return;
		// once the camera has stepped back from the last painting
		window.clearTimeout(finaleTimer);
		finaleTimer = window.setTimeout(openFinale, 2600);
	}

	function openFinale() {
		if (current !== "hub" || busy || guide.open || !finale.hidden) return;
		visit.set("finale", "seen");
		hint.hidden = true;
		if (motion && !reduced()) playCoda();
		else {
			view.set({ yaw: config.hub.view.yaw * DEG, pitch: config.hub.view.pitch * DEG, zoom: zoomFor("hub") });
			showClosing();
		}
	}

	// The ending answers the prologue: the view goes down to the water, and as
	// each room is named its pigment spreads, until the four colours meet.
	// Then it comes up again to the paintings. Any key, click or tap skips to
	// the end; nothing of it is lost, since the closing words are read out.
	const coda = $("#coda");
	const CODA_LINE_MS = 2900;
	let endCoda: (() => void) | null = null;

	function playCoda() {
		const lines = [...coda.querySelectorAll<HTMLElement>(".prologue-line")];
		const token = ++turnToken;
		holdEntrance();
		busy = true;
		view.locked = true;
		view.stop();
		root.classList.add("is-coda");
		coda.hidden = false;
		coda.classList.remove("is-leaving");
		for (const l of lines) l.classList.remove("is-on", "is-gone");
		$("#coda-skip").focus({ preventScroll: true });
		live.textContent = lines.map((l) => l.textContent!.trim()).join(" ");
		downpour = time + 22;
		nextDrip = time;
		const move = (yaw: number, pitch: number, seconds: number) => {
			const y0 = view.yaw, p0 = view.pitch, z0 = view.zoom;
			const dy = angleDelta(y0, yaw * DEG);
			return animate(seconds, easeInOutSine, (t) => {
				if (token !== turnToken) return;
				view.yaw = y0 + dy * t;
				view.pitch = lerp(p0, pitch * DEG, t);
				view.zoom = lerp(z0, zoomFor("hub"), t);
			});
		};
		move(config.hub.view.yaw, -30, 4.6);
		const timers: number[] = [];
		const finish = () => {
			if (endCoda !== finish) return;
			endCoda = null;
			for (const t of timers) window.clearTimeout(t);
			window.removeEventListener("keydown", onKey, true);
			coda.removeEventListener("click", finish);
			spreadGoal.fill(1);
			coda.classList.add("is-leaving");
			window.setTimeout(() => (coda.hidden = true), 950);
			busy = false;
			if (current !== "hub") return;
			move(config.hub.view.yaw, config.hub.view.pitch, 5).then(() => {
				if (token === turnToken) view.locked = false;
			});
			window.setTimeout(() => {
				root.classList.remove("is-coda");
				if (current === "hub" && !busy) showClosing();
			}, 1500);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
			e.preventDefault();
			e.stopPropagation();
			finish();
		};
		endCoda = finish;
		window.addEventListener("keydown", onKey, true);
		coda.addEventListener("click", finish);
		lines.forEach((line, i) => {
			const at = 1500 + i * CODA_LINE_MS;
			timers.push(
				window.setTimeout(() => {
					line.classList.add("is-on");
					if (i >= 4) return;
					spreadGoal[i] = 1;
					audio.drip(stains[i * 4], -config.hub.geometry.water, stains[i * 4 + 1], 1.6);
				}, at),
			);
			timers.push(window.setTimeout(() => line.classList.add("is-gone"), at + CODA_LINE_MS - 250));
		});
		timers.push(window.setTimeout(finish, 1500 + lines.length * CODA_LINE_MS));
	}

	function showClosing() {
		spreadGoal.fill(1);
		visit.set("coda", "seen");
		finale.hidden = false;
		hint.hidden = true;
		root.classList.add("is-closing");
		// words, not a trap: they take focus so they are read out and Escape puts them away, and nothing
		// behind them is closed off
		finale.focus({ preventScroll: true });
		wake();
	}

	function closeFinale(restoreFocus = true) {
		window.clearTimeout(finaleTimer);
		turning = false;
		root.classList.remove("is-closing");
		if (finale.hidden) return;
		const inside = finale.contains(document.activeElement);
		finale.hidden = true;
		downpour = 0;
		if (inside && restoreFocus) look.focus({ preventScroll: true });
	}
	// come back to on this visit, the water is as it was left
	if (visit.get("coda") === "seen") spreadGoal.fill(1);

	finale.querySelector("[data-finale-close]")!.addEventListener("click", () => closeFinale());
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && !finale.hidden && !guide.open) closeFinale();
	});
	// the room stops turning as soon as the visitor looks around for themselves
	look.addEventListener("pointerdown", () => (turning = false));
	look.addEventListener("keydown", () => (turning = false));

	// ─── Hint ───────────────────────────────────────────────────────────────
	let hasInteracted = false;
	/** Once the camera has settled, what the room has to say. */
	function showActHint(after: number) {
		const room = current;
		window.setTimeout(() => current === room && !busy && sayOnce("hint"), after);
	}
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
	const v0 = current === "hub" ? config.hub.view : roomBySlug[current].view;
	view.set({ yaw: v0.yaw * DEG, pitch: v0.pitch * DEG, zoom: zoomFor(current) });
	view.locked = true;
	updateDocument(current);

	first
		.then((tex) => {
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
					// and their programs, one after another
					order.reduce((before, id) => before.then(() => renderer.prepare(FEATURES[id]).ready).catch(() => {}), Promise.resolve());
				}, 2500);
			}
		})
		.catch((err) => {
			console.error(err);
			fallback(err);
			for (const el of behindIntro) el.inert = false;
			intro.hidden = false;
		});

	// ─── Prologue ───────────────────────────────────────────────────────────
	// Two lines, read looking down at the dark water, before the gallery
	// comes into view: the first time into the gallery on this visit, and
	// not with animation paused or reduced motion. Any key, click or tap
	// skips it. Resolves when the camera should start to rise.
	const prologueEl = $("#prologue");
	const LINE_MS = 2500;

	function wantsPrologue() {
		return current === "hub" && motion && !reduced() && !!config.hub.opening && visit.get("prologue") !== "seen";
	}

	function playPrologue(opening: Entrance): Promise<void> {
		visit.set("prologue", "seen");
		const lines = [...prologueEl.querySelectorAll<HTMLElement>(".prologue-line")];
		holding = true;
		view.set({ pitch: view.pitch + opening.pitch * DEG });
		prologueEl.hidden = false;
		live.textContent = lines.map((l) => l.textContent!.trim()).join(" ");
		$("#prologue-skip").focus({ preventScroll: true });
		return new Promise((resolve) => {
			const timers: number[] = [];
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				for (const t of timers) window.clearTimeout(t);
				window.removeEventListener("keydown", onKey, true);
				prologueEl.removeEventListener("click", finish);
				// the last line stays while the camera starts to rise, then goes
				window.setTimeout(() => {
					for (const l of lines) l.classList.add("is-gone");
					prologueEl.classList.add("is-leaving");
					window.setTimeout(() => (prologueEl.hidden = true), 1000);
				}, 1300);
				view.set({ pitch: view.pitch - opening.pitch * DEG });
				holding = false;
				resolve();
			};
			const onKey = (e: KeyboardEvent) => {
				if (e.key === "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
				e.preventDefault();
				e.stopPropagation();
				finish();
			};
			window.addEventListener("keydown", onKey, true);
			prologueEl.addEventListener("click", finish);
			lines.forEach((line, i) => {
				timers.push(window.setTimeout(() => line.classList.add("is-on"), 350 + i * LINE_MS));
				if (i < lines.length - 1) timers.push(window.setTimeout(() => line.classList.add("is-gone"), i * LINE_MS + LINE_MS - 150));
			});
			// the camera starts up as the last line is being read
			timers.push(window.setTimeout(finish, (lines.length - 1) * LINE_MS + 1500));
		});
	}

	async function enter(withSound: boolean) {
		if (entered) return;
		if (withSound) setSound(true);
		else btnSound.setAttribute("aria-pressed", "false");
		intro.classList.add("is-leaving");
		window.setTimeout(() => (intro.hidden = true), 1000);
		const reveal = () => {
			entered = true;
			root.classList.remove("is-intro");
			for (const el of behindIntro) el.inert = false;
		};
		const opening = wantsPrologue() ? config.hub.opening : undefined;
		// without a prologue the controls come in at once, over the still image if the scene is slow to load
		if (!opening) reveal();
		await first.catch(() => {});
		if (opening) {
			await playPrologue(opening);
			// the camera is already rising when the last line goes; the controls follow it
			startEntrance(opening, view.yaw);
			await wait(1.9);
			reveal();
		} else {
			startEntrance(current === "hub" ? config.hub.entrance : roomBySlug[current].entrance, view.yaw);
		}
		view.locked = false;
		look.focus({ preventScroll: true });
		if (current === "hub") window.setTimeout(showHint, opening ? 1800 : 0);
		showActHint(3200);
		markVisited(current);
		needsRender = true;
		wake();
		window.setTimeout(() => upgrade(current), 3000);
	}

	enter(withSound);
	requestAnimationFrame(frame);
}
