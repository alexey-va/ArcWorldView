"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createCanvas, Image } = require("canvas");

// Stock Prismarine packs sprites edge-to-edge. With MSAA a covered sample can
// use a fragment-centre UV just outside its triangle, even with NearestFilter.
// Keep the original 16 texels and geometry; add repeated edge texels around
// each sprite instead of shrinking faces or their visible texture region.
function padTerrainAtlas(root, version) {
  const atlasFile = path.join(root, "textures", `${version}.png`);
  const statesFile = path.join(root, "blocksStates", `${version}.json`);
  const image = new Image(); image.src = fs.readFileSync(atlasFile);
  const { width, height } = image;
  if (width % 16 || height % 16) throw Error("Terrain atlas must contain 16px tiles");
  const original = createCanvas(width, height), context = original.getContext("2d");
  context.drawImage(image, 0, 0);
  const source = context.getImageData(0, 0, width, height).data;
  const padded = createCanvas(width * 2, height * 2), target = padded.getContext("2d");
  const pixels = target.createImageData(padded.width, padded.height);
  for (let y = 0; y < padded.height; y++) for (let x = 0; x < padded.width; x++) {
    const sx = Math.floor(x / 32) * 16 + Math.max(0, Math.min(15, x % 32 - 8));
    const sy = Math.floor(y / 32) * 16 + Math.max(0, Math.min(15, y % 32 - 8));
    const from = (sy * width + sx) * 4, to = (y * padded.width + x) * 4;
    pixels.data.set(source.subarray(from, from + 4), to);
  }
  target.putImageData(pixels, 0, 0);
  const states = JSON.parse(fs.readFileSync(statesFile, "utf8"));
  function remap(value) {
    if (!value || typeof value !== "object") return;
    if (["u", "v", "su", "sv"].every((key) => Number.isFinite(value[key]))) {
      // bu/bv retain the original sprite centre for partial and mirrored UVs.
      const tileX = Math.floor((value.bu ?? value.u + value.su / 2) * width / 16);
      const tileY = Math.floor((value.bv ?? value.v + value.sv / 2) * height / 16);
      value.u = (value.u * width + tileX * 16 + 8) / (width * 2);
      value.v = (value.v * height + tileY * 16 + 8) / (height * 2);
      value.su /= 2; value.sv /= 2;
      if (value.bu !== undefined) value.bu = (tileX * 32 + 16) / (width * 2);
      if (value.bv !== undefined) value.bv = (tileY * 32 + 16) / (height * 2);
      return;
    }
    for (const child of Object.values(value)) remap(child);
  }
  remap(states);
  fs.writeFileSync(atlasFile, padded.toBuffer("image/png"));
  fs.writeFileSync(statesFile, JSON.stringify(states));
  return { width: padded.width, height: padded.height, tileSize: 16, padding: 8 };
}

module.exports = { padTerrainAtlas };
