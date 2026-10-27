"use strict";

function configureMinecraftRenderer(renderer, THREE) {
  // Prismarine Viewer leaves its block atlas at LinearEncoding. Keep the
  // renderer and every custom Minecraft texture in that same legacy pipeline;
  // applying an sRGB output transform to only the final frame washes the atlas
  // out because its already-sRGB pixel values were never decoded first.
  renderer.outputEncoding = THREE.LinearEncoding;
}

function configureMinecraftTexture(texture, THREE) {
  texture.encoding = THREE.LinearEncoding;
}

module.exports = {
  configureMinecraftRenderer,
  configureMinecraftTexture,
};
