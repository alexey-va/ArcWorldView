"use strict";

function copySkinRegion(context, scale, source, destination) {
  const [sourceX, sourceY, width, height] = source.map((value) => value * scale);
  const [destinationX, destinationY] = destination.map((value) => value * scale);
  const pixels = context.getImageData(sourceX, sourceY, width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width / 2; x += 1) {
      const left = (x + y * width) * 4;
      const right = (width - x - 1 + y * width) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const value = pixels.data[left + channel];
        pixels.data[left + channel] = pixels.data[right + channel];
        pixels.data[right + channel] = value;
      }
    }
  }
  context.putImageData(pixels, destinationX, destinationY);
}

function convertLegacySkin(context, width) {
  const scale = width / 64;
  const copies = [
    [[4, 16, 4, 4], [20, 48]],
    [[8, 16, 4, 4], [24, 48]],
    [[0, 20, 4, 12], [24, 52]],
    [[4, 20, 4, 12], [20, 52]],
    [[8, 20, 4, 12], [16, 52]],
    [[12, 20, 4, 12], [28, 52]],
    [[44, 16, 4, 4], [36, 48]],
    [[48, 16, 4, 4], [40, 48]],
    [[40, 20, 4, 12], [40, 52]],
    [[44, 20, 4, 12], [36, 52]],
    [[48, 20, 4, 12], [32, 52]],
    [[52, 20, 4, 12], [44, 52]],
  ];
  for (const [source, destination] of copies) {
    copySkinRegion(context, scale, source, destination);
  }
}

function legacySkinIsOpaque(context, width) {
  const height = width / 2;
  const pixels = context.getImageData(0, 0, width, height).data;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] !== 255) return false;
  }
  return true;
}

function clearLegacyHelmet(context, width) {
  const scale = width / 64;
  for (const [x, y, regionWidth, regionHeight] of [
    [40, 0, 8, 8],
    [48, 0, 8, 8],
    [32, 8, 8, 8],
    [40, 8, 8, 8],
    [48, 8, 8, 8],
    [56, 8, 8, 8],
  ]) {
    context.clearRect(x * scale, y * scale, regionWidth * scale, regionHeight * scale);
  }
}

function normalizePlayerSkinImage(image, documentRef = globalThis.document) {
  if (!image || image.width === image.height || image.width !== image.height * 2) return image;
  const canvas = documentRef.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.width;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, image.width, image.height);
  convertLegacySkin(context, image.width);
  if (legacySkinIsOpaque(context, image.width)) clearLegacyHelmet(context, image.width);
  return canvas;
}

module.exports = { clearLegacyHelmet, convertLegacySkin, legacySkinIsOpaque, normalizePlayerSkinImage };
