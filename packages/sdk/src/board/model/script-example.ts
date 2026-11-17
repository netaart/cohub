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

export const BOARD_SCRIPT_SPARKS_EXAMPLE = `export default function (ctx) {
  ctx.state.sparks = [];
  ctx.state.peers = [];
  ctx.hitRegions({ pad: { target: "self", label: "Make sparks" } });

  // Every viewer receives the burst, this one included, so everyone sees it.
  ctx.on("click", ({ point }) => ctx.broadcast("burst", { x: point.x, y: point.y }));

  let stop = null;
  const step = ({ dt }) => {
    const s = dt / 1000;
    ctx.state.sparks = ctx.state.sparks.filter((p) => {
      p.x += p.vx * s;
      p.y += p.vy * s;
      p.vy += 240 * s;
      p.life -= s * 1.4;
      return p.life > 0;
    });
    if (!ctx.state.sparks.length && stop) {
      stop();
      stop = null;
    }
  };
  ctx.on("burst", ({ data, peer }) => {
    for (let i = 0; i < 24; i++) {
      const angle = ctx.random() * Math.PI * 2;
      const speed = 60 + ctx.random() * 140;
      ctx.state.sparks.push({ x: data.x, y: data.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 1, color: peer?.color ?? "#e67845" });
    }
    stop ??= ctx.onFrame(step);
  });

  ctx.on("peerschange", ({ data }) => {
    ctx.state.peers = data;
    ctx.invalidate();
  });
}

export function draw(ctx, { state }) {
  for (const peer of state.peers) {
    if (!peer.point) continue;
    ctx.strokeStyle = ctx.fillStyle = peer.color;
    ctx.globalAlpha = peer.pressed ? 0.35 : 0.6;
    ctx.beginPath();
    ctx.arc(peer.point.x, peer.point.y, 18, 0, Math.PI * 2);
    if (peer.pressed) ctx.fill();
    else ctx.stroke();
  }
  for (const p of state.sparks) {
    ctx.globalAlpha = p.life;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2 + 3 * p.life, 0, Math.PI * 2);
    ctx.fill();
  }
}
`;

export const BOARD_SCRIPT_HANKY_EXAMPLE = `// A handkerchief from a Northeastern song-and-dance duet: tap it three times, or type
// "toss" in play, and it flies up spinning for every viewer, then drops back to rest.
// It draws the cloth and lifts itself, or the frame named by script.targets.lift, whose
// children then travel in the same picture.
const DURATION = 3200;
const ease = (t) => 1 - (1 - t) ** 3;
const smooth = (t) => t * t * (3 - 2 * t);
const clamp = (t) => Math.min(Math.max(t, 0), 1);

export default function (ctx) {
  let taps = 0;
  let idle = 0;
  let watch = null;
  let typed = "";
  let stop = null;
  ctx.hitRegions({ hanky: { target: "self", label: "Toss the handkerchief", cursor: "pointer", over: true } });

  const toss = () => {
    spin();
    ctx.broadcast("toss");
  };
  // Three taps, each within 600 ms of the last, timed on the script clock.
  const forget = () => {
    taps = 0;
    watch?.();
    watch = null;
  };
  ctx.on("click", () => {
    taps += 1;
    idle = 0;
    if (taps >= 3) {
      forget();
      return toss();
    }
    watch ??= ctx.onFrame(({ dt }) => {
      idle += dt;
      if (idle > 600) forget();
    });
  });
  ctx.on("keydown", ({ key }) => {
    typed = (typed + key).slice(-4).toLowerCase();
    if (typed === "toss") toss();
  });
  // Our own broadcast comes back with peer: null; we already spin.
  ctx.on("toss", ({ peer }) => {
    if (peer) spin();
  });

  const target = ctx.targets.lift ?? ctx.self.id;

  function spin() {
    if (stop) return;
    const box = ctx.get(target)?.size ?? ctx.self.base.size;
    const size = Math.max(box.width, box.height);
    const gentle = ctx.env.reducedMotion;
    let t = 0;
    stop = ctx.onFrame(({ dt }) => {
      t += dt;
      const p = clamp(t / DURATION);
      const windup = smooth(clamp(p / 0.12));
      const q = clamp((p - 0.1) / 0.7);
      const air = 4 * q * (1 - q);
      const land = clamp((p - 0.8) / 0.2);
      const settle = land ? Math.exp(-land * 5) * Math.sin(land * 18) : 0;
      const hold = 1 - smooth(land);
      ctx.present(target, {
        depth: {
          lift: gentle ? size * 0.1 * air : size * (0.06 * windup * hold + 0.55 * air) + size * 0.03 * settle,
          tilt: gentle
            ? { x: 0, y: 0 }
            : { x: (30 * windup + 10 * Math.sin(t / 180) * air) * hold + 6 * settle, y: 14 * Math.sin(t / 260) * air },
          spin: gentle ? 0 : 1440 * ease(p),
          bend: { kind: "cloth", amount: (0.25 * windup + 0.35 * air) * hold + 0.12 * Math.abs(settle), phase: t / 70 },
          shade: 0.7,
        },
      });
      if (p < 1) return;
      ctx.present(target, null);
      stop();
      stop = null;
      if (ctx.capabilities.has("haptics")) ctx.capabilities.call("haptics", { kind: "confirm" });
    });
  }
}

// A red octagon of peonies and leaves, edged with gold stitching.
export function draw(g, { width, height }) {
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const cut = Math.min(width, height) * 0.2;
  const octagon = (inset) => {
    const c = cut + inset * 0.41;
    g.beginPath();
    g.moveTo(c, inset);
    g.lineTo(width - c, inset);
    g.lineTo(width - inset, c);
    g.lineTo(width - inset, height - c);
    g.lineTo(width - c, height - inset);
    g.lineTo(c, height - inset);
    g.lineTo(inset, height - c);
    g.lineTo(inset, c);
    g.closePath();
  };
  octagon(0);
  g.save();
  g.clip();
  g.fillStyle = "#b3122e";
  g.fillRect(0, 0, width, height);
  const leaf = (x, y, r, a) => {
    g.save();
    g.translate(x, y);
    g.rotate(a);
    g.fillStyle = "#2f8f46";
    g.beginPath();
    g.ellipse(r * 0.9, 0, r * 0.75, r * 0.3, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  };
  const peony = (x, y, r, colors) => {
    for (let i = 0; i < 4; i++) leaf(x, y, r, rand() * Math.PI * 2);
    for (const [k, color] of [[1, colors[0]], [0.78, colors[1]], [0.55, colors[0]], [0.34, colors[2]]]) {
      g.fillStyle = color;
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2 + k * 3;
        g.beginPath();
        g.ellipse(x + Math.cos(a) * r * k * 0.45, y + Math.sin(a) * r * k * 0.45, r * k * 0.55, r * k * 0.36, a, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.fillStyle = "#ffd23f";
    g.beginPath();
    g.arc(x, y, r * 0.14, 0, Math.PI * 2);
    g.fill();
  };
  const palettes = [["#f2558c", "#ffc2d6", "#ffffff"], ["#ffffff", "#ffd6e3", "#f2558c"], ["#f7a531", "#ffe2a8", "#ffffff"], ["#5aa6ff", "#cfe4ff", "#ffffff"]];
  const step = Math.max(width, height) / 3.2;
  for (let y = step * 0.4; y < height + step * 0.5; y += step * 0.86)
    for (let x = (Math.round(y / step) % 2) * step * 0.5 + step * 0.3; x < width + step * 0.5; x += step)
      peony(x + (rand() - 0.5) * step * 0.2, y + (rand() - 0.5) * step * 0.2, step * (0.26 + rand() * 0.08), palettes[Math.floor(rand() * palettes.length)]);
  g.restore();
  g.lineWidth = 12;
  g.strokeStyle = "#ffd23f";
  g.setLineDash([3, 7]);
  octagon(6);
  g.stroke();
}
`;

export const BOARD_SCRIPT_ARENA_EXAMPLE = `// A fox to steer with WASD, the arrow keys or a gamepad; hold Shift to run. In Play the camera
// follows it, and its clips crossfade as it stops, walks and runs.
export const parameters = {
  speed: { type: "number", label: "Run speed", default: 420, min: 60, max: 1200 },
  idle: { type: "string", label: "Idle clip", default: "Survey" },
  walk: { type: "string", label: "Walk clip", default: "Walk" },
  run: { type: "string", label: "Run clip", default: "Run" },
};

const KEYS = { left: ["a", "arrowleft"], right: ["d", "arrowright"], up: ["w", "arrowup"], down: ["s", "arrowdown"] };

export default function (ctx) {
  const fox = ctx.targets.fox;
  const held = new Set();
  const pressed = (name) => KEYS[name].some((key) => held.has(key));
  ctx.on("keydown", ({ key }) => held.add(key.toLowerCase()));
  ctx.on("keyup", ({ key }) => held.delete(key.toLowerCase()));
  ctx.on("browser:gamepads", ({ data }) => { ctx.state.pad = data.pads[0] ?? null; });

  ctx.onFrame(({ dt }) => {
    const base = ctx.get(fox);
    if (!base) return;
    const pad = ctx.state.pad;
    const dead = (value) => (Math.abs(value ?? 0) > 0.15 ? value : 0);
    const x = (pressed("right") ? 1 : 0) - (pressed("left") ? 1 : 0) + dead(pad?.axes[0]);
    const y = (pressed("down") ? 1 : 0) - (pressed("up") ? 1 : 0) + dead(pad?.axes[1]);
    const push = Math.min(1, Math.hypot(x, y));
    const running = held.has("shift") || Boolean(pad?.buttons[0]?.pressed);
    const speed = push * ctx.params.speed * (running ? 1 : 0.4);
    const at = (ctx.state.at ??= { ...base.position });
    if (push > 0) {
      at.x += (x / Math.hypot(x, y)) * speed * (dt / 1000);
      at.y += (y / Math.hypot(x, y)) * speed * (dt / 1000);
      // The view's yaw orbits the camera: 0 shows the fox's face, -90 has it face right.
      const goal = (Math.atan2(-x, y) * 180) / Math.PI;
      const turn = ((goal - (ctx.state.yaw ?? 0) + 540) % 360) - 180;
      ctx.state.yaw = (ctx.state.yaw ?? 0) + turn * Math.min(1, dt / 90);
    }
    const clip = speed === 0 ? ctx.params.idle : running ? ctx.params.run : ctx.params.walk;
    const view = base.props.model?.view ?? { yaw: 0, pitch: 30, zoom: 1 };
    const yaw = ctx.state.yaw ?? view.yaw;
    const shown = \`\${at.x},\${at.y},\${clip},\${yaw}\`;
    if (shown === ctx.state.shown) return;
    ctx.state.shown = shown;
    ctx.present(fox, { position: at, props: { model: { animation: clip, view: { ...view, yaw } } } });
    ctx.present("camera", { center: { x: at.x + base.size.width / 2, y: at.y + base.size.height / 2 }, zoom: 1.4 });
  });
}
`;
