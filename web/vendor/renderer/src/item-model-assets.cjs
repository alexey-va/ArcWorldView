"use strict";

// Explicit captured-resource-pack subset of the project-owned renderer.
// Original pure helpers: f4e4e5a69fafacbc2750b1256ef3c8087963ad1c:scripts/player-bot/src/enhanced-viewer.cjs
// Runtime server configuration is outside this standalone asset builder.
const fs = require("node:fs");
const path = require("node:path");
const compiledAtlasCache = new Map();
const ITEM_DISPLAY_MODES = [
  "none",
  "thirdperson_lefthand",
  "thirdperson_righthand",
  "firstperson_lefthand",
  "firstperson_righthand",
  "head",
  "gui",
  "ground",
  "fixed",
];
const ITEM_DISPLAY_CONTEXTS = new Set(ITEM_DISPLAY_MODES);

function safeRelativeAssetPath(value, { minLength = 1, maxLength = 128 } = {}) {
  const relative = String(value ?? "");
  if (
    relative.length < minLength
    || relative.length > maxLength
    || relative.startsWith("/")
    || !/^[a-z0-9_./-]+$/.test(relative)
    || relative.split("/").some((part) => !part || part === "." || part === "..")
  ) return null;
  return relative;
}

function modelReference(value, fallbackNamespace) {
  const reference = resourceLocation(value, fallbackNamespace);
  if (!reference) return null;
  return { namespace: reference.namespace, modelPath: reference.path.replace(/^models\//, "") };
}

function customModelDataItemReference(resourcePackRoot, material, customModelData) {
  if (!resourcePackRoot || !Number.isFinite(Number(customModelData))) return null;
  const itemName = String(material ?? "").toLowerCase();
  if (!/^[a-z0-9_.-]{1,64}$/.test(itemName)) return null;

  const overlayRoots = [path.resolve(resourcePackRoot)];
  const pending = [{ directory: path.resolve(resourcePackRoot), depth: 0 }];
  const seen = new Set(overlayRoots);
  while (pending.length > 0) {
    const current = pending.shift();
    if (current.depth >= 4) continue;
    let entries;
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("ia_overlay")) continue;
      const candidate = path.resolve(current.directory, entry.name);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      overlayRoots.push(candidate);
      pending.push({ directory: candidate, depth: current.depth + 1 });
    }
  }

  const readJson = (file) => {
    if (!file) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  };
  const modelFromNode = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 16) return null;
    const type = String(node.type ?? "").replace(/^minecraft:/, "");
    if (type === "range_dispatch"
      && String(node.property ?? "").replace(/^minecraft:/, "") === "custom_model_data") {
      let selected = null;
      for (const entry of Array.isArray(node.entries) ? node.entries : []) {
        const threshold = Number(entry?.threshold);
        if (!Number.isFinite(threshold) || threshold > Number(customModelData)) continue;
        if (!selected || threshold >= selected.threshold) selected = { threshold, model: entry.model };
      }
      return modelFromNode(selected?.model, depth + 1);
    }
    if (type === "model" && typeof node.model === "string") {
      return modelReference(node.model, "minecraft");
    }
    return node.model && typeof node.model === "object"
      ? modelFromNode(node.model, depth + 1)
      : null;
  };

  // Newer ItemsAdder packs route custom_model_data through item definitions in
  // versioned overlays. Read that mapping from the same captured pack the
  // viewer is rendering, before consulting a potentially stale server cache.
  for (const overlayRoot of overlayRoots) {
    const definition = readJson(packFile(overlayRoot, "assets", "minecraft", "items", `${itemName}.json`));
    const reference = modelFromNode(definition?.model ?? definition);
    if (reference) return reference;
  }

  // Older packs use the vanilla item model's ordered override thresholds.
  const legacy = readJson(packFile(
    resourcePackRoot,
    "assets",
    "minecraft",
    "models",
    "item",
    `${itemName}.json`,
  ));
  let selectedModel = null;
  for (const override of Array.isArray(legacy?.overrides) ? legacy.overrides : []) {
    const predicate = override?.predicate;
    if (!predicate || !Object.hasOwn(predicate, "custom_model_data")) continue;
    const threshold = Number(predicate.custom_model_data);
    if (Number.isFinite(threshold) && threshold <= Number(customModelData)) {
      selectedModel = override.model;
    }
  }
  return modelReference(selectedModel, "minecraft");
}

function resourceLocation(value, fallbackNamespace = "minecraft") {
  const raw = String(value ?? "");
  const separator = raw.indexOf(":");
  if (separator !== raw.lastIndexOf(":")) return null;
  const namespace = separator < 0 ? fallbackNamespace : raw.slice(0, separator);
  const resourcePath = separator < 0 ? raw : raw.slice(separator + 1);
  if (
    !/^[a-z0-9_.-]+$/.test(namespace)
    || !safeRelativeAssetPath(namespace, { minLength: 1, maxLength: 64 })
    || !safeRelativeAssetPath(resourcePath, { minLength: 1, maxLength: 256 })
  ) return null;
  return { namespace, path: resourcePath };
}

function packFile(resourcePackRoot, ...parts) {
  const root = path.resolve(resourcePackRoot);
  const candidate = path.resolve(root, ...parts);
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.existsSync(candidate)) {
    return null;
  }
  try {
    const realRoot = fs.realpathSync(root);
    const realCandidate = fs.realpathSync(candidate);
    const realRelative = path.relative(realRoot, realCandidate);
    if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) return null;
  } catch {
    return null;
  }
  return candidate;
}

function mergeModel(reference, resourcePackRoot, stack = new Set(), options = {}) {
  const key = `${reference.namespace}:${reference.modelPath}`;
  if (stack.has(key)) throw new Error(`Circular ItemsAdder model parent: ${key}`);
  const file = modelFile(reference, resourcePackRoot, options);
  if (!file) {
    if (["item/generated", "builtin/generated"].includes(reference.modelPath)) {
      return {
        ambientocclusion: false,
        display: {},
        elements: [{
          from: [0, 0, 8],
          to: [16, 16, 8.01],
          faces: {
            north: { texture: "#layer0" },
            south: { texture: "#layer0" },
          },
        }],
        textures: {},
      };
    }
    return null;
  }
  const source = JSON.parse(fs.readFileSync(file, "utf8"));
  const parentReference = source.parent ? modelReference(source.parent, reference.namespace) : null;
  const parent = parentReference
    ? mergeModel(parentReference, resourcePackRoot, new Set(stack).add(key), options)
    : null;
  return {
    ambientocclusion: source.ambientocclusion ?? parent?.ambientocclusion ?? true,
    display: { ...(parent?.display ?? {}), ...(source.display ?? {}) },
    elements: Array.isArray(source.elements) ? source.elements : (parent?.elements ?? []),
    textures: { ...(parent?.textures ?? {}), ...(source.textures ?? {}) },
  };
}

function compiledAtlasResources(resourcePackRoot) {
  if (!resourcePackRoot) return new Map();
  if (compiledAtlasCache.has(resourcePackRoot)) return compiledAtlasCache.get(resourcePackRoot);
  const resources = new Map();
  const atlasRoots = [resourcePackRoot];
  try {
    atlasRoots.push(...fs.readdirSync(resourcePackRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("ia_overlay"))
      .map((entry) => path.join(resourcePackRoot, entry.name)));
  } catch {
    // A missing or unreadable pack root simply has no compiled atlas entries.
  }
  for (const atlasRoot of atlasRoots) {
    for (const name of ["blocks.json", "items.json"]) {
      const atlas = packFile(atlasRoot, "assets", "minecraft", "atlases", name);
      if (!atlas) continue;
      let source;
      try {
        source = JSON.parse(fs.readFileSync(atlas, "utf8"));
      } catch {
        continue;
      }
      for (const entry of Array.isArray(source.sources) ? source.sources.slice(0, 100_000) : []) {
        if (entry?.type !== "single" || typeof entry.sprite !== "string" || typeof entry.resource !== "string") continue;
        resources.set(entry.sprite, entry.resource);
      }
    }
  }
  compiledAtlasCache.set(resourcePackRoot, resources);
  return resources;
}

function resolveTextureReference(textures, key, fallbackNamespace, resourcePackRoot = null) {
  let value = key;
  const seen = new Set();
  while (typeof value === "string" && value.startsWith("#")) {
    const alias = value.slice(1);
    if (seen.has(alias)) return null;
    seen.add(alias);
    value = textures[alias];
  }
  const expanded = compiledAtlasResources(resourcePackRoot).get(value) ?? value;
  const reference = modelReference(expanded, fallbackNamespace);
  if (!reference) return null;
  if (reference.namespace === "minecraft" && reference.modelPath.startsWith("block/")) {
    const texturePath = reference.modelPath.slice("block/".length);
    return `/vanilla-block-texture/${encodeURIComponent(texturePath)}.png`;
  }
  return `/itemsadder-texture/${encodeURIComponent(reference.namespace)}/${reference.modelPath}.png`;
}

function resolveResourceItemModelReference(itemModel, displayContext, resourcePackRoot) {
  const item = resourceLocation(itemModel, "minecraft");
  const context = String(displayContext ?? "none").toLowerCase();
  if (!item || !ITEM_DISPLAY_CONTEXTS.has(context) || !resourcePackRoot) return null;
  const file = packFile(resourcePackRoot, "assets", item.namespace, "items", `${item.path}.json`);
  if (!file) return null;
  let definition;
  try {
    definition = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const selectModel = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 16) return null;
    const type = String(node.type ?? "").replace(/^minecraft:/, "");
    if (type === "select" && String(node.property ?? "").replace(/^minecraft:/, "") === "display_context") {
      const selected = (Array.isArray(node.cases) ? node.cases : []).find(({ when }) => (
        (Array.isArray(when) ? when : [when]).includes(context)
      ));
      return selectModel(selected?.model ?? node.fallback, depth + 1);
    }
    if (type === "model" && typeof node.model === "string") return modelReference(node.model, "minecraft");
    if (node.fallback) return selectModel(node.fallback, depth + 1);
    if (type === "condition" && node.on_false) return selectModel(node.on_false, depth + 1);
    return node.model && typeof node.model === "object" ? selectModel(node.model, depth + 1) : null;
  };
  return selectModel(definition.model ?? definition);
}

function resolveResourceItemRenderModel(itemModel, displayContext = "none", { resourcePackRoot = null } = {}) {
  const reference = resolveResourceItemModelReference(itemModel, displayContext, resourcePackRoot);
  if (!reference) return null;
  const model = mergeModel(reference, resourcePackRoot, new Set(), { allowItemsAdderFallback: false });
  if (!model) return null;
  const textures = Object.fromEntries(
    Object.keys(model.textures).map((key) => [
      key,
      resolveTextureReference(model.textures, `#${key}`, reference.namespace, resourcePackRoot),
    ]),
  );
  return {
    identity: `${reference.namespace}:${reference.modelPath}`,
    ambientocclusion: model.ambientocclusion,
    display: model.display,
    elements: model.elements,
    textures,
  };
}

function modelFile(reference, resourcePackRoot) {
  return resourcePackRoot ? packFile(resourcePackRoot, "assets", reference.namespace, "models", `${reference.modelPath}.json`) : null;
}

function resolveItemsAdderRenderModel(material, customModelData, { resourcePackRoot = null } = {}) {
  const reference = customModelDataItemReference(resourcePackRoot, material, customModelData);
  if (!reference) return null;
  const model = mergeModel(reference, resourcePackRoot, new Set(), { allowItemsAdderFallback: false });
  if (!model) return null;
  const textures = Object.fromEntries(Object.keys(model.textures).map((key) => [
    key, resolveTextureReference(model.textures, `#${key}`, reference.namespace, resourcePackRoot),
  ]));
  return { identity: `${reference.namespace}:${reference.modelPath}`, ambientocclusion: model.ambientocclusion,
    display: model.display, elements: model.elements, textures };
}

module.exports = { resolveResourceItemRenderModel, resolveItemsAdderRenderModel };
