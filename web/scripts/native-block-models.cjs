"use strict";

const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");
const { createCanvas,Image }=require("canvas");

// Closed/resting geometry from the pinned 1.21.11 client (SHA-1 ba2df812...):
// ChestModel.createSingleBodyLayer/createDoubleBody{Left,Right}Layer,
// BedRenderer.create{Head,Foot}Layer and SignRenderer.createSignLayer.
// Official mappings: piston-data.mojang.com/v1/objects/
// 031a68bebf55d824f66d6573d8c752f0e1bf232a/client.txt.
// Convert those block-entity parts to ordinary models. Stock Prismarine then
// meshes them in its worker alongside terrain, without a library patch.
function nativeBlockModels(root) {
  const write=(file,value)=>{ const target=path.join(root,"assets",file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,JSON.stringify(value)); };
  const models=new Map(),images=new Map(),textures=new Map();
  function cropped(texture,rect,turn=0) {
    const key=crypto.createHash("sha256").update(JSON.stringify([texture,rect,turn])).digest("hex").slice(0,20);
    const name=`arcworldview_native:block/${key}`;
    if(textures.has(name)) return textures.get(name);
    const file=path.join(root,"assets/minecraft/textures",texture+".png");
    if(!images.has(file)){const image=new Image();image.src=fs.readFileSync(file);images.set(file,image);}
    const source=images.get(file),[x,y,width,height]=rect;
    const crop=createCanvas(width,height),ctx=crop.getContext("2d");ctx.imageSmoothingEnabled=false;
    ctx.drawImage(source,x*source.width/64,y*source.width/64,width*source.width/64,height*source.width/64,0,0,width,height);
    const canvas=createCanvas(16,16),target=canvas.getContext("2d");target.imageSmoothingEnabled=false;
    const w=Math.min(16,turn%2?height:width),h=Math.min(16,turn%2?width:height);
    target.save();
    if(turn===1){target.translate(w,0);target.rotate(Math.PI/2);target.drawImage(crop,0,0,h,w);}
    else if(turn===2){target.translate(w,h);target.rotate(Math.PI);target.drawImage(crop,0,0,w,h);}
    else if(turn===3){target.translate(0,h);target.rotate(-Math.PI/2);target.drawImage(crop,0,0,h,w);}
    else target.drawImage(crop,0,0,w,h);
    target.restore();
    const output=path.join(root,"assets/arcworldview_native/textures/block",key+".png");fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,canvas.toBuffer("image/png"));
    const result={texture:name,uv:[0,0,w,h]};textures.set(name,result);return result;
  }
  function cube(texture,from,size,uv,{sourceSize=size,faceMap={},turns={}}={}) {
    const [x,y,z]=sourceSize,[u,v]=uv;
    const rectangles={west:[u,v+z,z,y],north:[u+z,v+z,x,y],east:[u+z+x,v+z,z,y],south:[u+z+x+z,v+z,x,y],up:[u+z,v,x,z],down:[u+z+x,v,x,z]};
    return {from,to:from.map((value,i)=>value+size[i]),faces:Object.fromEntries(Object.keys(rectangles).map((face)=>[face,cropped(texture,rectangles[faceMap[face]??face],turns[face]??0)]))};
  }
  function model(name,elements) {
    const id=`arcworldview_native:block/${name}`;
    models.set(id,{ambientocclusion:true,textures:{particle:"minecraft:block/oak_planks"},elements});
    return id;
  }
  const cardinal={south:0,west:90,north:180,east:270};
  for(const [block,texture] of [["chest","normal"],["trapped_chest","trapped"],["ender_chest","ender"]]) {
    const variants={};
    for(const type of block==="ender_chest"?["single"]:["single","left","right"]) {
      const x=type==="left"?0:1,width=type==="single"?14:15;
      const skin=`entity/chest/${texture}${type==="single"?"":"_"+type}`;
      const elements=[cube(skin,[x,0,1],[width,10,14],[0,19]),cube(skin,[x,9,1],[width,5,14],[0,0]),cube(skin,[type==="single"?7:type==="left"?0:15,7,15],[type==="single"?2:1,4,1],[0,0])];
      const reference=model(`${block}_${type}`,elements);
      for(const [facing,y] of Object.entries(cardinal)) variants[`facing=${facing}${block==="ender_chest"?"":`,type=${type}`}`]={model:reference,y};
    }
    write(`minecraft/blockstates/${block}.json`,{variants});
  }
  const colors=["white","orange","magenta","light_blue","yellow","lime","pink","gray","light_gray","cyan","purple","blue","brown","green","red","black"];
  for(const color of colors) {
    const variants={};
    for(const part of ["head","foot"]) {
      const skin=`entity/bed/${color}`;
      const elements=[cube(skin,[0,3,0],[16,6,16],[0,part==="head"?0:22],{sourceSize:[16,16,6],faceMap:{up:"north",down:"south",north:"down",south:"up"},turns:{west:1,east:3}})];
      const z=part==="head"?13:0;
      elements.push(cube(skin,[0,0,z],[3,3,3],[50,part==="head"?6:0]),cube(skin,[13,0,z],[3,3,3],[50,part==="head"?18:12]));
      const reference=model(`${color}_bed_${part}`,elements);
      for(const [facing,y] of Object.entries(cardinal)) variants[`facing=${facing},part=${part}`]={model:reference,y};
    }
    write(`minecraft/blockstates/${color}_bed.json`,{variants});
  }
  for(const wood of ["oak","spruce","birch","jungle","acacia","dark_oak","mangrove","cherry","pale_oak","bamboo","crimson","warped"]) {
    const skin=`entity/signs/${wood}`;
    const board=cube(skin,[0,28/3,22/3],[16,8,4/3],[0,0],{sourceSize:[24,12,2]});
    const stick=cube(skin,[22/3,0,22/3],[4/3,28/3,4/3],[0,14],{sourceSize:[2,14,2]});
    const standing=model(`${wood}_sign`,[board,stick]);
    write(`minecraft/blockstates/${wood}_sign.json`,{variants:Object.fromEntries(Array.from({length:16},(_,rotation)=>[`rotation=${rotation}`,{model:standing,y:rotation*22.5}]))});
    const wall=model(`${wood}_wall_sign`,[{...board,from:[0,13/3,1/3],to:[16,37/3,5/3]}]);
    write(`minecraft/blockstates/${wood}_wall_sign.json`,{variants:Object.fromEntries(Object.entries(cardinal).map(([facing,y])=>[`facing=${facing}`,{model:wall,y}]))});
  }
  for(const [id,value] of models) write(`${id.replace(":","/models/")}.json`,value);
  return {models:models.size,textures:textures.size};
}

module.exports={nativeBlockModels};
