import { DEG, angleDelta, clamp, radiansPerPixel, stereoFor, type Projection, type Vec3 } from "./math";

const MIN_PITCH = -85 * DEG;
const MAX_PITCH = 85 * DEG;
const MIN_ZOOM = 0.38;
const MAX_ZOOM = 1.25;

/**
 * Viewing direction of a phone held in front of the face, from the
 * DeviceOrientation angles (degrees) and the screen rotation (radians).
 * Same construction as the W3C spec example: Z-X'-Y'' Euler angles, then a
 * -90° turn about X so the camera looks out of the back of the device.
 */
function deviceForward(alpha: number, beta: number, gamma: number, orient: number): Vec3 {
	const x = beta * DEG, y = alpha * DEG, z = -gamma * DEG;
	const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
	const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
	// Euler 'YXZ' -> quaternion
	let qx = s1 * c2 * c3 + c1 * s2 * s3;
	let qy = c1 * s2 * c3 - s1 * c2 * s3;
	let qz = c1 * c2 * s3 - s1 * s2 * c3;
	let qw = c1 * c2 * c3 + s1 * s2 * s3;
	const mul = (bx: number, by: number, bz: number, bw: number) => {
		const ax = qx, ay = qy, az = qz, aw = qw;
		qx = aw * bx + ax * bw + ay * bz - az * by;
		qy = aw * by - ax * bz + ay * bw + az * bx;
		qz = aw * bz + ax * by - ay * bx + az * bw;
		qw = aw * bw - ax * bx - ay * by - az * bz;
	};
	mul(-Math.SQRT1_2, 0, 0, Math.SQRT1_2); // -90° about X
	mul(0, 0, Math.sin(-orient / 2), Math.cos(-orient / 2)); // screen rotation about Z
	// rotate (0, 0, -1): the camera's forward axis in a y-up, z-backwards frame
	const vx = 0, vy = 0, vz = -1;
	const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
	const fx = vx + qw * tx + (qy * tz - qz * ty);
	const fy = vy + qw * ty + (qz * tx - qx * tz);
	const fz = vz + qw * tz + (qx * ty - qy * tx);
	// convert to this app's frame (z forward)
	return [fx, fy, -fz];
}

export interface ViewState {
	yaw: number;
	pitch: number;
	zoom: number;
}

/**
 * Look-around controller: pointer drag with inertia, pinch and wheel zoom,
 * keyboard, and optional device orientation. Purely numeric — the app
 * decides what to render.
 */
export class ViewController implements ViewState {
	yaw = 0;
	pitch = 0;
	zoom = 1;
	/** When true, user input is ignored (scripted camera moves). */
	locked = false;
	onInteract: (() => void) | null = null;

	private el: HTMLElement;
	private vyaw = 0;
	private vpitch = 0;
	private pointers = new Map<number, { x: number; y: number }>();
	private pinch: { dist: number; zoom: number } | null = null;
	private samples: { t: number; dy: number; dp: number }[] = [];
	private keys = new Set<string>();
	private keyHold = 0;
	private gyro: { offset: number | null; alpha: number; beta: number; gamma: number; ready: boolean } | null = null;
	private dirty = true;

	constructor(el: HTMLElement) {
		this.el = el;
		el.addEventListener("pointerdown", this.onDown);
		el.addEventListener("pointermove", this.onMove);
		el.addEventListener("pointerup", this.onUp);
		el.addEventListener("pointercancel", this.onUp);
		el.addEventListener("lostpointercapture", this.onUp);
		el.addEventListener("wheel", this.onWheel, { passive: false });
		el.addEventListener("keydown", this.onKeyDown);
		el.addEventListener("keyup", this.onKeyUp);
		el.addEventListener("blur", () => this.keys.clear());
	}

	/** Base vertical field of view for the current screen shape. */
	static baseFov(aspect: number) {
		if (aspect >= 1) {
			// aim for ~100° across, kept within a comfortable vertical range
			const v = 2 * Math.atan(Math.tan(50 * DEG) / aspect);
			return clamp(v, 56 * DEG, 76 * DEG);
		}
		// portrait: keep ~76° across; the stereographic blend tames the edges
		const v = 2 * Math.atan(Math.tan(38 * DEG) / aspect);
		return clamp(v, 76 * DEG, 122 * DEG);
	}

	projection(aspect: number): Projection {
		const fovV = clamp(ViewController.baseFov(aspect) * this.zoom, 18 * DEG, 125 * DEG);
		return { fovV, stereo: stereoFor(fovV), aspect };
	}

	set(v: Partial<ViewState>) {
		if (v.yaw !== undefined) this.yaw = v.yaw;
		if (v.pitch !== undefined) this.pitch = clamp(v.pitch, MIN_PITCH, MAX_PITCH);
		if (v.zoom !== undefined) this.zoom = v.zoom;
		this.vyaw = this.vpitch = 0;
		this.dirty = true;
	}

	stop() {
		this.vyaw = this.vpitch = 0;
		this.pointers.clear();
		this.pinch = null;
		this.keys.clear();
	}

	/** Advance inertia / keys; returns true when the view changed. */
	update(dt: number): boolean {
		let changed = this.dirty;
		this.dirty = false;
		if (this.locked) return changed;

		if (this.keys.size) {
			this.keyHold += dt;
			const speed = (55 + Math.min(this.keyHold, 1.5) * 50) * DEG * Math.min(this.zoom, 1);
			if (this.keys.has("ArrowLeft")) this.yaw -= speed * dt;
			if (this.keys.has("ArrowRight")) this.yaw += speed * dt;
			if (this.keys.has("ArrowUp")) this.pitch += speed * dt * 0.8;
			if (this.keys.has("ArrowDown")) this.pitch -= speed * dt * 0.8;
			if (this.keys.has("+")) this.zoom *= Math.exp(-dt * 1.4);
			if (this.keys.has("-")) this.zoom *= Math.exp(dt * 1.4);
			changed = true;
		}

		if (this.pointers.size === 0 && (Math.abs(this.vyaw) > 1e-4 || Math.abs(this.vpitch) > 1e-4)) {
			this.yaw += this.vyaw * dt;
			this.pitch += this.vpitch * dt;
			const decay = Math.exp(-dt * 3.2);
			this.vyaw *= decay;
			this.vpitch *= decay;
			changed = true;
		}

		if (this.gyro?.ready) {
			const g = this.gyro;
			const [fx, fy, fz] = deviceForward(g.alpha, g.beta, g.gamma, (screen.orientation?.angle ?? 0) * DEG);
			const devYaw = Math.atan2(fx, fz);
			const devPitch = Math.asin(clamp(fy, -1, 1));
			// keep the current heading when motion control is switched on
			if (g.offset === null) g.offset = this.yaw - devYaw;
			const k = Math.min(1, dt * 14);
			this.yaw += angleDelta(this.yaw, devYaw + g.offset) * k;
			this.pitch += (clamp(devPitch, MIN_PITCH, MAX_PITCH) - this.pitch) * k;
			changed = true;
		}

		this.pitch = clamp(this.pitch, MIN_PITCH, MAX_PITCH);
		this.zoom = clamp(this.zoom, MIN_ZOOM, MAX_ZOOM);
		return changed;
	}

	// ─── Device orientation ──────────────────────────────────────────────────

	static gyroSupported() {
		return typeof window !== "undefined" && "DeviceOrientationEvent" in window && matchMedia("(pointer: coarse)").matches;
	}

	async enableGyro(): Promise<boolean> {
		const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
		if (typeof DOE.requestPermission === "function") {
			try {
				if ((await DOE.requestPermission()) !== "granted") return false;
			} catch {
				return false;
			}
		}
		this.gyro = { offset: null, alpha: 0, beta: 90, gamma: 0, ready: false };
		window.addEventListener("deviceorientation", this.onOrientation);
		return true;
	}

	disableGyro() {
		this.gyro = null;
		window.removeEventListener("deviceorientation", this.onOrientation);
	}

	get gyroActive() {
		return this.gyro !== null;
	}

	private onOrientation = (e: DeviceOrientationEvent) => {
		if (!this.gyro || e.alpha === null) return;
		this.gyro.alpha = e.alpha;
		this.gyro.beta = e.beta ?? 90;
		this.gyro.gamma = e.gamma ?? 0;
		this.gyro.ready = true;
	};

	// ─── Pointer ─────────────────────────────────────────────────────────────

	private rpp() {
		const rect = this.el.getBoundingClientRect();
		return radiansPerPixel(this.projection(rect.width / rect.height), rect.height);
	}

	private onDown = (e: PointerEvent) => {
		if (this.locked || (e.pointerType === "mouse" && e.button !== 0)) return;
		this.el.setPointerCapture(e.pointerId);
		this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		this.vyaw = this.vpitch = 0;
		this.samples = [];
		if (this.pointers.size === 2) {
			const [a, b] = [...this.pointers.values()];
			this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.zoom };
		}
		this.onInteract?.();
	};

	private onMove = (e: PointerEvent) => {
		const prev = this.pointers.get(e.pointerId);
		if (!prev || this.locked) return;
		const cur = { x: e.clientX, y: e.clientY };
		this.pointers.set(e.pointerId, cur);
		if (this.pointers.size >= 2 && this.pinch) {
			const [a, b] = [...this.pointers.values()];
			const dist = Math.hypot(a.x - b.x, a.y - b.y);
			if (dist > 0) this.zoom = clamp(this.pinch.zoom * (this.pinch.dist / dist), MIN_ZOOM, MAX_ZOOM);
			this.dirty = true;
			return;
		}
		const k = this.rpp();
		const dy = -(cur.x - prev.x) * k;
		const dp = (cur.y - prev.y) * k;
		this.yaw += dy;
		// with motion control on, dragging re-aims the heading; pitch follows the device
		if (this.gyro?.offset != null) this.gyro.offset += dy;
		else this.pitch = clamp(this.pitch + dp, MIN_PITCH, MAX_PITCH);
		const t = performance.now();
		this.samples.push({ t, dy, dp });
		while (this.samples.length && t - this.samples[0].t > 90) this.samples.shift();
		this.dirty = true;
	};

	private onUp = (e: PointerEvent) => {
		if (!this.pointers.has(e.pointerId)) return;
		this.pointers.delete(e.pointerId);
		if (this.pointers.size < 2) this.pinch = null;
		if (this.pointers.size === 0 && this.samples.length > 1) {
			const span = (performance.now() - this.samples[0].t) / 1000;
			if (span > 0 && performance.now() - this.samples[this.samples.length - 1].t < 60) {
				const sy = this.samples.reduce((s, v) => s + v.dy, 0);
				const sp = this.samples.reduce((s, v) => s + v.dp, 0);
				this.vyaw = clamp(sy / Math.max(span, 0.016), -6, 6);
				this.vpitch = clamp(sp / Math.max(span, 0.016), -4, 4);
			}
		}
		this.samples = [];
	};

	private onWheel = (e: WheelEvent) => {
		if (this.locked) return;
		e.preventDefault();
		const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
		this.zoom = clamp(this.zoom * Math.exp(e.deltaY * unit * 0.0012), MIN_ZOOM, MAX_ZOOM);
		this.dirty = true;
		this.onInteract?.();
	};

	// ─── Keyboard ────────────────────────────────────────────────────────────

	private static keyName(e: KeyboardEvent) {
		if (e.key === "=" || e.key === "+") return "+";
		if (e.key === "-" || e.key === "_") return "-";
		return e.key;
	}

	private onKeyDown = (e: KeyboardEvent) => {
		if (this.locked || e.altKey || e.ctrlKey || e.metaKey) return;
		const k = ViewController.keyName(e);
		if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "-"].includes(k)) {
			e.preventDefault();
			if (!this.keys.size) this.keyHold = 0;
			this.keys.add(k);
			this.vyaw = this.vpitch = 0;
			this.onInteract?.();
		}
	};

	private onKeyUp = (e: KeyboardEvent) => {
		this.keys.delete(ViewController.keyName(e));
	};
}
