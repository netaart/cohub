export const BOARD_SHADER_LIBRARY: Record<string, string> = {
  hash: `
uint cohubHashU(uint x) {
  x ^= x >> 16u; x *= 0x7feb352du;
  x ^= x >> 15u; x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
float hash(uint x) { return float(cohubHashU(x)) / 4294967296.0; }
float hash(int x) { return hash(uint(x)); }
float hash(int x, int y) { return hash(cohubHashU(uint(x)) ^ uint(y)); }
float hash(vec2 p) { return hash(cohubHashU(floatBitsToUint(p.x)) ^ floatBitsToUint(p.y)); }
vec2 hash2(int x) { uint h = cohubHashU(uint(x)); return vec2(float(h), float(cohubHashU(h))) / 4294967296.0; }
vec2 hash2(vec2 p) { uint h = cohubHashU(floatBitsToUint(p.x)) ^ floatBitsToUint(p.y); return vec2(float(cohubHashU(h)), float(cohubHashU(h + 1u))) / 4294967296.0; }
`,
  noise: `
uint cohubNoiseHash(uvec2 v) {
  uint x = v.x * 0x9e3779b1u ^ v.y * 0x85ebca77u;
  x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u;
  return x;
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = float(cohubNoiseHash(uvec2(ivec2(i)))) / 4294967296.0;
  float b = float(cohubNoiseHash(uvec2(ivec2(i + vec2(1.0, 0.0))))) / 4294967296.0;
  float c = float(cohubNoiseHash(uvec2(ivec2(i + vec2(0.0, 1.0))))) / 4294967296.0;
  float d = float(cohubNoiseHash(uvec2(ivec2(i + vec2(1.0, 1.0))))) / 4294967296.0;
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p, int octaves) {
  float sum = 0.0;
  float amplitude = 0.5;
  float total = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += noise(p) * amplitude;
    total += amplitude;
    p *= 2.03;
    amplitude *= 0.5;
  }
  return sum / max(total, 1e-6);
}
`,
  shapes: `
float sdCircle(vec2 p, float radius) { return length(p) - radius; }
float sdBox(vec2 p, vec2 extent) { vec2 d = abs(p) - extent; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float sdRoundBox(vec2 p, vec2 extent, float radius) { return sdBox(p, extent - radius) - radius; }
float sdSegment(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)); }
float fill(float distance, float width) { return clamp(0.5 - distance / max(width, 1e-6), 0.0, 1.0); }
`,
  color: `
vec3 srgbToLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 linearToSrgb(vec3 c) { return pow(c, vec3(1.0 / 2.2)); }
vec3 hsv(float h, float s, float v) { vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); return v * mix(vec3(1.0), k, s); }
float luminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`,
};
