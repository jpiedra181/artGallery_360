/**
 * What the drawn worlds are made with: smooth curves, filled outlines and
 * lines of ink, kept as flat triangles in painter's order. Every vertex hangs
 * from an anchor, and moving the anchors moves the drawing: that is all that is
 * worked out here, and the graphics card moves the vertices after them.
 * No DOM or WebGL here (see engine/overlay.ts, scripts/draw-sheet.mjs).
 */

export type P = readonly [number, number];

/** Where a sheet hangs around the viewer, in Mercator angles: drawn shapes keep their proportions wherever one looks. */
export interface Place {
	/** Sheet pixels per degree, the column that faces forward (yaw 0) and the row of the horizon. */
	scale: number;
	x0: number;
	horizon: number;
	/** The part of the sheet that is drawn (sheet pixels). */
	left: number;
	right: number;
	top: number;
	bottom: number;
	/** How far away it stands (metres), for the parallax. */
	distance: number;
}

/** A drawn world: `hang` writes every anchor (x, y, and cosine and sine times size), in sheet pixels, for a state of the drawing. */
export interface Sheet {
	PLACE: Place;
	COLOURS: readonly string[];
	draw(): Drawing;
	hang(d: Drawing, state: ArrayLike<number>, out: Float32Array): Float32Array;
}

// ─── Small maths ──────────────────────────────────────────────────────────────

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const smooth = (a: number, b: number, v: number) => {
	const t = clamp01((v - a) / (b - a));
	return t * t * (3 - 2 * t);
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Repeatable random numbers: the drawing is the same on every visit. */
export function random(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Smooth curve through points, resampled at an even step. */
export function curve(points: readonly P[], step = 9, closed = false): [number, number][] {
	const n = points.length;
	const at = (i: number): P => (closed ? points[(i + n) % n] : points[Math.min(n - 1, Math.max(0, i))]);
	const dense: [number, number][] = [];
	for (let i = 0; i < (closed ? n : n - 1); i++) {
		const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
		for (let k = 0; k < 16; k++) {
			const t = k / 16, t2 = t * t, t3 = t2 * t;
			const on = (c: 0 | 1) =>
				0.5 * (2 * p1[c] + (p2[c] - p0[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (3 * p1[c] - p0[c] - 3 * p2[c] + p3[c]) * t3);
			dense.push([on(0), on(1)]);
		}
	}
	const end = closed ? points[0] : points[n - 1];
	dense.push([end[0], end[1]]);
	const len = [0];
	for (let i = 1; i < dense.length; i++) len.push(len[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
	const total = len[len.length - 1];
	const count = Math.max(2, Math.round(total / step));
	const out: [number, number][] = [];
	let j = 0;
	for (let i = 0; i <= count - (closed ? 1 : 0); i++) {
		const s = (total * i) / count;
		while (j < len.length - 2 && len[j + 1] < s) j++;
		const t = (s - len[j]) / Math.max(1e-6, len[j + 1] - len[j]);
		out.push([lerp(dense[j][0], dense[j + 1][0], t), lerp(dense[j][1], dense[j + 1][1], t)]);
	}
	return out;
}

export const area = (p: readonly P[]) => {
	let a = 0;
	for (let i = 0; i < p.length; i++) {
		const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length];
		a += x0 * y1 - x1 * y0;
	}
	return a / 2;
};

/** Ear clipping: indices of the triangles of a simple polygon. */
export function triangulate(p: readonly P[]): number[] {
	const idx = p.map((_, i) => i);
	if (area(p) < 0) idx.reverse();
	const out: number[] = [];
	const cross = (a: P, b: P, c: P) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
	while (idx.length > 3) {
		let clipped = false;
		for (let i = 0; i < idx.length; i++) {
			const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
			const a = p[ia], b = p[ib], c = p[ic];
			if (cross(a, b, c) <= 1e-9) continue;
			let ear = true;
			for (const k of idx) {
				if (k === ia || k === ib || k === ic) continue;
				const q = p[k];
				if (cross(a, b, q) >= 0 && cross(b, c, q) >= 0 && cross(c, a, q) >= 0) {
					ear = false;
					break;
				}
			}
			if (!ear) continue;
			out.push(ia, ib, ic);
			idx.splice(i, 1);
			clipped = true;
			break;
		}
		if (!clipped) idx.splice(0, 1); // a pinched outline: drop a point and go on
	}
	out.push(idx[0], idx[1], idx[2]);
	return out;
}

export function inside(p: readonly P[], x: number, y: number) {
	let hit = false;
	for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
		const [xi, yi] = p[i], [xj, yj] = p[j];
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
	}
	return hit;
}

// ─── The press ────────────────────────────────────────────────────────────────

export interface Drawing {
	/** Anchors: rest position, group, how offsets scale, a random number of their own. */
	anchors: { x: Float32Array; y: Float32Array; group: Uint8Array; grow: Uint8Array; seed: Float32Array };
	/** Vertices: anchor, offset from it, colour. */
	vertexAnchor: Uint32Array;
	offset: Float32Array;
	colour: Uint8Array;
	index: Uint32Array;
}

/** Room to work in for the anchors of a drawing, made once. */
interface Work {
	tx: Float32Array;
	ty: Float32Array;
	c: Float32Array;
	s: Float32Array;
}
const works = new WeakMap<Drawing, Work>();
export function anchorsOf(d: Drawing): Work {
	let w = works.get(d);
	if (!w) {
		const n = d.anchors.x.length;
		works.set(d, (w = { tx: new Float32Array(n), ty: new Float32Array(n), c: new Float32Array(n), s: new Float32Array(n) }));
	}
	return w;
}
/** Four numbers an anchor, as the graphics card reads them. */
export function pack(d: Drawing, out: Float32Array): Float32Array {
	const { tx, ty, c, s } = anchorsOf(d);
	for (let i = 0, k = 0; i < tx.length; i++, k += 4) {
		out[k] = tx[i];
		out[k + 1] = ty[i];
		out[k + 2] = c[i];
		out[k + 3] = s[i];
	}
	return out;
}
/** Every vertex, for whoever has no graphics card to do it (scripts/draw-sheet.mjs). */
export function vertices(d: Drawing, hung: ArrayLike<number>, out: Float32Array): Float32Array {
	for (let v = 0, k = 0; v < d.vertexAnchor.length; v++, k += 2) {
		const i = d.vertexAnchor[v] * 4, ox = d.offset[k], oy = d.offset[k + 1];
		out[k] = hung[i] + hung[i + 2] * ox - hung[i + 3] * oy;
		out[k + 1] = hung[i + 1] + hung[i + 3] * ox + hung[i + 2] * oy;
	}
	return out;
}

export class Press {
	ax: number[] = [];
	ay: number[] = [];
	ag: number[] = [];
	ak: number[] = [];
	as: number[] = [];
	va: number[] = [];
	vo: number[] = [];
	vc: number[] = [];
	ix: number[] = [];
	group = 0;
	rnd = random(11);

	anchor(x: number, y: number, grow = 0) {
		this.ax.push(x);
		this.ay.push(y);
		this.ag.push(this.group);
		this.ak.push(grow);
		this.as.push(this.rnd());
		return this.ax.length - 1;
	}
	vertex(anchor: number, ox: number, oy: number, colour: number) {
		this.va.push(anchor);
		this.vo.push(ox, oy);
		this.vc.push(colour);
	}
	/** A filled outline; `spread` grows it outwards (the ink under a shape). */
	fill(p: readonly P[], colour: number, spread = 0, at = -1) {
		const tri = triangulate(p);
		const n = p.length;
		const sign = area(p) < 0 ? -1 : 1;
		const first = this.va.length;
		for (let i = 0; i < n; i++) {
			let ox = 0, oy = 0;
			if (spread) {
				const [x0, y0] = p[(i + n - 1) % n], [x1, y1] = p[(i + 1) % n];
				const l = Math.hypot(x1 - x0, y1 - y0) || 1;
				ox = ((y1 - y0) / l) * spread * sign;
				oy = (-(x1 - x0) / l) * spread * sign;
			}
			if (at >= 0) this.vertex(at, p[i][0] - this.ax[at] + ox, p[i][1] - this.ay[at] + oy, colour);
			else this.vertex(this.anchor(p[i][0], p[i][1]), ox, oy, colour);
		}
		for (const t of tri) this.ix.push(first + t);
	}
	/** A line of ink whose width follows `width` along it (0..1). */
	stroke(p: readonly P[], colour: number, width: (t: number) => number, at = -1) {
		const n = p.length;
		const first = this.va.length;
		for (let i = 0; i < n; i++) {
			const [x0, y0] = p[Math.max(0, i - 1)], [x1, y1] = p[Math.min(n - 1, i + 1)];
			const l = Math.hypot(x1 - x0, y1 - y0) || 1;
			const w = width(i / (n - 1)) / 2;
			const nx = (-(y1 - y0) / l) * w, ny = ((x1 - x0) / l) * w;
			const a = at >= 0 ? at : this.anchor(p[i][0], p[i][1]);
			const bx = p[i][0] - this.ax[a], by = p[i][1] - this.ay[a];
			this.vertex(a, bx + nx, by + ny, colour);
			this.vertex(a, bx - nx, by - ny, colour);
		}
		this.strip(first, n);
	}
	/** The area between two lines of the same length. */
	band(a: readonly P[], b: readonly P[], colour: number) {
		const first = this.va.length;
		for (let i = 0; i < a.length; i++) {
			this.vertex(this.anchor(a[i][0], a[i][1]), 0, 0, colour);
			this.vertex(this.anchor(b[i][0], b[i][1]), 0, 0, colour);
		}
		this.strip(first, a.length);
	}
	private strip(first: number, n: number) {
		for (let i = 0; i < n - 1; i++) {
			const k = first + i * 2;
			this.ix.push(k, k + 1, k + 2, k + 2, k + 1, k + 3);
		}
	}
	finish(): Drawing {
		return {
			anchors: {
				x: Float32Array.from(this.ax),
				y: Float32Array.from(this.ay),
				group: Uint8Array.from(this.ag),
				grow: Uint8Array.from(this.ak),
				seed: Float32Array.from(this.as),
			},
			vertexAnchor: Uint32Array.from(this.va),
			offset: Float32Array.from(this.vo),
			colour: Uint8Array.from(this.vc),
			index: Uint32Array.from(this.ix),
		};
	}
}
