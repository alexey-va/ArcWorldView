"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise the actual async cache boundary without booting WebGL or a fake DOM.
const app = fs.readFileSync(path.join(__dirname, "../src/app.cjs"), "utf8");
const boundary = app.slice(app.indexOf("async function fetchChunk("), app.indexOf("async function poll("));
function harness(json) {
  const added = [], decodeRequests = new Map(), pendingChunks = new Map();
  let markDecodeStarted;
  const decodeStarted = new Promise(resolve => { markDecodeStarted = resolve; });
  const scope = vm.createContext({
    module: { exports: {} }, json, AbortController, setTimeout, clearTimeout,
    performance, generation: 1, epoch: "epoch-a", sequence: 7,
    lastFrameAt: 0, loadedCount: 0, totalCount: 0, chunkRequestId: 0,
    selectedScene: { id: "village", bounds: { minY: 56, maxY: 72 } },
    catalog: { minecraftVersion: "1.21.11" }, assets: { unsupportedBlocks: [] },
    loadedChunks: new Map(), pendingChunks, decodeRequests, chunkControllers: new Set(), terrainWarnings: new Map(),
    viewport: { dataset: {} }, relativeUrl: value => value, notice() {},
    decoder: { postMessage() { markDecodeStarted(); } },
    terrain: { addColumn(...args) { added.push(args); }, removeColumn() {} },
    refreshCatalog: async () => {}, updateActors() {}, connection() {}, message() {},
    $: () => ({ textContent: "" }), resets: 0,
    clearWorld() { scope.resets++; scope.loadedChunks.clear(); pendingChunks.clear(); }
  });
  vm.runInContext(boundary + "\nmodule.exports = { fetchChunk, receiveFrame };", scope);
  return { scope, ...scope.module.exports, added, decodeRequests, pendingChunks, decodeStarted };
}
const descriptor = { x: 0, z: 0, revision: "1", url: "chunk.json" };
const chunk = { minY: 56, height: 16, palette: ["minecraft:stone"] };

test("repeated initial reset frame is idempotent while new reset and epoch clear once", async () => {
  const viewer = harness(async () => chunk);
  const frame = { sceneId: "village", epoch: "epoch-a", seq: 7, reset: true, loadedChunks: 0, totalChunks: 0, entities: [], chunks: [] };
  await viewer.receiveFrame(frame, 1);
  await viewer.receiveFrame(frame, 1);
  assert.equal(viewer.scope.resets, 0);
  await viewer.receiveFrame({ ...frame, seq: 8 }, 1);
  await viewer.receiveFrame({ ...frame, seq: 8 }, 1);
  assert.equal(viewer.scope.resets, 1);
  await viewer.receiveFrame({ ...frame, epoch: "epoch-b", seq: 8 }, 1);
  await viewer.receiveFrame({ ...frame, epoch: "epoch-b", seq: 8 }, 1);
  assert.equal(viewer.scope.resets, 2);
});

test("late old-epoch HTTP cannot decode or erase a replacement pending chunk", async () => {
  let finishHttp;
  const viewer = harness(() => new Promise(resolve => { finishHttp = resolve; }));
  const request = viewer.fetchChunk(descriptor, 1);
  viewer.scope.epoch = "epoch-b";
  viewer.pendingChunks.set("0,0", "1");
  finishHttp(chunk);
  await request;
  assert.equal(viewer.decodeRequests.size, 0);
  assert.equal(viewer.added.length, 0);
  assert.equal(viewer.pendingChunks.get("0,0"), "1");
});

test("late old-epoch decode cannot add terrain or erase a replacement pending chunk", async () => {
  const viewer = harness(async () => chunk);
  const request = viewer.fetchChunk(descriptor, 1);
  await viewer.decodeStarted;
  const pending = [...viewer.decodeRequests.values()][0];
  assert.ok(pending, "The request must reach the asynchronous decode boundary");
  viewer.scope.epoch = "epoch-b";
  viewer.pendingChunks.set("0,0", "1");
  pending.resolve("old-epoch-decoded-chunk");
  await request;
  assert.equal(viewer.added.length, 0);
  assert.equal(viewer.pendingChunks.get("0,0"), "1");
});
