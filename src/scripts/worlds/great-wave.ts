/**
 * The great wave, drawn the way the print is: a key block of ink lines, flat
 * blues under them and bare paper for the foam, all of it made here from a few
 * curves and one shape of claw.
 *
 * The drawing is a list of flat triangles in painter's order. Every vertex
 * hangs from an anchor; moving the anchors (`pose`) moves the wave, so one
 * drawing holds the whole cycle: the instant Hokusai chose (0), the fall, the
 * break, the spent water and the next wave rising (back to 1).
 *
 * Units are pixels of the print at 1800 wide, y down, so the curves below can
 * be read against it. `PLACE` says where that sheet hangs around the viewer.
 * No DOM or WebGL here: the site draws it live (engine/overlay.ts) and
 * scripts/draw-sheet.mjs draws it once for the stills.
 */

import { Press, clamp01, curve, inside, lerp, smooth, type Drawing, type P, type Place } from "./press.ts";

// ─── Where it hangs ───────────────────────────────────────────────────────────

export const PLACE: Place = {
	/** Print pixels per degree, the column that faces forward (yaw 0) and the row of the horizon. */
	scale: 16.5,
	x0: 990,
	horizon: 885,
	/** The part of the sheet that is drawn (print pixels). */
	left: -1010,
	right: 2990,
	top: 70,
	bottom: 1240,
	/** How far away it stands (metres), for the parallax. */
	distance: 34,
};

export const COLOURS = [
	"#1f2f52", // ink
	"#17335f", // deep
	"#2d6596", // mid
	"#b4d2d5", // pale
	"#f4eddb", // foam
	"#e6cf9c", // boat
	"#b8975c", // boat, shaded side
	"#2b4f86", // cloth
	"#f0d3b4", // skin
	"#6d6658", // straw
] as const;
const INK = 0, DEEP = 1, MID = 2, PALE = 3, FOAM = 4, BOAT = 5, BOAT_DARK = 6, CLOTH = 7, SKIN = 8, STRAW = 9;

/** How a group of anchors moves. */
const GREAT = 0, NEAR = 1, SWELL = 2, BOAT_LEFT = 3, BOAT_RIGHT = 4, BURST = 5, SPRAY = 6, FLECK = 7;
/** How offsets from the anchor scale. */
const RIGID = 0, CLAW = 1, GROWN = 2;

// ─── The claw ─────────────────────────────────────────────────────────────────

interface Claw {
	x: number;
	y: number;
	/** Direction it leaves in (radians, clockwise from the right), and how far it turns by the tip. */
	heading: number;
	curl: number;
	length: number;
	width: number;
}

const CLAW_N = 9;

/** The two edges of a claw: `back` is the outside of the bend. */
function clawEdges(c: Claw) {
	const back: [number, number][] = [], front: [number, number][] = [], spine: [number, number][] = [];
	let x = c.x, y = c.y;
	for (let i = 0; i <= CLAW_N; i++) {
		const t = i / CLAW_N;
		// straight out of the water, then tighter and tighter
		const a = c.heading + c.curl * Math.pow(t, 1.35);
		if (i) {
			x += (Math.cos(a) * c.length) / CLAW_N;
			y += (Math.sin(a) * c.length) / CLAW_N;
		}
		const w = c.width * (0.5 + 0.12 * Math.sin(t * 5)) * Math.pow(1 - t, 0.72);
		const side = Math.sign(c.curl) || 1;
		const nx = Math.sin(a) * side, ny = -Math.cos(a) * side;
		back.push([x + nx * w, y + ny * w]);
		front.push([x - nx * w, y - ny * w]);
		spine.push([x, y]);
	}
	return { back, front, spine };
}

const clawOutline = (c: Claw): P[] => {
	const { back, front } = clawEdges(c);
	return [...back, ...front.slice(0, -1).reverse()];
};

/** The marks on a claw: pale water under the bend, and a swelling line of ink along its back. */
function hook(press: Press, c: Claw, pale: boolean, at: number, weight: number) {
	const { back, front, spine } = clawEdges(c);
	if (pale) {
		// what the bend encloses, near its mouth
		const k = Math.round(CLAW_N * 0.85);
		const outer: P[] = [], inner: P[] = [];
		for (let i = 0; i <= k; i++) {
			const swell = Math.sin((Math.PI * i) / k) * 0.95;
			inner.push(front[i]);
			if (i > 0 && i < k) outer.push([lerp(front[i][0], spine[i][0], swell), lerp(front[i][1], spine[i][1], swell)]);
		}
		press.fill([...inner, ...outer.reverse()], PALE, 0, at);
	}
	const w = Math.max(2.2, c.width * weight);
	press.stroke(back.slice(1), INK, (t) => w * (0.35 + 1.5 * Math.sin(Math.PI * Math.min(1, t * 0.9 + 0.08)) * (1 - 0.35 * t)), at);
	press.stroke(front.slice(Math.round(CLAW_N * 0.5)), INK, (t) => w * 0.75 * Math.sin(Math.PI * (0.15 + 0.8 * t)), at);
}

/** Shapes whose outlines run together: all their ink first, then all their paper, then what is drawn on it. */
class Mass {
	private press: Press;
	private colour: number;
	private ink: (() => void)[] = [];
	private paper: (() => void)[] = [];
	private stains: (() => void)[] = [];
	private detail: (() => void)[] = [];
	constructor(press: Press, colour = FOAM) {
		this.press = press;
		this.colour = colour;
	}
	body(p: readonly P[], line = 3.4) {
		if (line) this.ink.push(() => this.press.fill(p, INK, line));
		this.paper.push(() => this.press.fill(p, this.colour));
	}
	claw(c: Claw, o: { line?: number; pale?: boolean; grow?: number } = {}) {
		const { press } = this;
		const at = press.anchor(c.x, c.y, o.grow ?? CLAW);
		const outline = clawOutline(c);
		this.ink.push(() => press.fill(outline, INK, o.line ?? 3, at));
		this.paper.push(() => press.fill(outline, this.colour, 0, at));
		this.detail.push(() => hook(press, c, o.pale ?? true, at, 0.16));
	}
	/** A claw seen against other foam: only its ink and its shade. */
	scale(c: Claw, pale = true) {
		const { press } = this;
		const at = press.anchor(c.x, c.y, CLAW);
		this.detail.push(() => {
			press.fill(clawOutline(c), this.colour, 0, at);
			hook(press, c, pale, at, 0.2);
		});
	}
	/** A rounded lump that grows from its own middle. */
	lump(x: number, y: number, p: readonly P[]) {
		const { press } = this;
		const at = press.anchor(x, y, GROWN);
		this.ink.push(() => press.fill(p, INK, 3, at));
		this.paper.push(() => press.fill(p, this.colour, 0, at));
	}
	stain(p: readonly P[]) {
		this.stains.push(() => this.press.fill(p, PALE));
	}
	print() {
		for (const f of [...this.ink, ...this.paper, ...this.stains, ...this.detail]) f();
	}
}

interface Fringe {
	spacing: number;
	length: [number, number];
	/** Turn off the line's own direction. */
	lean: number;
	/** Range of bends; its sign is the side the claws hang over. */
	curl: [number, number];
	/** Rows of scales behind the edge, and how far apart. */
	rows?: number;
	rowGap?: number;
	pale?: number;
	width?: number;
	line?: number;
	jitter?: number;
	/** Leave openings along the edge (0..1), and draw the edge itself as scales, over foam that is already printed. */
	gaps?: number;
	scales?: boolean;
}

/** Claws along a line. */
function fringe(mass: Mass, rnd: () => number, line: readonly P[], o: Fringe) {
	const pts = curve(line, 3);
	for (let row = o.rows ?? 0; row >= 0; row--) {
		let next = o.spacing * rnd() * 0.6;
		const phase = rnd() * 9;
		for (let i = 1; i < pts.length - 1; i++) {
			next -= 3;
			if (next > 0) continue;
			next = o.spacing * (0.7 + rnd() * 0.6) * (row ? 1.15 : 1);
			if (o.gaps && 0.5 + 0.5 * Math.sin(i * 0.037 + phase) * Math.sin(i * 0.0161 + phase * 2) < o.gaps * (row ? 1 : 0.7)) continue;
			const tau = Math.atan2(pts[i + 1][1] - pts[i - 1][1], pts[i + 1][0] - pts[i - 1][0]);
			const side = Math.sign(o.curl[0]);
			// rows behind the edge step back into the foam
			const depth = row * (o.rowGap ?? 22) * (0.8 + 0.4 * rnd());
			const length = lerp(o.length[0], o.length[1], rnd()) * (row ? 0.82 - 0.06 * row : 1);
			const c: Claw = {
				x: pts[i][0] + Math.sin(tau) * side * depth,
				y: pts[i][1] - Math.cos(tau) * side * depth,
				heading: tau + o.lean + (rnd() - 0.5) * (o.jitter ?? 0.7),
				curl: lerp(o.curl[0], o.curl[1], rnd()),
				length,
				width: length * (o.width ?? 0.46),
			};
			if (row || o.scales) mass.scale(c, rnd() < 0.75);
			else mass.claw(c, { pale: rnd() < (o.pale ?? 0.6), line: o.line });
		}
	}
}

/** An arm of foam that ends in a hand of claws. */
function arm(mass: Mass, rnd: () => number, spine: readonly P[], width: [number, number], o: { hand: number; length: number; side: number }) {
	const s = curve(spine, 8);
	const n = s.length;
	const left: P[] = [], right: P[] = [];
	for (let i = 0; i < n; i++) {
		const [x0, y0] = s[Math.max(0, i - 1)], [x1, y1] = s[Math.min(n - 1, i + 1)];
		const a = Math.atan2(y1 - y0, x1 - x0), w = lerp(width[0] * 0.9, width[1] * 0.62, i / (n - 1)) / 2;
		left.push([s[i][0] + Math.sin(a) * w, s[i][1] - Math.cos(a) * w]);
		right.push([s[i][0] - Math.sin(a) * w, s[i][1] + Math.cos(a) * w]);
	}
	mass.body([...left, ...right.reverse()]);
	const [x, y] = s[n - 1];
	const from = s[Math.max(0, n - 3)];
	const a = Math.atan2(y - from[1], x - from[0]);
	for (let k = 0; k < o.hand; k++) {
		const f = o.hand === 1 ? 0 : (k / (o.hand - 1)) * 2 - 1; // -1 .. 1 across the hand
		const bend = o.side;
		mass.claw(
			{
				x: x - Math.cos(a) * width[1] * 0.42 - Math.sin(a) * f * width[1] * 0.2,
				y: y - Math.sin(a) * width[1] * 0.42 + Math.cos(a) * f * width[1] * 0.2,
				heading: a + f * 0.8 - bend * 0.35,
				curl: bend * (1.9 + rnd() * 0.8),
				length: o.length * (1 + rnd() * 0.35),
				width: o.length * 0.36,
			},
			{ pale: rnd() < 0.5 },
		);
	}
}

/** Leaf of darker water lying along a swell. */
function leaf(press: Press, p: readonly P[], width: number, colour: number) {
	press.stroke(curve(p, 9), colour, (t) => width * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75)), 0.8));
}

/** A stripe in the face of the wave, rounded at its ends. */
function stripe(press: Press, p: readonly P[], w0: number, w1: number, colour: number) {
	press.stroke(curve(p, 8), colour, (t) => lerp(w0, w1, t) * Math.min(1, Math.sqrt(t * 7)) * Math.min(1, Math.sqrt((1 - t) * 10)));
}

function fleck(press: Press, x: number, y: number, r: number, grow = RIGID) {
	const at = press.anchor(x, y, grow);
	const n = 5 + Math.floor(press.rnd() * 3);
	const turn = press.rnd() * 7;
	const p: P[] = [];
	for (let i = 0; i < n; i++) {
		const a = turn + (i / n) * Math.PI * 2, q = r * (0.75 + press.rnd() * 0.5);
		p.push([x + Math.cos(a) * q, y + Math.sin(a) * q]);
	}
	press.fill(p, FOAM, 0, at);
}

function blob(rnd: () => number, x: number, y: number, rx: number, ry: number, turn: number): P[] {
	const n = 8;
	const p: P[] = [];
	for (let i = 0; i < n; i++) {
		const a = (i / n) * Math.PI * 2, k = 0.86 + rnd() * 0.28;
		const u = Math.cos(a) * rx * k, v = Math.sin(a) * ry * k;
		p.push([x + u * Math.cos(turn) - v * Math.sin(turn), y + u * Math.sin(turn) + v * Math.cos(turn)]);
	}
	return curve(p, 9, true);
}

/** A long fishing boat along its keel line, bow first, with its crew bent over the oars. */
function boat(press: Press, rnd: () => number, keel: readonly P[], depth: number, o: { crew: [number, number][]; cargo: [number, number]; deep?: boolean }) {
	const n = keel.length;
	const mid = keel[Math.floor(n / 2)];
	const at = press.anchor(mid[0], mid[1]);
	const normal = (i: number): P => {
		const [x0, y0] = keel[Math.max(0, i - 1)], [x1, y1] = keel[Math.min(n - 1, i + 1)];
		const l = Math.hypot(x1 - x0, y1 - y0) || 1;
		return [(y1 - y0) / l, -(x1 - x0) / l];
	};
	const breadth = (t: number) => depth * Math.min(1, 0.1 + 2.4 * t) * Math.min(1, 0.35 + 2.2 * (1 - t));
	const off = (i: number, w: number): P => {
		const [nx, ny] = normal(i);
		return [keel[i][0] + nx * w, keel[i][1] + ny * w];
	};
	const rail = keel.map((_, i) => off(i, breadth(i / (n - 1))));
	const ring = (x: number, y: number, rx: number, ry: number, turn: number): P[] =>
		Array.from({ length: 14 }, (_, i) => {
			const q = (i / 14) * Math.PI * 2, u = Math.cos(q) * rx, v = Math.sin(q) * ry;
			return [x + u * Math.cos(turn) - v * Math.sin(turn), y + u * Math.sin(turn) + v * Math.cos(turn)] as P;
		});
	const head = ([x, y, r]: readonly [number, number, number]) => {
		press.fill(ring(x, y, r, r * 0.92, 0), INK, 2.2, at);
		press.fill(ring(x, y, r, r * 0.92, 0), SKIN, 0, at);
		// bowed: we see the crown and the tied hair, not the face
		press.stroke([[x - r * 0.75, y - r * 0.3], [x - r * 0.35, y - r * 0.72], [x + r * 0.2, y - r * 0.78]], INK, (t) => 1.4 + 2.4 * Math.sin(Math.PI * t), at);
	};
	// the crew behind the rail: backs, then a far row of bowed heads
	const nearHeads: [number, number, number][] = [];
	for (const [t, count] of o.crew) {
		const farHeads: [number, number, number][] = [];
		for (let k = 0; k < count; k++) {
			const i = Math.min(n - 1, Math.max(0, Math.round((t + (k - (count - 1) / 2) * 0.044) * (n - 1))));
			const [nx, ny] = normal(i);
			const turn = Math.atan2(nx, -ny);
			const x = keel[i][0] + nx * depth * 1.02, y = keel[i][1] + ny * depth * 1.02;
			press.fill(ring(x + nx * 6, y + ny * 6, 25, 17, turn), INK, 2.4, at);
			press.fill(ring(x + nx * 6, y + ny * 6, 25, 17, turn), CLOTH, 0, at);
			press.stroke([[x - 9, y - 4], [x, y - 9], [x + 10, y - 5]], INK, () => 1.7, at);
			if (k % 2 === 0) farHeads.push([x + nx * 23 + (rnd() - 0.5) * 6, y + ny * 22, 7]);
			nearHeads.push([x + nx * 2 + ny * 10, y + ny * 2 + 3 + rnd() * 2, 8]);
		}
		farHeads.forEach(head);
	}
	const hull = [...keel, ...rail.slice().reverse()];
	press.fill(hull, INK, 2.8, at);
	press.fill(hull, BOAT, 0, at);
	const low = keel.map((_, i) => off(i, breadth(i / (n - 1)) * 0.26));
	press.fill([...keel, ...low.slice().reverse()], BOAT_DARK, 0, at);
	press.stroke(low, INK, () => 1.8, at);
	nearHeads.forEach(head);
	// straw matting over the cargo
	const i0 = Math.round(o.cargo[0] * (n - 1)), i1 = Math.round(o.cargo[1] * (n - 1));
	const hi: P[] = [], lo: P[] = [];
	for (let i = i0; i <= i1; i++) {
		const w = breadth(i / (n - 1));
		hi.push(off(i, w + 8));
		lo.push(off(i, w * 0.6));
	}
	const mat = [...hi, ...lo.slice().reverse()];
	press.fill(mat, INK, 1.8, at);
	press.fill(mat, o.deep ? BOAT : STRAW, 0, at);
	for (let i = 0; i < hi.length - 1; i++) {
		for (const f of [0, 0.5]) {
			const a: P = [lerp(hi[i][0], hi[i + 1][0], f), lerp(hi[i][1], hi[i + 1][1], f)];
			const b: P = [lerp(lo[i][0], lo[i + 1][0], f) - 3, lerp(lo[i][1], lo[i + 1][1], f) + 6 * rnd()];
			press.stroke([a, b], INK, () => 1.3, at);
		}
	}
	press.stroke(hi, INK, () => 2.6, at);
}

// ─── The drawing ──────────────────────────────────────────────────────────────

const BACK: P[] = [
	[-720, 892], [-600, 862], [-460, 812], [-330, 752], [-200, 672], [-80, 582], [40, 498], [150, 424], [230, 350], [300, 280],
	[380, 206], [470, 154], [560, 120], [640, 107], [700, 106], [742, 122], [752, 140], [792, 140], [840, 160], [872, 188],
];
const LIP: P[] = [[404, 348], [428, 312], [470, 292], [512, 268], [560, 262], [600, 244], [640, 236], [684, 254], [704, 286], [738, 306], [768, 332]];
const FRONT: P[] = [[800, 384], [764, 428], [730, 478], [714, 560], [722, 622], [750, 692], [798, 768], [852, 826], [940, 890]];
/** From the lip back down the far side of the hollow and out along the second belt of foam to its tip. */
const BELT_TOP: P[] = [[404, 348], [408, 376], [432, 402], [478, 406], [514, 420], [530, 452], [546, 482], [590, 484], [640, 506], [690, 534]];
const BELT_LOW: P[] = [[690, 540], [640, 540], [604, 558], [560, 566], [520, 552], [476, 556], [424, 566], [384, 594], [340, 586], [296, 568], [250, 560], [206, 552], [176, 566]];
const SKIRT: P[] = [[176, 566], [140, 604], [90, 626], [40, 664], [0, 692], [-80, 730], [-200, 780], [-400, 846], [-720, 894]];
const BELT2_TOP: P[] = [[40, 640], [110, 604], [180, 612], [250, 626], [330, 616], [400, 622], [470, 606], [530, 612], [566, 640]];
const BELT2_LOW: P[] = [[566, 648], [520, 652], [470, 682], [420, 672], [370, 676], [310, 694], [250, 672], [200, 668], [140, 664], [80, 690], [40, 700]];
const HAND: P[] = [[740, 130], [800, 150], [850, 190], [862, 250], [900, 300], [960, 292], [1004, 312], [1010, 360], [1000, 420], [960, 440], [910, 428], [860, 400], [800, 384], [764, 340], [740, 260]];

const NEAR_TOP: P[] = [
	[-560, 900], [-420, 874], [-280, 852], [-140, 842], [-40, 846], [40, 862], [90, 890], [140, 902], [210, 890], [270, 878], [320, 884],
	[370, 870], [420, 832], [470, 806], [520, 770], [568, 722], [600, 690], [632, 678], [664, 694], [704, 706], [736, 742], [782, 792], [842, 826],
	[872, 834], [940, 890], [1030, 920],
];
const NEAR_LOW: P[] = [[1030, 921], [960, 930], [900, 950], [850, 990], [790, 1030], [720, 1052], [640, 1066], [560, 1060], [470, 1052], [380, 1066], [290, 1050], [200, 1034], [110, 1040], [20, 1020], [-90, 1004], [-210, 984], [-340, 958], [-460, 930], [-560, 908]];

const SWELL_TOP: P[] = [
	[860, 872], [940, 892], [1010, 902], [1090, 926], [1160, 932], [1300, 906], [1440, 838], [1560, 742], [1640, 640], [1700, 562], [1760, 502], [1830, 456], [1920, 424],
	[2010, 424], [2100, 462], [2200, 540], [2310, 648], [2430, 762], [2560, 850], [2690, 902],
];
const SWELL_LINE: P[] = [[900, 890], [1050, 930], [1190, 952], [1400, 936], [1600, 866], [1800, 782], [1960, 740], [2120, 760], [2300, 816], [2500, 872], [2690, 902]];
const SWELL_FOAM: P[] = [[1230, 930], [1330, 914], [1420, 884], [1500, 850], [1580, 806], [1650, 752], [1720, 690], [1790, 620], [1860, 572], [1950, 552], [2060, 580], [2160, 640], [2270, 720], [2400, 808], [2540, 868]];
const RIDGE: P[] = [[900, 1222], [1120, 1176], [1300, 1130], [1420, 1074], [1540, 1004], [1650, 912], [1800, 800], [1920, 752], [2060, 760], [2240, 810], [2460, 866], [2690, 902]];
const RIDGE_LOW: P[] = [[900, 1223], [1140, 1226], [1330, 1222], [1520, 1196], [1720, 1140], [1920, 1066], [2140, 990], [2380, 934], [2690, 902]];

export function draw(): Drawing {
	const press = new Press();
	const rnd = press.rnd;

	// — the swell that closes the trough on the right —
	press.group = SWELL;
	{
		const body = [...curve(SWELL_TOP, 12), ...curve(SWELL_LINE, 12).reverse()];
		press.fill(body, INK, 3.2);
		press.fill(body, FOAM);
		// pockets of deep water under its foam, open towards us
		const f = curve(SWELL_FOAM, 12);
		const low = curve(SWELL_LINE.slice(2), 12).slice(2);
		press.fill([...f, ...low.slice().reverse()], MID);
		for (let i = 8; i < f.length - 10; i += 5) {
			const [x, y] = f[i];
			const k = low[Math.min(low.length - 1, Math.round((i / f.length) * low.length) + 4)];
			stripe(press, [[x + 10, y + 6], [lerp(x, k[0], 0.5) + 14, lerp(y, k[1], 0.45) + 4], [k[0] - 4, k[1] - 3]], 24, 9, DEEP);
		}
		const m = new Mass(press);
		for (const [x, y, rx, ry, a] of [[1880, 500, 60, 20, 0.1], [1760, 570, 60, 18, -0.8], [2060, 520, 60, 20, 0.6], [1640, 690, 50, 16, -0.8], [2220, 640, 50, 16, 0.7], [1500, 820, 50, 14, -0.6]])
			m.stain(blob(rnd, x, y, rx, ry, a));
		fringe(m, rnd, SWELL_FOAM.slice(1, -2).reverse(), { spacing: 27, length: [30, 52], lean: 0.15, curl: [-1.5, -2.3], rows: 2, rowGap: 25, width: 0.44, pale: 0.5, line: 2.4, gaps: 0.45 });
		m.print();
		press.stroke(curve(SWELL_LINE, 12), INK, () => 3);
	}

	// — the boat climbing it —
	press.group = BOAT_RIGHT;
	boat(press, rnd, curve([[996, 840], [1060, 872], [1140, 900], [1230, 912], [1320, 890], [1410, 850], [1490, 796], [1560, 730], [1618, 660], [1644, 634]], 10), 30, {
		crew: [[0.5, 2], [0.72, 6]],
		cargo: [0.13, 0.4],
	});

	// — the trough: pale water between the two swells —
	press.group = SWELL;
	press.fill([...curve(SWELL_LINE, 12), ...curve(RIDGE.slice(1), 12).reverse(), ...curve([[1120, 1176], [1096, 1130], [1030, 1086], [960, 1030], [912, 960], [900, 890]], 10).slice(1, -1)], PALE);
	const trough: [P[], number, number][] = [
		[[[940, 1010], [1010, 1064], [1090, 1110], [1200, 1126]], 40, DEEP],
		[[[1030, 1090], [1090, 1130], [1170, 1146], [1250, 1132]], 26, MID],
		[[[880, 900], [960, 968], [1080, 1030], [1230, 1074], [1330, 1092]], 46, DEEP],
		[[[980, 930], [1060, 984], [1170, 1030], [1300, 1056]], 30, MID],
		[[[1090, 962], [1190, 1010], [1300, 1036], [1430, 1046]], 34, DEEP],
		[[[1270, 968], [1370, 1000], [1470, 1012], [1560, 984]], 26, MID],
		[[[1290, 992], [1380, 1016], [1470, 1022], [1530, 1000]], 18, DEEP],
		[[[1430, 946], [1530, 962], [1610, 948], [1650, 920]], 20, DEEP],
		[[[1560, 912], [1640, 904], [1720, 866], [1770, 826]], 18, MID],
		[[[1700, 860], [1780, 816], [1860, 780], [1960, 764]], 22, DEEP],
		[[[1940, 752], [2060, 776], [2200, 808], [2330, 840]], 16, MID],
		[[[900, 896], [1000, 950], [1110, 1000], [1240, 1048], [1380, 1066]], 11, FOAM],
		[[[1030, 940], [1130, 990], [1250, 1026], [1400, 1040]], 10, FOAM],
		[[[1200, 956], [1300, 990], [1420, 1022], [1540, 1004]], 9, FOAM],
		[[[1380, 942], [1480, 964], [1590, 968], [1660, 918]], 8, FOAM],
	];
	for (const [p, w, c] of trough) leaf(press, p, w, c);

	// — the ridge in front of it, coming towards us —
	{
		const body = [...curve(RIDGE, 12), ...curve(RIDGE_LOW, 12).reverse()];
		press.fill(body, INK, 3);
		press.fill(body, FOAM);
		const leaves: [P[], number, number][] = [
			[[[1220, 1170], [1400, 1190], [1600, 1180], [1780, 1110]], 26, PALE],
			[[[1500, 1060], [1640, 1058], [1800, 1030], [1980, 966]], 22, PALE],
			[[[1650, 950], [1780, 930], [1900, 880], [2060, 846]], 26, PALE],
			[[[1900, 790], [2030, 784], [2190, 820], [2380, 868]], 16, PALE],
			[[[1330, 1150], [1450, 1168], [1580, 1160], [1700, 1120]], 46, DEEP],
			[[[1370, 1140], [1470, 1146], [1560, 1140], [1640, 1122]], 20, MID],
			[[[1480, 1100], [1620, 1110], [1780, 1092], [1960, 1030]], 50, DEEP],
			[[[1500, 1084], [1640, 1090], [1790, 1070], [1930, 1018]], 18, MID],
			[[[1600, 1040], [1740, 1034], [1880, 1000], [2040, 946]], 36, DEEP],
			[[[1640, 990], [1760, 974], [1890, 932], [2030, 900]], 34, DEEP],
			[[[1650, 978], [1760, 958], [1870, 924], [1980, 894]], 14, MID],
			[[[1740, 930], [1860, 884], [1980, 854], [2130, 862]], 28, DEEP],
			[[[1860, 830], [1980, 806], [2120, 822], [2290, 862]], 22, MID],
			[[[1980, 900], [2120, 884], [2280, 886], [2450, 900]], 18, MID],
		];
		for (const [p, w, c] of leaves) leaf(press, p, w, c);
	}

	// — where the swells run out, torn streaks of foam, so that they end as water does —
	for (const [p, w, c] of [
		[[[2560, 892], [2660, 896], [2780, 904]], 13, FOAM], [[[2640, 910], [2730, 912], [2850, 906]], 9, FOAM], [[[2740, 894], [2830, 897], [2920, 903]], 7, FOAM],
		[[[2500, 930], [2600, 928], [2720, 920]], 12, FOAM], [[[2560, 946], [2650, 944], [2760, 932]], 7, PALE], [[[2840, 911], [2900, 912], [2975, 909]], 5, FOAM], [[[2420, 958], [2520, 952], [2610, 940]], 9, FOAM],
	] as [P[], number, number][]) leaf(press, p, w, c);

	// — the great wave: first the deep water of its face —
	press.group = GREAT;
	const face: P[] = [
		...curve([[-690, 888], [-420, 846], [-200, 760], [0, 660], [120, 560], [260, 500], [380, 400], [400, 340], [470, 290], [560, 260], [640, 232], [700, 280], [770, 326], [800, 384]], 10),
		...curve(FRONT, 8).slice(1),
		...curve([[940, 900], [700, 905], [400, 915], [100, 915], [-200, 912], [-420, 908], [-690, 900]], 14),
	];
	press.fill(face, INK, 2.6);
	press.fill(face, DEEP);
	const stripes: [P[], number, number][] = [
		[[[474, 300], [446, 350], [438, 404]], 10, 12],
		[[[560, 284], [504, 330], [482, 404]], 13, 12],
		[[[640, 300], [556, 350], [520, 440]], 17, 15],
		[[[704, 292], [618, 342], [584, 420], [580, 486]], 18, 15],
		[[[700, 336], [660, 372], [634, 440], [630, 516]], 15, 15],
		[[[560, 250], [600, 262], [676, 258]], 9, 5],
		[[[500, 560], [520, 622], [566, 676], [620, 716]], 22, 10],
		[[[566, 660], [584, 694], [612, 720]], 14, 6],
		[[[620, 560], [634, 622], [660, 676], [704, 728]], 18, 10],
		[[[666, 560], [676, 620], [700, 668], [734, 716]], 9, 7],
		[[[220, 630], [244, 700], [320, 766], [450, 818]], 26, 12],
		[[[306, 690], [336, 742], [402, 782], [480, 800]], 24, 10],
		[[[368, 690], [404, 734], [462, 770], [530, 780]], 26, 8],
		[[[436, 694], [460, 734], [506, 764]], 12, 5],
		[[[150, 640], [166, 700], [204, 750], [280, 800]], 16, 8],
		[[[214, 560], [222, 590], [236, 616]], 22, 20],
		[[[80, 700], [96, 760], [140, 820], [220, 866]], 18, 8],
		[[[10, 712], [20, 770], [60, 830], [130, 880]], 20, 8],
		[[[-70, 748], [-56, 800], [-14, 846]], 18, 7],
		[[[-160, 782], [-146, 820], [-110, 852]], 16, 6],
		[[[-250, 816], [-234, 842], [-200, 862]], 12, 5],
	];
	for (const [p, w0, w1] of stripes) stripe(press, p, w0, w1, MID);
	{
		// the lit edge of the face, against the sky
		const edge = curve(FRONT, 8);
		press.band(edge, edge.map(([x, y], i): P => [x - lerp(58, 16, i / (edge.length - 1)) * Math.min(1, i / 4), y + (i === 0 ? 0 : 4)]), MID);
		press.stroke(edge, INK, (t) => 4.2 * (0.6 + 0.4 * Math.sin(Math.PI * t)));
	}
	// snow of spray on the dark water
	for (let i = 0; i < 640; i++) {
		const x = -260 + rnd() * 1140, y = 300 + rnd() * 560;
		const r = 1.2 + Math.pow(rnd(), 4) * 7.5;
		if (inside(face, x, y)) fleck(press, x, y, r);
	}

	// — the lower belt of foam across the face —
	{
		const m = new Mass(press);
		m.body([...curve(BELT2_TOP, 10), ...curve(BELT2_LOW, 10)]);
		fringe(m, rnd, BELT2_LOW.slice().reverse(), { spacing: 25, length: [30, 48], lean: -0.2, curl: [1.9, 2.7], rows: 2, rowGap: 19 });
		fringe(m, rnd, BELT2_TOP, { spacing: 36, length: [24, 36], lean: -0.6, curl: [1.6, 2.4], pale: 0.8 });
		m.print();
	}

	// — the boat in the hollow: we only see it between the foam and the near wave —
	press.group = BOAT_LEFT;
	boat(press, rnd, curve([[54, 574], [88, 628], [134, 690], [190, 744], [262, 790], [340, 826], [410, 850], [470, 852]], 9), 42, { crew: [[0.82, 4]], cargo: [0.3, 0.7], deep: true });

	// — the white back of the wave and the lip —
	press.group = GREAT;
	{
		const m = new Mass(press);
		m.body(
			[
				...curve(BACK, 10),
				...curve([[872, 188], [850, 250], [820, 300], [790, 330], [768, 332]], 8).slice(1),
				...curve(LIP.slice().reverse(), 8).slice(1),
				...curve(BELT_TOP, 8).slice(1),
				...curve(BELT_LOW, 8).slice(1),
				...curve(SKIRT, 10).slice(1),
			],
			4,
		);
		// pale washes in the foam, as if it were still running down
		for (const [x, y, rx, ry, a] of [
			[500, 222, 26, 16, 0.6], [548, 236, 20, 18, 0.2], [320, 470, 46, 26, -0.7], [250, 520, 60, 28, -0.4], [370, 520, 34, 60, 0.2], [120, 540, 70, 26, -0.1],
			[70, 600, 46, 30, 0.2], [452, 486, 34, 30, 0.4], [700, 230, 34, 18, 0.2], [770, 200, 26, 26, 0], [60, 660, 40, 26, 0.3], [-60, 660, 60, 22, -0.5], [-220, 730, 80, 20, -0.4],
		]) m.stain(blob(rnd, x, y, rx, ry, a));
		// the lower edges, then the lip, so the lip hangs over everything
		fringe(m, rnd, SKIRT.slice(0, 7).reverse(), { spacing: 28, length: [28, 46], lean: -0.1, curl: [1.8, 2.6], rows: 2, rowGap: 24, gaps: 0.35 });
		fringe(m, rnd, BELT_LOW.slice().reverse(), { spacing: 24, length: [30, 50], lean: -0.15, curl: [1.9, 2.7], rows: 3, rowGap: 22, gaps: 0.3 });
		fringe(m, rnd, [[404, 380], [432, 402], [478, 408], [520, 424], [538, 470], [590, 486], [640, 506]], { spacing: 34, length: [28, 44], lean: -0.7, curl: [2.0, 2.8] });
		fringe(m, rnd, LIP, { spacing: 23, length: [40, 66], lean: -0.35, curl: [2.1, 2.9], rows: 3, rowGap: 26, width: 0.4, gaps: 0.3 });
		// the arms it throws forward
		m.body(curve(HAND, 9, true));
		const arms: [P[], [number, number], number, number, number][] = [
			[[[830, 170], [866, 190], [884, 214]], [46, 26], 2, 50, 1],
			[[[830, 220], [876, 238], [898, 262]], [50, 26], 2, 48, 1],
			[[[820, 250], [846, 270], [852, 284]], [36, 22], 2, 40, 1],
			[[[960, 305], [1004, 320], [1022, 332]], [44, 26], 2, 48, 1],
			[[[990, 350], [1034, 366], [1056, 392]], [44, 24], 3, 50, 1],
			[[[980, 372], [1010, 400], [1016, 420]], [34, 22], 2, 42, 1],
			[[[960, 420], [1012, 448], [1042, 468]], [46, 24], 3, 48, 1],
			[[[940, 420], [980, 474], [1010, 500]], [50, 26], 3, 52, 1],
			[[[930, 420], [958, 468], [972, 500]], [40, 24], 2, 46, -1],
			[[[900, 420], [920, 446], [930, 462]], [38, 22], 2, 42, -1],
			[[[850, 396], [866, 440], [876, 452]], [42, 24], 3, 46, -1],
			[[[810, 384], [826, 404], [830, 418]], [30, 20], 2, 36, -1],
		];
		for (const [p, w, hand, length, side] of arms) arm(m, rnd, p, w, { hand, length, side });
		const palm = curve(HAND, 12, true);
		for (let i = 0; i < 150; i++) {
			const x = 745 + rnd() * 270, y = 150 + rnd() * 290;
			if (!inside(palm, x, y)) continue;
			const length = 24 + rnd() * 18;
			m.scale({ x, y, heading: -0.5 + rnd() * 0.9, curl: (rnd() < 0.82 ? 1 : -1) * (1.9 + rnd() * 0.9), length, width: length * 0.5 }, rnd() < 0.8);
		}
		m.print();
		// the outline of the back is heavier than the rest
		press.stroke(curve(BACK.slice(0, 15), 10), INK, (t) => 3.4 + 3 * Math.sin(Math.PI * t));
	}

	// — the near wave: a white peak that answers Fuji —
	press.group = NEAR;
	{
		const m = new Mass(press);
		m.body([...curve(NEAR_TOP, 10), ...curve(NEAR_LOW, 10)], 3.6);
		for (const [x, y, rx, ry, a] of [
			[380, 930, 60, 34, 0.7], [240, 960, 34, 46, 0.2], [100, 970, 60, 22, 0.1], [520, 930, 70, 22, -0.2], [640, 900, 60, 24, -0.3], [700, 960, 40, 30, 0], [460, 1010, 60, 26, 0],
			[-60, 930, 70, 20, 0.1], [-240, 910, 80, 16, 0.1], [600, 1010, 50, 24, 0], [840, 890, 40, 16, 0.6],
		]) m.stain(blob(rnd, x, y, rx, ry, a));
		fringe(m, rnd, NEAR_LOW.slice(3, -1).reverse(), { spacing: 27, length: [32, 58], lean: 0.05, curl: [1.7, 2.6], rows: 2, rowGap: 25, gaps: 0.4 });
		for (let i = 0; i < 16; i++) {
			const t = i / 15;
			const length = 20 + rnd() * 14;
			m.scale({
				x: lerp(470, 690, t) + (rnd() - 0.5) * 30,
				y: lerp(930, 830, Math.sin(t * Math.PI * 0.6)) + (rnd() - 0.5) * 40,
				heading: -0.8 + rnd() * 0.8,
				curl: 2 + rnd() * 0.7,
				length,
				width: length * 0.5,
			});
		}
		m.print();
		// hollows where the water behind shows through, with foam hanging over them
		const hollows: P[][] = [
			[[-150, 928], [-110, 906], [-50, 908], [10, 926], [60, 934], [90, 966], [40, 990], [-40, 980], [-120, 964]],
			[[150, 960], [190, 932], [250, 936], [300, 958], [344, 980], [330, 1016], [260, 1012], [190, 1000]],
			[[430, 990], [470, 966], [530, 972], [580, 990], [604, 1020], [550, 1034], [480, 1026]],
			[[668, 966], [700, 940], [744, 950], [790, 980], [780, 1008], [720, 1016], [680, 1000]],
		];
		for (const h of hollows) {
			const p = curve(h, 8, true);
			press.fill(p, INK, 2.4);
			press.fill(p, DEEP);
			const [x0, y0] = h[0], [x1, y1] = h[h.length - 3];
			for (const f of [0.25, 0.5, 0.75]) {
				const x = lerp(x0, x1, f), y = lerp(y0, y1, f);
				stripe(press, [[x - 6, y - 14], [x - 2, y + 8], [x + 14, y + 28]], 11, 6, MID);
			}
			for (let i = 0; i < 26; i++) {
				const x = x0 + rnd() * (x1 - x0 + 20), y = y0 - 30 + rnd() * 90;
				if (inside(p, x, y)) fleck(press, x, y, 1 + Math.pow(rnd(), 3) * 5);
			}
			const over = new Mass(press);
			fringe(over, rnd, h.slice(0, 6), { spacing: 21, length: [28, 46], lean: -0.1, curl: [1.9, 2.7], rows: 2, rowGap: 20, scales: true, gaps: 0.2 });
			over.print();
		}
		// the flank that runs down into the trough
		const flank: P[][] = [
			[[740, 762], [770, 820], [812, 880], [850, 930]],
			[[764, 810], [800, 860], [840, 900], [880, 944]],
		];
		// and its far end, torn the same way
		for (const [p, w, c] of [
			[[[-480, 886], [-580, 890], [-700, 900]], 14, FOAM], [[[-560, 906], [-660, 910], [-790, 908]], 10, FOAM], [[[-680, 894], [-780, 897], [-880, 903]], 8, FOAM],
			[[[-430, 930], [-540, 930], [-650, 924]], 12, FOAM], [[[-480, 950], [-580, 948], [-690, 940]], 7, PALE], [[[-830, 911], [-900, 912], [-985, 909]], 5, FOAM],
		] as [P[], number, number][]) leaf(press, p, w, c);
		for (const p of flank) press.stroke(curve(p, 8), INK, (t) => 3.2 * Math.sin(Math.PI * (0.1 + 0.85 * t)));
		leaf(press, [[850, 900], [890, 950], [960, 990], [1040, 1020]], 24, MID);
		leaf(press, [[868, 890], [920, 930], [990, 964], [1070, 990]], 12, FOAM);
		press.stroke(curve(NEAR_TOP.slice(11, 25), 10), INK, (t) => 4.4 * (0.7 + 0.3 * Math.sin(Math.PI * t)));
	}

	// — the water it throws up when it breaks: not there at the instant of the print —
	press.group = BURST;
	{
		const m = new Mass(press);
		for (let i = 0; i < 46; i++) {
			const u = rnd(), v = rnd();
			const x = 330 + u * 900, y = 890 - v * v * 330 * Math.sin(Math.PI * (0.12 + 0.8 * u));
			const r = 34 + rnd() * 58;
			m.lump(x, y, blob(rnd, x, y, r, r * (0.7 + rnd() * 0.3), rnd() * 3));
			for (let k = 0; k < 5; k++) {
				const a = -Math.PI * (0.02 + 0.96 * (k / 4)) + (rnd() - 0.5) * 0.5;
				const right = Math.cos(a) > 0 ? 1 : -1;
				const length = r * (0.55 + rnd() * 0.45);
				m.claw(
					{ x: x + Math.cos(a) * r * 0.75, y: y + Math.sin(a) * r * 0.65, heading: a - 0.3 * right, curl: right * (1.5 + rnd()), length, width: length * 0.48 },
					{ grow: GROWN, pale: rnd() < 0.6 },
				);
			}
		}
		m.print();
	}

	// — spray in the air —
	press.group = SPRAY;
	for (let i = 0; i < 150; i++) fleck(press, 770 + Math.pow(rnd(), 0.8) * 420, 480 + rnd() * 360, 1 + Math.pow(rnd(), 3) * 7, GROWN);
	press.group = FLECK;
	for (let i = 0; i < 120; i++) fleck(press, 380 + rnd() * 900, 860 - rnd() * 120, 2 + Math.pow(rnd(), 2) * 8, GROWN);
	return press.finish();
}

// ─── Time ─────────────────────────────────────────────────────────────────────

/** Keys of the cycle: when, height, how far the lip has bent over, reach of the arms, travel, size of the claws, broken water. */
const KEYS: readonly (readonly number[])[] = [
	[0.0, 1.0, 0.0, 1.0, 0, 1.0, 0],
	[0.09, 1.0, 0.22, 1.04, 22, 1.06, 0],
	[0.18, 0.95, 0.62, 1.08, 62, 1.12, 0],
	[0.26, 0.82, 1.08, 1.1, 112, 1.14, 0.12],
	[0.33, 0.58, 1.28, 1.02, 168, 1.1, 0.8],
	[0.41, 0.34, 1.0, 0.8, 196, 0.95, 1.0],
	[0.52, 0.2, 0.4, 0.5, 150, 0.7, 0.85],
	[0.63, 0.2, -0.1, 0.36, 30, 0.5, 0.35],
	[0.74, 0.42, -0.34, 0.4, -60, 0.45, 0],
	[0.85, 0.76, -0.3, 0.62, -62, 0.62, 0],
	[0.94, 0.96, -0.1, 0.9, -24, 0.88, 0],
];

/** Value of a track at a time, smooth and without overshoot, round and round. */
function track(column: number, t: number) {
	const n = KEYS.length;
	let i = n - 1;
	for (let k = 0; k < n; k++) if (KEYS[k][0] <= t) i = k;
	const time = (k: number) => KEYS[((k % n) + n) % n][0] + Math.floor(k / n);
	const value = (k: number) => KEYS[((k % n) + n) % n][column];
	const t0 = time(i), h = time(i + 1) - t0, s = (t - t0) / h;
	const slope = (k: number) => {
		const a = (value(k) - value(k - 1)) / (time(k) - time(k - 1)), b = (value(k + 1) - value(k)) / (time(k + 1) - time(k));
		return a * b <= 0 ? 0 : (2 * a * b) / (a + b);
	};
	const m0 = slope(i) * h, m1 = slope(i + 1) * h, s2 = s * s, s3 = s2 * s;
	return (2 * s3 - 3 * s2 + 1) * value(i) + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * value(i + 1) + (s3 - s2) * m1;
}

const TAU = Math.PI * 2;
const BASE = 890;

/** Where the wave is at time `state[0]` (0..1): positions of every vertex, in print pixels. */
export function pose(d: Drawing, state: ArrayLike<number>, out: Float32Array): Float32Array {
	const t = state[0] - Math.floor(state[0]);
	const height = track(1, t), bend = track(2, t), reach = track(3, t), travel = track(4, t), claws = track(5, t), broken = track(6, t);
	const sin = Math.sin(TAU * t), cos1 = 1 - Math.cos(TAU * t);
	// the two swells answer the wave: up as it comes down
	const lift = 0.08 * cos1 + 0.06 * sin;

	const great = (x: number, y: number, o: Float32Array) => {
		// the lip swings over a pivot inside the crest
		const w = smooth(440, 1080, x) * smooth(720, 380, y);
		const a = bend * w, k = lerp(1, reach, w);
		const dx = (x - 600) * k, dy = (y - 430) * k;
		const ca = Math.cos(a), sa = Math.sin(a);
		let qx = 600 + dx * ca - dy * sa, qy = 430 + dx * sa + dy * ca;
		// then the whole wave leans, travels and sinks into the sea
		const side = smooth(-760, 120, x); // its far shoulder stays where it is
		qx += travel * side * (0.35 + 0.75 * clamp01((BASE - qy) / 780));
		qy = BASE - (BASE - qy) * lerp(1, height, side);
		// nothing goes under the water
		if (qy > BASE + 26) qy = BASE + 26 + (qy - BASE - 26) * 0.12;
		o[0] = qx;
		o[1] = qy;
	};
	const near = (x: number, y: number, o: Float32Array) => {
		const env = smooth(-560, -100, x) * smooth(1010, 780, x);
		const v = Math.max(0, (900 - y) / 220);
		o[0] = x + env * v * (26 * sin + 18 * cos1);
		o[1] = y - env * v * 220 * (lift * 1.1 - 0.12 * sin) - env * 4.5 * (Math.sin(TAU * t * 2 + x * 0.006) - Math.sin(x * 0.006));
	};
	const swell = (x: number, y: number, o: Float32Array) => {
		const env = smooth(880, 1250, x) * smooth(2690, 2300, x);
		const ph = x * 0.0042;
		o[0] = x + env * 10 * (Math.cos(TAU * t - ph) - Math.cos(ph));
		o[1] = y + env * (14 * (Math.sin(TAU * t - ph) + Math.sin(ph)) - 13 * cos1 * smooth(920, 520, y));
	};
	const move = (g: number, x: number, y: number, o: Float32Array) => (g === GREAT ? great : g === NEAR ? near : swell)(x, y, o);

	const { x: X, y: Y, group, grow, seed } = d.anchors;
	const n = X.length;
	const tx = new Float32Array(n), ty = new Float32Array(n), c = new Float32Array(n), s = new Float32Array(n);
	const a = new Float32Array(2), b = new Float32Array(2);

	for (let i = 0; i < n; i++) {
		const x = X[i], y = Y[i], g = group[i], q = seed[i];
		c[i] = 1;
		if (g <= SWELL) {
			move(g, x, y, a);
			tx[i] = a[0];
			ty[i] = a[1];
			if (grow[i] === CLAW) {
				// a claw turns with the water it stands on, and keeps its shape
				move(g, x + 3, y, b);
				const turn = Math.atan2(b[1] - a[1], b[0] - a[0]);
				const size = g === GREAT ? claws : 1;
				c[i] = Math.cos(turn) * size;
				s[i] = Math.sin(turn) * size;
			}
		} else if (g === BOAT_LEFT || g === BOAT_RIGHT) {
			// a boat rides its swell: it rises with it and tips with its slope
			const left = g === BOAT_LEFT;
			const bx = left ? 430 : x, by = left ? 838 : y + 40;
			move(left ? NEAR : SWELL, bx - 60, by, a);
			move(left ? NEAR : SWELL, bx + 60, by, b);
			// the one in the hollow is set down on the level as the wave above it goes
			const down = left ? smooth(0.22, 0.42, t) * smooth(0.86, 0.6, t) : 0;
			const turn = Math.atan2(b[1] - a[1], b[0] - a[0]) + (left ? 0.1 : 0.07) * sin - 0.5 * down;
			const sink = 122 * down;
			tx[i] = x + (a[0] + b[0]) / 2 - bx;
			ty[i] = y + (a[1] + b[1]) / 2 - by + sink;
			c[i] = Math.cos(turn);
			s[i] = Math.sin(turn);
		} else if (g === BURST) {
			// thrown up from the line where the lip lands, each lump a little after the last
			const late = 0.16 * ((x - 330) / 900) + 0.08 * q;
			const k = broken * smooth(0.22 + late * 0.35, 0.36 + late * 0.35, t) * smooth(0.74, 0.46 + late, t);
			const up = k * Math.sin(Math.PI * clamp01((t - 0.2 - late * 0.3) / 0.42));
			tx[i] = x + (t - 0.3) * 190 * ((x - 700) / 450);
			ty[i] = lerp(BASE + 30, y, Math.max(0, up)) - 34 * up;
			c[i] = k;
			s[i] = 0.25 * k * Math.sin(q * 9 + t * 7);
		} else if (g === SPRAY) {
			// hangs in the air at the instant of the print, then falls with the lip
			const fall = t < 0.5 ? t : t - 1;
			tx[i] = x + fall * (160 + 240 * q);
			ty[i] = y + (fall >= 0 ? 260 * fall + 1500 * fall * fall * (0.4 + q) : fall * 420 * (0.4 + q));
			c[i] = fall >= 0 ? smooth(0.34, 0.2, fall) : smooth(-0.16, -0.02, fall);
		} else {
			// drops flung by the break
			const u = clamp01((t - 0.27 - q * 0.08) / 0.3);
			tx[i] = x + ((x - 760) / 480) * 260 * u;
			ty[i] = y - (380 + 520 * ((q * 7.3) % 1)) * u * (1 - u) * 1.6;
			c[i] = u > 0 && u < 1 ? Math.sin(Math.PI * Math.min(1, u * 1.1)) : 0;
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
