export const DEG = Math.PI / 180;

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => {
	const t = clamp((x - a) / (b - a), 0, 1);
	return t * t * (3 - 2 * t);
};

/** Shortest signed angular difference b - a, in (-π, π]. */
export const angleDelta = (a: number, b: number) => {
	let d = (b - a) % (Math.PI * 2);
	if (d > Math.PI) d -= Math.PI * 2;
	if (d <= -Math.PI) d += Math.PI * 2;
	return d;
};

export type Vec3 = [number, number, number];

/** World direction for yaw/pitch (radians). x right, y up, z forward. */
export const dirFromAngles = (yaw: number, pitch: number): Vec3 => [
	Math.sin(yaw) * Math.cos(pitch),
	Math.sin(pitch),
	Math.cos(yaw) * Math.cos(pitch),
];

/** Column-major mat3 that maps camera space (x right, y up, z forward) to world. */
export function rotation(yaw: number, pitch: number, out = new Float32Array(9), roll = 0) {
	const sy = Math.sin(yaw), cy = Math.cos(yaw);
	const sp = Math.sin(pitch), cp = Math.cos(pitch);
	// right, up, forward
	let rx = cy, ry = 0, rz = -sy;
	let ux = -sy * sp, uy = cp, uz = -cy * sp;
	if (roll !== 0) {
		// tilt the horizon: turn right/up about the forward axis
		const sr = Math.sin(roll), cr = Math.cos(roll);
		[rx, ry, rz, ux, uy, uz] = [rx * cr + ux * sr, ry * cr + uy * sr, rz * cr + uz * sr, ux * cr - rx * sr, uy * cr - ry * sr, uz * cr - rz * sr];
	}
	out[0] = rx; out[1] = ry; out[2] = rz;
	out[3] = ux; out[4] = uy; out[5] = uz;
	out[6] = sy * cp; out[7] = sp; out[8] = cy * cp;
	return out;
}

export interface Projection {
	fovV: number; // radians
	stereo: number;
	aspect: number;
}

/** Stereographic blend used for very wide (portrait) fields of view. */
export const stereoFor = (fovV: number) => smoothstep(85 * DEG, 125 * DEG, fovV) * 0.75;

/** Screen radius (in half-heights) at which a ray `theta` from the view axis lands. */
function radiusForAngle(theta: number, p: Projection) {
	const th = Math.tan(p.fovV / 2);
	const tq = Math.tan(p.fovV / 4);
	const f = (r: number) => lerp(Math.atan(r * th), 2 * Math.atan(r * tq), p.stereo);
	let lo = 0, hi = 40;
	if (f(hi) < theta) return Infinity;
	for (let i = 0; i < 28; i++) {
		const mid = (lo + hi) / 2;
		if (f(mid) < theta) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}

/** Camera-space ray through a point on screen (mirrors screenRay() in the shader). */
export function screenRay(ndcX: number, ndcY: number, p: Projection): Vec3 {
	const px = ndcX * p.aspect;
	const py = ndcY;
	const r = Math.hypot(px, py);
	const theta = lerp(Math.atan(r * Math.tan(p.fovV / 2)), 2 * Math.atan(r * Math.tan(p.fovV / 4)), p.stereo);
	const s = r > 1e-6 ? Math.sin(theta) / r : 0;
	return [px * s, py * s, Math.cos(theta)];
}

/** Apply a column-major rotation (camera → world). */
export const toWorld = (m: Float32Array, v: Vec3): Vec3 => [
	m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
	m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
	m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
];

/** Angular change per screen pixel at the centre of the view (radians/px). */
export function radiansPerPixel(p: Projection, heightPx: number) {
	// d(theta)/dr at r = 0 for both mappings, r measured in half-heights
	const k = lerp(Math.tan(p.fovV / 2), 2 * Math.tan(p.fovV / 4), p.stereo);
	return k / (heightPx / 2);
}

/**
 * Project a world direction to normalised device coordinates for the camera
 * at yaw/pitch. Returns null when the point is behind the viewer.
 */
export function project(dir: Vec3, yaw: number, pitch: number, p: Projection): [number, number] | null {
	const m = rotation(yaw, pitch);
	// camera = transpose(m) * dir
	const x = m[0] * dir[0] + m[1] * dir[1] + m[2] * dir[2];
	const y = m[3] * dir[0] + m[4] * dir[1] + m[5] * dir[2];
	const z = m[6] * dir[0] + m[7] * dir[1] + m[8] * dir[2];
	const theta = Math.acos(clamp(z, -1, 1));
	if (theta > Math.PI * 0.62) return null;
	const r = radiusForAngle(theta, p);
	if (!isFinite(r)) return null;
	const len = Math.hypot(x, y);
	if (len < 1e-6) return [0, 0];
	return [((x / len) * r) / p.aspect, (y / len) * r];
}

export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;
