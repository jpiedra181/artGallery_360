import type { Overlay } from "./overlay";
import { fragmentShader, vertexShader, type Feature } from "./shaders";

/** Effect parameters for one scene, packed the way the shader reads them. */
type Vec4 = [number, number, number, number];

export interface FxUniforms {
	water: Vec4;
	rain: Vec4;
	light: Vec4;
	mood: Vec4;
	grade: Vec4;
	live: Vec4;
	air: Vec4;
	lights: Vec4;
	darks: Vec4;
	mist: Vec4;
	hover: Vec4;
	hover2: Vec4;
}

export interface SceneTextures {
	pano: WebGLTexture;
	mask: WebGLTexture | null;
	/** Disparity map for parallax (see shaders.ts); null leaves the scene flat. */
	depth: WebGLTexture | null;
	/** A drawing that hangs in the scene and can move. */
	overlay?: Overlay | null;
	/** What it asks of the shader. */
	features: readonly Feature[];
	/** Distance of the scene's nearest surface (metres), the unit of its disparities. */
	near: number;
	width: number;
}

export interface FrameState {
	rotA: Float32Array;
	rotB: Float32Array;
	/** Eye offset per scene: xyz in units of the scene's nearest surface, w the depth curve. */
	eyeA: Float32Array;
	eyeB: Float32Array;
	fxA: FxUniforms;
	fxB: FxUniforms;
	fovV: number; // radians
	stereo: number;
	mix: number;
	ripple: boolean;
	center: [number, number];
	/** Pigment at the front of a transition: linear rgb and strength. */
	ink: [number, number, number, number];
	/** The next scene closes in on the origin instead of spreading from it. */
	close: boolean;
	time: number;
	drips: Float32Array; // 8 × vec4
	/** What rides the water of the scene: 7 × (yaw, pitch of its waterline, half width, amplitude). */
	rocks: Float32Array;
	/** Where the pointer keeps the rain off: yaw, height over the horizon (tan), how much. */
	shelter: Float32Array;
	/** Pigment in the water of the gallery: 4 × (x, z, radius, strength), 4 × linear rgb, and how far it glows. */
	stains: Float32Array;
	stainInks: Float32Array;
	stainGlow: number;
	/** How far the world is still looked at through its painting (see shaders.ts). */
	match: { amount: number; worldIsB: boolean; plane: Vec4; y: number; grid: Float32Array } | null;
}

const FX_FIELDS = ["water", "rain", "light", "mood", "grade", "live", "air", "lights", "darks", "mist", "hover", "hover2"] as const;

export const emptyFx = (): FxUniforms => ({
	water: [0, 1.6, 1, 1],
	rain: [0, 0, 1, 0],
	light: [0, 0, 0, 0],
	mood: [0, 0, 0, 0],
	grade: [0, 0, 0, 1],
	live: [0, 0, 0, 0],
	air: [0, 0, 0, 1],
	lights: [1, 1, 1, 1],
	darks: [1, 1, 1, 0],
	mist: [0, 0, 0, 0],
	hover: [0, 4, 1, 1],
	hover2: [0, 0, 0, 0],
});

const NO_SHEET = [0, 1, 0, 1];
const NO_EYE = new Float32Array([0, 0, 0, 1]);

const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));
const PHONE = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

interface Program {
	program: WebGLProgram;
	loc: Record<string, WebGLUniformLocation | null>;
	linked: boolean;
	ready: Promise<void>;
}

/**
 * Minimal WebGL2 renderer for equirectangular panoramas: a program per kind of
 * scene, one fullscreen triangle and two scene slots that can be cross-faded.
 */
export class PanoRenderer {
	readonly canvas: HTMLCanvasElement;
	gl: WebGL2RenderingContext;
	maxTextureSize = 4096;
	lost = false;
	onRestored: (() => void) | null = null;

	private programs = new Map<string, Program>();
	private vao!: WebGLVertexArrayObject;
	private black!: WebGLTexture;
	private anisotropy: { ext: EXT_texture_filter_anisotropic; max: number } | null = null;
	private slots: [SceneTextures | null, SceneTextures | null] = [null, null];
	/** The painting being approached, for the detail the panorama cannot hold. */
	art: WebGLTexture | null = null;
	private renderScale = 1;
	private pixelRatio = 1;
	/** CSS size of the canvas, given by whoever watches it (reading it on every frame forces a layout). */
	private cssWidth = 0;
	private cssHeight = 0;
	/** Scaled down for a moment, on top of the adaptive scale (a crossing on a phone). */
	momentScale = 1;

	constructor(canvas: HTMLCanvasElement) {
		this.canvas = canvas;
		const gl = canvas.getContext("webgl2", {
			alpha: false,
			antialias: false,
			depth: false,
			stencil: false,
			premultipliedAlpha: false,
			preserveDrawingBuffer: false,
			powerPreference: "high-performance",
			// refuse software rendering: the readable document is better than a slideshow
			failIfMajorPerformanceCaveat: true,
		});
		if (!gl) throw new Error("WebGL2 unavailable");
		this.gl = gl;
		this.init();

		canvas.addEventListener("webglcontextlost", (e) => {
			e.preventDefault();
			this.lost = true;
			this.slots = [null, null];
			this.art = null;
		});
		canvas.addEventListener("webglcontextrestored", () => {
			this.lost = false;
			this.init();
			this.onRestored?.();
		});
	}

	private init() {
		const gl = this.gl;
		this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
		const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
		this.anisotropy = aniso
			? { ext: aniso, max: Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) }
			: null;

		this.programs.clear();
		this.vao = gl.createVertexArray()!;

		this.black = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, this.black);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
	}

	/**
	 * The program for a set of features; its `ready` resolves once it is linked.
	 * Compiled without blocking: with KHR_parallel_shader_compile the driver
	 * works in the background and we poll for completion each frame instead of
	 * stalling the page for the hundreds of milliseconds a big fragment shader
	 * can take (ANGLE translates it to HLSL on Windows).
	 */
	prepare(features: readonly Feature[]): Program {
		const key = features.join();
		const known = this.programs.get(key);
		if (known) return known;
		const gl = this.gl;
		const parallel = gl.getExtension("KHR_parallel_shader_compile");
		const shader = (type: number, src: string) => {
			const sh = gl.createShader(type)!;
			gl.shaderSource(sh, src);
			gl.compileShader(sh);
			return sh;
		};
		const vs = shader(gl.VERTEX_SHADER, vertexShader);
		const fs = shader(gl.FRAGMENT_SHADER, fragmentShader(features));
		const program = gl.createProgram()!;
		gl.attachShader(program, vs);
		gl.attachShader(program, fs);
		gl.linkProgram(program);
		const made: Program = { program, loc: {}, linked: false, ready: Promise.resolve() };
		made.ready = new Promise<void>((resolve, reject) => {
			const poll = () => {
				if (gl.isContextLost()) return;
				if (parallel && !gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR)) {
					requestAnimationFrame(poll);
					return;
				}
				if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
					reject(new Error(gl.getShaderInfoLog(fs) || gl.getShaderInfoLog(vs) || gl.getProgramInfoLog(program) || "program link failed"));
					return;
				}
				this.lookupUniforms(made);
				made.linked = true;
				resolve();
			};
			poll();
		});
		made.ready.catch(() => {});
		this.programs.set(key, made);
		return made;
	}

	private lookupUniforms(p: Program) {
		const gl = this.gl;
		const names = [
			"uPano", "uMask", "uDepth", "uRot", "uRotOther", "uEye", "uIsB",
			"uAspect", "uTanHalf", "uTanQuarter", "uStereo", "uTime", "uMix", "uRipple", "uCenter", "uInk", "uClose",
			"uDrips", "uRock", "uShelter",
			"uMatch", "uMatchB", "uMatchPlane", "uMatchY", "uMatchGrid",
			"uArt", "uStain", "uStainInk", "uStainGlow",
			"uSheet", "uSheetRect", "uSheetOn",
		];
		for (const n of names) p.loc[n] = gl.getUniformLocation(p.program, n);
		for (const f of FX_FIELDS) p.loc[`uFx.${f}`] = gl.getUniformLocation(p.program, `uFx.${f}`);
		gl.useProgram(p.program);
		gl.uniform1i(p.loc.uPano, 0);
		gl.uniform1i(p.loc.uMask, 1);
		gl.uniform1i(p.loc.uDepth, 2);
		gl.uniform1i(p.loc.uSheet, 3);
		gl.uniform1i(p.loc.uArt, 4);
	}

	/**
	 * Upload a decoded image in horizontal strips, one per animation frame, so
	 * large panoramas never cause a long main-thread stall mid-animation.
	 */
	async uploadTexture(
		bitmap: ImageBitmap,
		opts: { srgb: boolean; mipmaps: boolean; stripRows?: number; grey?: boolean },
	): Promise<WebGLTexture> {
		const gl = this.gl;
		const { width, height } = bitmap;
		const levels = opts.mipmaps ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1;
		const tex = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, tex);
		// a single channel for grey maps: a quarter of the memory
		const format = opts.grey ? gl.RED : gl.RGBA;
		gl.texStorage2D(gl.TEXTURE_2D, levels, opts.grey ? gl.R8 : opts.srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, width, height);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
		gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);

		// ≈16 MB per strip; 4 on a phone, whose driver copies more slowly
		const rows = Math.min(opts.stripRows ?? Infinity, Math.max(128, Math.round((PHONE ? 1 << 20 : 1 << 22) / width)));
		if (rows >= height) {
			gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, format, gl.UNSIGNED_BYTE, bitmap);
		} else {
			for (let y = 0; y < height; y += rows) {
				const h = Math.min(rows, height - y);
				if (gl.isContextLost()) throw new Error("context lost");
				gl.bindTexture(gl.TEXTURE_2D, tex);
				// Rows are skipped in the upload, not cut out with createImageBitmap(bitmap, 0, y, …):
				// Firefox takes the top of the picture for every such cut.
				gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
				gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, width, h, format, gl.UNSIGNED_BYTE, bitmap);
				gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
				await nextFrame();
			}
			gl.bindTexture(gl.TEXTURE_2D, tex);
		}
		if (opts.mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
		if (opts.mipmaps && this.anisotropy) {
			gl.texParameterf(gl.TEXTURE_2D, this.anisotropy.ext.TEXTURE_MAX_ANISOTROPY_EXT, this.anisotropy.max);
		}
		return tex;
	}

	deleteTexture(tex: WebGLTexture | null) {
		if (tex && !this.lost) this.gl.deleteTexture(tex);
	}

	setSlot(index: 0 | 1, scene: SceneTextures | null) {
		this.slots[index] = scene;
	}

	getSlot(index: 0 | 1) {
		return this.slots[index];
	}

	/** Swap B into A at the end of a transition. */
	promote() {
		this.slots = [this.slots[1], null];
	}

	setRenderScale(scale: number) {
		this.renderScale = scale;
	}

	setSize(width: number, height: number) {
		this.cssWidth = width;
		this.cssHeight = height;
	}

	/** Resize the drawing buffer; returns true if it changed. */
	resize(): boolean {
		// a phone's screen is dense enough that a painting needs no more than one and a half pixels to its point
		this.pixelRatio = Math.min(window.devicePixelRatio || 1, PHONE ? 1.5 : 2);
		if (!this.cssWidth) this.setSize(this.canvas.clientWidth, this.canvas.clientHeight);
		const scale = this.pixelRatio * this.renderScale * this.momentScale;
		const w = Math.max(1, Math.round(this.cssWidth * scale));
		const h = Math.max(1, Math.round(this.cssHeight * scale));
		if (this.canvas.width !== w || this.canvas.height !== h) {
			this.canvas.width = w;
			this.canvas.height = h;
			return true;
		}
		return false;
	}

	render(f: FrameState) {
		const gl = this.gl;
		if (this.lost || gl.isContextLost()) return;
		const [a, b] = this.slots;
		gl.viewport(0, 0, this.canvas.width, this.canvas.height);
		if (!a || !this.prepare(a.features).linked) {
			gl.clearColor(0.02, 0.025, 0.03, 1);
			gl.clear(gl.COLOR_BUFFER_BIT);
			return;
		}
		// once the next scene is all there is, it is drawn alone
		if (!b || f.mix < 1) this.pass(f, a, !!b, false);
		if (b && f.mix > 0 && this.prepare(b.features).linked) {
			gl.enable(gl.BLEND);
			gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
			this.pass(f, b, true, true);
			gl.disable(gl.BLEND);
		}
	}

	/** Draw one scene over the whole canvas. */
	private pass(f: FrameState, scene: SceneTextures, crossing: boolean, isB: boolean) {
		const gl = this.gl;
		const { program, loc: L } = this.prepare(scene.features);
		gl.useProgram(program);
		gl.bindVertexArray(this.vao);

		const bindTex = (unit: number, tex: WebGLTexture | null) => {
			gl.activeTexture(gl.TEXTURE0 + unit);
			gl.bindTexture(gl.TEXTURE_2D, tex ?? this.black);
		};
		const sheet = scene.overlay ?? null;
		bindTex(0, scene.pano);
		bindTex(1, scene.mask);
		bindTex(2, scene.depth);
		bindTex(3, sheet?.texture ?? null);
		bindTex(4, this.art);

		const half = f.fovV / 2;
		gl.uniformMatrix3fv(L.uRot, false, isB ? f.rotB : f.rotA);
		gl.uniformMatrix3fv(L.uRotOther, false, isB ? f.rotA : f.rotB);
		gl.uniform1f(L.uIsB, isB ? 1 : 0);
		gl.uniform4fv(L.uSheetRect, sheet?.rect ?? NO_SHEET);
		gl.uniform2f(L.uSheetOn, sheet ? 1 : 0, sheet ? scene.near / sheet.distance : 0);
		// without a depth map there is nothing to shift
		gl.uniform4fv(L.uEye, scene.depth ? (isB ? f.eyeB : f.eyeA) : NO_EYE);
		gl.uniform1f(L.uAspect, this.canvas.width / this.canvas.height);
		gl.uniform1f(L.uTanHalf, Math.tan(half));
		gl.uniform1f(L.uTanQuarter, Math.tan(half / 2));
		gl.uniform1f(L.uStereo, f.stereo);
		gl.uniform1f(L.uTime, f.time);
		gl.uniform1f(L.uMix, crossing ? f.mix : 0);
		gl.uniform1f(L.uRipple, f.ripple ? 1 : 0);
		gl.uniform2f(L.uCenter, f.center[0], f.center[1]);
		gl.uniform4fv(L.uInk, f.ink);
		gl.uniform1f(L.uClose, f.close ? 1 : 0);
		gl.uniform4fv(L.uDrips, f.drips);
		gl.uniform4fv(L.uRock, f.rocks);
		gl.uniform4fv(L.uShelter, f.shelter);
		const m = crossing ? f.match : null;
		gl.uniform1f(L.uMatch, m?.amount ?? 0);
		if (m) {
			gl.uniform1f(L.uMatchB, m.worldIsB ? 1 : 0);
			gl.uniform4fv(L.uMatchPlane, m.plane);
			gl.uniform1f(L.uMatchY, m.y);
			gl.uniform2fv(L.uMatchGrid, m.grid);
		}
		gl.uniform4fv(L.uStain, f.stains);
		gl.uniform3fv(L.uStainInk, f.stainInks);
		gl.uniform1f(L.uStainGlow, f.stainGlow);
		const fx = isB ? f.fxB : f.fxA;
		for (const name of FX_FIELDS) gl.uniform4fv(L[`uFx.${name}`], fx[name]);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	}
}
