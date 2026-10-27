"use strict";

// Minecraft's texture clock runs at 20 ticks/s, independently of scene polling.
// Only the texture matrix changes: the original strip stays uploaded once.
function textureSample(animation, now) {
  const duration = animation.frames.reduce((sum, frame) => sum + frame.time, 0);
  let tick = Math.max(0, now) / 50 % duration;
  for (const [index, frame] of animation.frames.entries()) {
    if (tick < frame.time) return { index:frame.index, nextIndex:animation.frames[(index + 1) % animation.frames.length].index, amount:animation.interpolate ? tick / frame.time : 0 };
    tick -= frame.time;
  }
  return { index:animation.frames[0].index, nextIndex:animation.frames[0].index, amount:0 };
}

function textureFrame(animation, now) { return textureSample(animation, now).index; }

function frameOffset(animation, index, flipY) {
  const columns = animation.width / animation.frameWidth;
  const x = animation.frameWidth / animation.width, y = animation.frameHeight / animation.height;
  return [index % columns * x, flipY ? 1 - (Math.floor(index / columns) + 1) * y : Math.floor(index / columns) * y];
}

function animateTexture(texture, animation, now, sample = textureSample(animation, now)) {
  const x = animation.frameWidth / animation.width, y = animation.frameHeight / animation.height;
  texture.repeat.set(x, y);
  texture.offset.set(...frameOffset(animation, sample.index, texture.flipY));
  return sample.index;
}

module.exports = { textureFrame, textureSample, frameOffset, animateTexture };
