"use strict";

const { Quaternion } = require("three");

function angle(from, to, amount) {
  const difference = ((to - from + 540) % 360) - 180;
  return from + difference * amount;
}

function rememberActorFrame(history, frame, tracks) {
  const previous = history.at(-1);
  // A viewport change can return another subset of the same source snapshot.
  // Refresh membership without inventing an extra motion observation.
  if (Number.isFinite(frame.capturedAt) && previous?.capturedAt === frame.capturedAt) previous.actors = frame.actors;
  else history.push(frame);
  while (history.length > 8) history.shift();
  if (!tracks) return;
  for (const id of tracks.keys()) if (!frame.actors.has(id)) tracks.delete(id);
  for (const [id, record] of frame.actors) {
    const type = `${record.kind}:${record.type}`;
    let track = tracks.get(id);
    if (!track || track.type !== type) { track = { type, samples:[], discontinuous:true }; tracks.set(id,track); }
    const sourceAt = Number.isFinite(frame.capturedAt) ? frame.capturedAt : frame.at;
    track.offset = Math.max(track.offset ?? -Infinity, sourceAt - frame.at);
    const sampledAt = Number.isFinite(record.sampledAt) ? record.sampledAt : sourceAt;
    const previous = track.samples.at(-1);
    if (previous && sampledAt <= previous.at) continue;
    if (previous && discontinuity(previous,{ at:sampledAt, record })) {
      track.samples.length = 0; track.discontinuous = true;
    }
    track.samples.push({ at:sampledAt, record });
    while (track.samples.length > 8) track.samples.shift();
  }
}

function discontinuity(a, b) {
  const duration = b.at - a.at;
  return duration > 2000 || Math.hypot(...b.record.position.map((value,index) => value - a.record.position[index])) > Math.max(8,Math.min(32,duration * .016));
}

function interpolationDelay(history, minimum = 250) {
  let cadence = minimum;
  for (let index = Math.max(1, history.length - 4); index < history.length; index++) {
    // Source timestamps describe the snapshot cadence. Network stalls must not
    // turn the interpolation buffer into an ever-growing receive-time delay.
    const previous = history[index - 1].capturedAt, current = history[index].capturedAt;
    if (Number.isFinite(previous) && Number.isFinite(current) && current > previous) cadence = Math.max(cadence, current - previous);
  }
  return Math.min(cadence, 1250);
}

function interpolateDisplay(a, b, amount) {
  if (!a || !b || a.kind !== b.kind) return b;
  const vector = (name, fallback) => {
    const from = a[name] ?? fallback, to = b[name] ?? fallback;
    return to.map((value, index) => from[index] + (value - from[index]) * amount);
  };
  const rotation = (name) => {
    const result = [0, 0, 0, 1];
    Quaternion.slerpFlat(result, 0, a[name] ?? result, 0, b[name] ?? result, 0, amount);
    return result;
  };
  return { ...b, translation: vector("translation", [0, 0, 0]), scale: vector("scale", [1, 1, 1]), leftRotation: rotation("leftRotation"), rightRotation: rotation("rightRotation") };
}

function sampleActor(history, id, now, delay = interpolationDelay(history), track) {
  if (!track) {
    const temporary = new Map();
    for (const frame of history) rememberActorFrame([],frame,temporary);
    track = temporary.get(id);
    if (track) track.discontinuous = false;
  }
  if (!track?.samples.length) return null;
  const samples = track.samples, latest = samples.at(-1);
  const intervals = samples.slice(1).map((sample,index) => sample.at - samples[index].at).slice(-4).sort((a,b) => a-b);
  const cadence = intervals[Math.floor(intervals.length / 2)] ?? delay;
  // One source interval plus a small jitter cushion, bounded independently of
  // HTTP arrival gaps. Sparse native actors have their own capture cadence.
  const buffer = Math.min(1250,Math.max(delay,cadence * 1.15));
  const desired = Math.max(samples[0].at,Math.min(latest.at,now + track.offset - buffer));
  const gap = now - (track.now ?? now);
  const snapped = Boolean(track.discontinuous) || gap > 1000;
  if (!Number.isFinite(track.time) || snapped) track.time = track.discontinuous ? latest.at : desired;
  else {
    const predicted = track.time + Math.max(0,gap);
    const rate = Math.max(.85,Math.min(1.15,1 + (desired - predicted) / 500));
    track.time = Math.min(latest.at,Math.max(track.time,track.time + Math.max(0,gap) * rate));
  }
  track.now = now; track.discontinuous = false;
  const target = track.time;
  let left = samples[0], right = samples[0];
  for (const sample of samples) {
    if (sample.at < target) left = sample;
    right = sample;
    if (sample.at >= target) break;
  }
  const a = left.record, b = right.record, duration = right.at - left.at;
  const amount = duration > 0 ? Math.max(0,Math.min(1,(target - left.at) / duration)) : 1;
  const position = a.position.map((value, index) => value + (b.position[index] - value) * amount);
  const speed = duration > 0
    ? Math.min(10, Math.hypot(b.position[0] - a.position[0], b.position[2] - a.position[2]) * 1000 / duration)
    : 0;
  return { ...b, position, yawDegrees: angle(a.yawDegrees ?? 0, b.yawDegrees ?? 0, amount), headYawDegrees: angle(a.headYawDegrees ?? a.yawDegrees ?? 0, b.headYawDegrees ?? b.yawDegrees ?? 0, amount), pitchDegrees: (a.pitchDegrees ?? 0) + ((b.pitchDegrees ?? 0) - (a.pitchDegrees ?? 0)) * amount, ...(b.display ? { display: interpolateDisplay(a.display, b.display, amount) } : {}), speed:target >= latest.at ? 0 : speed, discontinuous:snapped };
}

function actorWalk(state, value, delta, reducedMotion = false) {
  const position = value.position, previous = state.renderPosition;
  state.renderPosition = position;
  const distance = previous ? Math.hypot(position[0]-previous[0],position[2]-previous[2]) : 0;
  if (!previous || value.discontinuous || reducedMotion || value.seated || ["FALL_FLYING","SWIMMING","SPIN_ATTACK","SLEEPING","DYING"].includes(value.pose) || delta <= 0 || distance > Math.max(2,delta * 16)) {
    state.phase = 0; state.walkAmplitude = 0; return 0;
  }
  const scale = Number(value.scale) > 0 ? Number(value.scale) : 1;
  const speed = distance / (delta * scale);
  // Native humanoid cadence is distance*4*.6662; legs reach 1.4 radians.
  // Follow actual rendered distance so network catch-up cannot moonwalk.
  state.phase = (state.phase + distance / scale * 2.6648) % (Math.PI * 2);
  const target = Math.min(1.4,speed * .28);
  state.walkAmplitude = (state.walkAmplitude ?? 0) + (target - (state.walkAmplitude ?? 0)) * (1-Math.exp(-delta/.065));
  if (state.walkAmplitude < .005) state.walkAmplitude = 0;
  return Math.sin(state.phase) * state.walkAmplitude;
}

module.exports = { sampleActor, interpolationDelay, interpolateDisplay, rememberActorFrame, actorWalk };
