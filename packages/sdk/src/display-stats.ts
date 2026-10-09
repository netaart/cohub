export type DisplayConnectionStats = {
  path: "direct" | "relay" | null;
  relayProtocol: string | null;
  rttMs: number | null;
  fps: number | null;
  bitrate: number | null;
  width: number | null;
  height: number | null;
  jitterBufferMs: number | null;
  decodeMs: number | null;
  packetsLost: number | null;
  freezes: number | null;
};
export type DisplayStatsCounters = {
  at: number;
  bytes: number;
  jitterBufferDelay: number;
  jitterBufferEmitted: number;
  decodeTime: number;
  decoded: number;
};

type Entry = Record<string, unknown>;

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
function perFrame(seconds: number, previousSeconds: number, frames: number, previousFrames: number): number | null {
  const count = frames - previousFrames;
  return count > 0 ? Math.round(((seconds - previousSeconds) * 1000) / count) : null;
}
export function readDisplayStats(
  report: RTCStatsReport,
  previous: DisplayStatsCounters | null,
  fallbackRttMs: number | null = null,
): { stats: DisplayConnectionStats; counters: DisplayStatsCounters | null } {
  const stats: DisplayConnectionStats = {
    path: null,
    relayProtocol: null,
    rttMs: fallbackRttMs,
    fps: null,
    bitrate: null,
    width: null,
    height: null,
    jitterBufferMs: null,
    decodeMs: null,
    packetsLost: null,
    freezes: null,
  };
  let counters: DisplayStatsCounters | null = null;
  report.forEach((entry: Entry) => {
    if (entry.type === "candidate-pair" && entry.nominated && entry.state === "succeeded") {
      const local = report.get(String(entry.localCandidateId)) as Entry | undefined;
      const remote = report.get(String(entry.remoteCandidateId)) as Entry | undefined;
      stats.path = local?.candidateType === "relay" || remote?.candidateType === "relay" ? "relay" : "direct";
      if (local?.candidateType === "relay" && typeof local.relayProtocol === "string") stats.relayProtocol = local.relayProtocol;
      const rtt = num(entry.currentRoundTripTime);
      if (rtt !== null) stats.rttMs = Math.round(rtt * 1000);
    }
    if (entry.type === "inbound-rtp" && entry.kind === "video") {
      stats.fps = num(entry.framesPerSecond);
      stats.width = num(entry.frameWidth);
      stats.height = num(entry.frameHeight);
      stats.packetsLost = num(entry.packetsLost);
      stats.freezes = num(entry.freezeCount);
      counters = {
        at: num(entry.timestamp) ?? 0,
        bytes: num(entry.bytesReceived) ?? 0,
        jitterBufferDelay: num(entry.jitterBufferDelay) ?? 0,
        jitterBufferEmitted: num(entry.jitterBufferEmittedCount) ?? 0,
        decodeTime: num(entry.totalDecodeTime) ?? 0,
        decoded: num(entry.framesDecoded) ?? 0,
      };
      if (previous && counters.at > previous.at) {
        stats.bitrate = Math.round(((counters.bytes - previous.bytes) * 8 * 1000) / (counters.at - previous.at));
        stats.jitterBufferMs = perFrame(counters.jitterBufferDelay, previous.jitterBufferDelay, counters.jitterBufferEmitted, previous.jitterBufferEmitted);
        stats.decodeMs = perFrame(counters.decodeTime, previous.decodeTime, counters.decoded, previous.decoded);
      }
    }
  });
  return { stats, counters };
}
