"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createCanvas, Image } = require("canvas");

function textureAnimation(metadata, width, height) {
  const animation = metadata?.animation;
  if (!animation) return null;
  const frameWidth = animation.width ?? (animation.height ? width : Math.min(width, height));
  const frameHeight = animation.height ?? (animation.width ? height : Math.min(width, height));
  const time = animation.frametime ?? 1;
  if (![frameWidth, frameHeight, time].every(value => Number.isSafeInteger(value) && value > 0) || width % frameWidth || height % frameHeight) throw Error("Invalid animated texture dimensions or frame time");
  const count = width / frameWidth * height / frameHeight;
  const frames = (animation.frames?.length ? animation.frames : Array.from({ length: count }, (_, index) => index)).map(frame => typeof frame === "number" ? { index: frame, time } : { index: frame.index, time: frame.time ?? time });
  if (!frames.every(frame => Number.isSafeInteger(frame.index) && frame.index >= 0 && frame.index < count && Number.isSafeInteger(frame.time) && frame.time > 0)) throw Error("Invalid animated texture frame sequence");
  return count > 1 ? { width, height, frameWidth, frameHeight, frametime:time, frames, interpolate: Boolean(animation.interpolate) } : null;
}

function textureAnimations(root, files) {
  const result = {};
  for (const file of files) {
    if (!file.endsWith(".png") || !fs.existsSync(path.join(root, file + ".mcmeta"))) continue;
    const image = new Image(); image.src = fs.readFileSync(path.join(root, file));
    let animation;
    try { animation = textureAnimation(JSON.parse(fs.readFileSync(path.join(root, file + ".mcmeta"), "utf8")), image.width, image.height); }
    catch (error) { console.warn(`Animated texture kept static: ${file}: ${error.message}`); continue; }
    if (!animation) continue;
    const canvas = createCanvas(image.width, image.height), context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    animation.translucent = pixels.some((value, index) => index % 4 === 3 && value > 0 && value < 255);
    result[file] = animation;
  }
  return result;
}

module.exports = { textureAnimation, textureAnimations };
