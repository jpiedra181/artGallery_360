/**
 * A drawing that hangs in a scene and can move (see worlds/).
 *
 * Its triangles are printed into a texture of their own, in the drawing's
 * Mercator angles, only when they have moved; the panorama shader then lays
 * that texture over the render. Parallax, rocking, transitions and grain
 * apply to it as to everything else.
 */

import type { Drawing, Sheet } from "../worlds/press";
import { DEG } from "./math";

const vertexSource = (colours: number) => /* glsl */ `#version 300 es
in vec2 aPos;
in float aColour;
uniform vec4 uSheet; // left, top, 1 / width, 1 / height
uniform vec3 uInks[${colours}];
flat out vec3 vColour;
void main() {
  vColour = uInks[int(aColour + 0.5)];
  // the top of the sheet is the first row of the texture, as in an image
  gl_Position = vec4((aPos - uSheet.xy) * uSheet.zw * 2.0 - 1.0, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
flat in vec3 vColour;
out vec4 outColor;
void main() {
  outColor = vec4(vColour, 1.0);
}
`;

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

export class Overlay {
	texture!: WebGLTexture;
	/** Left edge and width (radians of yaw), top and height (Mercator radians). */
	readonly rect: [number, number, number, number];
	readonly distance: number;
	private sheet: Sheet;

	private gl: WebGL2RenderingContext;
	private width: number;
	private height: number;
	private drawing: Drawing;
	private positions: Float32Array;
	private program!: WebGLProgram;
	private vao!: WebGLVertexArrayObject;
	private buffers: WebGLBuffer[] = [];
	private positionBuffer!: WebGLBuffer;
	private target!: WebGLFramebuffer;
	private resolved!: WebGLFramebuffer;
	private samplesBuffer!: WebGLRenderbuffer;
	private printed: number[] = [];

	private constructor(gl: WebGL2RenderingContext, width: number, sheet: Sheet) {
		const { PLACE } = sheet;
		this.gl = gl;
		this.sheet = sheet;
		this.distance = PLACE.distance;
		this.rect = [
			((PLACE.left - PLACE.x0) / PLACE.scale) * DEG,
			((PLACE.right - PLACE.left) / PLACE.scale) * DEG,
			((PLACE.horizon - PLACE.top) / PLACE.scale) * DEG,
			((PLACE.bottom - PLACE.top) / PLACE.scale) * DEG,
		];
		this.width = width;
		this.height = Math.round((width * (PLACE.bottom - PLACE.top)) / (PLACE.right - PLACE.left));
		this.drawing = sheet.draw();
		this.positions = new Float32Array(this.drawing.offset.length);
	}

	/** Prepared over a few frames, so the first scene to use it does not stutter. */
	static async create(gl: WebGL2RenderingContext, width: number, sheet: Sheet, state: ArrayLike<number>): Promise<Overlay> {
		const o = new Overlay(gl, width, sheet);
		await nextFrame();
		await o.init();
		await nextFrame();
		o.print(state);
		return o;
	}

	private async init() {
		const { gl, drawing } = this;
		const { PLACE, COLOURS } = this.sheet;
		const parallel = gl.getExtension("KHR_parallel_shader_compile");
		const shader = (type: number, src: string) => {
			const sh = gl.createShader(type)!;
			gl.shaderSource(sh, src);
			gl.compileShader(sh);
			return sh;
		};
		const program = gl.createProgram()!;
		gl.attachShader(program, shader(gl.VERTEX_SHADER, vertexSource(COLOURS.length)));
		gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
		gl.linkProgram(program);
		while (parallel && !gl.isContextLost() && !gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR)) await nextFrame();
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "overlay link failed");
		this.program = program;

		this.vao = gl.createVertexArray()!;
		gl.bindVertexArray(this.vao);
		const buffer = (target: number, data: ArrayBufferView | number, usage: number) => {
			const b = gl.createBuffer()!;
			gl.bindBuffer(target, b);
			if (typeof data === "number") gl.bufferData(target, data, usage);
			else gl.bufferData(target, data, usage);
			this.buffers.push(b);
			return b;
		};
		const aPos = gl.getAttribLocation(program, "aPos"), aColour = gl.getAttribLocation(program, "aColour");
		this.positionBuffer = buffer(gl.ARRAY_BUFFER, this.positions.byteLength, gl.DYNAMIC_DRAW);
		gl.enableVertexAttribArray(aPos);
		gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
		buffer(gl.ARRAY_BUFFER, drawing.colour, gl.STATIC_DRAW);
		gl.enableVertexAttribArray(aColour);
		gl.vertexAttribPointer(aColour, 1, gl.UNSIGNED_BYTE, false, 0, 0);
		buffer(gl.ELEMENT_ARRAY_BUFFER, drawing.index, gl.STATIC_DRAW);
		gl.bindVertexArray(null);

		gl.useProgram(program);
		gl.uniform4f(gl.getUniformLocation(program, "uSheet"), PLACE.left, PLACE.top, 1 / (PLACE.right - PLACE.left), 1 / (PLACE.bottom - PLACE.top));
		gl.uniform3fv(
			gl.getUniformLocation(program, "uInks"),
			COLOURS.flatMap((hex) => [1, 3, 5].map((i) => linear(parseInt(hex.slice(i, i + 2), 16) / 255))),
		);

		const { width, height } = this;
		const levels = Math.floor(Math.log2(Math.max(width, height))) + 1;
		this.texture = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, this.texture);
		gl.texStorage2D(gl.TEXTURE_2D, levels, gl.SRGB8_ALPHA8, width, height);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
		const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
		if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));

		this.samplesBuffer = gl.createRenderbuffer()!;
		gl.bindRenderbuffer(gl.RENDERBUFFER, this.samplesBuffer);
		gl.renderbufferStorageMultisample(gl.RENDERBUFFER, Math.min(4, gl.getParameter(gl.MAX_SAMPLES)), gl.SRGB8_ALPHA8, width, height);
		this.target = gl.createFramebuffer()!;
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
		gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.samplesBuffer);
		this.resolved = gl.createFramebuffer()!;
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.resolved);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.bindRenderbuffer(gl.RENDERBUFFER, null);
	}

	/** Print the drawing in a state. Does nothing if that is how it already is. */
	print(state: ArrayLike<number>) {
		const { gl, printed } = this;
		if (gl.isContextLost()) return;
		let same = printed.length === state.length;
		for (let i = 0; same && i < state.length; i++) same = printed[i] === state[i];
		if (same) return;
		this.printed = Array.from(state);
		this.sheet.pose(this.drawing, state, this.positions);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
		gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.positions);

		gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
		gl.viewport(0, 0, this.width, this.height);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.useProgram(this.program);
		gl.bindVertexArray(this.vao);
		gl.drawElements(gl.TRIANGLES, this.drawing.index.length, gl.UNSIGNED_INT, 0);
		gl.bindVertexArray(null);

		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.target);
		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.resolved);
		gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.texture);
		gl.generateMipmap(gl.TEXTURE_2D);
	}

	dispose() {
		const { gl } = this;
		if (gl.isContextLost()) return;
		gl.deleteTexture(this.texture);
		gl.deleteRenderbuffer(this.samplesBuffer);
		gl.deleteFramebuffer(this.target);
		gl.deleteFramebuffer(this.resolved);
		for (const b of this.buffers) gl.deleteBuffer(b);
		gl.deleteVertexArray(this.vao);
		gl.deleteProgram(this.program);
	}
}
