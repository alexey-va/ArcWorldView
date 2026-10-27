"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const THREE = require("three");
const { cameraView, cameraBounds, chunkPriority, actorPriority, frameConnection } = require("../src/view-priority.cjs");
const bounds = { minX: -256, maxX: 256, minY: 0, maxY: 128, minZ: -256, maxZ: 256 };
function camera() {
  const value = new THREE.OrthographicCamera(-24, 24, 20, -20, .1, 1000);
  value.position.set(0, 180, 100); value.lookAt(0, 64, 0); value.updateProjectionMatrix(); value.updateMatrixWorld(); return value;
}

test("upstream view encloses the complete height-window rays with outward context and scene clamp", () => {
  const viewCamera = camera(), region = cameraBounds(viewCamera, bounds);
  assert.ok(region.maxX - region.minX < 128, "A zoomed camera must not request the whole region");
  const direction = viewCamera.getWorldDirection(new THREE.Vector3());
  for (const x of [-1,1]) for (const y of [-1,1]) for (const height of [bounds.minY, bounds.maxY]) {
    const origin = new THREE.Vector3(x,y,-1).unproject(viewCamera);
    const point = origin.clone().addScaledVector(direction, (height - origin.y) / direction.y);
    assert.ok(region.minX <= point.x - 15.99 && region.maxX >= point.x + 15.99);
    assert.ok(region.minZ <= point.z - 15.99 && region.maxZ >= point.z + 15.99);
  }
  viewCamera.position.x += 2000; viewCamera.updateMatrixWorld();
  const outside = cameraBounds(viewCamera, bounds);
  assert.ok(outside.minX >= bounds.minX && outside.maxX <= bounds.maxX && outside.maxX > outside.minX);
});

test("chunk priority starts near the camera, retains joins, and skips distant invisible work", () => {
  const view = cameraView(camera(), new THREE.Vector3(0,64,0), bounds);
  assert.ok(chunkPriority({ x: 0, z: 0 }, view) < chunkPriority({ x: 1, z: 0 }, view));
  assert.ok(Number.isFinite(chunkPriority({ x: 2, z: 0 }, view)), "One neighbouring chunk stays in the context ring");
  assert.equal(chunkPriority({ x: 14, z: 14 }, view), Infinity);
  assert.equal(actorPriority({ kind: "mob", position: [230,64,230], scale: 1 }, view), Infinity);
  assert.ok(Number.isFinite(actorPriority({ kind: "display", position: [230,64,230], scale: 1 }, view)), "Unknown-sized IA content is culled using actual geometry, not a guessed origin box");
});

test("successful unchanged frames preserve transport heartbeat and distinguish delayed data", () => {
  assert.equal(frameConnection(10000, 9900, 1000, 19500, 20000).state, "live");
  const old = frameConnection(10000, 9900, 1000, 10000, 20000);
  assert.equal(old.state, "delayed"); assert.notEqual(old.text, "Связь прервалась");
  assert.equal(frameConnection(10000, 6000, 6000, 19500, 20000).state, "stale");
  assert.equal(frameConnection(10000, 9900, 9900, 19500, 20000, { frozen: true }).text, "Показываем последний кадр");
});
