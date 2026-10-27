"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Run the actual location-control handler. A user scene switch must retire the
// document's renderer/workers, even while the old scene still has pending work.
const app = fs.readFileSync(path.join(__dirname, "../src/app.cjs"), "utf8");
const start = app.indexOf("function navigateScene(");
const navigation = start < 0 ? "" : app.slice(start, app.indexOf("function selectScene(", start));
const handler = app.split("\n").find(line => line.startsWith('sceneSelect.addEventListener("change"'));

function control(href, current = "auto") {
  const assigned = [], listeners = new Map();
  const sceneSelect = { value: current, addEventListener: (event, callback) => listeners.set(event, callback) };
  const location = { href, assign: value => assigned.push(value) };
  const window = { location };
  for (const boundary of ["parent", "top"]) Object.defineProperty(window, boundary, { get() { throw Error("Must not navigate the containing website"); } });
  const scope = vm.createContext({
    URL, window, sceneSelect,
    catalog: { scenes: [{ id: "auto" }, { id: "spawn" }, { id: "civs:other-village" }] },
    selectedScene: { id: current },
    selectScene() { throw Error("Must not reuse the old renderer/worker document"); }
  });
  vm.runInContext(navigation + "\n" + handler, scope);
  return { assigned, change(id) { sceneSelect.value = id; listeners.get("change")(); } };
}

test("Auto to spawn uses document navigation instead of the stalled renderer reset path", () => {
  const viewer = control("https://rus-crafting.ru/worldview/?scene=auto");
  viewer.change("spawn");
  assert.deepEqual(viewer.assigned, ["https://rus-crafting.ru/worldview/?scene=spawn"]);
});

test("scene navigation stays inside the viewer iframe and preserves its path/query/hash", () => {
  const viewer = control("http://127.0.0.1:3094/worldview/?scene=spawn&fixture=1#view", "spawn");
  viewer.change("civs:other-village");
  assert.deepEqual(viewer.assigned, ["http://127.0.0.1:3094/worldview/?scene=civs%3Aother-village&fixture=1#view"]);
});

test("unchanged or unavailable scenes do not reload the viewer", () => {
  const viewer = control("https://rus-crafting.ru/worldview/?scene=auto");
  for (const id of ["auto", "", "unknown", "https://elsewhere.invalid/"]) viewer.change(id);
  assert.deepEqual(viewer.assigned, []);
});
