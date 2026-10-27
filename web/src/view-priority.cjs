"use strict";

const THREE = require("three");

function cameraView(camera, target, bounds) {
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  return { frustum, target, bounds };
}

function cameraBounds(camera, bounds) {
  camera.updateMatrixWorld();
  const direction = camera.getWorldDirection(new THREE.Vector3());
  if (Math.abs(direction.y) < 1e-5) return { minX: bounds.minX, minZ: bounds.minZ, maxX: bounds.maxX, maxZ: bounds.maxZ };
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  // Intersect the viewport rays with both ends of the complete advertised
  // height window. A high roof is never discarded based on the ground target.
  for (const x of [-1, 1]) for (const y of [-1, 1]) {
    const origin = new THREE.Vector3(x, y, -1).unproject(camera);
    for (const height of [bounds.minY, bounds.maxY]) {
      const point = origin.clone().addScaledVector(direction, (height - origin.y) / direction.y);
      minX = Math.min(minX, point.x); minZ = Math.min(minZ, point.z);
      maxX = Math.max(maxX, point.x); maxZ = Math.max(maxZ, point.z);
    }
  }
  minX = Math.max(bounds.minX, Math.min(bounds.maxX - 1, Math.floor(minX / 16) * 16 - 16));
  minZ = Math.max(bounds.minZ, Math.min(bounds.maxZ - 1, Math.floor(minZ / 16) * 16 - 16));
  maxX = Math.max(minX + 1, Math.min(bounds.maxX, Math.ceil(maxX / 16) * 16 + 16));
  maxZ = Math.max(minZ + 1, Math.min(bounds.maxZ, Math.ceil(maxZ / 16) * 16 + 16));
  return { minX, minZ, maxX, maxZ };
}

function chunkInBounds(x, z, bounds) {
  return x * 16 < bounds.maxX && (x + 1) * 16 > bounds.minX && z * 16 < bounds.maxZ && (z + 1) * 16 > bounds.minZ;
}

function chunkPriority(chunk, view) {
  const x = chunk.x * 16, z = chunk.z * 16;
  const box = new THREE.Box3(new THREE.Vector3(x, view.bounds.minY, z), new THREE.Vector3(x + 16, view.bounds.maxY, z + 16));
  const visible = view.frustum.intersectsBox(box);
  // Keep one neighbouring chunk for terrain joins, shadows and short pans.
  if (!visible && !view.frustum.intersectsBox(box.expandByScalar(16))) return Infinity;
  return (visible ? 0 : 1e12) + (x + 8 - view.target.x) ** 2 + (z + 8 - view.target.z) ** 2;
}

function actorPriority(record, view) {
  const [x, y, z] = record.position;
  const distance = (x - view.target.x) ** 2 + (z - view.target.z) ** 2;
  // Display geometry can extend far from its origin. Let Three cull its actual
  // meshes, rather than guess the size of an arbitrary resource-pack model.
  if (record.kind === "display") return distance;
  const scale = Number(record.scale) > 0 ? Number(record.scale) : 1;
  const radius = 8 * scale;
  const box = new THREE.Box3(new THREE.Vector3(x - radius, y - radius, z - radius), new THREE.Vector3(x + radius, y + radius * 2, z + radius));
  const visible = view.frustum.intersectsBox(box);
  if (!visible && !view.frustum.intersectsBox(box.expandByScalar(16))) return Infinity;
  return (visible ? 0 : 1e12) + distance;
}

function frameConnection(now, lastTransportAt, lastChangedAt, capturedAt, wallNow = Date.now(), source = {}) {
  if (!lastTransportAt) return { state: "idle", text: "Подключаемся" };
  if (now - lastTransportAt > 3000) return { state: "stale", text: "Связь прервалась" };
  if (source.frozen) return { state: "delayed", text: "Показываем последний кадр" };
  const captured = typeof capturedAt === "number" ? capturedAt : Date.parse(capturedAt);
  const age = Number.isFinite(captured) ? Math.max(0, wallNow - captured) : now - lastChangedAt;
  return source.stale || age > 5000 ? { state: "delayed", text: "Мир обновляется с задержкой" } : { state: "live", text: "В прямом эфире" };
}

module.exports = { cameraView, cameraBounds, chunkInBounds, chunkPriority, actorPriority, frameConnection };
