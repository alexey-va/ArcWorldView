"use strict";

function angle(from, to, amount) {
  const difference = ((to - from + 540) % 360) - 180;
  return from + difference * amount;
}

function sampleActor(history, id, now, delay = 250) {
  if (!history.length) return null;
  const target = now - delay;
  let left = history[0], right = history[0];
  for (const frame of history) {
    if (frame.at <= target) left = frame;
    right = frame;
    if (frame.at >= target) break;
  }
  const b = right.actors.get(id) ?? left.actors.get(id);
  const a = left.actors.get(id) ?? b;
  if (!a || !b) return null;
  const duration = right.at - left.at;
  const amount = duration > 0 ? Math.max(0, Math.min(1, (target - left.at) / duration)) : 1;
  const position = a.position.map((value, index) => value + (b.position[index] - value) * amount);
  const speed = duration > 0 && now - history.at(-1).at < 600
    ? Math.min(10, Math.hypot(b.position[0] - a.position[0], b.position[2] - a.position[2]) * 1000 / duration)
    : 0;
  return { ...b, position, yawDegrees: angle(a.yawDegrees ?? 0, b.yawDegrees ?? 0, amount), headYawDegrees: angle(a.headYawDegrees ?? a.yawDegrees ?? 0, b.headYawDegrees ?? b.yawDegrees ?? 0, amount), pitchDegrees: (a.pitchDegrees ?? 0) + ((b.pitchDegrees ?? 0) - (a.pitchDegrees ?? 0)) * amount, speed };
}

module.exports = { sampleActor };
