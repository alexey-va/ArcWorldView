"use strict";

// Compatibility data for the pinned 1.21.11 Java client, not image-size guesses.
// Source: official client ba2df812c2d12e0219c489c4cd9a5e1f0760f5bd,
// CowModel/PigModel/SheepFurModel/AbstractEquineModel and LayerDefinitions.
// An HD resource pack keeps these normalized coordinates unchanged.
const unsupportedNativeEntities = new Set(["bat", "fishing_bobber"]);
const adapted = new WeakSet();

function nativeEntityCompatibility(type, template) {
  if (unsupportedNativeEntities.has(type)) return "native-layout-unavailable";
  for (const model of Object.values(template.geometry ?? {})) {
    const bones = model.bones ?? [], names = new Set(bones.map(bone => bone.name));
    if (names.size !== bones.length || bones.some(bone => bone.parent && !names.has(bone.parent))) return "invalid-skeleton";
    for (const bone of bones) for (const cube of bone.cubes ?? []) {
      if (!Array.isArray(cube.uv) || !Array.isArray(cube.origin) || !Array.isArray(cube.size)) return "unsupported-geometry-format";
    }
  }
  return null;
}

function nativeHorseGeometry() {
  const cube = (origin, size, uv, inflate = 0) => ({ origin, size, uv, ...(inflate ? { inflate } : {}) });
  const headPivot = [0, 20, -12];
  return { texturewidth: 64, textureheight: 64, bones: [
    { name: "body", pivot: [0, 13, 5], cubes: [cube([-5, 11, -12], [10, 10, 22], [0, 32], .05)] },
    { name: "head_parts", pivot: headPivot, bind_pose_rotation: [30, 0, 0], cubes: [cube([-2.05, 14, -14], [4, 12, 7], [0, 35])] },
    { name: "head", parent: "head_parts", pivot: headPivot, bind_pose_rotation: [30, 0, 0], cubes: [cube([-3, 26, -14], [6, 5, 7], [0, 13])] },
    { name: "mane", parent: "head_parts", pivot: headPivot, bind_pose_rotation: [30, 0, 0], cubes: [cube([-1, 15, -6.99], [2, 16, 2], [56, 36])] },
    { name: "upper_mouth", parent: "head_parts", pivot: headPivot, bind_pose_rotation: [30, 0, 0], cubes: [cube([-2, 26, -19], [4, 5, 5], [0, 25])] },
    { name: "left_hind_leg", pivot: [4, 10, 7], mirror: true, cubes: [cube([1, .01, 6], [4, 11, 4], [48, 21])] },
    { name: "right_hind_leg", pivot: [-4, 10, 7], cubes: [cube([-5, .01, 6], [4, 11, 4], [48, 21])] },
    { name: "left_front_leg", pivot: [4, 10, -10], mirror: true, cubes: [cube([1, .01, -11.9], [4, 11, 4], [48, 21])] },
    { name: "right_front_leg", pivot: [-4, 10, -10], cubes: [cube([-5, .01, -11.9], [4, 11, 4], [48, 21])] },
    { name: "tail", parent: "body", pivot: [0, 18, 7], bind_pose_rotation: [30, 0, 0], cubes: [cube([-1.5, 4, 7], [3, 14, 4], [42, 36])] },
    { name: "left_ear", parent: "head", pivot: headPivot, bind_pose_rotation: [30, 0, 0], cubes: [cube([.55, 30, -8], [2, 3, 1], [19, 16], -.001)] },
    { name: "right_ear", parent: "head", pivot: headPivot, bind_pose_rotation: [30, 0, 0], cubes: [cube([-2.55, 30, -8], [2, 3, 1], [19, 16], -.001)] }
  ] };
}

function installNativeEntityModels(templates) {
  if (adapted.has(templates)) return;
  adapted.add(templates);
  for (const type of ["cow", "pig", "mooshroom", "zombie", "husk", "magma_cube"]) {
    const geometry = JSON.parse(JSON.stringify(templates[type].geometry));
    for (const model of Object.values(geometry)) { model.texturewidth = 64; model.textureheight = 64; }
    templates[type].geometry = geometry;
  }
  // The current Java cow also has a separate muzzle below the original head.
  for (const type of ["cow", "mooshroom"]) {
    const head = templates[type].geometry.default.bones.find(bone => bone.name === "head");
    head.cubes.push({ origin: [-3, 16, -15], size: [6, 3, 1], uv: [1, 33] });
  }
  templates.sheep.geometry = JSON.parse(JSON.stringify(templates.sheep.geometry));
  for (const [name, model] of Object.entries(templates.sheep.geometry)) {
    model.texturewidth = 64; model.textureheight = 32;
    if (name === "default") for (const bone of model.bones) for (const cube of bone.cubes ?? []) cube.uv[1] -= 32;
  }
  templates.llama_spit.geometry = JSON.parse(JSON.stringify(templates.llama_spit.geometry));
  templates.llama_spit.geometry.default.texturewidth = 64;
  templates.llama_spit.geometry.default.textureheight = 32;
  templates.chicken.geometry = JSON.parse(JSON.stringify(templates.chicken.geometry));
  const chickenBody = templates.chicken.geometry.default.bones.find(bone => bone.name === "body");
  // ChickenModel rotates its body around [0,8,0], not the world origin.
  chickenBody.bind_pose_rotation = [90, 0, 0];
  delete chickenBody.cubes[0].rotation;
  // The pinned strider data supplies explicit cube pivots; stock Entity omits
  // that field. One cube per bristle lets us express it as ordinary bone data.
  templates.strider.geometry = JSON.parse(JSON.stringify(templates.strider.geometry));
  for (const bone of templates.strider.geometry.default.bones) {
    const cube = bone.cubes?.[0];
    if (bone.cubes?.length === 1 && cube.rotation && cube.pivot) {
      bone.pivot = cube.pivot; bone.bind_pose_rotation = cube.rotation;
      delete cube.rotation; delete cube.pivot;
    }
  }
  // Legacy Bedrock horse legs/UVs cannot be mapped to the current Java atlas.
  templates.horse.geometry = { default: nativeHorseGeometry() };
}

module.exports = { installNativeEntityModels, nativeHorseGeometry, unsupportedNativeEntities, nativeEntityCompatibility };
