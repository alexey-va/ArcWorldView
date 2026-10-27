"use strict";

function localBonePivots(modelBones = []) {
  const absolutePivots = new Map(
    modelBones.map((bone) => [bone.name, bone.pivot ?? [0, 0, 0]]),
  );
  return Object.fromEntries(modelBones.map((bone) => {
    const pivot = absolutePivots.get(bone.name);
    const parentPivot = bone.parent ? absolutePivots.get(bone.parent) ?? [0, 0, 0] : [0, 0, 0];
    return [bone.name.toLowerCase(), pivot.map((value, axis) => value - parentPivot[axis])];
  }));
}

function offsetBoneRotation(base, offset) {
  return {
    x: base.x + offset.x,
    y: base.y + offset.y,
    z: base.z + offset.z,
  };
}

function actorBoneRotations({ riding = false, crouching = false, walk = 0, swingProgress = 0 } = {}) {
  const armBase = riding ? -Math.PI / 5 : 0;
  const swing = swingProgress > 0 ? Math.sin(swingProgress * Math.PI) * 1.65 : 0;
  return {
    body: { x: crouching ? -0.35 : 0, y: 0, z: 0 },
    leftarm: { x: armBase + (riding ? 0 : walk), y: 0, z: 0 },
    rightarm: { x: armBase - (riding ? 0 : walk) - swing, y: 0, z: 0 },
    // Minecraft's model renderer uses the opposite X rotation sign from the
    // Three.js skeleton built by prismarine-viewer. A positive pitch moves the
    // seated legs toward the player's visible front (-Z) in this skeleton.
    leftleg: riding
      ? { x: 1.4137167, y: -Math.PI / 10, z: -Math.PI / 40 }
      : { x: -walk, y: 0, z: 0 },
    rightleg: riding
      ? { x: 1.4137167, y: Math.PI / 10, z: Math.PI / 40 }
      : { x: walk, y: 0, z: 0 },
  };
}

module.exports = { actorBoneRotations, localBonePivots, offsetBoneRotation };
