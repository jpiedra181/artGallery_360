/**
 * The hours over the pond. Monet set up before the same motif again and again
 * as the light changed; here the light is what moves. 0 is the canvas of 1900
 * as it was painted, and everything is neutral there.
 */

import { lerp } from "./press.ts";

export interface Hour {
	at: number;
	/** What the hour does to the lights and the darks of the picture (linear gain), and to its colour. */
	lights: [number, number, number];
	darks: [number, number, number];
	saturation: number;
	/** Mist on the water: colour (linear) and amount. */
	mist: [number, number, number];
	fog: number;
	/** Wind in the leaves, sun through them, light on the water, and how still the water lies (0..1). */
	wind: number;
	sun: number;
	glints: number;
	calm: number;
}

const HOURS: Hour[] = [
	// as painted: late in an afternoon of summer
	{ at: 0, lights: [1, 1, 1], darks: [1, 1, 1], saturation: 1, mist: [0.6, 0.5, 0.4], fog: 0, wind: 1, sun: 0.34, glints: 0.8, calm: 0 },
	// the sun goes down behind the willows
	{ at: 0.17, lights: [1.9, 1.02, 0.52], darks: [1.25, 0.72, 0.72], saturation: 1.12, mist: [0.75, 0.3, 0.12], fog: 0.3, wind: 0.8, sun: 0.75, glints: 1.6, calm: 0.15 },
	// the blue hour
	{ at: 0.33, lights: [0.5, 0.56, 1.05], darks: [0.34, 0.36, 0.85], saturation: 0.72, mist: [0.1, 0.1, 0.24], fog: 0.5, wind: 0.5, sun: 0, glints: 0.5, calm: 0.4 },
	// night
	{ at: 0.52, lights: [0.3, 0.47, 0.78], darks: [0.15, 0.22, 0.44], saturation: 0.5, mist: [0.06, 0.095, 0.17], fog: 0.5, wind: 0.35, sun: 0, glints: 2.4, calm: 0.85 },
	// first light, and the mist on the water
	{ at: 0.7, lights: [1.0, 0.86, 1.0], darks: [0.72, 0.72, 1.0], saturation: 0.62, mist: [0.56, 0.5, 0.58], fog: 1.0, wind: 0.2, sun: 0, glints: 0.3, calm: 0.9 },
	// noon
	{ at: 0.87, lights: [1.75, 1.78, 1.2], darks: [1.15, 1.5, 1.0], saturation: 1.16, mist: [0.7, 0.75, 0.6], fog: 0, wind: 1.35, sun: 0.85, glints: 2.0, calm: 0 },
];

/** The light at an hour of the cycle (0..1). */
export function hour(t: number): Omit<Hour, "at"> {
	const n = HOURS.length;
	let i = n - 1;
	for (let k = 0; k < n; k++) if (HOURS[k].at <= t) i = k;
	const a = HOURS[i], b = HOURS[(i + 1) % n];
	const s = (t - a.at) / ((i + 1 < n ? b.at : 1) - a.at);
	const u = s * s * (3 - 2 * s);
	const three = (x: readonly number[], y: readonly number[]) => x.map((v, k) => lerp(v, y[k], u)) as [number, number, number];
	return {
		lights: three(a.lights, b.lights),
		darks: three(a.darks, b.darks),
		mist: three(a.mist, b.mist),
		saturation: lerp(a.saturation, b.saturation, u),
		fog: lerp(a.fog, b.fog, u),
		wind: lerp(a.wind, b.wind, u),
		sun: lerp(a.sun, b.sun, u),
		glints: lerp(a.glints, b.glints, u),
		calm: lerp(a.calm, b.calm, u),
	};
}
