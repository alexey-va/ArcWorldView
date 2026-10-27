"use strict";

const { Quaternion } = require("three");

function angle(from, to, amount) {
  const difference = ((to - from + 540) % 360) - 180;
  return from + difference * amount;
}

function rememberActorFrame(history, frame) {
  const previous = history.at(-1);
  // A viewport change can return another subset of the same source snapshot.
  // Refresh membership without inventing an extra motion observation.
  if (Number.isFinite(frame.capturedAt) && previous?.capturedAt === frame.capturedAt) previous.actors = frame.actors;
  else history.push(frame);
  while (history.length > 8) history.shift();
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

function sampleActor(history, id, now, delay = interpolationDelay(history)) {
  if (!history.length) return null;
  const target = now - delay;
  let left = history[0], right = history[0];
  for (const frame of history) {
    if (frame.at < target) left = frame;
    right = frame;
    if (frame.at >= target) break;
  }
  const b = right.actors.get(id) ?? left.actors.get(id);
  const a = left.actors.get(id) ?? b;
  if (!a || !b) return null;
  const duration = right.at - left.at;
  const amount = duration > 0 ? Math.max(0, Math.min(1, (target - left.at) / duration)) : 1;
  const position = a.position.map((value, index) => value + (b.position[index] - value) * amount);
  const speed = duration > 0
    ? Math.min(10, Math.hypot(b.position[0] - a.position[0], b.position[2] - a.position[2]) * 1000 / duration)
    : 0;
  return { ...b, position, yawDegrees: angle(a.yawDegrees ?? 0, b.yawDegrees ?? 0, amount), headYawDegrees: angle(a.headYawDegrees ?? a.yawDegrees ?? 0, b.headYawDegrees ?? b.yawDegrees ?? 0, amount), pitchDegrees: (a.pitchDegrees ?? 0) + ((b.pitchDegrees ?? 0) - (a.pitchDegrees ?? 0)) * amount, ...(b.display ? { display: interpolateDisplay(a.display, b.display, amount) } : {}), speed };
}

module.exports = { sampleActor, interpolationDelay, interpolateDisplay, rememberActorFrame };
