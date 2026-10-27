"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { browserNbtSource } = require("../scripts/browser-nbt.cjs");

function context() {
  const messages = [], intervals = [];
  const scope = vm.createContext({
    TextEncoder, TextDecoder, performance,
    console: { log() {}, warn() {}, error() {} },
    postMessage(value) { messages.push(value); },
    setInterval(callback) { intervals.push(callback); }, clearInterval() {},
    setTimeout, clearTimeout
  }, { codeGeneration: { strings: false, wasm: false } });
  scope.self = scope;
  return { scope, messages, intervals };
}

function loadWorker(name) {
  const file = path.resolve(__dirname, "../dist", name);
  assert.ok(fs.existsSync(file), "Run npm run build before npm test");
  const result = context();
  vm.runInContext(fs.readFileSync(file, "utf8"), result.scope, { filename: name, displayErrors: false });
  return result;
}

test("browser NBT preserves pinned pure JSON helpers and rejects binary codecs", () => {
  const original = require("prismarine-nbt");
  const { scope } = context();
  scope.module = { exports: {} };
  vm.runInContext(browserNbtSource(), scope, { displayErrors: false });
  const browser = scope.module.exports;
  const tree = original.comp({ name: original.string("village"), values: original.list(original.int([1, 7, 12])), nested: original.comp({ yes: original.byte(1) }) });
  assert.equal(JSON.stringify(browser.simplify(tree)), JSON.stringify(original.simplify(tree)));
  assert.equal(JSON.stringify(browser.comp({ item: browser.string("oak_sign") })), JSON.stringify(original.comp({ item: original.string("oak_sign") })));
  assert.equal(browser.equal(tree, structuredClone(tree)), original.equal(tree, structuredClone(tree)));
  assert.equal(browser.equal(original.int(1), original.int(2)), false);
  assert.throws(() => browser.parseUncompressed(new Uint8Array()), /Binary NBT is unsupported/);
  assert.throws(() => browser.writeUncompressed(tree), /Binary NBT is unsupported/);
});

test("built decode and terrain workers render JSON/RLE without string code generation", () => {
  const decoder = loadWorker("decode-worker.js");
  const faces = Object.fromEntries(["north", "south", "west", "east", "up", "down"].map(face => [face, { cullface: face, texture: { u: 0, v: 0, su: 1, sv: 1 } }]));
  const blockStates = { stone: { variants: { "": { model: { ao: false, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces }] } } } }, air: { variants: { "": { model: { elements: [] } } } } };
  const source = { x: 0, z: 0, minY: 56, height: 16, palette: ["minecraft:air", "minecraft:stone"], runs: [1, 1, 4095, 0] };
  decoder.scope.onmessage({ data: { id: 1, chunk: source, version: "1.21.11" } });
  const decoded = decoder.messages.find(message => message.id === 1);
  assert.equal(decoded?.error, undefined);
  assert.equal(typeof decoded?.result, "string");
  assert.equal(JSON.parse(decoded.result).minY, 0);
  decoder.scope.onmessage({ data: { type: "models", blockStates } });
  decoder.scope.onmessage({ data: { type: "block", id: 2, blockData: "minecraft:stone", version: "1.21.11" } });
  const display = decoder.messages.find(message => message.id === 2);
  assert.equal(display?.error, undefined);
  assert.ok(display.result.positions.length > 0);

  const worker = loadWorker("worker.js");
  for (const data of [
    { type: "version", version: "1.21.11" },
    { type: "blockStates", json: blockStates },
    { type: "chunk", x: 0, z: 0, chunk: decoded.result },
    { type: "dirty", x: 0, y: 0, z: 0, value: true }
  ]) worker.scope.onmessage({ data });
  for (const interval of worker.intervals) interval();
  const geometry = worker.messages.find(message => message.type === "geometry");
  assert.ok(geometry?.geometry.positions.length > 0, "Stock terrain mesher must emit geometry under the CSP boundary");
  assert.ok(worker.messages.some(message => message.type === "sectionFinished"));

  assert.equal(geometry.worldViewGeneration,0);
  worker.messages.length = 0;
  // A new epoch reuses the same grid coordinates. Results must be labelled at
  // their worker origin and the previous world's column must not survive.
  worker.scope.onmessage({ data:{ type:"chunk", x:16, z:0, chunk:decoded.result, worldViewGeneration:1 } });
  for (const x of [0,16]) worker.scope.onmessage({ data:{ type:"dirty", x, y:0, z:0, value:true, worldViewGeneration:1 } });
  for (const interval of worker.intervals) interval();
  assert.ok(worker.messages.every(message=>message.worldViewGeneration===1));
  assert.ok(!worker.messages.some(message=>message.type==="geometry"&&message.key==="0,0,0"),"old columns are cleared before accepting the new epoch");
  assert.ok(worker.messages.some(message=>message.type==="geometry"&&message.key==="16,0,0"));
});
