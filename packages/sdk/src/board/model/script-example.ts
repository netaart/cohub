export const BOARD_SCRIPT_DRAWING_EXAMPLE = `export const animated = true;

export const parameters = {
  amplitude: { type: "number", label: "Amplitude", default: 40, min: 0, max: 120 }
};

export function draw(ctx, { t, width, height, params }) {
  ctx.strokeStyle = "#e67845";
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let x = 0; x <= width; x += 2) {
    const y = height / 2 + Math.sin(x / 40 - t / 800) * params.amplitude;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
`;

/**
 * A Board script: rain over the whole view that splashes on the Board's items.
 * Every drop is a pure function of time, so it seeks, replays and exports.
 */
export const BOARD_SCRIPT_RAIN_EXAMPLE = `export const animated = true;

export const parameters = {
  density: { type: "number", label: "Density", default: 0.7, min: 0, max: 1, step: 0.05 },
  wind: { type: "number", label: "Wind", default: 0.15, min: -0.6, max: 0.6, step: 0.05 },
  splash: { type: "boolean", label: "Splash on cards", default: true },
};

// Each drop draws a streak and three droplets for its splash.
const PARTS = 4;
const DROPS = 2400;

const glsl = \`
#define PARTS \${PARTS}
#include "cohub:hash"

const float SPEED = 1400.0;  // screen pixels per second, at any zoom
const float SPLASH = 0.38;   // seconds a splash lasts

struct Drop { vec2 start; vec2 heading; float reach; float travelled; float landing; bool lands; };

// Drops respawn every cycle at new seeded places, anywhere in view.
Drop drop(int index, float pixel, bool streak) {
  float speed = SPEED * pixel;
  float cycle = board.view.w * 0.6 / speed + SPLASH;
  float clock = board.time + hash(index, 7) * cycle;
  int key = index * 131 + int(floor(clock / cycle));
  Drop d;
  d.heading = normalize(vec2(params.wind, 1.0));
  d.start = board.view.xy + vec2(hash(key, 1) * 1.2 - 0.1, hash(key, 2) * 0.9 - 0.15) * board.view.zw;
  d.reach = (0.25 + hash(key, 3) * 0.55) * board.view.w;
  d.travelled = mod(clock, cycle) * speed;
  d.lands = false;
  d.landing = d.reach;
  if (surface(d.start).inside) { d.reach = 0.0; return d; }
  float limit = min(d.reach, streak ? d.travelled + 0.15 * d.reach : d.travelled);
  // Sphere-trace the item edges along the drop's path.
  float ahead = 0.0;
  for (int i = 0; i < 40 && params.splash > 0.5; i++) {
    float gap = surface(d.start + d.heading * ahead).distance;
    if (gap < pixel) { d.lands = true; d.landing = ahead; break; }
    ahead += max(gap, 2.0 * pixel);
    if (ahead > limit) break;
  }
  return d;
}

Sprite sprite(int id) {
  int index = id / PARTS;
  int part = id - index * PARTS;
  Sprite s = makeSprite(vec2(0.0), vec2(0.0));
  if (hash(index, 11) > params.density || (part > 0 && params.splash < 0.5)) { s.visible = false; return s; }
  float pixel = 1.0 / board.zoom;
  vec4 tint = board.dark > 0.5 ? vec4(0.75, 0.84, 1.0, 0.5) : vec4(0.3, 0.4, 0.55, 0.45);
  Drop d = drop(index, pixel, part == 0);
  if (part == 0) {
    float end = d.lands ? d.landing : d.reach;
    float head = min(d.travelled, end);
    float tail = max(0.0, d.travelled - 34.0 * pixel);
    s.visible = head > tail;
    vec2 a = d.start + d.heading * tail;
    vec2 b = d.start + d.heading * head;
    s.position = (a + b) * 0.5;
    s.size = vec2(1.4 * pixel, distance(a, b));
    s.rotation = -atan(d.heading.x, d.heading.y);
    float fade = d.lands ? 1.0 : 1.0 - smoothstep(0.85, 1.0, head / max(end, 1e-3));
    s.color = vec4(tint.rgb, tint.a * smoothstep(0.0, 0.08 * d.reach, head) * fade);
    return s;
  }
  float age = (d.travelled - d.landing) / (SPEED * pixel);
  if (!d.lands || age < 0.0 || age > SPLASH) { s.visible = false; return s; }
  vec2 hit = d.start + d.heading * d.landing;
  vec2 normal = surface(hit - d.heading * 2.0 * pixel).normal;
  vec2 side = vec2(-normal.y, normal.x);
  vec2 velocity = (normal * (120.0 + 120.0 * hash(index * 7 + part, 6)) + side * (hash(index * 7 + part, 5) - 0.5) * 220.0) * pixel;
  s.position = hit + velocity * age + vec2(0.0, 450.0 * pixel) * age * age;
  s.size = vec2(2.6 * pixel) * (1.0 - 0.5 * age / SPLASH);
  s.color = vec4(tint.rgb, 1.6 * tint.a * (1.0 - age / SPLASH));
  s.data = vec4(1.0);
  return s;
}

vec4 effect(Fragment f) {
  vec2 c = f.uv - 0.5;
  float shape = f.data.x > 0.5
    ? smoothstep(0.5, 0.2, length(c))
    : smoothstep(0.5, 0.0, abs(c.x)) * (0.5 - c.y);
  return vec4(f.color.rgb, f.color.a * shape);
}
\`;

export const shader = {
  surfaces: true,
  passes: [{ glsl, sprites: DROPS * PARTS }],
};
`;

export const BOARD_SCRIPT_SENSES_EXAMPLE = `// Helpers over raw browser:* input. import { onMotion, onAudio } from "./senses.js";

const DEG = Math.PI / 180;
const vec = (v) => ({ x: v?.x ?? 0, y: v?.y ?? 0, z: v?.z ?? 0 });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

// Device axes to screen axes: x right, y up, z out of the screen, however it is turned.
export function toScreen({ x, y, z }, angle) {
  const c = Math.round(Math.cos(angle * DEG));
  const s = Math.round(Math.sin(angle * DEG));
  return { x: x * c - y * s, y: x * s + y * c, z };
}

// Calls handler once a frame with the samples since the last one: acceleration and
// gravity in m/s², rotationRate in rad/s, all in screen axes.
export function onMotion(ctx, handler) {
  let samples = [];
  let up = { x: 0, y: 0, z: 0 };
  const stops = [
    ctx.on("browser:devicemotion", ({ data }) => {
      const total = vec(data.accelerationIncludingGravity);
      let acceleration = data.acceleration && vec(data.acceleration);
      if (acceleration) up = sub(total, acceleration);
      else {
        up = { x: up.x + (total.x - up.x) * 0.1, y: up.y + (total.y - up.y) * 0.1, z: up.z + (total.z - up.z) * 0.1 };
        acceleration = sub(total, up);
      }
      const rate = data.rotationRate ?? {};
      const angle = ctx.env.angle;
      samples.push({
        t: data.t,
        acceleration: toScreen(acceleration, angle),
        gravity: toScreen({ x: -up.x, y: -up.y, z: -up.z }, angle),
        rotationRate: toScreen({ x: (rate.beta ?? 0) * DEG, y: (rate.gamma ?? 0) * DEG, z: (rate.alpha ?? 0) * DEG }, angle),
      });
    }),
    ctx.onFrame(() => {
      if (!samples.length) return;
      const batch = samples;
      samples = [];
      handler(batch);
    }),
  ];
  return () => stops.forEach((stop) => stop());
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const step = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size)
      for (let k = 0; k < size / 2; k++) {
        const cos = Math.cos(step * k), sin = Math.sin(step * k);
        const a = start + k, b = a + size / 2;
        const tr = re[b] * cos - im[b] * sin, ti = re[b] * sin + im[b] * cos;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
  }
}

// Calls handler for each microphone chunk with level (0–1), pitch in Hz or null,
// onset (a sound started) and spectrum: 32 log-spaced bands from 50 Hz to 12 kHz, 0–1.
export function onAudio(ctx, handler) {
  let smooth = 0;
  let onsetAt = -Infinity;
  return ctx.on("browser:audio", ({ data: { samples, sampleRate, t } }) => {
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const level = Math.min(1, Math.max(0, (20 * Math.log10(Math.sqrt(sum / samples.length) || 1e-6) + 60) / 60));
    const onset = level > 0.3 && level - smooth > 0.15 && t - onsetAt > 100;
    if (onset) onsetAt = t;
    smooth += (level - smooth) * 0.2;
    const re = new Float64Array(1024), im = new Float64Array(1024);
    re.set(samples.subarray(0, 1024));
    fft(re, im);
    const bin = (hz) => Math.min(511, Math.round((hz / sampleRate) * 1024));
    const spectrum = Array.from({ length: 32 }, (_, i) => {
      const from = bin(50 * 240 ** (i / 32)), to = Math.max(from + 1, bin(50 * 240 ** ((i + 1) / 32)));
      let power = 0;
      for (let k = from; k < to; k++) power += re[k] * re[k] + im[k] * im[k];
      return Math.min(1, Math.max(0, (10 * Math.log10(power / (to - from) || 1e-12) + 40) / 70));
    });
    handler({ level, pitch: level > 0.2 ? pitchOf(samples, sampleRate) : null, onset, spectrum });
  });
}

function pitchOf(samples, rate) {
  const min = Math.floor(rate / 1000), max = Math.min(samples.length >> 1, Math.ceil(rate / 60));
  let energy = 0, best = 0, lag = 0;
  for (let i = 0; i < max; i++) energy += samples[i] * samples[i];
  for (let offset = min; offset < max; offset++) {
    let sum = 0;
    for (let i = 0; i < max; i++) sum += samples[i] * samples[i + offset];
    if (sum > best) { best = sum; lag = offset; }
  }
  return energy && lag && best / energy > 0.5 ? Math.round(rate / lag) : null;
}
`;

export const BOARD_SCRIPT_TILT_EXAMPLE = `import { onMotion } from "./senses.js";

export default function (ctx) {
  ctx.state.ball ??= { x: 0.5, y: 0.5 };
  onMotion(ctx, (samples) => {
    const { gravity } = samples.at(-1);
    const ball = ctx.state.ball;
    ball.x = Math.min(1, Math.max(0, ball.x + gravity.x * 0.0015 * samples.length));
    ball.y = Math.min(1, Math.max(0, ball.y - gravity.y * 0.0015 * samples.length));
    ctx.invalidate();
  });
}

export function draw(ctx, { width, height, state }) {
  ctx.fillStyle = "#e67845";
  ctx.beginPath();
  ctx.arc(state.ball.x * width, state.ball.y * height, 16, 0, Math.PI * 2);
  ctx.fill();
}
`;
