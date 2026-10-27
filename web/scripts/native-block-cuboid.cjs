"use strict";

// ModelPart.Cube/Polygon in the pinned 1.21.11 client. Preserve the UV at each
// vertex when a block-entity renderer rotates its parts into block coordinates.
// Entity UVs cannot be assigned by the destination face name alone.
function nativeBlockCuboid(from, size, uv, transform = (point) => point) {
  const [x, y, z] = size, [u, v] = uv;
  const vertices = Array.from({ length: 8 }, (_, i) => transform(from.map((n, axis) => n + ((i >> axis) & 1) * size[axis])));
  const low = [0, 1, 2].map((axis) => Math.min(...vertices.map((point) => point[axis])));
  const high = [0, 1, 2].map((axis) => Math.max(...vertices.map((point) => point[axis])));
  const polygons = [
    [[5, 4, 0, 1], [u + z, v, u + z + x, v + z]],
    [[3, 2, 6, 7], [u + z + x, v + z, u + z + x * 2, v]],
    [[0, 4, 6, 2], [u, v + z, u + z, v + z + y]],
    [[1, 0, 2, 3], [u + z, v + z, u + z + x, v + z + y]],
    [[5, 1, 3, 7], [u + z + x, v + z, u + z * 2 + x, v + z + y]],
    [[4, 5, 7, 6], [u + z * 2 + x, v + z, u + z * 2 + x * 2, v + z + y]]
  ];
  const faces = {};
  for (const [indices, [u0, v0, u1, v1]] of polygons) {
    const points = indices.map((index) => vertices[index]);
    const axis = [0, 1, 2].find((a) => points.every((point) => Math.abs(point[a] - points[0][a]) < 1e-8));
    const face = [["west", "east"], ["down", "up"], ["north", "south"]][axis][Math.abs(points[0][axis] - low[axis]) < 1e-8 ? 0 : 1];
    const pixels = [[u1, v0], [u0, v0], [u0, v1], [u1, v1]];
    const mapped = points.map((point, index) => {
      const [a, b, c] = point.map((n, i) => (n - low[i]) / (high[i] - low[i]));
      const [s, t] = { west: [c, 1 - b], east: [1 - c, 1 - b], north: [1 - a, 1 - b], south: [a, 1 - b], up: [a, c], down: [1 - a, c] }[face];
      return { s: Math.round(s), t: Math.round(t), pixel: pixels[index] };
    });
    faces[face] = [[0, 0], [1, 0], [0, 1]].map(([s, t]) => mapped.find((point) => point.s === s && point.t === t).pixel);
  }
  return { from: low, to: high, faces };
}

module.exports = { nativeBlockCuboid };
