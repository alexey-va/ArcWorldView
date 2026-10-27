"use strict";

function prepareMobSkeletons(root, template, type) {
  const definitions = Object.entries(template.geometry).filter(([name]) => template.textures[name]);
  const bodies = [];
  root.traverse(part => {
    if (!part.isSkinnedMesh) return;
    const [partName, model] = definitions[bodies.length];
    const byName = new Map(model.bones.map((definition, index) => [definition.name.toLowerCase(), { definition, bone: part.skeleton.bones[index] }]));
    const parentNames = new Map(model.bones.map(definition => [definition.name.toLowerCase(), definition.parent?.toLowerCase()]));
    // Old segmented templates describe lower segments as independent roots.
    // Keep the whole limb on its hip rather than swinging each segment apart.
    for (const name of byName.keys()) {
      const match = name.match(/^(leg\d+)[bc]$/);
      if (match && byName.has(match[1] + "a")) parentNames.set(name, match[1] + "a");
      const foot = name.match(/^rearfoot(left|right)$/);
      if (foot && byName.has("haunch" + foot[1])) parentNames.set(name, "haunch" + foot[1]);
    }
    const bones = {}, pivots = {};
    for (const [name, { definition, bone }] of byName) {
      const parentName = parentNames.get(name), parent = byName.get(parentName);
      const pivot = definition.pivot ?? [0, 0, 0], parentPivot = parent?.definition.pivot ?? [0, 0, 0];
      (parent?.bone ?? part).add(bone);
      bone.name = definition.name;
      bone.position.set(...pivot.map((value, axis) => value - parentPivot[axis]));
      // Stock Entity already baked bind_pose_rotation/rotation into vertices.
      // Keeping it on the parent changes the joint's frame a second time.
      bone.rotation.set(0, 0, 0);
      bones[name] = bone; pivots[name] = pivot;
    }
    part.updateMatrixWorld(true); part.bind(part.skeleton);
    const legs = [...byName.keys()].filter(name => /leg|^haunch/.test(name) && !/tip|foot/.test(name) && !/leg|^haunch/.test(parentNames.get(name) ?? ""));
    const motion = [];
    if (!["armor_stand", "bee", "ender_dragon"].includes(type)) {
      const midZ = legs.reduce((sum, name) => sum + pivots[name][2], 0) / Math.max(legs.length, 1);
      for (const [index, name] of legs.entries()) {
        const side = pivots[name][0] < 0 ? 1 : -1;
        const sign = legs.length === 4 ? side * (pivots[name][2] < midZ ? -1 : 1) : legs.length > 4 ? side * (Math.floor(index / 2) % 2 ? -1 : 1) : side;
        motion.push({ bone: bones[name], axis: /spider|turtle/.test(type) ? "y" : "x", sign, amplitude: /spider|turtle/.test(type) ? .5 : 1 });
      }
      if (legs.length === 2) for (const [name, bone] of Object.entries(bones)) {
        if (/^(leftarm|rightarm|arm[01])$/.test(name)) motion.push({ bone, axis: "x", sign: pivots[name][0] < 0 ? -1 : 1, amplitude: 1 });
      }
    }
    bodies.push({ mesh: part, partName, bones, pivots, motion, look: bones.head_parts ?? bones.head });
  });
  return bodies;
}

function poseMobSkeletons(bodies, walk, headYaw = 0, pitch = 0) {
  for (const body of bodies) {
    for (const { bone, axis, sign, amplitude } of body.motion) bone.rotation[axis] = walk * sign * amplitude;
    if (body.look) { body.look.rotation.y = -headYaw; body.look.rotation.x = -pitch; }
  }
}

module.exports = { prepareMobSkeletons, poseMobSkeletons };
