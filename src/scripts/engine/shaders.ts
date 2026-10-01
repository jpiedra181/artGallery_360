/**
 * GLSL for the panorama renderer.
 *
 * The whole view is a single fullscreen triangle. For every pixel the
 * fragment shader builds a camera ray, rotates it into each scene, samples
 * the equirectangular render and layers real-time effects on top using the
 * scene's semantic mask (R water, G sky, B light sources / painting ids).
 *
 * World space: x right, y up, z forward (yaw 0). Positive yaw turns right.
 */

export const vertexShader = /* glsl */ `#version 300 es
const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vNdc;
void main() {
  vNdc = P[gl_VertexID];
  gl_Position = vec4(vNdc, 0.0, 1.0);
}
`;

export const fragmentShader = /* glsl */ `#version 300 es
precision highp float;

in vec2 vNdc;
out vec4 outColor;

struct Fx {
  vec4 water;   // x strength, y eye height above water (m), z scale, w speed
  vec4 rain;    // x density, y angle (rad), z speed, w ripple strength
  vec4 light;   // x flicker, y sky shimmer
  vec4 grade;   // x vignette, y grain, z drips on/off, w exposure
  vec4 hover;   // painting under the pointer: x wall yaw (rad), y distance, z/w half size (m)
  vec4 hover2;  // x centre height relative to the eye (m), y highlight amount
};

uniform sampler2D uPanoA;
uniform sampler2D uPanoB;
uniform sampler2D uMaskA;
uniform sampler2D uMaskB;
uniform mat3 uRotA;
uniform mat3 uRotB;
uniform Fx uFxA;
uniform Fx uFxB;

uniform float uAspect;     // width / height
uniform float uTanHalf;    // tan(vertical fov / 2)
uniform float uTanQuarter; // tan(vertical fov / 4)
uniform float uStereo;     // 0 rectilinear .. 1 stereographic
uniform float uTime;
uniform float uMix;        // 0 = scene A, 1 = scene B
uniform float uRipple;     // 1 = water-drop transition, 0 = plain crossfade
uniform vec2 uCenter;      // transition origin in NDC
uniform vec4 uDrips[4];    // x, z on the water plane (m), start time (s), amplitude
uniform vec2 uResolution;

const float PI = 3.14159265359;
const float TAU = 6.28318530718;

// ─── Noise ───────────────────────────────────────────────────────────────────

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}

// ─── Projection ──────────────────────────────────────────────────────────────

// Camera-space ray for a point on screen. Wide fields of view blend towards
// a stereographic mapping, which keeps the edges of tall phone screens from
// stretching the way a pure rectilinear projection does.
vec3 screenRay(vec2 ndc) {
  vec2 p = vec2(ndc.x * uAspect, ndc.y);
  float r = length(p);
  float theta = mix(atan(r * uTanHalf), 2.0 * atan(r * uTanQuarter), uStereo);
  vec2 dir = r > 1e-6 ? p / r : vec2(0.0);
  return vec3(dir * sin(theta), cos(theta));
}

vec2 dirToUv(vec3 d) {
  return vec2(atan(d.x, d.z) / TAU + 0.5, 0.5 - asin(clamp(d.y, -1.0, 1.0)) / PI);
}

// Screen derivatives of u jump by 1 at the back seam of the panorama; wrap
// them so mipmapping does not draw a visible line there.
vec2 seamless(vec2 d) {
  d.x -= floor(d.x + 0.5);
  return d;
}

// ─── Water ───────────────────────────────────────────────────────────────────

// Slope of a calm surface: a few deep-water swells with physical dispersion.
vec2 swellSlope(vec2 p, float t, float footprint) {
  vec2 g = vec2(0.0);
  const vec4 W[5] = vec4[5](
    vec4( 0.80,  0.60,  5.0, 0.0040),
    vec4(-0.45,  0.89,  8.5, 0.0023),
    vec4( 0.98, -0.20, 13.0, 0.0013),
    vec4(-0.70, -0.71, 21.0, 0.0008),
    vec4( 0.10,  0.99, 33.0, 0.0005));
  for (int i = 0; i < 5; i++) {
    float k = W[i].z;
    float aa = 1.0 - smoothstep(0.5, 1.6, footprint * k);
    float w = sqrt(9.81 * k);
    float ph = k * dot(W[i].xy, p) - w * t + float(i) * 1.7;
    g += W[i].xy * (W[i].w * k * cos(ph) * aa);
  }
  return g;
}

// Expanding rings from drops falling into the water.
vec2 dripSlope(vec2 p, float t, float footprint) {
  vec2 g = vec2(0.0);
  float aa = 1.0 - smoothstep(0.3, 1.0, footprint * 22.0);
  for (int i = 0; i < 4; i++) {
    vec4 d = uDrips[i];
    float age = t - d.z;
    if (age < 0.0 || age > 6.0 || d.w <= 0.0) continue;
    vec2 v = p - d.xy;
    float r = length(v);
    float front = 0.32 * age;
    float x = r - front;
    float env = exp(-x * x / 0.012) * exp(-age * 0.75) * d.w;
    g += (r > 1e-4 ? v / r : vec2(0.0)) * cos(x * 22.0) * env * aa;
  }
  return g * 0.1;
}

// Raindrop impacts: a grid of cells, each spawning a short-lived ring.
vec2 rainSlope(vec2 p, float t, float density, float footprint) {
  vec2 g = vec2(0.0);
  float aa = 1.0 - smoothstep(0.3, 1.0, footprint * 30.0);
  if (aa <= 0.0) return g;
  vec2 q = p * 2.5;
  vec2 cell = floor(q);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 c = cell + vec2(i, j);
      vec2 h = hash22(c);
      if (h.x > density) continue;
      float age = fract(t * (0.8 + h.y) + h.x * 7.0);
      vec2 centre = c + 0.15 + 0.7 * hash22(c + 7.31);
      vec2 v = q - centre;
      float r = length(v);
      float x = (r - age * 0.9) * 18.0;
      float env = exp(-x * x) * (1.0 - age) * (1.0 - age);
      g += (r > 1e-4 ? v / r : vec2(0.0)) * cos(x * 2.4) * env;
    }
  }
  return g * 0.12 * aa;
}

// Perturb the lookup direction where the mask says there is water. The
// rendered panorama already contains the mirror image, so tilting the ray by
// the surface slope reproduces how a ripple bends a reflection.
vec3 waterRay(vec3 d, Fx fx, float waterMask) {
  // derivatives first: they are undefined inside per-pixel branches
  float dist = fx.water.y / max(-d.y, 0.004);
  vec2 p = d.xz * dist * fx.water.z;
  float footprint = length(fwidth(p));
  if (fx.water.x <= 0.0 || waterMask < 0.004 || d.y > -0.004) return d;
  float t = uTime * fx.water.w;
  vec2 slope = swellSlope(p, t, footprint);
  if (fx.grade.z > 0.5) slope += dripSlope(d.xz * dist, uTime, footprint);
  if (fx.rain.w > 0.0) slope += rainSlope(d.xz * dist, uTime, fx.rain.x, footprint) * fx.rain.w;
  slope *= fx.water.x * waterMask;
  // decompose the slope into "towards the viewer" (moves the reflection up or
  // down) and "sideways" (moves it left or right)
  vec2 fwd = normalize(d.xz);
  vec2 side = vec2(fwd.y, -fwd.x);
  float along = dot(slope, fwd);
  float across = dot(slope, side);
  float lat = asin(d.y) + along * 2.0 * (-d.y + 0.15);
  float lon = atan(d.x, d.z) - across * 1.2 / max(sqrt(1.0 - d.y * d.y), 0.2);
  return vec3(sin(lon) * cos(lat), sin(lat), cos(lon) * cos(lat));
}

// ─── Rain streaks ────────────────────────────────────────────────────────────

// Streaks live on a cylinder around the viewer, so they stay fixed to the
// world as you turn. Thin, dark and slanted, like the cut lines of a print.
float rainLayer(vec3 d, float t, float columns, float tilt, float speed, float density, float seed) {
  float lon = atan(d.x, d.z) / TAU;
  float h = d.y / max(length(d.xz), 1e-3);
  vec2 uv = vec2(lon * columns, h * columns / TAU / 5.0);
  uv.x += uv.y * 5.0 * tan(tilt);
  uv.y += t * speed;
  vec2 cell = floor(uv);
  vec2 f = fract(uv);
  float present = step(hash12(cell + seed), density);
  float x0 = 0.15 + 0.7 * hash12(cell + seed + 1.73);
  float y0 = hash12(cell + seed + 4.19);
  float len = 0.45 + 0.4 * hash12(cell + seed + 9.1);
  float px = fwidth(uv.x);
  float line = 1.0 - smoothstep(0.35 * px, 1.1 * px, abs(f.x - x0));
  float along = fract(f.y - y0);
  float seg = smoothstep(0.0, 0.08, along) * (1.0 - smoothstep(len - 0.12, len, along));
  // thin lines must fade before they alias into moiré
  float fade = 1.0 - smoothstep(0.25, 0.6, px);
  return line * seg * present * fade;
}

float rainStreaks(vec3 d, Fx fx) {
  if (fx.rain.x <= 0.0) return 0.0;
  float t = uTime * fx.rain.z;
  float a = fx.rain.y;
  float r = rainLayer(d, t * 1.9, 720.0, a, 1.0, fx.rain.x * 0.55, 0.0);
  r = max(r, rainLayer(d, t * 1.6, 520.0, a + 0.09, 1.0, fx.rain.x * 0.45, 17.0) * 0.8);
  r = max(r, rainLayer(d, t * 1.3, 360.0, a - 0.05, 1.0, fx.rain.x * 0.35, 41.0) * 0.6);
  return r * (1.0 - smoothstep(0.55, 0.85, abs(d.y)));
}

// ─── Scene shading ───────────────────────────────────────────────────────────

vec3 shade(sampler2D pano, sampler2D maskTex, mat3 rot, Fx fx, vec3 camRay) {
  vec3 d = rot * camRay;
  vec2 uv = dirToUv(d);
  vec2 dx = seamless(dFdx(uv));
  vec2 dy = seamless(dFdy(uv));
  vec4 mask = textureGrad(maskTex, uv, dx, dy);

  vec3 rd = waterRay(d, fx, mask.r);
  vec2 ruv = dirToUv(rd);
  // keep the ripple only if it still lands on water: otherwise the railing,
  // a boat or the shore would be dragged into the reflection as jagged teeth
  float landed = textureGrad(maskTex, ruv, dx, dy).r;
  ruv = mix(uv, ruv, smoothstep(0.45, 0.85, landed));
  vec3 col = textureGrad(pano, ruv, dx, dy).rgb;

  // light sources breathe (fire, lanterns); B channel
  if (fx.light.x > 0.0) {
    float n = vnoise(vec2(uTime * 7.0, uv.x * 40.0)) * 0.6 + vnoise(vec2(uTime * 17.0, uv.y * 60.0)) * 0.4;
    col *= 1.0 + fx.light.x * (n - 0.5) * mask.b;
  }
  // clouds drift and stars glint; G channel
  if (fx.light.y > 0.0) {
    float n = vnoise(vec2(uv.x * 24.0 + uTime * 0.03, uv.y * 12.0)) - 0.5;
    col *= 1.0 + fx.light.y * n * mask.g;
  }
  // hovered painting (hub): exact rectangle on its wall, plus a soft halo
  // as if its spotlight had been turned up
  if (fx.hover2.y > 0.0) {
    vec3 n = vec3(sin(fx.hover.x), 0.0, cos(fx.hover.x));
    vec3 tangent = vec3(cos(fx.hover.x), 0.0, -sin(fx.hover.x));
    vec3 p = d * (fx.hover.y / max(dot(d, n), 0.05));
    vec2 q = abs(vec2(dot(p, tangent), p.y - fx.hover2.x)) - fx.hover.zw;
    float edge = max(q.x, q.y);
    float facing = step(0.05, dot(d, n));
    float inside = 1.0 - smoothstep(-0.004, 0.004, edge);
    float halo = exp(-max(edge, 0.0) * 5.0) * (1.0 - inside);
    col *= 1.0 + fx.hover2.y * facing * (0.16 * inside + 0.55 * halo);
  }

  float rain = rainStreaks(d, fx);
  col = mix(col, col * 0.45 + vec3(0.03, 0.035, 0.04), rain * 0.55);
  return col * fx.grade.w;
}

void main() {
  vec2 ndc = vNdc;

  // Water-drop transition: a ring of ripples spreads from the origin and the
  // next scene floods in behind it.
  float reveal = uMix;
  if (uMix > 0.0 && uMix < 1.0) {
    if (uRipple > 0.5) {
      vec2 q = (ndc - uCenter) * vec2(uAspect, 1.0);
      float r = length(q);
      float front = uMix * (length(vec2(uAspect, 1.0)) + 0.6) * 1.15 - 0.15;
      float wobble = (vnoise(normalize(q + 1e-4) * 3.0 + uTime * 0.2) - 0.5) * 0.12;
      reveal = 1.0 - smoothstep(front - 0.22, front + 0.02, r + wobble);
      float x = r - front;
      float wave = sin(x * 34.0) * exp(-x * x * 18.0) * sin(uMix * PI);
      ndc += (r > 1e-4 ? q / r : vec2(0.0)) * vec2(1.0 / uAspect, 1.0) * wave * 0.018;
    } else {
      reveal = smoothstep(0.0, 1.0, uMix);
    }
  }

  // branch on the uniform only, so screen derivatives stay well defined
  vec3 ray = screenRay(ndc);
  vec3 col;
  if (uMix <= 0.0) {
    col = shade(uPanoA, uMaskA, uRotA, uFxA, ray);
  } else if (uMix >= 1.0) {
    col = shade(uPanoB, uMaskB, uRotB, uFxB, ray);
  } else {
    col = mix(shade(uPanoA, uMaskA, uRotA, uFxA, ray), shade(uPanoB, uMaskB, uRotB, uFxB, ray), reveal);
  }

  vec4 grade = uMix < 0.5 ? uFxA.grade : uFxB.grade;

  // vignette
  vec2 v = vNdc * vec2(min(uAspect, 1.6), 1.0) * 0.62;
  col *= 1.0 - grade.x * smoothstep(0.35, 1.25, dot(v, v));

  // linear -> sRGB
  col = max(col, 0.0);
  col = mix(col * 12.92, 1.055 * pow(col, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, col));

  // film grain, strongest in the mid-tones, then dither to hide banding
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  float g = hash12(gl_FragCoord.xy + fract(uTime * 23.17) * 1000.0) - 0.5;
  col += g * grade.y * (1.0 - abs(luma * 2.0 - 1.0) * 0.7);
  col += (hash12(gl_FragCoord.xy * 1.37 + 3.1) - 0.5) / 255.0;

  outColor = vec4(col, 1.0);
}
`;
