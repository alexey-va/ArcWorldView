"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../src/app.cjs"), "utf8");
const boundary = source.slice(source.indexOf("function viewQuery("), source.indexOf("function pumpChunks("));
function harness(json) {
  const scope = vm.createContext({
    module: { exports: {} }, json, AbortController, setTimeout, clearTimeout, URL,
    selectedScene: { id: "village", bounds: { minX: 0, minZ: 0, maxX: 16, maxZ: 16 } },
    camera: {}, cameraBounds: (_, bounds) => bounds, baseUrl: new URL("https://example.test/worldview/"),
    generation: 1, liveFramesSeen: false, epoch: null, bootstrapController: null,
    chunkDescriptors: new Map(), loadedCount: 0, totalCount: 0, lastTransportAt: 0,
    lastFrameAt: 0, history: [], actorRecords: new Map(), connections: [], pumps: 0,
    connection(state, text) { scope.connections.push({ state, text }); }, $: () => ({ textContent: "" }),
    pumpChunks() { scope.pumps++; }
  });
  vm.runInContext(boundary + "\nmodule.exports={bootstrapTerrain};", scope);
  return { ...scope.module.exports, scope };
}
const cached = { sceneId: "village", epoch: "saved-epoch", capturedAt: 1000, stale: true, chunks: [{ x: 0, z: 0, revision: "1", url: "cached.json" }], loadedChunks: 1, totalChunks: 1 };

test("saved terrain can bootstrap the initial epoch without fabricating live actors or heartbeat", async () => {
  const viewer = harness(async url => { assert.equal(url.searchParams.get("view"), "0,0,16,16"); return cached; });
  await viewer.bootstrapTerrain(1);
  assert.equal(viewer.scope.epoch, "saved-epoch"); assert.equal(viewer.scope.chunkDescriptors.size, 1);
  assert.equal(viewer.scope.lastTransportAt, 0); assert.equal(viewer.scope.lastFrameAt, 0);
  assert.equal(viewer.scope.history.length, 0); assert.equal(viewer.scope.actorRecords.size, 0);
  assert.equal(viewer.scope.connections[0].state, "saved"); assert.equal(viewer.scope.pumps, 1);
});

test("late cached terrain cannot replace live revisions or resurrect an authoritative missing chunk", async () => {
  let finish;
  const viewer = harness(() => new Promise(resolve => { finish = resolve; }));
  const pending = viewer.bootstrapTerrain(1);
  viewer.scope.liveFramesSeen = true; viewer.scope.epoch = cached.epoch;
  viewer.scope.chunkDescriptors.set("1,0", { x: 1, z: 0, revision: "9", url: "live.json" });
  finish(cached); await pending;
  assert.equal(viewer.scope.chunkDescriptors.size, 1);
  assert.equal(viewer.scope.chunkDescriptors.get("1,0").revision, "9");
  assert.equal(viewer.scope.chunkDescriptors.has("0,0"), false); assert.equal(viewer.scope.pumps, 0);
});

test("late cached response is ignored after a scene or epoch change", async () => {
  for (const change of [scope => { scope.generation++; }, scope => { scope.epoch = "new-epoch"; }]) {
    let finish; const viewer = harness(() => new Promise(resolve => { finish = resolve; }));
    const pending = viewer.bootstrapTerrain(1); change(viewer.scope); finish(cached); await pending;
    assert.equal(viewer.scope.chunkDescriptors.size, 0); assert.equal(viewer.scope.pumps, 0);
  }
});
