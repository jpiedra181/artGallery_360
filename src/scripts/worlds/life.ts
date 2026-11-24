/**
 * What is loose in the air of each painting, stroke by stroke (engine/loose.ts):
 * willow leaves and petals on their way to the pond, dragonflies, fireflies at
 * night; smoke, embers and gulls on the river; the spray of the great wave.
 *
 * Positions are metres around the eye: x right, y up, z forward.
 */

import { LOOSE } from "../engine/loose.ts";
import { clamp01, lerp, random, smooth } from "./press.ts";

const TAU = Math.PI * 2;
const RAD = Math.PI / 180;
type Rgb = readonly [number, number, number];
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as unknown as Rgb;

class Brush {
	count = 0;
	private out: Float32Array;
	constructor(out: Float32Array) {
		this.out = out;
	}
	put(x: number, y: number, z: number, long: number, wide: number, turn: number, c: Rgb, alpha: number, soft = 0, seed = 0) {
		if (alpha <= 0.003 || (this.count + 1) * LOOSE > this.out.length) return;
		this.out.set([x, y, z, turn, long, wide, soft, seed, c[0], c[1], c[2], alpha], this.count++ * LOOSE);
	}
}

export interface LifeNow {
	/** Seconds the room has been alive (stands still with animation paused), and since the last frame. */
	time: number;
	dt: number;
	/** 0..1: fades everything in on arriving and out on leaving. */
	presence: number;
	/** The clock of the room's act (the hour in the garden, the wave's cycle), 0..1. */
	clock: number;
	/** Light of the fires, for the river. */
	fire: number;
	/** What the hour does to the colour of things (linear rgb). */
	lights: ArrayLike<number>;
	/** Something has touched the water here. */
	drop(x: number, z: number, strength: number): void;
}

/** Writes the strokes of an instant; returns how many. */
export type Life = (out: Float32Array, now: LifeNow) => number;

// ─── The garden ───────────────────────────────────────────────────────────────

const WATER = -1.75;
const LEAVES = ["#c9b63c", "#a8a43a", "#7f8f3c", "#d6c777", "#d9a7b4", "#e6c9cc", "#b98fb0", "#8fa05a"].map(hex);

export function garden(): Life {
	const rnd = random(1900);
	const leaves = Array.from({ length: 64 }, () => ({ q: rnd(), w: rnd(), kind: Math.floor(rnd() * LEAVES.length), wet: true, period: 11 + rnd() * 9, at: rnd() * 20 }));
	const flies = Array.from({ length: 3 }, (_, i) => ({ from: [1.4 - i, -0.8, 2.6 + 0.4 * i], to: [1.4 - i, -0.8, 2.6 + 0.4 * i], t: -1 - i * 1.4, seed: rnd() }));
	const lamps = Array.from({ length: 70 }, () => [rnd(), rnd(), rnd(), rnd()]);
	return (out, n) => {
		const b = new Brush(out);
		const L = n.lights;
		const lit = (c: Rgb, k = 1): Rgb => [Math.min(1, c[0] * Math.sqrt(L[0]) * k), Math.min(1, c[1] * Math.sqrt(L[1]) * k), Math.min(1, c[2] * Math.sqrt(L[2]) * k)];
		const night = smooth(0.4, 0.5, n.clock) * (1 - smooth(0.6, 0.7, n.clock));

		leaves.forEach((l, i) => {
			const age = (n.time + l.at * l.period) / l.period;
			const turn = Math.floor(age), u = age - turn;
			// a new place every time round
			const r = (k: number) => Math.abs((Math.sin((i * 37.7 + turn * 12.9 + k * 78.2) * 43.7) * 4375.85) % 1);
			const landX = -4.2 + 9.6 * r(1), landZ = 2.4 + 7.2 * Math.pow(r(2), 1.3);
			const fall = 0.62;
			const c = LEAVES[l.kind];
			const size = 0.034 + 0.03 * l.q;
			if (u < fall) {
				const v = u / fall;
				const high = (1 - v) * (4.6 + 2.6 * l.w);
				const swing = Math.sin(v * (9 + 5 * l.q) + l.w * 6);
				// carried across by the wind
				const x = landX - (1 - v) * (2.4 + 2.2 * l.w) + 0.35 * swing * (1 - v);
				const z = landZ + 0.2 * Math.cos(v * 8 + l.q * 5) * (1 - v);
				const tumble = Math.abs(Math.cos(n.time * (1.8 + 2 * l.q) + l.w * 9));
				b.put(x, WATER + 0.02 + high, z, size, size * (0.16 + 0.34 * tumble), 0.7 * swing + l.q * 3, lit(c), n.presence * smooth(0, 0.08, v) * 0.95, 0, l.q);
				l.wet = false;
			} else {
				if (!l.wet) {
					l.wet = true;
					n.drop(landX, landZ, 0.5);
				}
				const v = (u - fall) / (1 - fall);
				b.put(landX + v * 0.5, WATER + 0.01, landZ + 0.05 * Math.sin(n.time + i) * v, size, size * 0.3, 0.1 * Math.sin(n.time * 0.8 + i), lit(c, 0.9), n.presence * (1 - smooth(0.55, 1, v)) * 0.95, 0, l.q);
			}
		});

		// dragonflies: hang, then are somewhere else
		const day = 1 - smooth(0.28, 0.4, n.clock) * (1 - smooth(0.68, 0.78, n.clock));
		flies.forEach((f, i) => {
			f.t += n.dt;
			if (f.t > 1.8 + 2.2 * f.seed) {
				f.t = 0;
				f.seed = (f.seed * 7.13 + 0.317) % 1;
				f.from = f.to;
				f.to = [-1.2 + 3.6 * f.seed, -1.2 + 0.85 * ((f.seed * 5.7) % 1), 2.1 + 1.6 * ((f.seed * 11.3) % 1)];
			}
			const go = smooth(0, 0.42, f.t);
			const hover = (k: number) => 0.025 * Math.sin(n.time * (2.3 + k) + i * 2 + k);
			const x = lerp(f.from[0], f.to[0], go) + hover(0), y = lerp(f.from[1], f.to[1], go) + hover(1), z = lerp(f.from[2], f.to[2], go);
			const face = f.to[0] >= f.from[0] ? 1 : -1;
			const tilt = (go > 0 && go < 1 ? 0.35 : 0.14) * face;
			const beat = Math.sin(n.time * 41 + i * 3);
			const wing = lit([0.81, 0.88, 0.86]), body = lit(i === 1 ? [0.69, 0.29, 0.21] : [0.12, 0.44, 0.54]);
			const a = n.presence * day;
			// a long dark body and four wings that never stop: big enough to be a mark of the brush
			b.put(x - 0.06 * face, y - 0.02, z, 0.115, 0.011, tilt, body, a, 0, 0.3 + i);
			b.put(x + 0.055 * face, y + 0.008, z, 0.032, 0.022, tilt, body, a, 0, 0.7 + i);
			for (const s of [-1, 1])
				for (const p of [0, 1]) {
					const w = (s > 0 ? 0.5 : 2.64) + s * (0.28 * p + 0.16 * beat);
					b.put(x + (0.04 - 0.045 * p) * face + Math.cos(w) * 0.075, y + 0.012 + Math.sin(w) * 0.075, z - 0.01, 0.082, 0.017, w, wing, a * 0.5, 0, p + s);
				}
		});

		// fireflies, when the night has come
		if (night > 0.01)
			for (const [q, w, e, k] of lamps) {
				const s = n.time * (0.12 + 0.1 * q);
				const x = -6.5 + 14 * q + 0.7 * Math.sin(s * 2.1 + w * 9), z = 2.6 + 8 * w + 0.5 * Math.cos(s * 1.7 + q * 9);
				const y = -1.4 + 2.3 * e + 0.3 * Math.sin(s * 3.1 + k * 9);
				const glow = Math.pow(clamp01(0.6 + 0.5 * Math.sin(n.time * (0.9 + k) + q * 40)), 3) * night * n.presence;
				b.put(x, y, z, 0.2, 0.2, 0, [0.78, 0.82, 0.3], glow * 0.3, 1, q);
				b.put(x, y, z, 0.03, 0.022, q * 3, [1, 0.97, 0.66], glow, 0, w);
			}
		return b.count;
	};
}

// ─── The river ────────────────────────────────────────────────────────────────

/** Where the fires burn: bearing and height in degrees. */
const FIRES = [[29.4, -1.2], [39.1, 1.4], [46.6, 0.6], [57, 0.4], [34, 1.0]];
const AWAY = 24;

export function river(): Life {
	const rnd = random(1835);
	const puffs = Array.from({ length: 84 }, () => [rnd(), rnd(), rnd(), Math.floor(rnd() * FIRES.length)]);
	const embers = Array.from({ length: 90 }, () => [rnd(), rnd(), rnd(), Math.floor(rnd() * FIRES.length)]);
	const gulls = Array.from({ length: 7 }, () => [rnd(), rnd(), rnd()]);
	const place = (yaw: number, pitch: number, dist: number) =>
		[Math.sin(yaw * RAD) * Math.cos(pitch * RAD) * dist, Math.sin(pitch * RAD) * dist, Math.cos(yaw * RAD) * Math.cos(pitch * RAD) * dist] as const;
	return (out, n) => {
		const b = new Brush(out);
		// smoke goes up off the fires and over the river, towards the moon
		for (const [q, w, e, f] of puffs) {
			const u = (n.time * (0.045 + 0.03 * q) + w * 7) % 1;
			const [yaw, pitch] = FIRES[f];
			const [x, y, z] = place(yaw + 1.5 * (e - 0.5) - u * (9 + 11 * q) - 2 * u * Math.sin(u * 5 + e * 6), pitch + 1.2 + u * (9 + 11 * e), AWAY - 1);
			const heat = 1 - smooth(0.02, 0.3, u);
			const grey = 0.25 + 0.25 * u + 0.1 * e;
			const c: Rgb = [grey * 1.06 + heat * 0.42 * (0.7 + n.fire * 0.5), grey * 0.94 + heat * 0.13, grey * 0.84];
			const size = 0.5 + 2.4 * Math.sqrt(u) + 0.6 * e;
			b.put(x, y, z, size * 1.25, size * 0.8, 1.1 + 1.3 * (e - 0.5) + u * (q - 0.4) * 2, c, n.presence * 0.3 * smooth(0, 0.12, u) * (1 - smooth(0.4, 1, u)), 1, w);
		}
		for (const [q, w, e, f] of embers) {
			const u = (n.time * (0.16 + 0.16 * q) + w * 5) % 1;
			const [yaw, pitch] = FIRES[f];
			const [x, y, z] = place(yaw + (e - 0.5) * 1.6 - u * u * (2 + 4 * q) + 0.35 * Math.sin(u * 11 + q * 9), pitch + u * (3.5 + 6 * e), AWAY - 1.4);
			const s = 0.028 + 0.03 * e;
			const alpha = n.presence * smooth(0, 0.06, u) * (1 - smooth(0.45, 1, u)) * clamp01(0.75 + 0.5 * n.fire) * (0.6 + 0.4 * Math.sin(n.time * 13 + q * 30));
			b.put(x, y, z, s * 1.7, s, 1.4 + (q - 0.5), [1, lerp(0.86, 0.36, u), lerp(0.46, 0.1, u)], alpha, 0, q);
		}
		// gulls, round the light
		gulls.forEach(([q, w, e], i) => {
			const way = i % 3 === 0 ? -1 : 1;
			const s = n.time * (0.055 + 0.03 * q) * way + w * TAU;
			const yaw = -8 + (8 + 9 * e) * Math.cos(s), pitch = 13 + 5 * q + (3 + 3 * w) * Math.sin(s * 1.3 + e * 5);
			const [x, y, z] = place(yaw, pitch, 40 + 10 * Math.sin(s));
			const flap = Math.sin(n.time * (3.4 + q) + i * 2) * smooth(-0.5, 0.2, Math.sin(n.time * 0.5 + i));
			const span = 0.5;
			const bank = -0.35 * Math.cos(s) * way;
			const c: Rgb = [0.36, 0.39, 0.41];
			for (const side of [-1, 1]) {
				const a = side * (0.28 + 0.5 * flap) + bank;
				b.put(x + side * Math.cos(a) * span * 0.86, y + side * Math.sin(a) * span * 0.86, z, span, 0.1, a, c, n.presence * 0.85, 0, q + side);
			}
			b.put(x, y - 0.04, z, 0.22, 0.1, bank, c, n.presence * 0.85, 0, w);
		});
		return b.count;
	};
}

// ─── The wave ─────────────────────────────────────────────────────────────────

/** Spray that the break flings at whoever is looking. Where the clock stands, it hangs. */
export function spray(): Life {
	const rnd = random(1831);
	const drops = Array.from({ length: 130 }, () => [rnd(), rnd(), rnd(), rnd()]);
	const FOAM = hex("#f4eddb"), INK = hex("#1f2f52"), PALE = hex("#b4d2d5");
	return (out, n) => {
		const b = new Brush(out);
		const t = n.clock;
		if (t < 0.25 || t > 0.66) return 0;
		for (const [q, w, e, k] of drops) {
			const u = (t - 0.27 - 0.07 * q) / (0.15 + 0.13 * w);
			if (u <= 0 || u >= 1) continue;
			const yaw = (-27 + 34 * e) * RAD;
			const x = lerp(Math.sin(yaw) * 26, (e - 0.5) * 13 + (q - 0.5) * 6, u), z = lerp(Math.cos(yaw) * 26, 2.2 + 13 * w, u);
			const y = lerp(0.4 + 2.5 * k, -1.6, u) + 4 * u * (1 - u) * (3.5 + 6.5 * k);
			const s = (0.05 + 0.13 * Math.pow(q, 3)) * (1 - 0.35 * u);
			const a = n.presence * smooth(0, 0.08, u) * (1 - smooth(0.93, 1, u));
			const turn = q * 6 + t * 30 * (k - 0.5);
			b.put(x, y, z + 0.02, s * 1.22, s * 1.02, turn, INK, a, 0, q);
			b.put(x, y, z, s, s * 0.8, turn, k > 0.8 ? PALE : FOAM, a, 0, q);
		}
		return b.count;
	};
}
