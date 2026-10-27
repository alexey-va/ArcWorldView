"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const THREE = require("three");
const { textureAnimation } = require("../scripts/texture-animation-assets.cjs");
const { textureFrame, textureSample, animateTexture } = require("../src/texture-animation.cjs");

test("native six-frame strips use mcmeta's 20-tick clock and preserve partial UV crops", () => {
  const animation = textureAnimation({animation:{frametime:2}},256,1536);
  assert.deepEqual(animation.frames,Array.from({length:6},(_,index)=>({index,time:2})));
  assert.deepEqual([0,99,100,599,600].map(now=>textureFrame(animation,now)),[0,0,1,5,0]);
  const texture = new THREE.Texture();
  const version = texture.version;
  for (const now of [0,100,200,300,400,500]) {
    const frame = animateTexture(texture,animation,now); texture.updateMatrix();
    const cropped = new THREE.Vector2(4.5/16,1-4.5/16).applyMatrix3(texture.matrix);
    assert.ok(Math.abs(cropped.x-4.5/16)<1e-10);
    assert.ok(Math.abs(cropped.y-(1-(frame+4.5/16)/6))<1e-10);
  }
  assert.equal(texture.version,version,"advancing the frame never reuploads the strip");
});

test("explicit frame dimensions, sequence and frame durations survive asset compilation", () => {
  const animation = textureAnimation({animation:{width:16,height:16,frametime:2,frames:[3,{index:0,time:5},2]}},32,32);
  assert.deepEqual(animation.frames,[{index:3,time:2},{index:0,time:5},{index:2,time:2}]);
  assert.deepEqual([0,100,349,350,449,450].map(now=>textureFrame(animation,now)),[3,0,0,2,2,3]);
  assert.equal(textureAnimation({},16,32),null);
  assert.throws(()=>textureAnimation({animation:{frametime:0}},16,32),/frame time/);
  assert.throws(()=>textureAnimation({animation:{frames:[2]}},16,32),/frame sequence/);
});

test("interpolated texture metadata blends RGB at display cadence between native frames",()=>{
  const animation = textureAnimation({animation:{frametime:2,frames:[1,0],interpolate:true}},16,32);
  assert.deepEqual(textureSample(animation,50),{index:1,nextIndex:0,amount:.5});
  assert.deepEqual(textureSample(animation,100),{index:0,nextIndex:1,amount:0});
});

test("layered native portal planes keep geometry, unshaded alpha and a single face per side",async()=>{
  const file = require.resolve("../src/model-renderer.cjs"), requireFrom = createRequire(file), mod = {exports:{}};
  const rendererRoot = require("../scripts/viewer-source.cjs").viewerSource();
  const imageFile = "native/assets/portal/strip.png", modelFile = "models/portal.json";
  const model = {elements:[{from:[0,0,8],to:[16,16,8],shade:false,faces:{north:{texture:"#layer",uv:[4.5,4.5,11.75,11.75]},south:{texture:"#layer",uv:[11.75,4.5,4.5,11.75]}}}],textures:{layer:imageFile}};
  vm.runInNewContext(fs.readFileSync(file,"utf8"),{
    module:mod,exports:mod.exports,
    fetch:async()=>({ok:true,json:async()=>model}),
    require:name=>name==="three"?{...THREE,TextureLoader:class{load(){return new THREE.Texture()}}}:
      name.startsWith("@viewer/")?require(path.join(rendererRoot,"src",name.slice(8)+".cjs")):
      name==="./viewer-utils.cjs"?{assetUrl:file=>file}:requireFrom(name)
  });
  mod.exports.configureModels({revision:"portal-fixture",files:{[imageFile]:{},[modelFile]:{}},items:{"minecraft:paper|1|none":modelFile},textureAnimations:{[imageFile]:{...textureAnimation({animation:{frametime:2}},256,1536),translucent:true}}});
  const group = await mod.exports.itemMesh({material:"minecraft:paper",customModelData:1},"fixed");
  const mesh = group.children[0], material = mesh.material;
  assert.equal(material.isMeshBasicMaterial,true);
  assert.equal(material.transparent,true); assert.equal(material.depthWrite,false);
  assert.equal(material.side,THREE.BackSide);
  assert.equal(mesh.geometry.attributes.position.count,12);
  assert.equal(new Set(Array.from(mesh.geometry.attributes.position.array).filter((_,index)=>index%3===2)).size,1);
  const before = Array.from(mesh.geometry.attributes.uv.array), version = material.map.version;
  mod.exports.animateModelTextures(100);
  assert.ok(Math.abs(material.map.offset.y-2/3)<1e-10);
  assert.deepEqual(Array.from(mesh.geometry.attributes.uv.array),before);
  assert.equal(material.map.version,version);

  mod.exports.configureModels({revision:"interpolated-fixture",files:{[imageFile]:{},[modelFile]:{}},items:{"minecraft:paper|1|none":modelFile},textureAnimations:{[imageFile]:{...textureAnimation({animation:{frametime:2,interpolate:true}},256,1536),translucent:true}}});
  const interpolated = (await mod.exports.itemMesh({material:"minecraft:paper",customModelData:1},"fixed")).children[0].material;
  const shader = {uniforms:{},fragmentShader:"void main() {\n#include <map_fragment>\n}"};
  interpolated.onBeforeCompile(shader);
  mod.exports.animateModelTextures(50);
  assert.equal(shader.uniforms.worldViewFrameBlend.value,.5);
  assert.ok(Math.abs(shader.uniforms.worldViewFrameOffset.value.y+1/6)<1e-10);
  assert.match(shader.fragmentShader,/texelColor\.rgb = mix/);
  assert.doesNotMatch(shader.fragmentShader,/texelColor\.a\s*=/,"the current frame owns alpha");
});
