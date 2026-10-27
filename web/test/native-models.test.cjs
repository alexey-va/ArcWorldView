"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {createCanvas}=require("canvas");
const {nativeBlockModels}=require("../scripts/native-block-models.cjs");

test("native chest halves join without a gap; beds keep feet and signs keep separate board/stick geometry",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"worldview-native-models-"));
  const png=createCanvas(64,64).toBuffer("image/png");
  const write=(name)=>{const file=path.join(root,"assets/minecraft/textures/entity",name+".png");fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,png);};
  try{
    for(const name of ["normal","trapped","ender"]) for(const part of name==="ender"?[""]:["","_left","_right"]) write(`chest/${name}${part}`);
    for(const color of ["white","orange","magenta","light_blue","yellow","lime","pink","gray","light_gray","cyan","purple","blue","brown","green","red","black"])write(`bed/${color}`);
    for(const wood of ["oak","spruce","birch","jungle","acacia","dark_oak","mangrove","cherry","pale_oak","bamboo","crimson","warped"])write(`signs/${wood}`);
    nativeBlockModels(root);
    const read=(name)=>JSON.parse(fs.readFileSync(path.join(root,"assets/arcworldview_native/models/block",name+".json")));
    const single=read("chest_single"),left=read("chest_left"),right=read("chest_right");
    assert.equal(single.elements.length,3);
    assert.deepEqual(single.elements[0].from,[1,0,1]);
    assert.deepEqual(single.elements[1].to,[15,14,15]);
    assert.equal(right.elements[0].to[0],16+left.elements[0].from[0]);
    const bed=read("red_bed_head");assert.equal(bed.elements.length,3);
    assert.deepEqual(bed.elements[0].from,[0,3,0]);assert.deepEqual(bed.elements[0].to,[16,9,16]);
    assert.equal(read("oak_sign").elements.length,2);assert.equal(read("oak_wall_sign").elements.length,1);
    const face=single.elements[0].faces.south;
    assert.deepEqual(face.uv,[0,0,14,10]);
    const texture=path.join(root,"assets",face.texture.replace(":","/textures/")+".png");
    assert.ok(fs.existsSync(texture));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
