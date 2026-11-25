/**
 * The keelmen at their work: dark figures against the fires of the painted
 * river (blender/scripts/moonlight.py), bending to the heap and heaving up, coal
 * in the air; and two keels rowed across the moonlight. No key line here: it is
 * an oil painting, and they are touches of shadow with a warm edge (the shader
 * breaks their outlines as a brush would).
 *
 * `state[0]` is how many seconds they have worked, `state[1]` how long the river
 * has been alive.
 */

import { Press, curve, smooth, type Drawing, type P, type Place, anchorsOf, pack } from "./press.ts";

/** Sheet pixels: 40 to the degree, from the near ship on the left to the colliers on the right. */
export const PLACE: Place = { scale: 40, x0: -760, horizon: 640, left: -2140, right: 1460, top: 280, bottom: 900, distance: 24 };

export const COLOURS = [
	"#150f0b", // shadow
	"#2a1b11", // shadow, nearer the light
	"#b0551f", // the edge the fire finds
	"#ffb056", // and where it is close
	"#ffe2a0", // a lantern
	"#0f0c0a", // coal
	"#2b2a22", // a keel, against the moon
	"#3d3a2c", // and what it leaves in the water
	"#8d8a72", // light on wet wood
] as const;
const SHADE = 0, SHADE_2 = 1, RIM = 2, RIM_2 = 3, LAMP = 4, COAL = 5, KEEL = 6, KEEL_2 = 7, WET = 8;

/** What an anchor turns with. */
const LEGS = 0, TORSO = 1, ARMS = 2, HULL = 3, ROWER = 4, OAR = 5, DEEP = 6;

/** Groups: each man is FIRST + i; then the coal, then the keels. */
const FIRST = 1;

/** A man: where his feet are (picture pixels, 1500 wide), how tall (degrees), which way he heaves, his place in the rhythm, the side the fire is on. */
interface Man {
	x: number;
	y: number;
	tall: number;
	dir: 1 | -1;
	beat: number;
	lit: -1 | 1;
}
const MEN: Man[] = [
	{ x: 1078, y: 806, tall: 4.2, dir: 1, beat: 0.33, lit: 1 },
	{ x: 1132, y: 812, tall: 4.7, dir: 1, beat: 0.0, lit: 1 },
	{ x: 1226, y: 816, tall: 4.9, dir: -1, beat: 0.42, lit: -1 },
	{ x: 1284, y: 822, tall: 5.2, dir: 1, beat: 0.7, lit: 1 },
	{ x: 1372, y: 818, tall: 5.0, dir: -1, beat: 0.18, lit: -1 },
	{ x: 1410, y: 824, tall: 5.3, dir: 1, beat: 0.55, lit: 1 },
	{ x: 1496, y: 830, tall: 5.6, dir: -1, beat: 0.85, lit: -1 },
];
const LUMPS = 7; // in the air for each man
const COAL_GROUP = FIRST + MEN.length, KEEL_GROUP = COAL_GROUP + 1;

/** A keel under oars: degrees of yaw from and to, pitch of its waterline, its length (degrees), seconds to cross, when it sets out. */
const KEELS = [
	{ from: 23, to: -31, pitch: -3.1, long: 5.4, seconds: 100, at: 0.3 },
	{ from: -29, to: 21, pitch: -1.7, long: 3.2, seconds: 130, at: 0.62 },
];
const ROWERS = 3;

const HIP: P = [0, -0.5];
const SHOULDER: P = [0.02, -0.82];

/** Picture pixels to sheet pixels. */
const at = (x: number, y: number): P => [PLACE.x0 + ((x - 700) / 16) * PLACE.scale, PLACE.horizon - ((745 - y) / 16) * PLACE.scale];

export function draw(): Drawing {
	const press = new Press();
	const rnd = press.rnd;

	KEELS.forEach((k, i) => {
		press.group = KEEL_GROUP + i;
		const d = Math.sign(k.to - k.from);
		const flip = (p: readonly P[]) => curve(p.map(([x, y]): P => [x * d, y]), 0.02, true);
		const hull = press.anchor(0, 0, HULL);
		// its shadow in the water, in broken touches
		for (let t = 0; t < 12; t++) {
			const y = 0.035 + t * 0.016, w = (0.46 - t * 0.026) * (0.6 + 0.5 * rnd()), x = (rnd() - 0.5) * 0.2;
			const a = press.anchor(x, y, DEEP);
			press.fill([[x - w, y], [x - w * 0.4, y - 0.011], [x + w * 0.5, y - 0.009], [x + w, y + 0.002], [x + w * 0.2, y + 0.011], [x - w * 0.5, y + 0.009]], t < 5 ? KEEL : KEEL_2, 0, a);
		}
		// the men, behind the side of the boat
		for (let r = 0; r < ROWERS; r++) {
			const x = (-0.22 + r * 0.2) * d;
			const a = press.anchor(x, -0.03, ROWER);
			const body = (p: P[]) => press.fill(curve(p.map(([u, v]): P => [x + u * d, v]), 0.01, true), KEEL, 0, a);
			body([[-0.035, 0.0], [-0.04, -0.07], [-0.02, -0.125], [0.02, -0.13], [0.04, -0.08], [0.04, 0.0]]);
			body([[-0.012, -0.12], [-0.016, -0.155], [0.004, -0.175], [0.024, -0.158], [0.02, -0.122]]);
			body([[0.0, -0.1], [0.07, -0.075], [0.11, -0.06], [0.1, -0.04], [0.05, -0.05], [0.0, -0.07]]);
		}
		press.fill(flip([[-0.5, -0.055], [-0.46, 0.0], [-0.36, 0.038], [0.3, 0.04], [0.43, 0.01], [0.52, -0.075], [0.4, -0.048], [0.0, -0.034], [-0.36, -0.04]]), KEEL, 0, hull);
		press.stroke([[-0.47 * d, -0.048], [-0.3 * d, -0.036], [0.1 * d, -0.033], [0.42 * d, -0.052], [0.51 * d, -0.072]], WET, (t) => 0.011 * Math.sin(Math.PI * t), hull);
		// a heap of coal amidships
		press.fill(flip([[0.16, -0.03], [0.22, -0.075], [0.3, -0.088], [0.37, -0.066], [0.41, -0.04]]), COAL, 0, hull);
		for (let r = 0; r < ROWERS; r++) {
			const x = (-0.12 + r * 0.2) * d;
			const a = press.anchor(x, -0.045, OAR);
			press.stroke([[x - 0.02 * d, -0.055], [x + 0.1 * d, 0.0], [x + 0.2 * d, 0.052]], KEEL, (t) => 0.011 + 0.014 * smooth(0.75, 1, t), a);
		}
		// the lantern at the stern, and its light on the water
		const stern = -0.45 * d;
		press.stroke([[stern, -0.05], [stern, -0.14]], KEEL, () => 0.008, hull);
		press.fill(Array.from({ length: 8 }, (_, t): P => [stern + Math.cos(t * 0.785) * 0.016, -0.15 + Math.sin(t * 0.785) * 0.022]), LAMP, 0, hull);
		for (let t = 0; t < 5; t++) {
			const y = 0.05 + t * 0.034, a = press.anchor(stern, y, DEEP);
			press.fill([[stern - 0.024, y], [stern, y - 0.008], [stern + 0.026, y], [stern, y + 0.008]], t < 2 ? RIM_2 : RIM, 0, a);
		}
	});

	MEN.forEach((m, i) => {
		press.group = FIRST + i;
		const d = m.dir, s = m.lit;
		const legs = press.anchor(0, 0, LEGS);
		const torso = press.anchor(HIP[0], HIP[1], TORSO);
		const arms = press.anchor(SHOULDER[0] * d, SHOULDER[1], ARMS);
		const shape = (a: number, p: P[], colour: number) => press.fill(curve(p.map(([x, y]): P => [x * d, y]), 0.025, true), colour, 0, a);
		// legs apart, knees given
		shape(legs, [[-0.06, -0.54], [-0.2, -0.28], [-0.19, -0.04], [-0.27, 0.0], [-0.12, 0.02], [-0.08, -0.25], [0.06, -0.48]], SHADE);
		shape(legs, [[-0.08, -0.52], [0.13, -0.3], [0.1, -0.03], [0.1, 0.02], [0.26, 0.01], [0.19, -0.05], [0.22, -0.31], [0.1, -0.54]], SHADE);
		// back, shoulders, a head in a round cap
		shape(torso, [[-0.11, -0.46], [-0.16, -0.64], [-0.13, -0.82], [-0.02, -0.89], [0.1, -0.86], [0.15, -0.72], [0.12, -0.46]], SHADE_2);
		shape(torso, [[-0.03, -0.87], [-0.06, -0.97], [0.0, -1.04], [0.1, -1.03], [0.13, -0.95], [0.08, -0.87]], SHADE);
		// the fire along one side of him
		press.stroke(curve([[s * 0.13, -0.47], [s * 0.16, -0.66], [s * 0.11, -0.85]], 0.03), RIM, (t) => 0.05 * Math.sin(Math.PI * (0.1 + 0.85 * t)), torso);
		press.stroke(curve([[s * 0.15, -0.58], [s * 0.14, -0.76]], 0.03), RIM_2, (t) => 0.03 * Math.sin(Math.PI * t), torso);
		press.stroke(curve([[0.04 * d + s * 0.08, -0.92], [0.04 * d + s * 0.06, -1.02]], 0.03), RIM_2, (t) => 0.03 * Math.sin(Math.PI * t), torso);
		press.stroke(curve([[s * 0.2, -0.04], [s * 0.2, -0.28], [s * 0.1, -0.46]], 0.03), RIM, (t) => 0.034 * Math.sin(Math.PI * t), legs);
		// the long shovel, and the arms that carry it
		press.stroke([[-0.12 * d, -0.56], [0.3 * d, -0.6], [0.78 * d, -0.6]], SHADE, () => 0.036, arms);
		shape(arms, [[0.72, -0.66], [0.94, -0.67], [1.02, -0.6], [0.94, -0.53], [0.72, -0.54]], SHADE);
		shape(arms, [[-0.07, -0.86], [0.08, -0.87], [0.24, -0.72], [0.36, -0.62], [0.32, -0.55], [0.16, -0.64], [0.0, -0.74]], SHADE_2);
		shape(arms, [[-0.09, -0.82], [0.0, -0.84], [-0.0, -0.66], [0.02, -0.56], [-0.06, -0.54], [-0.1, -0.68]], SHADE);
		press.stroke([[0.74 * d, -0.66], [0.94 * d, -0.665]], RIM, (t) => 0.026 * Math.sin(Math.PI * t), arms);
		press.stroke(curve([[0.1 * d, -0.84], [0.25 * d, -0.71], [0.35 * d, -0.62]], 0.03), RIM, (t) => 0.026 * Math.sin(Math.PI * t), arms);
	});
	press.group = COAL_GROUP;
	for (let i = 0; i < MEN.length * LUMPS; i++) {
		const a = press.anchor(i, 0, LEGS);
		const r = 0.035 + rnd() * 0.05;
		press.fill(Array.from({ length: 6 }, (_, k): P => [i + Math.cos(k * 1.05) * r * (0.7 + 0.5 * rnd()), Math.sin(k * 1.05) * r * (0.7 + 0.5 * rnd())]), COAL, 0, a);
	}
	return press.finish();
}

/** One heave: down into the heap (-1), up (1), and over (0). */
function heave(t: number) {
	const down = smooth(0, 0.3, t) * (1 - smooth(0.36, 0.54, t));
	const up = smooth(0.38, 0.6, t) * (1 - smooth(0.72, 1, t));
	return up - down;
}

const BEAT = 2.6; // seconds from one heave to the next

export function hang(d: Drawing, state: ArrayLike<number>, out: Float32Array): Float32Array {
	const now = state[0] ?? 0, life = state[1] ?? 0;
	const { x: X, y: Y, group, grow, seed } = d.anchors;
	const n = X.length;
	// all that an anchor does: where it is, and how what hangs from it is turned and sized
	const { tx, ty, c, s } = anchorsOf(d);
	s.fill(0);
	c.fill(0);
	for (let i = 0; i < n; i++) {
		const g = group[i];
		if (g >= KEEL_GROUP) {
			const k = KEELS[g - KEEL_GROUP];
			const way = Math.sign(k.to - k.from);
			const u = (life / k.seconds + k.at) % 1;
			const stroke = life * 2.1 + g * 2;
			// each pull sends it on a little
			const yaw = k.from + (k.to - k.from) * u + 0.05 * way * Math.sin(stroke);
			// it comes out of the dark of one ship and goes into that of another
			const size = k.long * PLACE.scale * smooth(0, 0.03, u) * smooth(1, 0.97, u);
			const bob = 0.012 * Math.sin(life * 0.9 + g);
			const tilt = 0.014 * Math.sin(stroke - 0.6) + 0.01 * Math.sin(life * 0.7);
			const cx = PLACE.x0 + yaw * PLACE.scale, cy = PLACE.horizon - k.pitch * PLACE.scale;
			let turn = tilt;
			if (grow[i] === ROWER) turn += way * (0.12 + 0.34 * Math.sin(stroke));
			else if (grow[i] === OAR) turn += way * (0.12 + 0.42 * Math.sin(stroke + 0.5)) - (Math.cos(stroke + 0.5) > 0 ? 0.16 * way * Math.cos(stroke + 0.5) : 0);
			let x = X[i], y = Y[i];
			if (grow[i] === DEEP) {
				x += 0.05 * Math.sin(life * 2.2 + y * 60 + seed[i] * 4);
				turn = 0;
			} else y += bob;
			tx[i] = cx + size * (x - tilt * y);
			ty[i] = cy + size * (y + tilt * x * (grow[i] === DEEP ? 0 : 1));
			c[i] = Math.cos(turn) * size;
			s[i] = Math.sin(turn) * size;
		} else if (g < COAL_GROUP) {
			const m = MEN[g - FIRST];
			const k = m.tall * PLACE.scale;
			const [fx, fy] = at(m.x, m.y);
			const h = heave((now / BEAT + m.beat) % 1);
			const lean = (0.4 - 0.46 * h) * m.dir, reach = (0.16 - 0.95 * h) * m.dir;
			const sink = 0.04 * Math.max(0, -h);
			let px = X[i], py = Y[i], turn = 0;
			if (grow[i] === TORSO) turn = lean;
			else if (grow[i] === ARMS) {
				const dx = X[i] - HIP[0], dy = Y[i] - HIP[1];
				px = HIP[0] + dx * Math.cos(lean) - dy * Math.sin(lean);
				py = HIP[1] + dx * Math.sin(lean) + dy * Math.cos(lean);
				turn = lean + reach;
			}
			tx[i] = fx + px * k;
			ty[i] = fy + (py + (grow[i] === LEGS ? 0 : sink)) * k;
			c[i] = Math.cos(turn) * k;
			s[i] = Math.sin(turn) * k;
		} else {
			const j = Math.round(X[i]);
			const m = MEN[Math.floor(j / LUMPS)];
			const k = m.tall * PLACE.scale;
			const [fx, fy] = at(m.x, m.y);
			// thrown at the top of the heave, up and over into the dark of the ship
			const t = ((now / BEAT + m.beat) % 1) - 0.55 - 0.016 * (j % LUMPS);
			const u = t / 0.36;
			const alive = u > 0 && u < 1 && now > 0.5;
			const q = seed[i];
			tx[i] = fx + m.dir * k * (0.7 + u * (0.8 + 0.5 * q));
			ty[i] = fy - k * (1.1 + u * (1.0 + 0.4 * q) - u * u * (1.1 + 0.2 * q));
			c[i] = alive ? k * Math.min(1, 6 * (1 - u)) : 0;
		}
	}
	return pack(d, out);
}
