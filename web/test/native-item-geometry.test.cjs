"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const THREE = require("three");
const { isGeneratedItemFallback, generatedItemFaces, nativeItemContextMatrix, nativeHandGripMatrix, playerHandBone, playerHandGripMatrix, heldItemArmRotation } = require("../src/native-item-geometry.cjs");
const close = (actual, expected) => actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-8, `${actual} != ${expected}`));
const transform = (matrix, point) => new THREE.Vector3(...point).applyMatrix4(matrix).toArray();

test("only the pinned generated sentinel receives native sprite extrusion", () => {
  const model = { textures: { layer0: "native/axe.png" }, elements: [{ from:[0,0,8],to:[16,16,8.01],faces:{north:{texture:"#layer0"},south:{texture:"#layer0"}} }] };
  assert.equal(isGeneratedItemFallback(model), true);
  const explicit = structuredClone(model); explicit.elements[0].faces.north.uv = [0,0,16,16];
  assert.equal(isGeneratedItemFallback(explicit), false, "an explicit IA face is not a generated sentinel");
  const plane = structuredClone(model); plane.elements[0].to[2] = 8;
  assert.equal(isGeneratedItemFallback(plane), false);
});

test("generated sprites keep one unmirrored silhouette, native thickness and opaque side texels", () => {
  const pixels = new Uint8ClampedArray(3 * 3 * 4);
  for (const [x,y] of [[0,0],[0,1],[1,1]]) pixels[(y*3+x)*4+3] = 255;
  const faces = generatedItemFaces(pixels,3,3,"native/axe.png");
  assert.equal(faces.length,10, "two faces plus eight exposed edges of an asymmetric L");
  for (const face of faces.slice(0,2)) for (let vertex=0;vertex<4;vertex++) {
    close(face.uvs[vertex],[face.positions[vertex][0]+.5,face.positions[vertex][1]+.5]);
  }
  const zs = faces.flatMap(face=>face.positions.map(point=>point[2]));
  assert.equal(Math.max(...zs)-Math.min(...zs),1/16);
  for (const face of faces.slice(2)) for (const [u,v] of face.uvs) assert.equal(pixels[(Math.floor((1-v)*3)*3+Math.floor(u*3))*4+3],255);
  assert.throws(()=>generatedItemFaces(new Uint8Array(),513,512,"x"),/budget/);
  const checker = new Uint8ClampedArray(256*256*4);
  for(let y=0;y<256;y++)for(let x=0;x<256;x++)if((x+y)%2===0)checker[(y*256+x)*4+3]=255;
  assert.throws(()=>generatedItemFaces(checker,256,256,"x"),/silhouette.*budget/);
});

test("native item context follows Quaternion XYZ and left-hand sign rules", () => {
  const model = { display: {
    thirdperson_righthand:{rotation:[0,-90,55],translation:[0,4,.5],scale:[.85,.85,.85]},
    thirdperson_lefthand:{rotation:[0,90,-55],translation:[0,4,.5],scale:[.85,.85,.85]}
  } };
  // Native hand-held JSON and ItemTransform: Rz acts before Ry on the vertex.
  const expected = [0, .25+.85*Math.sin(55*Math.PI/180), .03125+.85*Math.cos(55*Math.PI/180)];
  close(transform(nativeItemContextMatrix(model,"thirdperson_righthand"),[1,0,0]),expected);
  close(transform(nativeItemContextMatrix(model,"thirdperson_lefthand"),[1,0,0]),expected);
  const fallback={display:{thirdperson_righthand:{translation:[2,4,1]}}};
  close(transform(nativeItemContextMatrix(fallback,"thirdperson_lefthand"),[0,0,0]),[-.125,.25,.0625]);
  close(transform(nativeItemContextMatrix({display:{fixed:{rotation:[90,90,0]}}},"fixed"),[1,0,0]),[0,1,0]);
});

test("native grip and ITEM arm pose stay attached in both hands through a walking cycle", () => {
  const right=nativeHandGripMatrix("HAND"),left=nativeHandGripMatrix("OFF_HAND");
  close(transform(right,[0,0,0]),[-1,-10,-2]);
  close(transform(left,[0,0,0]),[1,-10,-2]);
  close(transform(right,[1,0,0]),[-17,-10,-2]);
  close(transform(right,[0,1,0]),[-1,-10,-18]);
  close(transform(right,[0,0,1]),[-1,6,-2]);
  close(transform(nativeHandGripMatrix("HAND",true),[0,0,0]),[-.5,-10,-2]);
  close(transform(nativeHandGripMatrix("OFF_HAND",true),[0,0,0]),[.5,-10,-2]);
  for(let frame=0;frame<=24;frame++) {
    const walk=Math.sin(frame/24*Math.PI*2)*.62;
    for(const [hand,sign] of [["HAND",1],["OFF_HAND",-1]]) {
      const pose=heldItemArmRotation({x:walk*sign,y:.2,z:0});
      assert.equal(pose.x,walk*sign*.5+Math.PI/10); assert.equal(pose.y,0);
      const arm=new THREE.Bone(),item=new THREE.Group();
      arm.position.set(-sign*5,22,0);arm.rotation.set(pose.x,pose.y,pose.z);
      item.matrixAutoUpdate=false;item.matrix.copy(nativeHandGripMatrix(hand));arm.add(item);arm.updateMatrixWorld(true);
      const grip=item.getWorldPosition(new THREE.Vector3());
      close(grip.toArray(),[-sign*6,22-10*Math.cos(pose.x)+2*Math.sin(pose.x),-10*Math.sin(pose.x)-2*Math.cos(pose.x)]);
    }
  }
});

test("production item renderer caches sprite extraction across hands and invalidates by revision", async () => {
  const viewerRoot=require("../scripts/viewer-source.cjs").viewerSource();
  const file=require.resolve("../src/model-renderer.cjs"),dependencyRequire=createRequire(file),mod={exports:{}};
  const pixels=new Uint8ClampedArray(3*3*4);for(const [x,y] of [[0,0],[0,1],[1,1]])pixels[(y*3+x)*4+3]=255;
  let reads=0,modelLoads=0;
  const source={textures:{layer0:"native/axe.png"},elements:[{from:[0,0,8],to:[16,16,8.01],faces:{north:{texture:"#layer0"},south:{texture:"#layer0"}}}],display:{thirdperson_righthand:{rotation:[0,-90,55]},thirdperson_lefthand:{rotation:[0,90,-55]}}};
  vm.runInNewContext(fs.readFileSync(file,"utf8"),{
    module:mod,exports:mod.exports,
    fetch:async()=>{modelLoads++;return {ok:true,json:async()=>structuredClone(source)};},
    Image:class {width=3;height=3;set src(_value){queueMicrotask(()=>this.onload());}},
    document:{createElement:()=>({getContext:()=>({drawImage(){},getImageData(){reads++;return {data:pixels};}})})},
    require:name=>name==="three"?{...THREE,TextureLoader:class {load(){return new THREE.Texture();}}}:
      name.startsWith("@viewer/")?require(path.join(viewerRoot,"src",name.slice(8)+".cjs")):
      name==="./viewer-utils.cjs"?{assetUrl:file=>file}:dependencyRequire(name)
  });
  const renderer=mod.exports;
  const manifest={files:{"models/axe.json":{},"native/axe.png":{}},items:{"minecraft:iron_axe||none":"models/axe.json"}};
  renderer.configureModels({...manifest,revision:"one"});
  const item={material:"minecraft:iron_axe"};
  const results=await Promise.all([renderer.itemMesh(item,"thirdperson_righthand"),renderer.itemMesh(item,"thirdperson_lefthand")]);
  assert.equal(reads,1);assert.equal(modelLoads,1);
  assert.ok(results.every(group=>group.children[0].geometry.attributes.position.count===60));
  await renderer.itemMesh(item,"thirdperson_righthand");assert.equal(reads,1);
  renderer.configureModels({...manifest,revision:"two"});
  await renderer.itemMesh(item,"thirdperson_righthand");assert.equal(reads,2);assert.equal(modelLoads,2);
});

test("physical hands match the full native renderer and arm matrix in rest and motion", () => {
  const definitions=require("prismarine-viewer/viewer/lib/entity/entities.json").player.geometry.default.bones;
  assert.equal(playerHandBone("HAND"),"leftarm");
  assert.equal(playerHandBone("OFF_HAND"),"rightarm");
  for(const slim of [false,true]) for(const slot of ["HAND","OFF_HAND"]) for(let frame=0;frame<=24;frame++) {
    const side=slot==="HAND"?1:-1,walk=Math.sin(frame/24*Math.PI*2)*.62,yaw=frame/24*Math.PI*2;
    const pose=heldItemArmRotation({x:walk,y:0,z:0});
    const definition=definitions.find(bone=>bone.name.toLowerCase()===playerHandBone(slot));
    const actual=new THREE.Matrix4().makeRotationY(Math.PI-yaw)
      .multiply(new THREE.Matrix4().makeTranslation(...definition.pivot))
      .multiply(new THREE.Matrix4().makeRotationX(pose.x))
      .multiply(playerHandGripMatrix(slot,slim));
    // Independent native chain: LivingEntityRenderer, Java arm pivot/pose,
    // ItemInHandLayer rotations/offset, then item units. Ground origins are
    // normalized equally (the native renderer's universal .001 lift is omitted).
    const native=new THREE.Matrix4().makeRotationY(Math.PI-yaw)
      .multiply(new THREE.Matrix4().makeScale(-1,-1,1))
      .multiply(new THREE.Matrix4().makeTranslation(0,-24,0))
      .multiply(new THREE.Matrix4().makeTranslation(-side*5+(slim?side*.5:0),2,0))
      .multiply(new THREE.Matrix4().makeRotationX(-pose.x))
      .multiply(new THREE.Matrix4().makeRotationX(-Math.PI/2))
      .multiply(new THREE.Matrix4().makeRotationY(Math.PI))
      .multiply(new THREE.Matrix4().makeTranslation(side,2,-10))
      .multiply(new THREE.Matrix4().makeScale(16,16,16));
    for(const point of [[0,0,0],[1,0,0],[0,1,0],[0,0,1],[-.5,.5,-.03125]])close(transform(actual,point),transform(native,point));
    if(frame===0)assert.equal(Math.sign(transform(actual,[0,0,0])[0]),-side,"at yaw0 the physical right hand lies west, the left east");
  }
});
