"use strict";

const THREE = require("three");
let assets = null;
const textures = new Map();

function setAssets(value) {
  if (assets?.revision !== value.revision) { for (const texture of textures.values()) texture.dispose(); textures.clear(); }
  assets = value;
}
function assetUrl(relative) { return new URL(relative, assets.manifestUrl).href; }

function loadTexture(requested, callback) {
  const match = String(requested).match(/(?:^|\/)textures\/[^/]+\/(.+)\.png$/);
  const relative = match ? assets.entityTextures[match[1]] : null;
  const url = relative ? assetUrl(relative) : requested;
  if (textures.has(url)) { callback(textures.get(url)); return; }
  const texture = new THREE.TextureLoader().load(url, callback, undefined, () => {
    window.dispatchEvent(new CustomEvent("worldview-asset-error", { detail: url }));
  });
  textures.set(url, texture);
}

function loadJSON(url, callback) {
  fetch(url).then((response) => {
    if (!response.ok) throw Error(`Resource returned ${response.status}`);
    return response.json();
  }).then(callback);
}

module.exports = { setAssets, assetUrl, loadTexture, loadJSON };
