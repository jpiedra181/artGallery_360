/**
 * The keelmen at their work: dark dabs against the fires of the painted river
 * (blender/scripts/moonlight.py), shovels going up and down, coal in the air,
 * sparks. No key line here: it is an oil painting, and they are touches of
 * shadow with a warm edge.
 *
 * `state[0]` is how many seconds they have worked.
 */

import { Press, curve, smooth, type Drawing, type P, type Place } from "./press.ts";

/** Sheet pixels: 40 to the degree, over the colliers on the right. */
export const PLACE: Place = { scale: 40, x0: -760, horizon: 640, left: 0, right: 1400, top: 0, bottom: 960, distance: 24 };

export const COLOURS = [
	"#1b1510", // shadow
	"#2b2018", // shadow, nearer the light
	"#8f4a20", // the edge the fire finds
	"#d8873a", // and where it is close
	"#ffcf7a", // spark
	"#ff9a45", // spark, cooling
	"#120f0d", // coal
] as const;
const SHADE = 0, SHADE_2 = 1, RIM = 2, RIM_2 = 3, SPARK = 4, EMBER = 5, COAL = 6;

/** Groups: each man is FIRST + i; then lumps of coal and sparks. */
const FIRST = 1;
const BODY = 0, ARMS = 1;

/** A man: where his feet are (picture pixels, 1500 wide), how tall (degrees), which way he heaves, his place in the rhythm. */
interface Man {
	x: number;
	y: number;
	tall: number;
	dir: 1 | -1;
	beat: number;
	lit: -1 | 1;
}
const MEN: Man[] = [
	{ x: 1126, y: 806, tall: 2.6, dir: 1, beat: 0.0, lit: 1 },
	{ x: 1206, y: 812, tall: 2.9, dir: -1, beat: 0.42, lit: -1 },
	{ x: 1262, y: 818, tall: 3.1, dir: 1, beat: 0.7, lit: 1 },
	{ x: 1356, y: 812, tall: 2.9, dir: 1, beat: 0.18, lit: 1 },
	{ x: 1398, y: 818, tall: 3.0, dir: -1, beat: 0.55, lit: 1 },
	{ x: 1466, y: 826, tall: 3.2, dir: -1, beat: 0.85, lit: -1 },
	{ x: 1092, y: 800, tall: 2.3, dir: 1, beat: 0.33, lit: 1 },
];
const FIRES: P[] = [[1170, 770], [1326, 726], [1446, 738]];
const LUMPS = 5; // in the air for each man
const COAL_GROUP = FIRST + MEN.length, SPARK_GROUP = COAL_GROUP + 1;

/** Picture pixels to sheet pixels. */
const at = (x: number, y: number): P => [PLACE.x0 + ((x - 700) / 16) * PLACE.scale, PLACE.horizon - ((745 - y) / 16) * PLACE.scale];

export function draw(): Drawing {
	const press = new Press();
	const rnd = press.rnd;
	MEN.forEach((m, i) => {
		press.group = FIRST + i;
		const hip = press.anchor(0, -0.46, BODY);
		const shoulder = press.anchor(0.1 * m.dir, -0.8, ARMS);
		const d = m.dir;
		const shape = (a: number, p: P[], colour: number) => press.fill(curve(p.map(([x, y]): P => [x * d, y]), 0.04, true), colour, 0, a);
		// legs apart, a bent back, a head: three touches and an edge of light
		shape(hip, [[-0.2, 0.02], [-0.12, -0.5], [0.06, -0.52], [0.0, -0.24], [0.14, -0.5], [0.22, -0.02], [0.12, 0.03], [0.02, -0.2], [-0.08, 0.04]], SHADE);
		shape(hip, [[-0.14, -0.42], [-0.18, -0.7], [0.0, -0.88], [0.17, -0.86], [0.16, -0.62], [0.12, -0.42]], SHADE_2);
		shape(hip, [[0.1, -0.84], [0.12, -1.0], [0.24, -1.02], [0.27, -0.9], [0.2, -0.8]], SHADE);
		const s = m.lit;
		press.stroke(curve([[s * 0.17, -0.45], [s * 0.18, -0.66], [s * 0.1, -0.86]], 0.05), RIM, (t) => 0.045 * Math.sin(Math.PI * (0.1 + 0.85 * t)), hip);
		press.stroke(curve([[s * 0.16, -0.6], [s * 0.13, -0.78]], 0.05), RIM_2, (t) => 0.028 * Math.sin(Math.PI * t), hip);
		// arms and the long shovel
		shape(shoulder, [[-0.06, -0.82], [0.1, -0.86], [0.42, -0.66], [0.4, -0.58], [0.08, -0.72]], SHADE_2);
		press.stroke([[-0.12 * d, -0.62], [0.3 * d, -0.66], [0.86 * d, -0.56]], SHADE, () => 0.04, shoulder);
		shape(shoulder, [[0.8, -0.62], [1.02, -0.62], [1.06, -0.52], [0.84, -0.48]], SHADE);
	});
	press.group = COAL_GROUP;
	for (let i = 0; i < MEN.length * LUMPS; i++) {
		const a = press.anchor(i, 0, BODY);
		const r = 0.05 + rnd() * 0.06;
		press.fill(Array.from({ length: 6 }, (_, k): P => [i + Math.cos(k * 1.05) * r * (0.7 + 0.5 * rnd()), Math.sin(k * 1.05) * r * (0.7 + 0.5 * rnd())]), COAL, 0, a);
	}
	press.group = SPARK_GROUP;
	for (let i = 0; i < 140; i++) {
		const a = press.anchor(i % FIRES.length, 0, BODY);
		const r = 0.9 + rnd() * 1.5;
		press.fill(Array.from({ length: 5 }, (_, k): P => [(i % FIRES.length) + Math.cos(k * 1.257) * r * 0.6, Math.sin(k * 1.257) * r * 1.3]), rnd() < 0.45 ? SPARK : EMBER, 0, a);
	}
	return press.finish();
}

/** One heave: down into the heap, up, and over (0..1). */
function heave(t: number) {
	const down = smooth(0, 0.28, t) * (1 - smooth(0.36, 0.56, t));
	const up = smooth(0.4, 0.62, t) * (1 - smooth(0.74, 1, t));
	return up - down;
}

const BEAT = 2.3; // seconds from one heave to the next

export function pose(d: Drawing, state: ArrayLike<number>, out: Float32Array): Float32Array {
	const now = state[0] ?? 0;
	const { x: X, y: Y, group, grow, seed } = d.anchors;
	const n = X.length;
	const tx = new Float32Array(n), ty = new Float32Array(n), c = new Float32Array(n), s = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const g = group[i];
		if (g < COAL_GROUP) {
			const m = MEN[g - FIRST];
			const k = m.tall * PLACE.scale * 0.76;
			const [fx, fy] = at(m.x, m.y);
			const h = heave((now / BEAT + m.beat) % 1);
			const body = -0.12 * h * m.dir, arms = -0.75 * h * m.dir;
			const turn = grow[i] === ARMS ? arms + body : body;
			tx[i] = fx + (X[i] + (grow[i] === ARMS ? 0.12 * h * m.dir * -1 : 0)) * k;
			ty[i] = fy + (Y[i] - 0.03 * h) * k;
			c[i] = Math.cos(turn) * k;
			s[i] = Math.sin(turn) * k;
		} else if (g === COAL_GROUP) {
			const j = Math.round(X[i]);
			const m = MEN[Math.floor(j / LUMPS)];
			const k = m.tall * PLACE.scale * 0.76;
			const [fx, fy] = at(m.x, m.y);
			// thrown at the top of the heave, up and over into the dark of the ship
			const t = ((now / BEAT + m.beat) % 1) - 0.6 - 0.02 * (j % LUMPS);
			const u = t / 0.34;
			const alive = u > 0 && u < 1;
			const q = seed[i];
			tx[i] = fx + m.dir * k * (0.75 + u * (1.0 + 0.7 * q));
			ty[i] = fy - k * (1.15 + u * (1.5 + 0.5 * q) - u * u * (1.5 + 0.3 * q));
			// and none is in the air before they begin
			c[i] = alive ? k * Math.min(1, 6 * (1 - u)) * smooth(0.1, 0.9, now) : 0;
		} else {
			const f = FIRES[Math.round(X[i])];
			const [fx, fy] = at(f[0], f[1]);
			const q = seed[i], q2 = (q * 7.31) % 1, q3 = (q * 3.17) % 1;
			// rise, drift and go out; none at all before they begin to work
			const age = (now * (0.22 + 0.2 * q2) + q3 * 3) % 1;
			const lit = smooth(0.4, 2.2, now) * smooth(0, 0.1, age) * smooth(1, 0.55, age);
			tx[i] = fx + (q - 0.5) * 46 + age * (36 + 60 * q2) + 12 * Math.sin(age * 9 + q * 20);
			ty[i] = fy - age * (150 + 190 * q3);
			c[i] = lit;
		}
	}
	const { vertexAnchor, offset } = d;
	for (let v = 0, k = 0; v < vertexAnchor.length; v++, k += 2) {
		const i = vertexAnchor[v];
		const ox = offset[k], oy = offset[k + 1];
		out[k] = tx[i] + c[i] * ox - s[i] * oy;
		out[k + 1] = ty[i] + s[i] * ox + c[i] * oy;
	}
	return out;
}
