"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const CONTEXTS = ["none", "ground", "fixed", "head", "gui", "thirdperson_lefthand", "thirdperson_righthand", "firstperson_lefthand", "firstperson_righthand"];

function files(directory, prefix = "") {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? files(path.join(directory, entry.name), prefix + entry.name + "/")
    : entry.isFile() && entry.name.endsWith(".json") ? [prefix + entry.name] : []);
}

function compileItemAssets({ viewerRoot, output }) {
  // The pinned public subset resolves only the explicit captured resource pack.
  const { resolveResourceItemRenderModel, resolveItemsAdderRenderModel } = require(path.join(viewerRoot, "src/item-model-assets.cjs"));
  const nativeRoot = path.join(output, "native");
  const modelRoot = path.join(output, "models");
  fs.mkdirSync(modelRoot, { recursive: true });
  const items = {}, itemModels = {}, unsupported = new Set();
  const save = (source) => {
    if (!source?.elements?.length) return null;
    const model = structuredClone(source);
    for (const [key, value] of Object.entries(model.textures ?? {})) {
      if (!value) continue;
      let relative;
      if (value.startsWith("/itemsadder-texture/")) relative = "native/assets/" + decodeURIComponent(value.slice(20)).replace(/^([^/]+)\//, "$1/textures/");
      else if (value.startsWith("/vanilla-block-texture/")) relative = "native/assets/minecraft/textures/block/" + decodeURIComponent(value.slice(23));
      else if (value.startsWith("/vanilla-item-texture/")) relative = "native/assets/minecraft/textures/item/" + decodeURIComponent(value.slice(22));
      if (!relative || !fs.existsSync(path.join(output, relative))) return null;
      model.textures[key] = relative;
    }
    const bytes = JSON.stringify(model);
    const file = `models/${crypto.createHash("sha256").update(bytes).digest("hex").slice(0,24)}.json`;
    fs.writeFileSync(path.join(output, file), bytes);
    return file;
  };
  const collectThresholds = (node, values) => {
    if (!node || typeof node !== "object") return;
    if (String(node.type).replace(/^minecraft:/, "") === "range_dispatch" && String(node.property).replace(/^minecraft:/, "") === "custom_model_data") {
      for (const entry of node.entries ?? []) if (Number.isInteger(entry.threshold)) values.add(entry.threshold);
    }
    for (const value of Object.values(node)) if (typeof value === "object") {
      if (Array.isArray(value)) value.forEach((entry) => collectThresholds(entry, values));
      else collectThresholds(value, values);
    }
  };
  for (const namespace of fs.readdirSync(path.join(nativeRoot, "assets"))) {
    const directory = path.join(nativeRoot, "assets", namespace, "items");
    for (const file of files(directory)) {
      const key = `${namespace}:${file.slice(0,-5)}`;
      let defaultModel=null;
      for (const mode of CONTEXTS) {
        const model = resolveResourceItemRenderModel(key, mode, { resourcePackRoot: nativeRoot });
        const saved = save(model);
        if (saved) {
          if(mode==="none") defaultModel=saved;
          if(mode==="none" || saved!==defaultModel) {
            itemModels[`${key}|${mode}`] = saved;
            if (namespace === "minecraft") items[`${key}||${mode}`] = saved;
          }
        } else unsupported.add(key);
      }
      if (namespace !== "minecraft") continue;
      const material = file.slice(0,-5);
      const thresholds = new Set();
      collectThresholds(JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")), thresholds);
      const legacyPath = path.join(nativeRoot, "assets/minecraft/models/item", file);
      if (fs.existsSync(legacyPath)) for (const override of JSON.parse(fs.readFileSync(legacyPath, "utf8")).overrides ?? []) {
        if (Number.isInteger(override.predicate?.custom_model_data)) thresholds.add(override.predicate.custom_model_data);
      }
      for (const threshold of thresholds) {
        const saved = save(resolveItemsAdderRenderModel(material, threshold, { resourcePackRoot: nativeRoot }));
        if (saved) items[`${key}|${threshold}|none`] = saved;
        else unsupported.add(`${key}|${threshold}`);
      }
    }
  }
  return { items, itemModels, unsupported: [...unsupported].sort() };
}

module.exports = { compileItemAssets };

if (require.main === module) {
  process.stdout.write(JSON.stringify(compileItemAssets({ viewerRoot:process.argv[2],output:process.argv[3] })));
}
