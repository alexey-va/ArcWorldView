"use strict";

const THREE = require("three");
const MAX_SPRITE_PIXELS = 512 * 512;
const MAX_EDGE_FACES = 16384;

// Recognize only the exact builtin/generated sentinel emitted by the pinned
// source. Explicit IA geometry, including ordinary thin planes, stays intact.
function isGeneratedItemFallback(model) {
  if (model.elements?.length !== 1 || !model.textures?.layer0) return false;
  const element = model.elements[0];
  return JSON.stringify(element.from) === "[0,0,8]" && JSON.stringify(element.to) === "[16,16,8.01]" &&
    Object.keys(element).sort().join() === "faces,from,to" && Object.keys(element.faces ?? {}).sort().join() === "north,south" &&
    ["north", "south"].every(face => Object.keys(element.faces[face]).join() === "texture" && element.faces[face].texture === "#layer0");
}

function validateSpriteSize(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > MAX_SPRITE_PIXELS) throw Error("Generated item sprite exceeds the supported geometry budget");
}

// ItemModelGenerator (hqj), Java 1.21.11: z=7.5..8.5, opposite north UV,
// and one side quad at each opaque/transparent pixel transition. Keep HD texels.
function generatedItemFaces(pixels, width, height, texture) {
  validateSpriteSize(width, height);
  if (pixels.length !== width * height * 4) throw Error("Invalid generated item pixels");
  const lo = -1 / 32, hi = 1 / 32;
  const faces = [
    { texture, positions: [[-.5,.5,hi],[.5,.5,hi],[.5,-.5,hi],[-.5,-.5,hi]], uvs: [[0,1],[1,1],[1,0],[0,0]] },
    { texture, positions: [[.5,.5,lo],[-.5,.5,lo],[-.5,-.5,lo],[.5,-.5,lo]], uvs: [[1,1],[0,1],[0,0],[1,0]] }
  ];
  const opaque = (x, y) => x >= 0 && x < width && y >= 0 && y < height && pixels[(y * width + x) * 4 + 3] > 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!opaque(x, y)) continue;
    const left = x / width - .5, right = (x + 1) / width - .5, top = .5 - y / height, bottom = .5 - (y + 1) / height;
    // Native UV_SHRINK=0.1 pixel keeps each edge inside its opaque texel.
    const u0 = (x + .1) / width, u1 = (x + .9) / width, v0 = 1 - (y + .1) / height, v1 = 1 - (y + .9) / height;
    const add = positions => {
      if (faces.length - 2 >= MAX_EDGE_FACES) throw Error("Generated item silhouette exceeds the supported geometry budget");
      faces.push({ texture, positions, uvs: [[u0,v0],[u1,v0],[u1,v1],[u0,v1]] });
    };
    if (!opaque(x, y - 1)) add([[left,top,lo],[right,top,lo],[right,top,hi],[left,top,hi]]);
    if (!opaque(x, y + 1)) add([[right,bottom,lo],[left,bottom,lo],[left,bottom,hi],[right,bottom,hi]]);
    if (!opaque(x - 1, y)) add([[left,top,lo],[left,top,hi],[left,bottom,hi],[left,bottom,lo]]);
    if (!opaque(x + 1, y)) add([[right,top,hi],[right,top,lo],[right,bottom,lo],[right,bottom,hi]]);
  }
  return faces;
}

function nativeItemContextMatrix(model, mode) {
  const left = mode === "thirdperson_lefthand" || mode === "firstperson_lefthand";
  const transform = model.display?.[mode] ?? (left ? model.display?.[mode.replace("lefthand", "righthand")] : null) ?? {};
  const rotation = transform.rotation ?? [0, 0, 0], translation = transform.translation ?? [0, 0, 0], scale = transform.scale ?? [1, 1, 1];
  // ItemTransform.apply: T * Quaternion.rotationXYZ * S, with the native
  // left-hand X-translation / Y,Z-rotation signs. Inputs are already centred.
  const euler = new THREE.Euler(...rotation.map((value, axis) => THREE.MathUtils.degToRad(value * (left && axis > 0 ? -1 : 1))), "XYZ");
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...translation.map((value, axis) => value / 16 * (left && axis === 0 ? -1 : 1))),
    new THREE.Quaternion().setFromEuler(euler), new THREE.Vector3(...scale)
  );
}

function applyNativeItemContext(faces, model, mode) {
  const matrix = nativeItemContextMatrix(model, mode);
  return faces.map(face => ({ ...face, positions: face.positions.map(point => new THREE.Vector3(...point).applyMatrix4(matrix).toArray()) }));
}

function nativeHandGripMatrix(slot, slim = false) {
  const side = slot === "OFF_HAND" ? -1 : 1;
  // ItemInHandLayer: arm * Rx(-90) * Ry(180) * T(side/16,1/8,-5/8).
  // Convert the Java downward arm frame to this skeleton's upward pixel frame.
  const matrix = new THREE.Matrix4().makeScale(16, -16, 16)
    .multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2))
    .multiply(new THREE.Matrix4().makeRotationY(Math.PI))
    .multiply(new THREE.Matrix4().makeTranslation(side / 16, .125, -.625));
  if (slim) matrix.elements[12] += side * .5; // PlayerModel.translateToHand.
  return matrix;
}

function playerHandBone(slot) {
  // The pinned Bedrock mesh faces -Z; its named leftArm is physically right.
  // Keep skin/mesh data intact and translate wire handedness at this boundary.
  return slot === "OFF_HAND" ? "rightarm" : "leftarm";
}

function playerHandGripMatrix(slot, slim = false) {
  // LivingEntityRenderer's native X reflection is absent from the stock mesh
  // frame. Restore it for the attached item, alongside the physical arm map.
  return new THREE.Matrix4().makeScale(-1, 1, 1).multiply(nativeHandGripMatrix(slot, slim));
}

function heldItemArmRotation(rotation) {
  // HumanoidModel's ITEM pose, converted from native downward Y.
  return { ...rotation, x: rotation.x * .5 + Math.PI / 10, y: 0 };
}

module.exports = { isGeneratedItemFallback, validateSpriteSize, generatedItemFaces, nativeItemContextMatrix, applyNativeItemContext, nativeHandGripMatrix, playerHandBone, playerHandGripMatrix, heldItemArmRotation };
