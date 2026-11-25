/**
 * The people on the bridge, the railings they run between and the raft, drawn
 * over the rendered river (blender/scripts/rain.py, whose layout is repeated
 * here). Flat colour and a thin key line, as in the print.
 *
 * At rest they stand where Hiroshige caught them. Each party has its own
 * clock: `state[i]` is how many seconds party i has been running. The one after
 * the last party's is how long the raft has been on its way.
 */

import { Press, curve, lerp, smooth, type Drawing, type P, type Place, anchorsOf, pack } from "./press.ts";

// ─── Layout, as in blender/scripts/rain.py (metres; the eye over the origin) ──

const EYE = 22;
const ALONG = [0.848, 0.53] as const;
const START = [-9, 22] as const;
const HALF = 3.2;
const S0 = -21, S1 = 131;

const deckZ = (s: number) => 5.6 + 3.2 * (1 - ((s - 55) / 78) ** 2);
/** A point of the bridge: s along it, t across (positive towards us), z above the deck. */
const onBridge = (s: number, t: number, z = 0): [number, number, number] => [
	START[0] + ALONG[0] * s + ALONG[1] * t,
	START[1] + ALONG[1] * s - ALONG[0] * t,
	deckZ(s) + z,
];

export const PLACE: Place = { scale: 20, x0: 1500, horizon: 0, left: 0, right: 2800, top: 60, bottom: 1560, distance: 34 };

export const COLOURS = [
	"#26282d", // ink
	"#dba07a", // railing
	"#c08a66", // railing, shaded
	"#e9c084", // straw
	"#c99f62", // straw, shaded
	"#4b4d55", // oiled paper, dark
	"#3d4854", // robe, dark
	"#7aa3a3", // robe, blue
	"#8c9468", // robe, green
	"#b2453c", // red
	"#e7bd94", // skin
	"#8b6a4c", // timber
	"#efe3c6", // paper
	"#6a5138", // timber, dark
] as const;
const INK = 0, RAIL = 1, RAIL_DARK = 2, STRAW = 3, STRAW_DARK = 4, PAPER_DARK = 5, ROBE = 6, BLUE = 7, GREEN = 8, RED = 9, SKIN = 10, TIMBER = 11, TIMBER_DARK = 13;

const DEG = Math.PI / 180;

/** Sheet position of a point in the world. */
function project(x: number, y: number, z: number): [number, number] {
	const yaw = Math.atan2(x, y) / DEG;
	const pitch = Math.atan2(z - EYE, Math.hypot(x, y));
	return [PLACE.x0 + yaw * PLACE.scale, PLACE.horizon - (Math.asinh(Math.tan(pitch)) / DEG) * PLACE.scale];
}

/** Sheet pixels to the metre at a point, seen square on. */
function perMetre(x: number, y: number, z: number) {
	const flat = Math.hypot(x, y);
	const pitch = Math.atan2(z - EYE, flat);
	return PLACE.scale / DEG / Math.hypot(flat, z - EYE) / Math.cos(pitch);
}

// ─── Who is on the bridge ─────────────────────────────────────────────────────

/** s: where along the bridge the print has them; t: across it; dir: the way they run along it; pace in metres a second. */
interface Party {
	s: number;
	t: number;
	dir: 1 | -1;
	pace: number;
	size?: number;
	who: { kind: Kind; at: number; robe: number; under?: number }[];
}
type Kind = "hat" | "mat" | "umbrella" | "shared" | "women" | "porter";

/** Furthest from us first: those nearer are drawn over them. The first four are the print's own. */
export const PARTIES: Party[] = [
	{ s: 18.2, t: -2.0, dir: -1, pace: 3.0, who: [{ kind: "mat", at: 0, robe: ROBE }] },
	{ s: 13.4, t: -1.7, dir: 1, pace: 2.5, who: [{ kind: "shared", at: -0.36, robe: BLUE }, { kind: "shared", at: 0.36, robe: ROBE }] },
	{ s: 9.0, t: -0.9, dir: -1, pace: 3.3, who: [{ kind: "hat", at: 0, robe: ROBE }] },
	{ s: 4.6, t: 0.1, dir: -1, pace: 2.2, who: [{ kind: "women", at: 0.3, robe: GREEN, under: RED }, { kind: "women", at: -0.36, robe: BLUE, under: RED }] },
	{ s: 74, t: -1.4, dir: -1, pace: 2.8, who: [{ kind: "hat", at: 0.5, robe: BLUE }, { kind: "mat", at: -0.6, robe: ROBE }] },
	{ s: 52, t: -0.4, dir: 1, pace: 2.6, who: [{ kind: "umbrella", at: 0, robe: GREEN }] },
	{ s: 36, t: 0.7, dir: -1, pace: 3.1, who: [{ kind: "porter", at: 0.5, robe: BLUE }, { kind: "hat", at: -0.9, robe: ROBE }] },
	{ s: 26.5, t: 1.5, dir: 1, pace: 2.9, who: [{ kind: "hat", at: 0, robe: BLUE }] },
	{ s: -6.5, t: 1.0, dir: 1, pace: 2.7, who: [{ kind: "umbrella", at: 0, robe: ROBE }] },
];

const RUN_FROM = S0 + 5, RUN_TO = S1 - 5;

/** Where a party is after running for `seconds`: along the bridge, off one end and on again at the other. */
function place(p: Party, seconds: number) {
	const length = RUN_TO - RUN_FROM;
	const s = p.s + p.dir * p.pace * seconds;
	return RUN_FROM + ((((s - RUN_FROM) % length) + length) % length);
}

/** Bearing and height (radians) of the middle of a party. */
export function bearing(i: number, seconds: number): [number, number] {
	const p = PARTIES[i];
	const [x, y, z] = onBridge(place(p, seconds), p.t, 0.8);
	return [Math.atan2(x, y), Math.atan2(z - EYE, Math.hypot(x, y))];
}

// ─── Groups ───────────────────────────────────────────────────────────────────

/** Anchors of group FIRST + i belong to party i and are in metres about its feet; group 0 is fixed. */
const FIRST = 1;
const RAFT = 60, POLE = 4;
const RAFT_AT = [-15, 74] as const;
const BODY = 0, LEG_A = 1, LEG_B = 2, CLOTH = 3;

const KEY = 0.017; // width of the key line, metres

/** One figure, facing the way it runs; x forward, y down, metres, feet at 0. */
class Figure {
	private press: Press;
	private dx: number;
	private flip: 1 | -1;
	private phase: number;
	constructor(press: Press, dx: number, flip: 1 | -1, phase: number) {
		this.press = press;
		this.dx = dx;
		this.flip = flip;
		this.phase = phase;
	}
	anchor(x: number, y: number, role = BODY) {
		const a = this.press.anchor(this.dx + x * this.flip, y, role);
		this.press.as[a] = this.phase;
		return a;
	}
	/** Points given about (0, 0) of the figure, hung from an anchor at (ax, ay). */
	shape(at: number, p: readonly P[], colour: number, line = KEY) {
		const q = p.map(([x, y]): P => [this.dx + x * this.flip, y]);
		if (line) this.press.fill(q, INK, line, at);
		this.press.fill(q, colour, 0, at);
	}
	line(at: number, p: readonly P[], width = KEY, colour = INK) {
		this.press.stroke(p.map(([x, y]): P => [this.dx + x * this.flip, y]), colour, () => width, at);
	}
	ellipse(at: number, x: number, y: number, rx: number, ry: number, turn: number, colour: number, line = KEY) {
		this.shape(at, Array.from({ length: 20 }, (_, i): P => {
			const a = (i / 20) * Math.PI * 2, u = Math.cos(a) * rx, v = Math.sin(a) * ry;
			return [x + u * Math.cos(turn) - v * Math.sin(turn), y + u * Math.sin(turn) + v * Math.cos(turn)];
		}), colour, line);
	}
	leg(role: number, hip: P, stance: number) {
		const at = this.anchor(hip[0], hip[1], role);
		const [x, y] = hip;
		// bare, muscled, a bend at the knee and the heel lifting
		const k = stance;
		this.shape(at, curve([
			[x - 0.1, y - 0.06], [x + 0.11, y - 0.05], [x + 0.13 + 0.16 * k, y + 0.3], [x + 0.05 + 0.13 * k, y + 0.48], [x + 0.02 + 0.02 * k, y + 0.68],
			[x + 0.2 + 0.02 * k, y + 0.76], [x + 0.2 + 0.02 * k, y + 0.8], [x - 0.07 + 0.02 * k, y + 0.8], [x - 0.06 + 0.04 * k, y + 0.62], [x - 0.1 + 0.1 * k, y + 0.46], [x - 0.02 + 0.14 * k, y + 0.32],
		], 0.05, true), SKIN);
		this.line(at, [[x - 0.08, y + 0.79], [x + 0.2, y + 0.795]], 0.028, INK);
	}
	head(at: number, x: number, y: number) {
		this.ellipse(at, x, y, 0.105, 0.12, 0.3, SKIN);
		this.shape(at, curve([[x - 0.12, y + 0.02], [x - 0.09, y - 0.13], [x + 0.06, y - 0.13], [x + 0.03, y - 0.07], [x - 0.05, y - 0.03]], 0.04, true), INK, 0);
	}
	/** A back bent into the rain: the robe tucked up, or hanging. */
	robe(at: number, colour: number, hem: number) {
		this.shape(at, curve([
			[-0.2, -0.72], [-0.27, -0.95], [-0.2, -1.2], [0.0, -1.36], [0.2, -1.37], [0.3, -1.26], [0.27, -1.05], [0.21, -0.86], [0.24, -0.72 + hem], [0.02, -0.66 + hem], [-0.2, -0.64 + hem],
		], 0.05, true), colour);
		this.line(at, [[0.24, -1.26], [0.08, -1.05], [0.02, -0.82]], 0.013);
		this.line(at, [[-0.2, -1.02], [-0.06, -0.96], [0.2, -0.95]], 0.022);
		this.line(at, [[-0.12, -0.9], [-0.1, -0.74 + hem * 0.6]], 0.012);
		this.line(at, [[0.08, -0.9], [0.1, -0.72 + hem * 0.6]], 0.012);
	}
	arm(at: number, p: readonly P[], colour: number) {
		this.shape(at, p, colour);
	}
}

function drawFigure(press: Press, party: Party, member: Party["who"][number], i: number) {
	const f = new Figure(press, member.at, party.dir, (i * 0.37 + member.at) % 1);
	const { kind, robe } = member;
	const long = kind === "women" || kind === "umbrella";
	const hem = long ? 0.3 : 0.04;
	f.leg(LEG_B, [-0.02, -0.8], -0.5);
	f.leg(LEG_A, [0.05, -0.8], 0.6);
	const at = f.anchor(0, -0.8, BODY);
	const cloth = f.anchor(0, -0.75, CLOTH);
	if (member.under) f.shape(cloth, curve([[-0.24, -0.6], [0.26, -0.6], [0.34, -0.22], [0.16, -0.26], [0.02, -0.2], [-0.14, -0.27], [-0.32, -0.2]], 0.06, true), member.under);
	f.robe(at, robe, hem);
	if (kind === "hat" || kind === "porter") {
		f.head(at, 0.33, -1.4);
		f.arm(at, curve([[0.14, -1.3], [0.32, -1.24], [0.5, -1.4], [0.46, -1.46], [0.3, -1.36]], 0.06, true), robe);
		f.ellipse(at, 0.47, -1.47, 0.055, 0.045, 0, SKIN);
		// a round straw hat held down against the wind
		f.ellipse(at, 0.36, -1.5, 0.37, 0.2, 0.1, STRAW);
		f.line(at, [[0.05, -1.53], [0.36, -1.6], [0.68, -1.5]], 0.01, STRAW_DARK);
		f.line(at, [[0.08, -1.45], [0.36, -1.4], [0.68, -1.43]], 0.01, STRAW_DARK);
		if (kind === "hat") f.line(at, [[-0.16, -0.94], [-0.46, -0.62]], 0.03); // a sword, or a pipe case
		else {
			f.line(at, [[-0.75, -1.24], [0.1, -1.34], [0.85, -1.2]], 0.035, TIMBER_DARK);
			for (const x of [-0.72, 0.82]) f.shape(cloth, curve([[x - 0.2, -0.95], [x + 0.2, -0.95], [x + 0.24, -0.66], [x, -0.56], [x - 0.24, -0.66]], 0.06, true), STRAW_DARK);
			f.line(cloth, [[-0.72, -1.22], [-0.72, -0.95]], 0.012);
			f.line(cloth, [[0.82, -1.2], [0.82, -0.95]], 0.012);
		}
	} else if (kind === "mat") {
		f.arm(at, curve([[0.1, -1.28], [0.3, -1.2], [0.42, -1.42], [0.35, -1.46], [0.24, -1.34]], 0.06, true), SKIN);
		f.head(at, 0.3, -1.36);
		// a straw mat over head and back, its edge fraying
		f.shape(at, curve([[0.52, -1.22], [0.5, -1.5], [0.24, -1.72], [-0.2, -1.82], [-0.62, -1.78], [-0.74, -1.6], [-0.66, -1.2], [-0.36, -1.12], [0.05, -1.26], [0.3, -1.42]], 0.07, true), STRAW);
		for (let k = 0; k < 11; k++) {
			const u = k / 10;
			f.line(at, [[lerp(0.46, -0.6, u), lerp(-1.46, -1.72, Math.sin(u * 2)) + 0.04], [lerp(0.3, -0.56, u), lerp(-1.34, -1.22, u)]], 0.008, STRAW_DARK);
		}
		for (let k = 0; k < 7; k++) f.line(at, [[-0.68 + k * 0.03, -1.3 + k * 0.03], [-0.76 + k * 0.03, -1.2 + k * 0.04]], 0.014, STRAW_DARK);
	} else {
		// under an umbrella
		f.head(at, 0.28, -1.44);
		const shared = kind === "shared";
		const hold: P = [0.42, -1.3];
		f.arm(at, curve([[0.1, -1.28], [0.28, -1.18], [0.46, -1.26], [0.44, -1.34], [0.26, -1.3]], 0.06, true), robe);
		if (shared && member !== party.who[party.who.length - 1]) return;
		const cx = shared ? -0.36 : 0.22, top = shared ? -2.06 : -2.02, wide = shared ? 1.02 : 0.7, drop = shared ? 0.42 : 0.46;
		const tilt = kind === "women" ? 0.16 : 0.06;
		const rim = (u: number): P => {
			const x = cx + u * wide;
			return [x, top + drop * (0.86 + 0.14 * Math.cos(u * 3)) + u * tilt];
		};
		const paper = kind === "shared" ? STRAW : PAPER_DARK;
		f.line(at, [hold, [cx, top]], 0.03, TIMBER_DARK);
		const edge: P[] = Array.from({ length: 13 }, (_, k) => rim((k / 12) * 2 - 1));
		f.shape(at, [[cx - 0.05, top - 0.02], ...edge, [cx + 0.05, top - 0.02]].slice() as P[], paper);
		for (const p of edge.slice(1, -1)) f.line(at, [[cx, top], p], 0.012, paper === STRAW ? TIMBER_DARK : INK);
		f.shape(at, [[cx - 0.07, top + 0.04], [cx, top - 0.09], [cx + 0.07, top + 0.04]], paper === STRAW ? TIMBER : INK);
	}
}

// ─── The drawing ──────────────────────────────────────────────────────────────

function railing(press: Press, t: number, face: number) {
	const beam = (z: number, h: number, colour: number) => {
		const up: P[] = [], low: P[] = [];
		for (let s = S0; s <= S1; s += 0.8) {
			up.push(project(...onBridge(s, t, z + h)));
			low.push(project(...onBridge(s, t, z)));
		}
		press.band(up, low, colour);
		press.stroke(up, INK, () => 1.5);
		press.stroke(low, INK, () => 1.2);
	};
	beam(0.0, 0.16, face);
	beam(0.4, 0.12, RAIL);
	for (let s = S0; s <= S1; s += 3.2) {
		const [x, y, z] = onBridge(s, t, 0.5);
		const w = 0.1 * perMetre(x, y, z);
		const a = project(...onBridge(s, t, 0)), b = project(...onBridge(s, t, 0.93));
		const post: P[] = [[a[0] - w, a[1]], [b[0] - w, b[1]], [b[0] + w, b[1]], [a[0] + w, a[1]]];
		press.fill(post, INK, 1);
		press.fill(post, face);
		press.stroke([[b[0] + w * 0.35, b[1]], [a[0] + w * 0.35, a[1]]], INK, () => 0.9);
	}
	beam(0.8, 0.14, RAIL);
}

export function draw(): Drawing {
	const press = new Press();
	const rnd = press.rnd;

	// — boats under the far bank, and the raft —
	press.group = 0;
	for (const [x, y, l] of [[46, 112, 10], [26, 122, 8], [-62, 152, 10]]) {
		const hull: P[] = [];
		for (let i = 0; i <= 10; i++) hull.push(project(x + 0.871 * l * (i / 10 - 0.5), y - 0.491 * l * (i / 10 - 0.5), 0.2 + 1.1 * Math.abs(i / 5 - 1) ** 3));
		const keel = hull.map(([u, v], i): P => [u, v + perMetre(x, y, 0) * (0.2 + 0.7 * Math.sin((Math.PI * i) / 10))]);
		press.fill([...hull, ...keel.reverse()], PAPER_DARK);
	}
	{
		press.group = RAFT;
		const [rx, ry] = RAFT_AT;
		const at = (a: number, b: number, z = 0.2): P => project(rx + 0.94 * a + 0.34 * b, ry - 0.34 * a + 0.94 * b, z);
		for (let k = 0; k < 7; k++) {
			const b = (k - 3) * 0.55, l0 = -8 - rnd() * 1.6, l1 = 8 + rnd() * 4;
			const spine = curve([at(l0, b), at(0, b), at(l1, b)], 8);
			press.stroke(spine, INK, (u) => 6.4 * Math.min(1, 0.3 + 6 * u) * Math.min(1, 5 * (1 - u)));
			press.stroke(spine, k % 2 ? TIMBER : RAIL_DARK, (u) => 4.2 * Math.min(1, 0.3 + 6 * u) * Math.min(1, 5 * (1 - u)));
		}
		for (const a of [-5, 4]) press.stroke([at(a, -2), at(a + 0.4, 2)], TIMBER_DARK, () => 2.4);
		// the raftsman under his straw cape, leaning on the pole
		const [px, py] = at(-4.4, 0.6, 0.4);
		const m = perMetre(rx - 4, ry, 0) * 1.1;
		const q = (x: number, y: number): P => [px + x * m, py + y * m];
		press.stroke([q(0.1, -0.1), q(0.2, -0.7)], SKIN, () => 0.2 * m);
		press.stroke([q(-0.15, -0.1), q(0.05, -0.7)], SKIN, () => 0.2 * m);
		const cape = curve([q(0.0, -1.65), q(0.36, -1.2), q(0.46, -0.5), q(0.1, -0.62), q(-0.28, -0.55), q(-0.34, -1.2)], 3, true);
		press.fill(cape, INK, 1.2);
		press.fill(cape, STRAW);
		for (let k = 0; k < 6; k++) press.stroke([q(-0.2 + k * 0.1, -1.2), q(-0.24 + k * 0.12, -0.62)], STRAW_DARK, () => 1);
		const hat = curve([q(-0.5, -1.55), q(-0.1, -1.86), q(0.32, -1.56), q(-0.1, -1.48)], 3, true);
		press.fill(hat, INK, 1.2);
		press.fill(hat, STRAW);
		const hand = q(-0.2, -1.2);
		press.stroke([hand, q(-1.0, -0.2), q(-2.4, 0.9)], TIMBER_DARK, () => 2.6, press.anchor(hand[0], hand[1], POLE));
		press.group = 0;
	}

	// — the far railing, the boards, the people, the near railing —
	railing(press, -HALF, RAIL);
	for (const t of [-0.5, -0.38]) {
		const line: P[] = [];
		for (let s = S0; s <= S1; s += 0.8) line.push(project(...onBridge(s, t + 0.04 * Math.sin(s * 1.1))));
		press.stroke(line, INK, () => 1.1);
	}
	for (let s = S0; s < S1; s += 0.75) {
		if (rnd() < 0.3) continue;
		const t0 = -HALF + 0.2 + rnd() * 5, t1 = Math.min(HALF - 0.1, t0 + 0.5 + rnd() * 1.6);
		press.stroke([project(...onBridge(s, t0)), project(...onBridge(s, (t0 + t1) / 2)), project(...onBridge(s, t1))], INK, (u) => 1.05 * Math.sin(Math.PI * (0.1 + 0.8 * u)));
	}
	PARTIES.map((p, i) => ({ p, i }))
		.sort((a, b) => a.p.t - b.p.t)
		.forEach(({ p, i }) => {
			press.group = FIRST + i;
			p.who.forEach((member) => drawFigure(press, p, member, i));
		});
	press.group = 0;
	railing(press, HALF, RAIL);
	return press.finish();
}

/** How far along the river the raft is (m): poled out, and carried back by the stream. */
const drift = (seconds: number) => 7.5 * Math.sin(seconds * 0.075) + 0.5 * Math.sin(seconds * 1.5);

/** Where a point marked on the print (degrees) has gone after the raft has been on its way for `seconds`. */
export function carry(id: string, yaw: number, pitch: number, seconds: number): [number, number] {
	if (id !== "raft") return [yaw, pitch];
	const to = (d: number) => project(RAFT_AT[0] + 0.94 * d, RAFT_AT[1] - 0.34 * d, 0.2);
	const a = to(0), b = to(drift(seconds));
	const y = Math.asinh(Math.tan(pitch * DEG)) / DEG - (b[1] - a[1]) / PLACE.scale;
	return [yaw + (b[0] - a[0]) / PLACE.scale, Math.atan(Math.sinh(y * DEG)) / DEG];
}

// ─── Time ─────────────────────────────────────────────────────────────────────

/** Where every anchor hangs, in sheet pixels, when party i has been running for state[i] seconds. */
export function hang(d: Drawing, state: ArrayLike<number>, out: Float32Array): Float32Array {
	const { x: X, y: Y, group, grow, seed } = d.anchors;
	const n = X.length;
	// all that an anchor does: where it is, and how what hangs from it is turned and sized
	const { tx, ty, c, s } = anchorsOf(d);
	s.fill(0);
	c.fill(0);
	const at = PARTIES.map((p, i) => {
		const along = place(p, state[i] ?? 0);
		const [x, y, z] = onBridge(along, p.t);
		const [px, py] = project(x, y, z);
		// the deck climbs: those on it lean with it a little
		const [qx, qy] = project(...onBridge(along + 0.5, p.t));
		const ends = smooth(0, 3, along - RUN_FROM) * smooth(0, 3, RUN_TO - along);
		return { px, py, m: perMetre(x, y, z) * (p.size ?? 1.4) * ends, slope: Math.atan2(qy - py, qx - px) };
	});
	const river = state[PARTIES.length] ?? 0;
	const raftFrom = project(RAFT_AT[0], RAFT_AT[1], 0.2), d1 = drift(river);
	const raftTo = project(RAFT_AT[0] + 0.94 * d1, RAFT_AT[1] - 0.34 * d1, 0.2);
	const bob = 0.7 * Math.sin(river * 1.1);
	for (let i = 0; i < n; i++) {
		const g = group[i];
		if (g === RAFT) {
			tx[i] = X[i] + raftTo[0] - raftFrom[0];
			ty[i] = Y[i] + raftTo[1] - raftFrom[1] + (river ? bob + 0.006 * (X[i] - raftFrom[0]) * Math.sin(river * 0.8) : 0);
			const lean = grow[i] === POLE ? 0.24 * Math.sin(river * 1.5) : 0;
			c[i] = Math.cos(lean);
			s[i] = Math.sin(lean);
			continue;
		}
		if (g < FIRST) {
			tx[i] = X[i];
			ty[i] = Y[i];
			c[i] = 1;
			continue;
		}
		const p = PARTIES[g - FIRST], { px, py, m, slope } = at[g - FIRST];
		const seconds = state[g - FIRST] ?? 0;
		// three steps to the metre and a half; at 0 each is caught somewhere in a stride
		const swing = Math.sin(seconds * p.pace * 2.6 + 1.0 + seed[i] * 0.9);
		let turn = 0;
		if (grow[i] === LEG_A) turn = -0.46 * swing * p.dir;
		else if (grow[i] === LEG_B) turn = 0.46 * swing * p.dir;
		else if (grow[i] === CLOTH) turn = 0.08 * swing * p.dir;
		const lift = 0.04 * Math.abs(swing);
		// along the slope of the deck, but upright
		const ax = X[i] * m, ay = (Y[i] - lift) * m;
		tx[i] = px + ax;
		ty[i] = py + ay + Math.tan(slope) * ax * 0.85;
		c[i] = Math.cos(turn) * m;
		s[i] = Math.sin(turn) * m;
	}
	return pack(d, out);
}
