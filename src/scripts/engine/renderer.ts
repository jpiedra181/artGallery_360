import type { Overlay } from "./overlay";
import { fragmentShader, vertexShader } from "./shaders";

/** Effect parameters for one scene, packed the way the shader reads them. */
type Vec4 = [number, number, number, number];

export interface FxUniforms {
	water: Vec4;
	rain: Vec4;
	light: Vec4;
	mood: Vec4;
	grade: Vec4;
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
	drips: Float32Array; // 4 × vec4
	/** Pigment in the water of the gallery: 4 × (x, z, radius, strength), 4 × linear rgb, and how far it glows. */
	stains: Float32Array;
	stainInks: Float32Array;
	stainGlow: number;
	/** How far the world is still looked at through its painting (see shaders.ts). */
	match: { amount: number; worldIsB: boolean; plane: Vec4; y: number; grid: Float32Array } | null;
}

const FX_FIELDS = ["water", "rain", "light", "mood", "grade", "hover", "hover2"] as const;

export const emptyFx = (): FxUniforms => ({
	water: [0, 1.6, 1, 1],
	rain: [0, 0, 1, 0],
	light: [0, 0, 0, 0],
	mood: [0, 0, 0, 0],
	grade: [0, 0, 0, 1],
	hover: [0, 4, 1, 1],
	hover2: [0, 0, 0, 0],
});

const NO_SHEET = [0, 1, 0, 1];
const NO_EYE = new Float32Array([0, 0, 0, 1]);

const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

/**
 * Minimal WebGL2 renderer for equirectangular panoramas: one program, one
 * fullscreen triangle and two scene slots that can be cross-faded.
 */
export class PanoRenderer {
	readonly canvas: HTMLCanvasElement;
	gl: WebGL2RenderingContext;
	maxTextureSize = 4096;
	lost = false;
	onRestored: (() => void) | null = null;

	private program!: WebGLProgram;
	private vao!: WebGLVertexArrayObject;
	private loc: Record<string, WebGLUniformLocation | null> = {};
	private black!: WebGLTexture;
	private anisotropy: { ext: EXT_texture_filter_anisotropic; max: number } | null = null;
	private slots: [SceneTextures | null, SceneTextures | null] = [null, null];
	/** The painting being approached, for the detail the panorama cannot hold. */
	art: WebGLTexture | null = null;
	private renderScale = 1;
	private pixelRatio = 1;
	private linked = false;
	/** Resolves once the shader program is linked and ready to draw. */
	ready: Promise<void> = Promise.resolve();

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

		// Compile without blocking: with KHR_parallel_shader_compile the driver
		// works in the background and we poll for completion each frame instead
		// of stalling the page for the hundreds of milliseconds a big fragment
		// shader can take (ANGLE translates it to HLSL on Windows).
		const parallel = gl.getExtension("KHR_parallel_shader_compile");
		const shader = (type: number, src: string) => {
			const sh = gl.createShader(type)!;
			gl.shaderSource(sh, src);
			gl.compileShader(sh);
			return sh;
		};
		const vs = shader(gl.VERTEX_SHADER, vertexShader);
		const fs = shader(gl.FRAGMENT_SHADER, fragmentShader);
		const program = gl.createProgram()!;
		gl.attachShader(program, vs);
		gl.attachShader(program, fs);
		gl.linkProgram(program);
		this.program = program;
		this.vao = gl.createVertexArray()!;
		this.linked = false;

		const finish = () => {
			if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
				const log = gl.getShaderInfoLog(fs) || gl.getShaderInfoLog(vs) || gl.getProgramInfoLog(program);
				throw new Error(log || "program link failed");
			}
			this.lookupUniforms();
			this.linked = true;
		};
		this.ready = new Promise<void>((resolve, reject) => {
			const poll = () => {
				if (gl.isContextLost()) return;
				if (parallel && !gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR)) {
					requestAnimationFrame(poll);
					return;
				}
				try {
					finish();
					resolve();
				} catch (err) {
					reject(err);
				}
			};
			poll();
		});
		this.ready.catch(() => {});

		this.black = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, this.black);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
	}

	private lookupUniforms() {
		const gl = this.gl;
		const program = this.program;
		const names = [
			"uPanoA", "uPanoB", "uMaskA", "uMaskB", "uDepthA", "uDepthB", "uRotA", "uRotB", "uEyeA", "uEyeB",
			"uAspect", "uTanHalf", "uTanQuarter", "uStereo", "uTime", "uMix", "uRipple", "uCenter", "uInk", "uClose",
			"uDrips", "uResolution",
			"uMatch", "uMatchB", "uMatchPlane", "uMatchY", "uMatchGrid",
			"uArt", "uStain", "uStainInk", "uStainGlow",
			"uSheetA", "uSheetB", "uSheetRectA", "uSheetRectB", "uSheetOnA", "uSheetOnB",
		];
		for (const n of names) this.loc[n] = gl.getUniformLocation(program, n);
		for (const slot of ["uFxA", "uFxB"]) {
			for (const f of FX_FIELDS) this.loc[`${slot}.${f}`] = gl.getUniformLocation(program, `${slot}.${f}`);
		}
		gl.useProgram(program);
		gl.uniform1i(this.loc.uPanoA, 0);
		gl.uniform1i(this.loc.uPanoB, 1);
		gl.uniform1i(this.loc.uMaskA, 2);
		gl.uniform1i(this.loc.uMaskB, 3);
		gl.uniform1i(this.loc.uDepthA, 4);
		gl.uniform1i(this.loc.uDepthB, 5);
		gl.uniform1i(this.loc.uSheetA, 6);
		gl.uniform1i(this.loc.uSheetB, 7);
		gl.uniform1i(this.loc.uArt, 8);
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

		const rows = opts.stripRows ?? Math.max(128, Math.round((1 << 22) / width)); // ≈16 MB per strip
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

	/** Resize the drawing buffer; returns true if it changed. */
	resize(): boolean {
		this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
		const w = Math.max(1, Math.round(this.canvas.clientWidth * this.pixelRatio * this.renderScale));
		const h = Math.max(1, Math.round(this.canvas.clientHeight * this.pixelRatio * this.renderScale));
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
		if (!a || !this.linked) {
			gl.viewport(0, 0, this.canvas.width, this.canvas.height);
			gl.clearColor(0.02, 0.025, 0.03, 1);
			gl.clear(gl.COLOR_BUFFER_BIT);
			return;
		}
		gl.viewport(0, 0, this.canvas.width, this.canvas.height);
		gl.useProgram(this.program);
		gl.bindVertexArray(this.vao);

		const bindTex = (unit: number, tex: WebGLTexture | null) => {
			gl.activeTexture(gl.TEXTURE0 + unit);
			gl.bindTexture(gl.TEXTURE_2D, tex ?? this.black);
		};
		bindTex(0, a.pano);
		bindTex(1, (b ?? a).pano);
		bindTex(2, a.mask);
		bindTex(3, (b ?? a).mask);
		bindTex(4, a.depth);
		bindTex(5, (b ?? a).depth);
		const sheetA = a.overlay ?? null, sheetB = (b ?? a).overlay ?? null;
		bindTex(6, sheetA?.texture ?? null);
		bindTex(7, sheetB?.texture ?? null);
		bindTex(8, this.art);

		const L = this.loc;
		const half = f.fovV / 2;
		gl.uniformMatrix3fv(L.uRotA, false, f.rotA);
		gl.uniformMatrix3fv(L.uRotB, false, f.rotB);
		gl.uniform4fv(L.uSheetRectA, sheetA?.rect ?? NO_SHEET);
		gl.uniform4fv(L.uSheetRectB, sheetB?.rect ?? NO_SHEET);
		gl.uniform2f(L.uSheetOnA, sheetA ? 1 : 0, sheetA ? a.near / sheetA.distance : 0);
		gl.uniform2f(L.uSheetOnB, sheetB ? 1 : 0, sheetB ? (b ?? a).near / sheetB.distance : 0);
		// without a depth map there is nothing to shift
		gl.uniform4fv(L.uEyeA, a.depth ? f.eyeA : NO_EYE);
		gl.uniform4fv(L.uEyeB, (b ?? a).depth ? f.eyeB : NO_EYE);
		gl.uniform1f(L.uAspect, this.canvas.width / this.canvas.height);
		gl.uniform1f(L.uTanHalf, Math.tan(half));
		gl.uniform1f(L.uTanQuarter, Math.tan(half / 2));
		gl.uniform1f(L.uStereo, f.stereo);
		gl.uniform1f(L.uTime, f.time);
		gl.uniform1f(L.uMix, b ? f.mix : 0);
		gl.uniform1f(L.uRipple, f.ripple ? 1 : 0);
		gl.uniform2f(L.uCenter, f.center[0], f.center[1]);
		gl.uniform4fv(L.uInk, f.ink);
		gl.uniform1f(L.uClose, f.close ? 1 : 0);
		gl.uniform4fv(L.uDrips, f.drips);
		const m = b ? f.match : null;
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
		gl.uniform2f(L.uResolution, this.canvas.width, this.canvas.height);
		for (const f2 of FX_FIELDS) {
			gl.uniform4fv(L[`uFxA.${f2}`], f.fxA[f2]);
			gl.uniform4fv(L[`uFxB.${f2}`], f.fxB[f2]);
		}
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	}
}
