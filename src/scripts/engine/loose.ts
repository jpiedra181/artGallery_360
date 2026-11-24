/**
 * Strokes that have come loose from the picture: a leaf on its way down, smoke,
 * sparks, a dragonfly, spray. Each is one touch of a brush facing the viewer,
 * placed in metres around the eye and drawn over the panorama with its own
 * projection, parallax and depth, so it passes behind what is nearer.
 */

/** Numbers per stroke: position (m), turn (rad), half length and half width (m), softness (0 bristles, 1 smoke), seed, colour (sRGB), alpha. */
export const LOOSE = 12;

const VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec4 aPlace; // x, y, z, turn
layout(location = 1) in vec4 aSize;  // half length, half width, softness, seed
layout(location = 2) in vec4 aColour;
uniform mat3 uRot;
uniform vec4 uEye;
uniform float uNear;
uniform float uAspect, uTanHalf, uTanQuarter, uStereo;
uniform sampler2D uDepth;
out vec2 vAt;
out vec4 vColour;
flat out vec3 vKind; // softness, seed, length over width

// the radius on screen of an angle off the middle of the view (shaders.ts, the other way round)
float radius(float theta) {
  float r = tan(min(theta, 2.6) * 0.5) / uTanQuarter;
  for (int i = 0; i < 4; i++) {
    float f = mix(atan(r * uTanHalf), 2.0 * atan(r * uTanQuarter), uStereo) - theta;
    float g = mix(uTanHalf / (1.0 + r * r * uTanHalf * uTanHalf), 2.0 * uTanQuarter / (1.0 + r * r * uTanQuarter * uTanQuarter), uStereo);
    r = max(0.0, r - f / g);
  }
  return r;
}

void main() {
  vec2 corner = vec2(gl_VertexID & 1, gl_VertexID >> 1) * 2.0 - 1.0;
  float dist = length(aPlace.xyz);
  vec3 d = aPlace.xyz / max(dist, 1e-3);
  float disparity = uNear / max(dist, uNear);
  vec3 shift = uEye.xyz * pow(disparity, uEye.w);
  d = normalize(d - shift / (1.0 + length(shift) / 0.14));
  vec3 c = transpose(uRot) * d;
  float theta = acos(clamp(c.z, -1.0, 1.0));
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vAt = corner;
  vColour = aColour;
  vKind = vec3(aSize.z, aSize.w, aSize.x / max(aSize.y, 1e-4));
  if (theta < 1.9 && aColour.a > 0.002) {
    float r = radius(theta);
    vec2 at = normalize(c.xy + 1e-6) * r;
    // a hidden stroke is hidden whole
    vec2 uv = vec2(atan(d.x, d.z) / 6.2831853 + 0.5, 0.5 - asin(clamp(d.y, -1.0, 1.0)) / 3.14159265);
    float near = textureLod(uDepth, uv, 0.0).r;
    vColour.a *= 1.0 - smoothstep(0.0, 0.03, near - disparity - 0.015 - 0.25 * disparity);
    float grow = (theta > 1e-3 ? r / theta : 1.0 / uTanHalf) / dist;
    vec2 o = corner * aSize.xy * grow;
    float s = sin(aPlace.w), k = cos(aPlace.w);
    at += vec2(o.x * k - o.y * s, o.x * s + o.y * k);
    gl_Position = vec4(at.x / uAspect, at.y, 0.0, 1.0);
  }
}
`;

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vAt;
in vec4 vColour;
flat in vec3 vKind;
out vec4 outColor;
float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  float seed = vKind.y * 97.0;
  vec2 p = vAt;
  float a;
  vec3 col = vColour.rgb;
  if (vKind.x > 0.5) {
    // smoke: one turn of a wide, dry brush
    vec2 w = p + 0.5 * vec2(noise(p * 2.0 + seed), noise(p * 2.3 - seed)) - 0.25;
    float streak = noise(vec2(w.x * 2.0 + w.y * 1.5, w.y * 9.0 - w.x * 3.0) + seed);
    a = (1.0 - smoothstep(0.1, 1.0, length(w))) * (0.45 + 0.75 * streak);
    col *= 0.85 + 0.3 * streak;
  } else {
    float edge = 0.78 + 0.22 * noise(vec2(p.x * 2.5, seed));
    float body = 1.0 - smoothstep(edge - 0.22, edge, abs(p.y) / sqrt(max(1.0 - p.x * p.x * 0.92, 0.02)));
    float end = 1.0 - smoothstep(0.72, 1.0, abs(p.x) + 0.3 * (noise(vec2(p.y * 5.0, seed + 3.0)) - 0.4));
    float bristle = noise(vec2(p.x * vKind.z * 0.5, p.y * 5.0) + seed);
    a = body * end * (0.75 + 0.35 * bristle);
    col *= 0.8 + 0.4 * bristle;
  }
  outColor = vec4(col, clamp(a, 0.0, 1.0) * vColour.a);
}
`;

export interface LooseView {
	rot: Float32Array;
	eye: Float32Array;
	near: number;
	depth: WebGLTexture | null;
	aspect: number;
	fovV: number;
	stereo: number;
}

export class Loose {
	readonly data: Float32Array;
	private gl: WebGL2RenderingContext;
	private program: WebGLProgram;
	private vao: WebGLVertexArrayObject;
	private buffer: WebGLBuffer;
	private loc: Record<string, WebGLUniformLocation | null> = {};
	private ready = false;

	constructor(gl: WebGL2RenderingContext, max = 340) {
		this.gl = gl;
		this.data = new Float32Array(max * LOOSE);
		const compile = (type: number, src: string) => {
			const s = gl.createShader(type)!;
			gl.shaderSource(s, src);
			gl.compileShader(s);
			return s;
		};
		this.program = gl.createProgram()!;
		gl.attachShader(this.program, compile(gl.VERTEX_SHADER, VERTEX));
		gl.attachShader(this.program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
		gl.linkProgram(this.program);
		this.vao = gl.createVertexArray()!;
		this.buffer = gl.createBuffer()!;
		gl.bindVertexArray(this.vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
		gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
		for (let i = 0; i < 3; i++) {
			gl.enableVertexAttribArray(i);
			gl.vertexAttribPointer(i, 4, gl.FLOAT, false, LOOSE * 4, i * 16);
			gl.vertexAttribDivisor(i, 1);
		}
		gl.bindVertexArray(null);
	}

	/** Draw the first `count` strokes of `data` over what is on the canvas. */
	draw(count: number, v: LooseView) {
		const { gl } = this;
		if (!count || !v.depth || gl.isContextLost()) return;
		if (!this.ready) {
			if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) return;
			for (const n of ["uRot", "uEye", "uNear", "uAspect", "uTanHalf", "uTanQuarter", "uStereo", "uDepth"]) this.loc[n] = gl.getUniformLocation(this.program, n);
			this.ready = true;
		}
		gl.useProgram(this.program);
		gl.bindVertexArray(this.vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
		gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, count * LOOSE);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, v.depth);
		const L = this.loc;
		gl.uniform1i(L.uDepth, 0);
		gl.uniformMatrix3fv(L.uRot, false, v.rot);
		gl.uniform4fv(L.uEye, v.eye);
		gl.uniform1f(L.uNear, v.near);
		gl.uniform1f(L.uAspect, v.aspect);
		gl.uniform1f(L.uTanHalf, Math.tan(v.fovV / 2));
		gl.uniform1f(L.uTanQuarter, Math.tan(v.fovV / 4));
		gl.uniform1f(L.uStereo, v.stereo);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
		gl.disable(gl.BLEND);
		gl.bindVertexArray(null);
	}

	dispose() {
		const { gl } = this;
		if (gl.isContextLost()) return;
		gl.deleteBuffer(this.buffer);
		gl.deleteVertexArray(this.vao);
		gl.deleteProgram(this.program);
	}
}
