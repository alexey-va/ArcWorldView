"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function files(root, suffix, prefix = "") {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) return files(path.join(root, entry.name), suffix, relative + "/");
    return entry.isFile() && relative.endsWith(suffix) ? [relative] : [];
  });
}

function location(value) {
  const text = String(value);
  const [namespace, name] = text.includes(":") ? text.split(":") : ["minecraft", text];
  if (!/^[a-z0-9_.-]+$/.test(namespace) || !/^[a-z0-9_./-]+$/.test(name) || name.split("/").some((part) => !part || part === "." || part === "..")) throw Error(`Invalid resource location: ${text}`);
  return `${namespace}:${name}`;
}

function packRoots(packRoot, resourceFormat = 75) {
  if (!packRoot) return [];
  const root = path.resolve(packRoot);
  const roots = [root];
  const metadataPath = path.join(root, "pack.mcmeta");
  if (!fs.existsSync(metadataPath)) return roots;
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  const major = (value) => Number(Array.isArray(value) ? value[0] : value);
  for (const overlay of metadata.overlays?.entries ?? []) {
    const formats = overlay.formats;
    const min = major(overlay.min_format ?? (typeof formats === "object" ? formats?.min_inclusive : formats));
    const max = major(overlay.max_format ?? (typeof formats === "object" ? formats?.max_inclusive : formats));
    if (!Number.isFinite(min) || !Number.isFinite(max) || resourceFormat < min || resourceFormat > max) continue;
    if (typeof overlay.directory !== "string" || !/^[a-zA-Z0-9_/-]+$/.test(overlay.directory) || overlay.directory.split("/").some((part) => !part || part === "..")) throw Error("Unsafe resource-pack overlay directory");
    const candidate = path.resolve(root, overlay.directory);
    if (!candidate.startsWith(root + path.sep)) throw Error("Resource-pack overlay escaped its root");
    roots.push(candidate);
  }
  return roots;
}

function mergedBlockAssets({ vanillaRoot, resourcePackRoot, outputBlocks, resourceFormat = 75 }) {
  const { createCanvas, Image } = require("canvas");
  const roots = [path.resolve(vanillaRoot), ...packRoots(resourcePackRoot, resourceFormat)];
  const states = {}, models = {}, textures = new Map(), spriteAliases = new Map();
  for (const root of roots) {
    const assets = path.join(root, "assets");
    if (!fs.existsSync(assets)) continue;
    for (const namespace of fs.readdirSync(assets, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)) {
      const namespaceRoot = path.join(assets, namespace);
      for (const file of files(path.join(namespaceRoot, "models"), ".json")) models[location(`${namespace}:${file.slice(0,-5)}`)] = JSON.parse(fs.readFileSync(path.join(namespaceRoot, "models", file), "utf8"));
      if (namespace === "minecraft") for (const file of files(path.join(namespaceRoot, "blockstates"), ".json")) states[file.slice(0,-5)] = JSON.parse(fs.readFileSync(path.join(namespaceRoot, "blockstates", file), "utf8"));
      for (const file of files(path.join(namespaceRoot, "textures"), ".png")) textures.set(location(`${namespace}:${file.slice(0,-4)}`), path.join(namespaceRoot, "textures", file));
      const atlas = path.join(namespaceRoot, "atlases", "blocks.json");
      if (fs.existsSync(atlas)) for (const entry of JSON.parse(fs.readFileSync(atlas, "utf8")).sources ?? []) {
        if (String(entry.type).replace("minecraft:", "") === "single" && entry.resource) spriteAliases.set(location(entry.sprite ?? entry.resource), location(entry.resource));
      }
    }
  }
  const normalizedModels = {};
  const usedTextures = new Set();
  const key = (prefix, name) => prefix + crypto.createHash("sha256").update(name).digest("hex").slice(0,24);
  const textureKey = (reference) => {
    let name = location(reference);
    if (name === "minecraft:missingno") return "missing_texture";
    const seen = new Set();
    while (spriteAliases.has(name)) {
      if (seen.has(name)) throw Error(`Circular atlas alias: ${name}`);
      seen.add(name); name = spriteAliases.get(name);
    }
    if (!textures.has(name)) throw Error(`Missing block texture: ${name}`);
    usedTextures.add(name); return key("tex_", name);
  };
  const modelKey = (reference, stack = new Set()) => {
    const name = location(reference);
    if (stack.has(name)) throw Error(`Circular block model: ${name}`);
    const id = key("model_", name);
    if (normalizedModels[id]) return id;
    const source = models[name];
    if (!source) throw Error(`Missing block model: ${name}`);
    const result = structuredClone(source);
    if (source.parent) result.parent = modelKey(source.parent, new Set(stack).add(name));
    for (const [slot, texture] of Object.entries(result.textures ?? {})) if (!texture.startsWith("#")) result.textures[slot] = textureKey(texture);
    for (const element of result.elements ?? []) for (const face of Object.values(element.faces ?? {})) if (!face.texture.startsWith("#")) {
      face.texture = Object.hasOwn(result.textures ?? {}, face.texture) ? `#${face.texture}` : textureKey(face.texture);
    }
    normalizedModels[id] = result;
    return id;
  };
  const resolve = (variant) => {
    if (Array.isArray(variant)) variant.forEach(resolve);
    else if (variant?.model) variant.model = modelKey(variant.model);
  };
  for (const state of Object.values(states)) {
    for (const variant of Object.values(state.variants ?? {})) resolve(variant);
    for (const part of state.multipart ?? []) resolve(part.apply);
  }
  // Upstream adds its own missing-texture model with this vanilla parent name.
  normalizedModels.cube_all = { parent: modelKey("minecraft:block/cube_all") };
  fs.mkdirSync(outputBlocks, { recursive: true });
  for (const name of usedTextures) {
    const image = new Image(); image.src = fs.readFileSync(textures.get(name));
    if (image.width < 1 || image.height < image.width) throw Error(`Invalid block texture dimensions: ${name}`);
    const canvas = createCanvas(16,16), context = canvas.getContext("2d");
    context.imageSmoothingEnabled = false;
    context.drawImage(image,0,0,image.width,image.width,0,0,16,16);
    fs.writeFileSync(path.join(outputBlocks,key("tex_",name)+".png"),canvas.toBuffer("image/png"));
  }
  return { states, models: normalizedModels, textures: usedTextures.size, resourcePackRoots: roots.slice(1) };
}

module.exports = { mergedBlockAssets, packRoots };
