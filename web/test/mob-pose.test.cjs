"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const THREE = require("three");
const { prepareMobSkeletons, poseMobSkeletons } = require("../src/mob-pose.cjs");
const { installNativeEntityModels, unsupportedNativeEntities, nativeEntityCompatibility } = require("../src/native-entity-models.cjs");

const templates = JSON.parse(JSON.stringify(require("prismarine-viewer/viewer/lib/entity/entities.json")));
const legacyHorse = JSON.parse(JSON.stringify(templates.horse));
installNativeEntityModels(templates);
for (const type of ["horse", "cat", "rabbit", "villager", "zombie_villager"]) templates[type].textures.default = Object.values(templates[type].textures)[0];
const entityFile = require.resolve("prismarine-viewer/viewer/lib/entity/Entity");
const dependencyRequire = createRequire(entityFile), moduleObject = { exports: {} };
// Unmodified pinned Entity source; only texture I/O is replaced for CPU tests.
vm.runInNewContext(fs.readFileSync(entityFile, "utf8"), {
  module: moduleObject, exports: moduleObject.exports, THREE, globalThis: {},
  require: name => name === "./entities.json" ? templates : name === "../utils" ? { loadTexture(_url, callback) { callback(new THREE.Texture()); } } : dependencyRequire(name)
});
const Entity = moduleObject.exports;
const candidateTypes = "armor_stand bat bee blaze boat cat cave_spider chest_minecart chicken cod command_block_minecart cow creeper dolphin dragon_fireball drowned elder_guardian ender_dragon enderman endermite evoker_fangs evoker experience_orb fishing_bobber ghast guardian hoglin hopper_minecart horse husk iron_golem leash_knot llama_spit magma_cube minecart mooshroom panda phantom pig player polar_bear pufferfish rabbit ravager salmon sheep shulker_bullet silverfish skeleton slime snow_golem spider stray strider trident tnt_minecart tropical_fish turtle villager vindicator wandering_trader wither wither_skeleton wither_skull wolf zoglin zombie zombie_villager".split(" ");

function vertices(root) {
  root.updateMatrixWorld(true);
  const points = [];
  root.traverse(part => {
    if (!part.isSkinnedMesh) return;
    for (let index = 0; index < part.geometry.attributes.position.count; index++) points.push(part.boneTransform(index, new THREE.Vector3()).applyMatrix4(part.matrixWorld));
  });
  return points;
}
function close(actual, expected, detail) { assert.ok(actual.distanceTo(expected) < 1e-6, `${detail}: ${actual.toArray()} vs ${expected.toArray()}`); }

test("every available native template keeps its rest vertices and finite attached joints", () => {
  for (const type of candidateTypes.filter(type => !nativeEntityCompatibility(type, templates[type]))) {
    const root = new Entity("1.21.11", type, new THREE.Scene()).mesh;
    const before = vertices(root);
    const bodies = prepareMobSkeletons(root, templates[type], type);
    const after = vertices(root);
    assert.equal(after.length, before.length, type);
    after.forEach((point, index) => close(point, before[index], `${type} rest vertex ${index}`));
    for (const body of bodies) for (const [name, bone] of Object.entries(body.bones)) close(bone.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(...body.pivots[name]).multiplyScalar(1 / 16), `${type}/${name} native joint`);
    for (const walk of [-.62, 0, .62, 0]) {
      poseMobSkeletons(bodies, walk);
      for (const point of vertices(root)) assert.ok(point.toArray().every(Number.isFinite), `${type} finite animated vertex`);
    }
  }
});

test("cow sheep pig chicken horse and humanoid limbs stay at native hips throughout a walk", () => {
  for (const type of ["cow", "sheep", "pig", "chicken", "horse", "zombie"]) {
    const root = new Entity("1.21.11", type, new THREE.Scene()).mesh;
    const bodies = prepareMobSkeletons(root, templates[type], type);
    assert.ok(bodies.some(body => body.motion.length), `${type} has a gait`);
    for (let frame = 0; frame <= 24; frame++) {
      poseMobSkeletons(bodies, Math.sin(frame / 24 * Math.PI * 2) * .62, Math.sin(frame / 12) * .25, .1);
      const points = vertices(root);
      assert.ok(Math.min(...points.map(point => point.y)) >= -.1, `${type}: detached limb below ground`);
      for (const body of bodies) for (const { bone } of body.motion) close(bone.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(...body.pivots[bone.name.toLowerCase()]).multiplyScalar(1 / 16), `${type}/${bone.name} stable hip`);
    }
    if (type === "sheep") for (const name of ["leg0", "leg1", "leg2", "leg3"]) close(bodies[0].bones[name].getWorldPosition(new THREE.Vector3()), bodies[1].bones[name].getWorldPosition(new THREE.Vector3()), `wool/base ${name}`);
  }
});

test("legacy segmented limbs share the upper joint instead of swinging each segment", () => {
  const current = templates.horse;
  templates.horse = legacyHorse; legacyHorse.textures.default = Object.values(legacyHorse.textures)[0];
  try {
    const root = new Entity("1.21.11", "horse", new THREE.Scene()).mesh;
    const [body] = prepareMobSkeletons(root, legacyHorse, "horse");
    assert.equal(body.motion.length, 4);
    assert.equal(body.bones.leg1b.parent, body.bones.leg1a);
    assert.equal(body.bones.leg1c.parent, body.bones.leg1a);
    const initial = vertices(root);
    for (const walk of [-.62, .62, 0]) { poseMobSkeletons([body], walk); vertices(root); }
    vertices(root).forEach((point, index) => close(point, initial[index], "segmented rest return"));
  } finally { templates.horse = current; }
});

test("native UV spaces match Java layouts without rescaling images or losing wool layers", () => {
  for (const type of ["cow", "pig", "zombie", "husk", "mooshroom", "magma_cube", "horse"]) {
    assert.equal(templates[type].geometry.default.texturewidth, 64);
    assert.equal(templates[type].geometry.default.textureheight, 64);
  }
  for (const model of Object.values(templates.sheep.geometry)) {
    assert.equal(model.textureheight, 32);
    assert.ok(model.bones.flatMap(bone => bone.cubes ?? []).every(cube => cube.uv[1] >= 0 && cube.uv[1] < 32));
  }
  assert.equal(templates.ghast.geometry.default.textureheight, 32, "Java ghast uses64×32 UV space even with its128×64 PNG");
  assert.ok(unsupportedNativeEntities.has("bat"), "Incompatible legacy layouts must remain explicit coverage gaps");
});

test("player armour follows the actual normalized limbs throughout walking and returns to rest", () => {
  const viewerRoot = require("../scripts/viewer-source.cjs").viewerSource();
  const playerModel = require(path.join(viewerRoot, "src/player-model.cjs"));
  const { actorBoneRotations } = require(path.join(viewerRoot, "src/actor-pose.cjs"));
  const modelFile = require.resolve("../src/model-renderer.cjs"), modelModule = { exports: {} };
  const modelRequire = createRequire(modelFile);
  // Exercise production armour geometry; texture I/O alone is stubbed.
  vm.runInNewContext(fs.readFileSync(modelFile, "utf8"), {
    module: modelModule, exports: modelModule.exports,
    require: name => name === "three" ? { ...THREE, TextureLoader: class { load() { return new THREE.Texture(); } } } :
      name === "@viewer/player-model" ? playerModel : name === "@viewer/item-model-geometry" ? {} :
      name === "@viewer/viewer-color" ? { configureMinecraftTexture() {} } :
      name === "./viewer-utils.cjs" ? { assetUrl: file => file } : modelRequire(name)
  });
  const renderer = modelModule.exports;
  renderer.configureModels({ revision: "test", files: Object.fromEntries(["humanoid", "humanoid_leggings"].map(name => [`native/assets/minecraft/textures/entity/equipment/${name}/iron.png`, {}])) });
  const root = new Entity("1.21.11", "player", new THREE.Scene()).mesh;
  const body = playerModel.playerBodyMesh(root);
  playerModel.normalizePlayerSkeleton(body); playerModel.applyPlayerGeometry(body, "default");
  const bones = playerModel.playerBones(body), attachments = [];
  for (const [slot, material] of [["HEAD", "helmet"], ["CHEST", "chestplate"], ["LEGS", "leggings"], ["FEET", "boots"]]) {
    for (const part of renderer.armorParts({ material: `minecraft:iron_${material}` }, slot)) {
      bones[part.bone].add(part.mesh); attachments.push({ ...part, slot });
    }
  }
  const initial = vertices(root);
  for (let frame = 0; frame <= 24; frame++) {
    const walk = Math.sin(frame / 24 * Math.PI * 2) * .62;
    for (const [name, rotation] of Object.entries(actorBoneRotations({ walk }))) bones[name].rotation.set(rotation.x, rotation.y, rotation.z);
    root.updateMatrixWorld(true);
    const points = vertices(root);
    assert.ok(Math.min(...points.map(point => point.y)) >= -.08, "player foot never detaches below ground");
    for (const { mesh, bone, slot } of attachments) {
      const inverse = bones[bone].matrixWorld.clone().invert();
      const armorBounds = new THREE.Box3().setFromBufferAttribute(mesh.geometry.attributes.position);
      const bodyBounds = new THREE.Box3();
      const index = body.skeleton.bones.indexOf(bones[bone]);
      for (let vertex = 0; vertex < body.geometry.attributes.position.count; vertex++) {
        if (body.geometry.attributes.skinIndex.getX(vertex) !== index) continue;
        bodyBounds.expandByPoint(body.boneTransform(vertex, new THREE.Vector3()).applyMatrix4(body.matrixWorld).applyMatrix4(inverse));
      }
      assert.ok(armorBounds.containsBox(bodyBounds), `${slot}/${bone} encloses its actual limb`);
      const margin = armorBounds.getSize(new THREE.Vector3()).sub(bodyBounds.getSize(new THREE.Vector3()));
      assert.ok(margin.toArray().every(value => value >= -.001 && value <= 2.001), `${slot}/${bone} remains within native armour inflation`);
      for (let vertex = 0; vertex < mesh.geometry.attributes.position.count; vertex++) {
        const point = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, vertex);
        close(point.clone().applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse), point, `${slot}/${bone} attached vertex`);
      }
    }
  }
  vertices(root).forEach((point, index) => close(point, initial[index], "player rest return"));
});
