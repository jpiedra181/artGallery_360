/**
 * GLSL for the panorama renderer.
 *
 * The whole view is a single fullscreen triangle. For every pixel the
 * fragment shader builds a camera ray, rotates it into each scene, samples
 * the equirectangular render and layers real-time effects on top using the
 * scene's semantic mask (R water, G sky, B light sources / painting ids).
 * A depth map lets the eye move a little around the point the panorama was
 * rendered from, so near things slide over far ones.
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
  vec4 light;   // x flicker, y sky shimmer, z soften the back seam, w how still the water lies (0..1)
  vec4 grade;   // x vignette, y grain, z drips on/off, w exposure
  vec4 mood;    // x light of the fires, y light of the moon (both 0 = as painted), z/w where the moon is (yaw, pitch)
  vec4 hover;   // painting under the pointer: x wall yaw (rad), y distance, z/w half size (m)
  vec4 hover2;  // x centre height relative to the eye (m), y highlight amount, z detail from the painting itself, w its mip level that matches the render
};

uniform sampler2D uPanoA;
uniform sampler2D uPanoB;
uniform sampler2D uMaskA;
uniform sampler2D uMaskB;
uniform sampler2D uDepthA;
uniform sampler2D uDepthB;
uniform sampler2D uSheetA;   // a drawing that hangs in the scene (premultiplied)
uniform sampler2D uSheetB;
uniform vec4 uSheetRectA;    // left, width (yaw), top, height (Mercator)
uniform vec4 uSheetRectB;
uniform vec2 uSheetOnA;      // x on/off, y its disparity
uniform vec2 uSheetOnB;
uniform sampler2D uArt;      // the painting approached, sharper than the render holds it
uniform float uMatch;        // 1 = the world is looked at through its painting, 0 = with the camera
uniform float uMatchB;       // which scene is the world: 1 = B (going in), 0 = A (coming out)
uniform vec4 uMatchPlane;    // the painting on its wall: yaw (rad), distance, half size (m)
uniform float uMatchY;       // height of its centre relative to the eye (m)
uniform vec2 uMatchGrid[63]; // what lies at each point of it: yaw and Mercator height (rad), 9 x 7
uniform vec4 uStain[4];      // pigment let into the water: x, z (m), radius (m), strength
uniform vec3 uStainInk[4];
uniform float uStainGlow;    // how far it carries light of its own
uniform vec4 uEyeA;        // xyz eye offset in the scene, in units of its nearest surface; w depth curve
uniform vec4 uEyeB;
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
uniform float uRipple;     // 1 = pigment-in-water transition, 0 = plain crossfade
uniform vec2 uCenter;      // transition origin in NDC
uniform vec4 uInk;         // pigment that blooms at the front: rgb (linear), a strength
uniform float uClose;      // 0 = the next scene spreads from the origin, 1 = it closes in on it
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

// ─── Through the canvas ──────────────────────────────────────────────────────

// The direction, in the world of a painting, of what is painted where a ray
// of the gallery meets its canvas (scripts/registration.py).
vec3 painted(vec3 ray) {
  vec3 n = vec3(sin(uMatchPlane.x), 0.0, cos(uMatchPlane.x));
  vec3 across = vec3(cos(uMatchPlane.x), 0.0, -sin(uMatchPlane.x));
  vec3 p = ray * (uMatchPlane.y / max(dot(ray, n), 0.05));
  vec2 a = vec2(dot(p, across), uMatchY - p.y) / (2.0 * uMatchPlane.zw) + 0.5;
  vec2 inside = clamp(a, 0.0, 1.0);
  vec2 g = inside * vec2(8.0, 6.0);
  ivec2 i = ivec2(clamp(floor(g), vec2(0.0), vec2(7.0, 5.0)));
  vec2 f = g - vec2(i);
  int k = i.y * 9 + i.x;
  vec2 d = mix(mix(uMatchGrid[k], uMatchGrid[k + 1], f.x), mix(uMatchGrid[k + 9], uMatchGrid[k + 10], f.x), f.y);
  // past the edge of the canvas the picture goes on as it went across it, less and less steeply
  vec2 past = a - inside;
  past /= 1.0 + 0.55 * abs(past);
  d += past.x * (uMatchGrid[35] - uMatchGrid[27]) + past.y * (uMatchGrid[58] - uMatchGrid[4]);
  d = vec2(clamp(d.x, -2.7, 2.7), clamp(d.y, -1.9, 2.2));
  // Mercator height back to a direction
  float c = 1.0 / cosh(d.y);
  return vec3(sin(d.x) * c, tanh(d.y), cos(d.x) * c);
}

// ─── Parallax ────────────────────────────────────────────────────────────────

// The panorama holds what one point sees. From an eye a short way off that
// point, the surface seen along a ray lies in a slightly different direction
// of the panorama: by eye / distance. The distance is the one at the answer,
// so a few rounds of substitution find it. Large shifts level off, so a
// surface right beside the viewer bends instead of tearing.
const float MAX_SHIFT = 0.14;

vec3 parallax(sampler2D depthTex, vec3 d, vec4 eye, vec2 dx, vec2 dy) {
  vec3 q = d;
  for (int i = 0; i < 3; i++) {
    float disparity = pow(textureGrad(depthTex, dirToUv(q), dx, dy).r, eye.w);
    vec3 shift = eye.xyz * disparity;
    q = normalize(d + shift / (1.0 + length(shift) / MAX_SHIFT));
  }
  return q;
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
  slope *= fx.water.x * waterMask * (1.0 - 0.94 * fx.light.w);
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

// Each room visited leaves its pigment in the water of the gallery: a cloud
// with a ragged, slowly turning edge, where clouds meet their colours mix.
vec3 stained(vec3 col, vec3 d, Fx fx, float water) {
  if (d.y > -0.01) return col;
  vec2 p = d.xz * (fx.water.y / -d.y);
  vec3 ink = vec3(0.0);
  float sum = 0.0, clear = 1.0;
  for (int i = 0; i < 4; i++) {
    vec4 s = uStain[i];
    if (s.w <= 0.0) continue;
    vec2 q = p - s.xy;
    float t = uTime * 0.05 + float(i) * 7.3;
    // the cloud is drawn out by the currents it drifts on
    vec2 w = q + 0.5 * vec2(vnoise(q * 0.9 + t), vnoise(q * 0.9 - t + 5.1)) - 0.25;
    float n = vnoise(w * 1.1 + t * 0.6) * 0.55 + vnoise(w * 2.7 - t) * 0.3 + vnoise(w * 6.3 + t * 1.7) * 0.15;
    float edge = s.z * (0.42 + 1.05 * n);
    float a = (1.0 - smoothstep(edge * 0.12, edge, length(q))) * s.w;
    // darker threads in it, as ink hangs in water
    a *= 0.72 + 0.28 * smoothstep(0.25, 0.75, vnoise(w * 3.9 + t * 2.0));
    // where clouds meet, the stronger wins: currents side by side, not one mud
    float k = a * a * a * a + 1e-5 * a;
    ink += uStainInk[i] * k;
    sum += k;
    clear *= 1.0 - a;
  }
  if (clear >= 0.999) return col;
  float tone = dot(col, vec3(0.299, 0.587, 0.114));
  vec3 lit = (ink / sum) * (uStainGlow + 2.2 * tone);
  return mix(col, lit, (1.0 - clear) * 0.8 * water);
}

// ─── Rain streaks ────────────────────────────────────────────────────────────

// Streaks live on a cylinder around the viewer, so they stay fixed to the
// world as you turn. Thin, dark and slanted, like the cut lines of a print.
const float LENGTH = 26.0; // of a cell, in columns: most of the height of the sheet

float rainLayer(vec3 d, float t, float columns, float tilt, float speed, float density, float seed) {
  float lon = atan(d.x, d.z) / TAU;
  float h = d.y / max(length(d.xz), 1e-3);
  vec2 uv = vec2(lon * columns, h * columns / TAU / LENGTH);
  uv.x += uv.y * LENGTH * tan(tilt);
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
  float r = rainLayer(d, t * 0.62, 620.0, a, 1.0, fx.rain.x * 0.55, 0.0);
  r = max(r, rainLayer(d, t * 0.5, 500.0, a + 0.115, 1.0, fx.rain.x * 0.5, 17.0) * 0.9);
  r = max(r, rainLayer(d, t * 0.8, 330.0, a + 0.03, 1.0, fx.rain.x * 0.5, 41.0) * 0.8);
  return r * (1.0 - smoothstep(0.55, 0.85, abs(d.y)));
}

// ─── A drawing in the scene ──────────────────────────────────────────────────

// Laid over the render, behind whatever the mask's B channel holds in front.
vec3 layDrawing(vec3 col, sampler2D sheet, vec4 rect, vec2 on, vec3 ray, vec4 eye, float infront) {
  vec3 shift = eye.xyz * pow(on.y, eye.w);
  vec3 q = normalize(ray + shift / (1.0 + length(shift) / MAX_SHIFT));
  float y = clamp(q.y, -0.999, 0.999);
  vec2 p = vec2((atan(q.x, q.z) - rect.x) / rect.y, (rect.z - 0.5 * log((1.0 + y) / (1.0 - y))) / rect.w);
  vec2 dx = dFdx(p), dy = dFdy(p);
  // the jump at the back of the world lies outside the sheet
  vec2 inside = step(vec2(0.0), p) * step(p, vec2(1.0));
  vec4 ink = textureGrad(sheet, p, dx, dy) * inside.x * inside.y * on.x * (1.0 - infront);
  // the same paper as the rest of the print
  vec2 f = p * vec2(rect.y, rect.w);
  float paper = 1.0 + 0.05 * (vnoise(f * vec2(220.0, 620.0)) - 0.5) + 0.06 * (vnoise(f * 9.0) - 0.5);
  return col * (1.0 - ink.a) + ink.rgb * paper;
}

// ─── Scene shading ───────────────────────────────────────────────────────────

vec3 shade(sampler2D pano, sampler2D maskTex, sampler2D depthTex, sampler2D sheet, vec4 rect, vec2 on, vec4 eye, Fx fx, vec3 ray) {
  // the ray on screen: rain falls around the viewer and stays with it
  vec2 uv = dirToUv(ray);
  vec2 dx = seamless(dFdx(uv));
  vec2 dy = seamless(dFdy(uv));
  // where that ray lands in the panorama
  vec3 d = ray;
  if (dot(eye.xyz, eye.xyz) > 0.0) {
    d = parallax(depthTex, ray, eye, dx, dy);
    uv = dirToUv(d);
  }
  vec4 mask = textureGrad(maskTex, uv, dx, dy);

  vec3 rd = waterRay(d, fx, mask.r);
  vec2 ruv = dirToUv(rd);
  // keep the ripple only if it still lands on water: otherwise the railing,
  // a boat or the shore would be dragged into the reflection as jagged teeth
  float landed = textureGrad(maskTex, ruv, dx, dy).r;
  ruv = mix(uv, ruv, smoothstep(0.45, 0.85, landed));
  // image compression knows nothing of the far side of the seam, so the two
  // edges of a smooth sky end a shade apart: there, read a few texels wide
  float seam = fx.light.z * (1.0 - smoothstep(0.0008, 0.0026, min(ruv.x, 1.0 - ruv.x)));
  vec2 wide = vec2(0.0022 * seam, 0.0);
  vec3 col = textureGrad(pano, ruv, dx + wide, dy + wide.yx).rgb;

  // Lying still, the water is a mirror: what stands over it is in the same panorama. The ray
  // goes on from where it meets the water, up, to about where the far bank and the bridge are.
  if (fx.light.w > 0.0) {
    float h = fx.water.y;
    vec3 p = d * (h / max(-d.y, 0.02));
    vec3 r = vec3(d.x, -d.y, d.z);
    float b = dot(p.xz, r.xz), a = max(dot(r.xz, r.xz), 1e-4);
    const float ROUND = 13.0;
    float t = (-b + sqrt(max(b * b - a * (dot(p.xz, p.xz) - ROUND * ROUND), 0.0))) / a;
    vec2 muv = dirToUv(normalize(p + r * t));
    vec3 mirror = textureGrad(pano, muv, dx, dy).rgb * vec3(0.8, 0.82, 0.84);
    col = mix(col, mirror, fx.light.w * mask.r * 0.9 * smoothstep(0.0, 0.03, -d.y));
  }
  if (fx.mood.x != 0.0 || fx.mood.y > 0.0) {
    // the fires, and the air they light
    float near = textureLod(maskTex, uv, 4.5).b;
    col *= 1.0 + fx.mood.x * (0.5 * mask.b + 0.75 * near);
    // the moon, and its road on the water
    vec3 moon = vec3(sin(fx.mood.z) * cos(fx.mood.w), sin(fx.mood.w), cos(fx.mood.z) * cos(fx.mood.w));
    vec3 up = vec3(rd.x, abs(rd.y), rd.z);
    float ang = acos(clamp(dot(up, moon), -1.0, 1.0));
    float road = rd.y < 0.0 ? exp(-pow(abs(atan(rd.x, rd.z) - fx.mood.z) * 4.2, 2.0)) * mask.r : 0.0;
    col *= 1.0 + fx.mood.y * (0.42 * exp(-ang * ang * 5.5) * (rd.y > 0.0 ? 1.0 : 0.0) + 0.5 * road);
    col *= 1.0 - 0.16 * fx.mood.y * smoothstep(0.35, 1.2, ang);
  }
  if (uStainGlow > 0.0 && fx.grade.z > 0.5) col = stained(col, rd, fx, mask.r);

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
  if (on.x > 0.0) col = layDrawing(col, sheet, rect, on, ray, eye, smoothstep(0.4, 0.75, mask.b));
  // hovered painting (hub): exact rectangle on its wall, plus a soft halo
  // as if its spotlight had been turned up
  if (fx.hover2.y > 0.0 || fx.hover2.z > 0.0) {
    vec3 n = vec3(sin(fx.hover.x), 0.0, cos(fx.hover.x));
    vec3 tangent = vec3(cos(fx.hover.x), 0.0, -sin(fx.hover.x));
    vec3 p = d * (fx.hover.y / max(dot(d, n), 0.05));
    vec2 q = abs(vec2(dot(p, tangent), p.y - fx.hover2.x)) - fx.hover.zw;
    float edge = max(q.x, q.y);
    float facing = step(0.05, dot(d, n));
    float inside = 1.0 - smoothstep(-0.004, 0.004, edge);
    float halo = exp(-max(edge, 0.0) * 5.0) * (1.0 - inside);
    col *= 1.0 + fx.hover2.y * facing * (0.16 * inside + 0.55 * halo);
    // up close, the fine detail the panorama has no pixels for: what the painting holds
    // over and above a copy of it as soft as the render
    vec2 a = vec2(dot(p, tangent), fx.hover2.x - p.y) / (2.0 * fx.hover.zw) + 0.5;
    vec3 fine = textureGrad(uArt, a, dFdx(a), dFdy(a)).rgb;
    vec3 soft = textureLod(uArt, a, fx.hover2.w).rgb;
    vec3 gain = clamp((fine + 0.012) / (soft + 0.012), 0.35, 2.4);
    col *= mix(vec3(1.0), gain, fx.hover2.z * facing * inside);
  }

  float rain = rainStreaks(ray, fx);
  // a dark line on the light, and a paler one where the cloud is black, as the block leaves it
  float sky = dot(col, vec3(0.3, 0.59, 0.11));
  col = mix(col, mix(vec3(0.075, 0.085, 0.1), col * 0.22, smoothstep(0.015, 0.09, sky)), rain * 0.52);
  return col * fx.grade.w;
}

void main() {
  vec2 ndc = vNdc;

  // Passing through the canvas. A drop lands on the picture: pigment blooms
  // from the point of impact like ink let into water, the surface swells
  // and ripples, and behind the bloom the next scene is already there.
  // Leaving a painting runs the other way: the gallery closes in on it.
  float reveal = uMix;
  float pigment = 0.0;
  float rim = 0.0;
  if (uMix > 0.0 && uMix < 1.0) {
    if (uRipple > 0.5) {
      vec2 q = (ndc - uCenter) * vec2(uAspect, 1.0);
      float r = length(q);
      vec2 away = r > 1e-4 ? q / r : vec2(0.0);
      // far enough to clear the farthest corner
      float reach = length((vec2(1.0) + abs(uCenter)) * vec2(uAspect, 1.0)) + 0.5;
      float front = mix(uMix, 1.0 - uMix, uClose) * reach - 0.12;
      float spread = max(front, 0.0);
      // a ragged, drifting edge: more so the further it has spread
      float n = vnoise(away * 2.3 + uTime * 0.12) * 0.55 + vnoise(q * 4.5 + 3.7) * 0.3 + vnoise(q * 12.0 - uTime * 0.3) * 0.15;
      float x = r + (n - 0.5) * (0.08 + 0.45 * spread) - front; // signed distance to the front
      float soft = 0.06 + 0.16 * spread;
      float inside = 1.0 - smoothstep(-soft, 0.0, x);
      reveal = mix(inside, 1.0 - inside, uClose);
      // on the side of the scene arriving, the pigment thins out behind the front
      float behind = mix(-x, x, uClose);
      float settle = sin(uMix * PI);
      pigment = (behind > 0.0 ? exp(-behind / (0.14 + 0.4 * spread)) : exp(behind / (soft * 0.6))) * settle;
      rim = exp(-x * x / (soft * soft * 0.08)) * settle;
      // the surface is disturbed: a swell at the front, ripples dying away behind it
      float swell = sin(x * 26.0) * exp(-x * x * 14.0);
      float ripples = behind > 0.0 ? sin(behind * 34.0 - uTime * 7.0) * exp(-behind * 4.5) : 0.0;
      ndc += away * vec2(1.0 / uAspect, 1.0) * (swell * 0.03 + ripples * 0.012) * settle;
    } else {
      reveal = smoothstep(0.0, 1.0, uMix);
    }
  }

  // branch on the uniform only, so screen derivatives stay well defined
  vec3 ray = screenRay(ndc);
  vec3 rayA = uRotA * ray, rayB = uRotB * ray;
  // Through the canvas, the world is first seen exactly where it is painted.
  if (uMatch > 0.0) {
    if (uMatchB > 0.5) rayB = normalize(mix(rayB, painted(rayA), uMatch));
    else rayA = normalize(mix(rayA, painted(rayB), uMatch));
  }
  vec3 col;
  if (uMix <= 0.0) {
    col = shade(uPanoA, uMaskA, uDepthA, uSheetA, uSheetRectA, uSheetOnA, uEyeA, uFxA, rayA);
  } else if (uMix >= 1.0) {
    col = shade(uPanoB, uMaskB, uDepthB, uSheetB, uSheetRectB, uSheetOnB, uEyeB, uFxB, rayB);
  } else {
    col = mix(
      shade(uPanoA, uMaskA, uDepthA, uSheetA, uSheetRectA, uSheetOnA, uEyeA, uFxA, rayA),
      shade(uPanoB, uMaskB, uDepthB, uSheetB, uSheetRectB, uSheetOnB, uEyeB, uFxB, rayB),
      reveal);
  }

  if (pigment > 0.0) {
    // pigment takes the tone of what it lies over, so the picture shows through
    float tone = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, uInk.rgb * (0.55 + 0.9 * tone), clamp(pigment * uInk.a, 0.0, 1.0));
    // and gathers at its edge as it dries, like a wash
    col *= 1.0 - 0.28 * rim * uInk.a;
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
