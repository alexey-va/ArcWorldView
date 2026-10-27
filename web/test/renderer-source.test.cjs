"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { viewerSource } = require("../scripts/viewer-source.cjs");
const renderer = viewerSource();
const { resolveResourceItemRenderModel, resolveItemsAdderRenderModel } = require(path.join(renderer, "src/item-model-assets.cjs"));
const { itemModelFaces } = require(path.join(renderer, "src/item-model-geometry.cjs"));

test("public build uses the exact bundled source snapshot without private repository access", () => {
  const provenance = JSON.parse(fs.readFileSync(path.join(renderer, "PROVENANCE.json"), "utf8"));
  const pin = fs.readFileSync(path.resolve(__dirname, "../../renderer-source.ref"), "utf8").trim();
  assert.equal(provenance.upstream_commit, pin);
  assert.equal(provenance.files.length, 9);
  for (const entry of provenance.files) {
    const bytes = fs.readFileSync(path.join(renderer, entry.destination_path));
    assert.equal(bytes.length, entry.bytes, entry.destination_path);
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), entry.source_sha256, entry.destination_path);
  }
});

test("captured-pack item resolver preserves generated planes, inherited context and CMD thresholds", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worldview-public-models-"));
  const write = (relative, value) => {
    const target = path.join(root, "assets/minecraft", relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(value));
  };
  try {
    write("models/item/generated.json", { parent: "builtin/generated", display: { thirdperson_righthand: { translation: [0,16,0] } } });
    write("models/item/tool.json", { parent: "minecraft:item/generated", textures: { layer0: "minecraft:item/iron_axe" } });
    write("models/item/custom.json", { parent: "minecraft:item/generated", textures: { layer0: "minecraft:item/diamond_axe" } });
    write("items/tool.json", { model: { type: "minecraft:condition", on_false: { type: "minecraft:range_dispatch",
      property: "minecraft:custom_model_data", fallback: { type: "minecraft:model", model: "minecraft:item/tool" },
      entries: [{ threshold: 10, model: { type: "minecraft:model", model: "minecraft:item/custom" } }] } } });
    write("items/cmdtool.json", { model: { type: "minecraft:range_dispatch", property: "minecraft:custom_model_data",
      entries: [{ threshold: 10, model: { type: "minecraft:model", model: "minecraft:item/custom" } }] } });
    const model = resolveResourceItemRenderModel("minecraft:tool", "thirdperson_righthand", { resourcePackRoot: root });
    assert.equal(model.elements.length, 1);
    assert.equal(model.textures.layer0, "/itemsadder-texture/minecraft/item/iron_axe.png");
    const faces = itemModelFaces(model, "thirdperson_righthand");
    assert.equal(faces.length, 2);
    assert.equal(Math.min(...faces.flatMap(face => face.positions.map(point => point[1]))), .5);
    assert.equal(Math.max(...faces.flatMap(face => face.positions.map(point => point[1]))), 1.5);
    const custom = resolveItemsAdderRenderModel("cmdtool", 12, { resourcePackRoot: root });
    assert.equal(custom.identity, "minecraft:item/custom");
    assert.equal(custom.textures.layer0, "/itemsadder-texture/minecraft/item/diamond_axe.png");
    assert.equal(resolveItemsAdderRenderModel("cmdtool", 9, { resourcePackRoot: root }), null);
    assert.equal(resolveResourceItemRenderModel("minecraft:../outside", "none", { resourcePackRoot: root }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
