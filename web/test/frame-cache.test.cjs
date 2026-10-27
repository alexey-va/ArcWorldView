"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { frameConnection, chunkInBounds } = require("../src/view-priority.cjs");

// Exercise the actual async request/decode/queue boundary without booting WebGL.
const app = fs.readFileSync(path.join(__dirname, "../src/app.cjs"), "utf8");
const boundary = app.slice(app.indexOf("function pumpChunks("), app.indexOf("async function poll("));
const descriptor = { x: 0, z: 0, revision: "1", url: "chunk.json" };
const chunk = { minY: 56, height: 16, palette: ["minecraft:stone"] };
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(json) {
  const added = [], removed = [], decodeRequests = new Map(), pendingChunks = new Map();
  let markDecodeStarted;
  const decodeStarted = new Promise(resolve => { markDecodeStarted = resolve; });
  const scope = vm.createContext({
    module: { exports: {} }, json, AbortController, setTimeout, clearTimeout,
    performance, generation: 1, epoch: "epoch-a", sequence: 7,
    lastFrameAt: 0, lastTransportAt: 0, capturedAt: null, lastAcceptedView: null,
    liveFramesSeen: false, sourceState: {}, bootstrapController: null,
    loadedCount: 0, totalCount: 0, chunkRequestId: 0, workerFailed: false, hasGeometry: false,
    document: { hidden: false }, camera: {}, controls: { target: {} }, currentView: null,
    cameraView: () => ({}), chunkPriority: chunk => chunk.priority ?? 0, frameConnection, chunkInBounds,
    selectedScene: { id: "village", bounds: { minX: 0, maxX: 192, minZ: 0, maxZ: 16, minY: 56, maxY: 72 } },
    catalog: { minecraftVersion: "1.21.11" }, assets: { unsupportedBlocks: [] },
    loadedChunks: new Map(), pendingChunks, decodeRequests, terrainWarnings: new Map(),
    chunkDescriptors: new Map([["0,0", descriptor]]), chunkRetries: new Map(),
    viewport: { dataset: {} }, relativeUrl: value => value, notice() {}, updateModelNotice() {},
    decoder: { postMessage() { markDecodeStarted(); } },
    atmosphere: { setChunk() {}, removeChunk() {} },
    terrain: { addColumn(...args) { added.push(args); }, removeColumn(...args) { removed.push(args); } },
    refreshCatalog: async () => {}, actorUpdates: 0, updateActors() { scope.actorUpdates++; }, connection() {}, message() {},
    $: () => ({ textContent: "" }), resets: 0,
    clearWorld() { scope.resets++; scope.loadedChunks.clear(); pendingChunks.clear(); scope.chunkDescriptors.clear(); }
  });
  vm.runInContext(boundary + "\nmodule.exports = { fetchChunk, receiveFrame, pumpChunks };", scope);
  return { scope, ...scope.module.exports, added, removed, decodeRequests, pendingChunks, decodeStarted };
}
const baseFrame = { sceneId: "village", epoch: "epoch-a", seq: 7, reset: false, loadedChunks: 0, totalChunks: 0, entities: [], chunks: [], removedChunks: [] };

test("repeated initial reset frame is idempotent while new reset and epoch clear once", async () => {
  const viewer = harness(async () => chunk), frame = { ...baseFrame, reset: true };
  await viewer.receiveFrame(frame, 1); await viewer.receiveFrame(frame, 1);
  assert.equal(viewer.scope.resets, 0);
  await viewer.receiveFrame({ ...frame, seq: 8 }, 1); await viewer.receiveFrame({ ...frame, seq: 8 }, 1);
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
  const replacement = { revision: "1", controller: new AbortController() };
  viewer.pendingChunks.set("0,0", replacement);
  finishHttp(chunk); await request;
  assert.equal(viewer.decodeRequests.size, 0); assert.equal(viewer.added.length, 0);
  assert.equal(viewer.pendingChunks.get("0,0"), replacement);
});

test("late old-epoch decode cannot add terrain or erase a replacement pending chunk", async () => {
  const viewer = harness(async () => chunk);
  const request = viewer.fetchChunk(descriptor, 1);
  await viewer.decodeStarted;
  const pending = [...viewer.decodeRequests.values()][0];
  viewer.scope.epoch = "epoch-b";
  const replacement = { revision: "1", controller: new AbortController() };
  viewer.pendingChunks.set("0,0", replacement);
  pending.resolve("old-epoch-decoded-chunk"); await request;
  assert.equal(viewer.added.length, 0); assert.equal(viewer.pendingChunks.get("0,0"), replacement);
});

test("two chunk jobs refill immediately in camera priority order without another frame", async () => {
  const requests = [], viewer = harness(async (url, signal, cache) => {
    requests.push(url); assert.equal(cache, "default"); return chunk;
  });
  viewer.scope.chunkDescriptors = new Map([
    ["0,0", { ...descriptor, priority: 20 }],
    ["1,0", { ...descriptor, x: 1, url: "near.json", priority: 1 }],
    ["2,0", { ...descriptor, x: 2, url: "middle.json", priority: 10 }]
  ]);
  viewer.pumpChunks(); await flush();
  assert.deepEqual(requests, ["near.json", "middle.json"]);
  assert.equal(viewer.pendingChunks.size, 2);
  [...viewer.decodeRequests.values()][0].resolve("decoded"); await flush();
  assert.deepEqual(requests, ["near.json", "middle.json", "chunk.json"]);
  assert.equal(viewer.pendingChunks.size, 2);
  viewer.scope.workerFailed = true;
  for (const pending of viewer.decodeRequests.values()) pending.resolve("decoded");
  await flush();
  assert.equal(viewer.pendingChunks.size, 0);
});

test("same-sequence viewport responses update actors while off-view terrain remains cached", async () => {
  const viewer = harness(async () => chunk);
  viewer.scope.loadedChunks.set("0,0", "1"); viewer.scope.loadedChunks.set("10,0", "1");
  await viewer.receiveFrame({ ...baseFrame, view: { minX: 0, minZ: 0, maxX: 16, maxZ: 16 } }, 1);
  assert.equal(viewer.scope.loadedChunks.has("0,0"), false);
  assert.equal(viewer.scope.loadedChunks.has("10,0"), true);
  await viewer.receiveFrame({ ...baseFrame, view: { minX: 16, minZ: 0, maxX: 32, maxZ: 16 } }, 1);
  assert.equal(viewer.scope.actorUpdates, 2);
  await viewer.receiveFrame({ ...baseFrame, view: { minX: 16, minZ: 0, maxX: 32, maxZ: 16 }, removedChunks: [{ x: 10, z: 0 }] }, 1);
  assert.equal(viewer.scope.loadedChunks.has("10,0"), false);
});

test("partial terrain coverage retains missing cached chunks but explicit removals and epochs win", async () => {
  const viewer = harness(async () => chunk);
  const partial = { ...baseFrame, terrainComplete: false, view: { minX: 0, minZ: 0, maxX: 16, maxZ: 16 } };
  viewer.scope.loadedChunks.set("0,0", "1");
  await viewer.receiveFrame(partial, 1);
  assert.equal(viewer.scope.loadedChunks.get("0,0"), "1");
  assert.equal(viewer.removed.length, 0);
  await viewer.receiveFrame({ ...partial, removedChunks: [{ x: 0, z: 0 }] }, 1);
  assert.equal(viewer.scope.loadedChunks.has("0,0"), false);
  assert.deepEqual(viewer.removed, [[0,0]]);
  viewer.scope.loadedChunks.set("0,0", "1");
  await viewer.receiveFrame({ ...partial, epoch: "epoch-b" }, 1);
  assert.equal(viewer.scope.loadedChunks.has("0,0"), false);
  assert.equal(viewer.scope.resets, 1);
});

test("an explicit newer all-air chunk replaces cached terrain even with partial coverage", async () => {
  const air = { x: 0, z: 0, minY: 56, height: 16, palette: ["minecraft:air"], runs: [4096,0] };
  const decoded = require("../src/chunk-codec.cjs").decodeChunk(air);
  const viewer = harness(async () => air);
  viewer.scope.loadedChunks.set("0,0", "1");
  await viewer.receiveFrame({ ...baseFrame, seq: 8, terrainComplete: false, chunks: [{ ...descriptor, revision: "2" }] }, 1);
  await viewer.decodeStarted;
  [...viewer.decodeRequests.values()][0].resolve(decoded);
  await flush();
  assert.equal(viewer.scope.loadedChunks.get("0,0"), "2");
  assert.deepEqual(viewer.added, [[0,0,decoded]]);
  assert.equal(viewer.pendingChunks.size, 0);
});
