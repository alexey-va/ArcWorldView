"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const THREE = require("three");
const { createAtmosphere, chunkLanterns } = require("../src/atmosphere.cjs");

function setup(maxTextureSize = 4096) {
  const renderer = {
    shadowMap: { enabled:false, type:THREE.PCFShadowMap, autoUpdate:true, needsUpdate:false },
    capabilities: { maxTextureSize }, outputEncoding: THREE.LinearEncoding,
    render(scene, camera) { this.lastRender = { scene, camera, update: this.shadowMap.needsUpdate }; }
  };
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera();
  const atmosphere = createAtmosphere({ renderer, scene, camera });
  return { renderer, scene, camera, atmosphere, sun: scene.children.find(child => child.isDirectionalLight) };
}

test("the sun includes all scene bounds with bounded shadow allocation", () => {
  const { atmosphere, sun } = setup(1536);
  const bounds = { minX:-320, maxX:-256, minY:-32, maxY:96, minZ:1200, maxZ:1248 };
  atmosphere.setBounds(bounds); atmosphere.resize(1280,720);
  assert.equal(sun.shadow.mapSize.x,1024);
  for (const x of [bounds.minX,bounds.maxX]) for (const y of [bounds.minY,bounds.maxY]) for (const z of [bounds.minZ,bounds.maxZ]) {
    const point = new THREE.Vector3(x,y,z).project(sun.shadow.camera);
    assert.ok(Math.max(Math.abs(point.x),Math.abs(point.y),Math.abs(point.z)) < 1, `clipped corner ${point.toArray()}`);
  }
  let disposed = 0;
  sun.shadow.map = { dispose() { disposed++; } };
  atmosphere.resize(380,720);
  assert.equal(disposed,0,"an unchanged allocation is reused");
  atmosphere.dispose(); assert.equal(disposed,1);
});

test("alpha-cutout maps, asynchronous skins and skeletons reach the shadow pass", () => {
  const { atmosphere, scene, renderer } = setup();
  const material = new THREE.MeshLambertMaterial({ alphaTest:.1, skinning:true, transparent:true });
  const body = new THREE.SkinnedMesh(new THREE.BoxGeometry(),material);
  const label = new THREE.Mesh(new THREE.PlaneGeometry(),new THREE.MeshBasicMaterial({ transparent:true }));
  scene.add(body,label); atmosphere.render(0);
  assert.equal(body.castShadow,true); assert.equal(body.receiveShadow,true);
  assert.equal(body.customDepthMaterial.skinning,true);
  assert.equal(body.customDepthMaterial.alphaTest,.1);
  assert.equal(label.castShadow,false); assert.equal(label.customDepthMaterial,undefined);
  const skin = new THREE.Texture(), alpha = new THREE.Texture();
  material.map = skin; material.alphaMap = alpha;
  atmosphere.render(190);
  assert.equal(body.customDepthMaterial.map,skin); assert.equal(body.customDepthMaterial.alphaMap,alpha);
  assert.equal(renderer.outputEncoding,THREE.LinearEncoding);
  assert.equal(skin.encoding,THREE.LinearEncoding);
  atmosphere.render(200); assert.equal(renderer.lastRender.update,false);
  atmosphere.render(225); assert.equal(renderer.lastRender.update,true);
  atmosphere.dispose();
});

test("removed chunks release depth materials and disposal restores renderer ownership", () => {
  const { atmosphere, scene, renderer, camera } = setup();
  const body = new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshLambertMaterial());
  scene.add(body); atmosphere.render(0);
  let disposed = 0;
  body.customDepthMaterial.addEventListener("dispose",() => disposed++);
  scene.remove(body); atmosphere.render(200);
  assert.equal(disposed,1); assert.equal(body.castShadow,false); assert.equal(body.customDepthMaterial,undefined);
  assert.deepEqual(renderer.lastRender.scene,scene); assert.deepEqual(renderer.lastRender.camera,camera);
  atmosphere.dispose(); atmosphere.dispose();
  assert.deepEqual(renderer.shadowMap,{ enabled:false, type:THREE.PCFShadowMap, autoUpdate:true, needsUpdate:false });
  assert.equal(scene.children.length,0); assert.equal(scene.background,null);
});

test("unsupported shadow hardware keeps direct lighting without depth resources", () => {
  const { atmosphere, renderer, scene, sun } = setup(256);
  const body = new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshLambertMaterial());
  scene.add(body); atmosphere.render(0); atmosphere.resize(1280,720);
  assert.equal(sun.castShadow,false); assert.equal(renderer.shadowMap.enabled,false);
  assert.equal(body.customDepthMaterial,undefined); assert.ok(renderer.lastRender);
  atmosphere.dispose();
});

test("lanterns use exact block identities and native bulb centres in chunk coordinates", () => {
  const chunk = { x:-2,z:3,minY:-16,palette:["minecraft:air","minecraft:lantern[hanging=false,waterlogged=false]","minecraft:soul_lantern[hanging=true,waterlogged=false]","minecraft:sea_lantern"],runs:[273,0,1,1,1,2,1,3,65536-276,0] };
  const lamps = chunkLanterns(chunk);
  assert.equal(lamps.length,2);
  assert.deepEqual(lamps[0].position.toArray(),[-30.5,-15+3.5/16,49.5]);
  assert.deepEqual(lamps[1].position.toArray(),[-29.5,-15+4.5/16,49.5]);
  assert.notEqual(lamps[0].color,lamps[1].color);
  assert.equal(chunkLanterns({ ...chunk,runs:[65536,1] }).length,32,"source retention is bounded");
});

test("light pool follows visible lamps and releases glow on scene reset", () => {
  const { atmosphere, scene, camera } = setup();
  camera.position.set(.5,1,10); camera.lookAt(.5,0,0); camera.updateMatrixWorld();
  atmosphere.setChunk("0,0",{ x:0,z:0,minY:0,palette:["minecraft:lantern"],runs:[1,0] });
  atmosphere.render(0);
  const lamps = scene.children.filter(child => child.isPointLight);
  assert.equal(lamps.length,4); assert.equal(lamps.filter(light => light.intensity > 0).length,1);
  const halo = scene.children.find(child => child.isSprite && child.visible);
  assert.equal(halo.material.depthTest,true); assert.equal(halo.material.depthWrite,false);
  atmosphere.removeChunk("0,0"); atmosphere.render(200);
  assert.equal(lamps.filter(light => light.intensity > 0).length,0);
  atmosphere.setChunk("0,0",{ x:0,z:0,minY:0,palette:["minecraft:lantern"],runs:[1,0] });
  atmosphere.render(400); atmosphere.reset();
  assert.equal(lamps.filter(light => light.intensity > 0).length,0);
  atmosphere.dispose();
});

test("pinned shadow renderer excludes armour's outer depth faces while retaining cutout maps", () => {
  const viewerRoot = require("../scripts/viewer-source.cjs").viewerSource();
  const file = require.resolve("../src/model-renderer.cjs"), dependencyRequire = createRequire(file), mod = { exports:{} };
  vm.runInNewContext(fs.readFileSync(file,"utf8"),{
    module:mod,exports:mod.exports,
    require:name => name === "three" ? { ...THREE,TextureLoader:class { load() { return new THREE.Texture(); } } } :
      name.startsWith("@viewer/") ? require(path.join(viewerRoot,"src",name.slice(8)+".cjs")) :
      name === "./viewer-utils.cjs" ? { assetUrl:file => file } : dependencyRequire(name)
  });
  const armorFile = "native/assets/minecraft/textures/entity/equipment/humanoid/iron.png";
  mod.exports.configureModels({ revision:"shadow-regression",files:{ [armorFile]:{} } });
  const armor = [...mod.exports.armorParts({ material:"minecraft:iron_helmet" },"HEAD"),...mod.exports.armorParts({ material:"minecraft:iron_chestplate" },"CHEST")].map(part => part.mesh);
  const { atmosphere,scene,renderer,camera,sun } = setup();
  const cutout = new THREE.Mesh(new THREE.PlaneGeometry(),new THREE.MeshLambertMaterial({ map:new THREE.Texture(),alphaTest:.1,side:THREE.DoubleSide }));
  for (const mesh of [...armor,cutout]) { mesh.frustumCulled = false; scene.add(mesh); }
  atmosphere.setBounds({ minX:-24,maxX:24,minY:-16,maxY:16,minZ:-24,maxZ:24 });

  // Execute the pinned Three shadow adapter; replace only GPU submission. This
  // catches r128 overriding customDepthMaterial.side from the colour material.
  const shadowFile = path.join(path.dirname(require.resolve("three/package.json")),"src/renderers/webgl/WebGLShadowMap.js");
  const source = fs.readFileSync(shadowFile,"utf8").replace(/^import .*;\n/gm,"").replace(/export \{ WebGLShadowMap \};/,"");
  const ShadowMap = vm.runInNewContext(source+"\nWebGLShadowMap",{ ...THREE,vsm_frag:"",vsm_vert:"" });
  const submitted = new Map();
  Object.assign(renderer,{
    state:{ setBlending(){},setScissorTest(){},viewport(){},buffers:{ color:{ setClear(){} },depth:{ setTest(){} } } },
    getRenderTarget:() => null,getActiveCubeFace:() => 0,getActiveMipmapLevel:() => 0,setRenderTarget(){},clear(){},
    renderBufferDirect(_camera,_scene,_geometry,material,object) { submitted.set(object,material); }
  });
  const shadowMap = new ShadowMap(renderer,{ update:object => object.geometry },renderer.capabilities);
  Object.assign(shadowMap,renderer.shadowMap); renderer.shadowMap = shadowMap;
  renderer.render = (world,view) => { world.updateMatrixWorld(true); shadowMap.render([sun],world,view); };
  atmosphere.render(0);
  for (const mesh of armor) {
    const depth = submitted.get(mesh);
    assert.equal(mesh.material.side,THREE.DoubleSide,"colour geometry stays unchanged");
    assert.equal(depth.side,THREE.BackSide);
    assert.equal(depth.map,mesh.material.map); assert.equal(depth.alphaTest,.1);
  }
  const helmet = armor[0], ray = new THREE.Raycaster(new THREE.Vector3(0,20,0),new THREE.Vector3(0,-1,0));
  assert.equal(ray.intersectObject(helmet)[0].point.y,9,"the visible helmet still includes its outer top");
  const depthMesh = new THREE.Mesh(helmet.geometry,submitted.get(helmet));
  assert.equal(ray.intersectObject(depthMesh)[0].point.y,-1,"the sun-facing top cannot write its own shadow depth");
  assert.equal(submitted.get(cutout).side,THREE.DoubleSide,"thin item/foliage cutouts keep both casting sides");
  assert.equal(submitted.get(cutout).map,cutout.material.map);
  atmosphere.dispose();
});
