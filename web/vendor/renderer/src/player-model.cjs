"use strict";

// Shared native player-mesh corrections used by the packet viewer and ArcWorldView.
const viewerEntityModels = require("prismarine-viewer/viewer/lib/entity/entities.json");
const { localBonePivots } = require("./actor-pose.cjs");
const playerBoneDefinitions = viewerEntityModels.player.geometry.default.bones;
const playerBoneNames = playerBoneDefinitions.map((bone) => bone.name);
const playerBoneLocalPivots = localBonePivots(playerBoneDefinitions);

const CUBE_FACES = [
  {
    u0: [0, 0, 1], v0: [0, 0, 0], u1: [1, 0, 1], v1: [0, 0, 1],
    corners: [[0, 1, 1, 0, 0], [1, 1, 1, 1, 0], [0, 1, 0, 0, 1], [1, 1, 0, 1, 1]],
  },
  {
    u0: [1, 0, 1], v0: [0, 0, 0], u1: [2, 0, 1], v1: [0, 0, 1],
    corners: [[1, 0, 1, 0, 0], [0, 0, 1, 1, 0], [1, 0, 0, 0, 1], [0, 0, 0, 1, 1]],
  },
  {
    u0: [0, 0, 0], v0: [0, 0, 1], u1: [0, 0, 1], v1: [0, 1, 1],
    corners: [[1, 1, 1, 0, 0], [1, 0, 1, 0, 1], [1, 1, 0, 1, 0], [1, 0, 0, 1, 1]],
  },
  {
    u0: [1, 0, 1], v0: [0, 0, 1], u1: [1, 0, 2], v1: [0, 1, 1],
    corners: [[0, 1, 0, 0, 0], [0, 0, 0, 0, 1], [0, 1, 1, 1, 0], [0, 0, 1, 1, 1]],
  },
  {
    u0: [0, 0, 1], v0: [0, 0, 1], u1: [1, 0, 1], v1: [0, 1, 1],
    corners: [[1, 0, 0, 0, 1], [0, 0, 0, 1, 1], [1, 1, 0, 0, 0], [0, 1, 0, 1, 0]],
  },
  {
    u0: [1, 0, 2], v0: [0, 0, 1], u1: [2, 0, 2], v1: [0, 1, 1],
    corners: [[0, 0, 1, 0, 1], [1, 0, 1, 1, 1], [0, 1, 1, 0, 0], [1, 1, 1, 1, 0]],
  },
];

function dot(left, right) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cubeVertexData(cube) {
  const positions = [];
  const uvs = [];
  const inflate = cube.inflate ?? 0;
  for (const face of CUBE_FACES) {
    for (const corner of face.corners) {
      positions.push(
        cube.origin[0] + corner[0] * cube.size[0] + (corner[0] ? inflate : -inflate),
        cube.origin[1] + corner[1] * cube.size[1] + (corner[1] ? inflate : -inflate),
        cube.origin[2] + corner[2] * cube.size[2] + (corner[2] ? inflate : -inflate),
      );
      const u = (cube.uv[0] + dot(corner[3] ? face.u1 : face.u0, cube.size)) / 64;
      const v = (cube.uv[1] + dot(corner[4] ? face.v1 : face.v0, cube.size)) / 64;
      uvs.push(u, v);
    }
  }
  return { positions, uvs };
}

function playerBodyMesh(mesh) {
  let body = null;
  mesh.traverse((part) => {
    if (body || !part.isSkinnedMesh) return;
    if (part.skeleton?.bones?.length === playerBoneNames.length) body = part;
  });
  return body;
}

function playerBones(body) {
  return Object.fromEntries(
    playerBoneNames.map((name, index) => [name.toLowerCase(), body.skeleton.bones[index]]),
  );
}

function normalizePlayerSkeleton(body) {
  if (body.userData.playerSkeletonNormalized) return;
  const bones = playerBones(body);
  for (const [name, pivot] of Object.entries(playerBoneLocalPivots)) {
    bones[name]?.position.set(...pivot);
  }
  body.updateMatrixWorld(true);
  body.bind(body.skeleton);
  body.userData.playerSkeletonNormalized = true;
}

function applyPlayerGeometry(body, model) {
  if (body.userData.playerModel === model) return;
  const armWidth = model === "slim" ? 3 : 4;
  const rightOrigin = model === "slim" ? -7 : -8;
  const armCubes = {
    leftArm: { origin: [4, 12, -2], size: [armWidth, 12, 4], uv: [32, 48] },
    leftSleeve: { origin: [4, 12, -2], size: [armWidth, 12, 4], uv: [48, 48], inflate: 0.25 },
    rightArm: { origin: [rightOrigin, 12, -2], size: [armWidth, 12, 4], uv: [40, 16] },
    rightSleeve: { origin: [rightOrigin, 12, -2], size: [armWidth, 12, 4], uv: [40, 32], inflate: 0.25 },
  };
  const positions = body.geometry.attributes.position;
  const uvs = body.geometry.attributes.uv;
  const skinIndices = body.geometry.attributes.skinIndex;
  for (const [boneName, cube] of Object.entries(armCubes)) {
    const boneIndex = playerBoneNames.indexOf(boneName);
    const vertexIndices = [];
    for (let index = 0; index < skinIndices.count; index += 1) {
      if (skinIndices.getX(index) === boneIndex) vertexIndices.push(index);
    }
    const data = cubeVertexData(cube);
    if (vertexIndices.length !== 24) continue;
    for (let offset = 0; offset < vertexIndices.length; offset += 1) {
      const index = vertexIndices[offset];
      positions.setXYZ(
        index,
        data.positions[offset * 3],
        data.positions[offset * 3 + 1],
        data.positions[offset * 3 + 2],
      );
      uvs.setXY(index, data.uvs[offset * 2], data.uvs[offset * 2 + 1]);
    }
  }
  positions.needsUpdate = true;
  uvs.needsUpdate = true;
  body.geometry.computeBoundingBox();
  body.geometry.computeBoundingSphere();
  body.userData.playerModel = model;
}

module.exports = { playerBoneNames, playerBodyMesh, playerBones, normalizePlayerSkeleton, applyPlayerGeometry, cubeVertexData };
