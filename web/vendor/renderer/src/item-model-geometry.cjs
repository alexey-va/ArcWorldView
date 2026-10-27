"use strict";

const FACE_VERTICES = Object.freeze({
  down: ([x0, y0, z0], [x1, _y1, z1]) => [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]],
  up: ([x0, _y0, z0], [x1, y1, z1]) => [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]],
  north: ([x0, y0, z0], [x1, y1]) => [[x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [x1, y0, z0]],
  south: ([x0, y0, _z0], [x1, y1, z1]) => [[x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1]],
  west: ([x0, y0, z0], [_x1, y1, z1]) => [[x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0]],
  east: ([_x0, y0, z0], [x1, y1, z1]) => [[x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1]],
});

function vector3(value) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const result = value.map(Number);
  return result.every(Number.isFinite) ? result : null;
}

function defaultFaceUv(from, to, face) {
  const [x0, y0, z0] = from;
  const [x1, y1, z1] = to;
  return ({
    down: [x0, 16 - z1, x1, 16 - z0],
    up: [x0, z0, x1, z1],
    north: [16 - x1, 16 - y1, 16 - x0, 16 - y0],
    south: [x0, 16 - y1, x1, 16 - y0],
    west: [z0, 16 - y1, z1, 16 - y0],
    east: [16 - z1, 16 - y1, 16 - z0, 16 - y0],
  })[face];
}

function normalizedFaceUv(raw, rotation = 0) {
  const uv = Array.isArray(raw) ? raw.map(Number) : null;
  const angle = Number(rotation ?? 0);
  if (!uv || uv.length !== 4 || !uv.every(Number.isFinite) || ![0, 90, 180, 270].includes(angle)) return null;
  const [u1, v1, u2, v2] = uv;
  const corners = [
    [u1 / 16, 1 - v1 / 16],
    [u2 / 16, 1 - v1 / 16],
    [u2 / 16, 1 - v2 / 16],
    [u1 / 16, 1 - v2 / 16],
  ];
  const steps = angle / 90;
  return steps ? corners.slice(-steps).concat(corners.slice(0, -steps)) : corners;
}

function rotateAxis(point, axis, degrees) {
  const angle = Number(degrees) * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const [x, y, z] = point;
  if (axis === "x") return [x, y * cosine - z * sine, y * sine + z * cosine];
  if (axis === "y") return [x * cosine + z * sine, y, -x * sine + z * cosine];
  if (axis === "z") return [x * cosine - y * sine, x * sine + y * cosine, z];
  return point.slice();
}

function elementPoint(point, rotation) {
  if (!rotation) return point.slice();
  const origin = vector3(rotation.origin ?? [8, 8, 8]);
  const axis = String(rotation.axis ?? "").toLowerCase();
  const angle = Number(rotation.angle ?? 0);
  if (!origin || !["x", "y", "z"].includes(axis) || !Number.isFinite(angle) || Math.abs(angle) > 45) return point.slice();
  const local = point.map((value, index) => value - origin[index]);
  if (rotation.rescale && Math.abs(angle) > 1e-12) {
    const factor = 1 / Math.abs(Math.cos(angle * Math.PI / 180));
    for (const [index, name] of ["x", "y", "z"].entries()) {
      if (name !== axis) local[index] *= factor;
    }
  }
  return rotateAxis(local, axis, angle).map((value, index) => value + origin[index]);
}

function itemContextPoint(point, model, mode) {
  const normalizedMode = ["ground", "fixed", "head", "gui", "thirdperson_lefthand", "thirdperson_righthand", "firstperson_lefthand", "firstperson_righthand"].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase()
    : "none";
  const transform = model?.display?.[normalizedMode] ?? {};
  const scale = vector3(transform.scale) ?? [1, 1, 1];
  const rotation = vector3(transform.rotation) ?? [0, 0, 0];
  const translation = vector3(transform.translation) ?? [0, 0, 0];
  let result = point.map((value, index) => value * scale[index]);
  result = rotateAxis(result, "x", rotation[0]);
  result = rotateAxis(result, "y", rotation[1]);
  result = rotateAxis(result, "z", rotation[2]);
  return result.map((value, index) => value + translation[index] / 16);
}

function textureUrl(model, reference) {
  let current = String(reference ?? "");
  const visited = new Set();
  while (current.startsWith("#")) {
    const key = current.slice(1);
    if (!key || visited.has(key)) return null;
    visited.add(key);
    current = String(model?.textures?.[key] ?? "");
  }
  return current || null;
}

function nonDegenerate(positions) {
  const a = positions[1].map((value, index) => value - positions[0][index]);
  const b = positions[2].map((value, index) => value - positions[0][index]);
  const cross = [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  return cross.reduce((total, value) => total + value * value, 0) > 1e-18;
}

function itemModelFaces(model, mode = "none", { origin = "center" } = {}) {
  const result = [];
  const coordinateOffset = origin === "corner" ? 0 : 8;
  const elements = Array.isArray(model?.elements) ? model.elements.slice(0, 512) : [];
  for (const [elementIndex, element] of elements.entries()) {
    const from = vector3(element?.from);
    const to = vector3(element?.to);
    if (!from || !to || !element?.faces || typeof element.faces !== "object") continue;
    for (const [face, definition] of Object.entries(element.faces)) {
      const buildVertices = FACE_VERTICES[face];
      if (!buildVertices || !definition || typeof definition !== "object") continue;
      const resolvedTexture = textureUrl(model, definition.texture);
      const uvs = normalizedFaceUv(definition.uv ?? defaultFaceUv(from, to, face), definition.rotation);
      if (!resolvedTexture || !uvs) continue;
      const positions = buildVertices(from, to)
        .map((point) => elementPoint(point, element.rotation))
        .map((point) => point.map((value) => (value - coordinateOffset) / 16))
        .map((point) => itemContextPoint(point, model, mode));
      if (!nonDegenerate(positions)) continue;
      result.push({ elementIndex, face, texture: resolvedTexture, positions, uvs });
    }
  }
  return result;
}

module.exports = {
  defaultFaceUv,
  itemModelFaces,
  normalizedFaceUv,
};
