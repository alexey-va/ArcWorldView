"use strict";

const { interpolateDisplay } = require("./actor-motion.cjs");

// Map server epoch timestamps onto rAF's monotonic clock. Repeated cached frames
// cannot restart a window, and a slower response cannot move playback backward.
function rememberDisplayClock(clock, capturedAt, receivedAt, stale = false) {
  if (!Number.isFinite(capturedAt) || !Number.isFinite(receivedAt) || capturedAt <= (clock.capturedAt ?? -Infinity)) return;
  if (!Number.isFinite(clock.offset) && stale) clock.staleBefore = capturedAt;
  clock.offset = Math.max(clock.offset ?? -Infinity, capturedAt - receivedAt);
  clock.capturedAt = capturedAt;
}

function validPose(pose) {
  return pose && ["position", "translation", "scale", "leftRotation", "rightRotation"].every(name =>
    Array.isArray(pose[name]) && pose[name].length === (name.endsWith("Rotation") ? 4 : 3) && pose[name].every(Number.isFinite)) &&
    Number.isFinite(pose.yawDegrees) && Number.isFinite(pose.pitchDegrees);
}

function sampleDisplayAnimation(record, now, clock) {
  const display = record.display, animation = display?.animation;
  if (!animation || !Number.isFinite(clock.offset) || !Number.isFinite(now) || !Number.isFinite(animation.capturedAt) ||
      !Number.isFinite(animation.sampleMillis) || animation.sampleMillis <= 0 || animation.sampleMillis > 2000 ||
      !Array.isArray(animation.samples) || !animation.samples.length || animation.samples.length > 21) return null;
  const duration = Math.min(2000, (animation.samples.length - 1) * animation.sampleMillis);
  const elapsed = animation.capturedAt <= (clock.staleBefore ?? -Infinity) ? duration :
    Math.max(0, Math.min(duration, now + clock.offset - animation.capturedAt));
  const index = Math.min(animation.samples.length - 1, Math.floor(elapsed / animation.sampleMillis));
  const left = animation.samples[index], right = animation.samples[Math.min(index + 1, animation.samples.length - 1)];
  if (!validPose(left) || !validPose(right)) return null;
  const amount = (elapsed - index * animation.sampleMillis) / animation.sampleMillis;
  const pose = interpolateDisplay({ ...left, kind:display.kind }, { ...right, kind:display.kind }, amount);
  let itemIndex = left.itemIndex, switchAt = -Infinity;
  if (Array.isArray(animation.itemSwitches) && animation.itemSwitches.length <= 8) {
    for (const change of animation.itemSwitches) {
      if (Number.isFinite(change.offsetMillis) && change.offsetMillis >= 0 && change.offsetMillis <= elapsed && change.offsetMillis >= switchAt) {
        switchAt = change.offsetMillis; itemIndex = change.itemIndex;
      }
    }
  }
  const item = Array.isArray(animation.items) && animation.items.length <= 8 && Number.isInteger(itemIndex) ? animation.items[itemIndex] : null;
  const yaw = left.yawDegrees + (((right.yawDegrees - left.yawDegrees + 540) % 360) - 180) * amount;
  return { ...record, position:left.position.map((value, axis) => value + (right.position[axis] - value) * amount),
    yawDegrees:yaw, headYawDegrees:yaw, pitchDegrees:left.pitchDegrees + (right.pitchDegrees - left.pitchDegrees) * amount,
    display:{ ...display, translation:pose.translation, scale:pose.scale, leftRotation:pose.leftRotation, rightRotation:pose.rightRotation,
      ...(display.kind === "item" && item ? { item } : {}) } };
}

module.exports = { rememberDisplayClock, sampleDisplayAnimation };
