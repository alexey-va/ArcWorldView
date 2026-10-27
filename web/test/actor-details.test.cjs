"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../src/app.cjs"), "utf8");
const boundary = source.slice(source.indexOf("function stopActorDetails("), source.indexOf("function applyActorPose("));
function harness(json) {
  const timers = new Map(), elements = new Map(); let timer = 0;
  const scope = vm.createContext({
    module: { exports: {} }, URL, AbortController, document: { hidden: false },
    baseUrl: new URL("https://example.test/worldview/"), json,
    detailToken: 1, generation: 2, pinnedActor: "npc:a", detailData: null,
    detailController: null, detailTimer: null,
    setTimeout(fn, delay) { const id = ++timer; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    $(id) { if (!elements.has(id)) elements.set(id, { hidden: true, textContent: "" }); return elements.get(id); },
    showActor() {}
  });
  vm.runInContext(boundary + "\nmodule.exports={loadActorDetails,stopActorDetails};", scope);
  return { ...scope.module.exports, scope, timers, elements };
}

test("selected details refresh no faster than one second and encode the passive route", async () => {
  let requested;
  const viewer = harness(async url => { requested = String(url); return { id: "npc:a", title: "Житель", fields: [] }; });
  await viewer.loadActorDetails(1, 2, "civs:one", "npc:a", 0);
  assert.match(requested, /scenes\/civs%3Aone\/entities\/npc%3Aa$/);
  assert.equal(viewer.timers.size, 1);
  assert.equal([...viewer.timers.values()][0].delay, 1000);
  assert.deepEqual(viewer.scope.detailData.fields, []);
  viewer.stopActorDetails(); assert.equal(viewer.timers.size, 0);
});

test("warmup retries are bounded and a missing actor stops refresh with an honest state", async () => {
  const viewer = harness(async () => { throw Object.assign(Error("warming"), { status: 425 }); });
  for (let attempt = 0; attempt < 4; attempt++) {
    viewer.timers.clear(); await viewer.loadActorDetails(1, 2, "village", "npc:a", attempt);
    assert.equal(viewer.timers.size, attempt < 3 ? 1 : 0);
  }
  assert.equal(viewer.elements.get("actor-retry").hidden, false);
  const missing = harness(async () => { throw Object.assign(Error("left"), { status: 404 }); });
  await missing.loadActorDetails(1, 2, "village", "npc:a", 0);
  assert.equal(missing.timers.size, 0);
  assert.match(missing.elements.get("actor-detail-state").textContent, /Больше не находится/);
});

test("hidden views do not fetch details and obsolete selection responses cannot replace the card", async () => {
  let calls = 0, resolve;
  const viewer = harness(() => { calls++; return new Promise(done => { resolve = done; }); });
  viewer.scope.document.hidden = true;
  await viewer.loadActorDetails(1, 2, "village", "npc:a", 0);
  assert.equal(calls, 0); viewer.timers.clear(); viewer.scope.document.hidden = false;
  const pending = viewer.loadActorDetails(1, 2, "village", "npc:a", 0);
  viewer.stopActorDetails(); viewer.scope.pinnedActor = "npc:b";
  resolve({ id: "npc:a", title: "Old", fields: [] }); await pending;
  assert.equal(viewer.scope.detailData, null); assert.equal(viewer.timers.size, 0);
});
