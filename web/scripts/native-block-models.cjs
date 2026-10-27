"use strict";

const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");
const { createCanvas,Image }=require("canvas");
const { nativeBlockCuboid }=require("./native-block-cuboid.cjs");

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
  function cropped(texture,pixels) {
    const key=crypto.createHash("sha256").update(JSON.stringify([texture,pixels])).digest("hex").slice(0,20);
    const name=`arcworldview_native:block/${key}`;
    if(textures.has(name)) return textures.get(name);
    const file=path.join(root,"assets/minecraft/textures",texture+".png");
    if(!images.has(file)){
      const image=new Image();image.src=fs.readFileSync(file);
      const canvas=createCanvas(image.width,image.height),context=canvas.getContext("2d");context.drawImage(image,0,0);
      images.set(file,context.getImageData(0,0,image.width,image.height));
    }
    const source=images.get(file),[origin,right,bottom]=pixels;
    const du=right.map((n,i)=>n-origin[i]),dv=bottom.map((n,i)=>n-origin[i]);
    const w=Math.min(16,Math.hypot(...du)),h=Math.min(16,Math.hypot(...dv));
    const canvas=createCanvas(16,16),target=canvas.getContext("2d"),outputPixels=target.createImageData(16,16);
    for(let y=0;y<16;y++) for(let x=0;x<16;x++) {
      // Extrude the last row/column into unused sprite space. MSAA may evaluate
      // UVs just beyond a covered edge; transparent crop padding made pinholes.
      const s=(Math.min(x,w-1)+0.5)/w,t=(Math.min(y,h-1)+0.5)/h;
      const sx=Math.floor((origin[0]+du[0]*s+dv[0]*t)*source.width/64);
      const sy=Math.floor((origin[1]+du[1]*s+dv[1]*t)*source.width/64);
      outputPixels.data.set(source.data.subarray((sy*source.width+sx)*4,(sy*source.width+sx)*4+4),(y*16+x)*4);
    }
    target.putImageData(outputPixels,0,0);
    const output=path.join(root,"assets/arcworldview_native/textures/block",key+".png");fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,canvas.toBuffer("image/png"));
    const result={texture:name,uv:[0,0,w,h]};textures.set(name,result);return result;
  }
  function cube(texture,from,size,uv,transform) {
    const box=nativeBlockCuboid(from,size,uv,transform);
    return {...box,faces:Object.fromEntries(Object.entries(box.faces).map(([face,pixels])=>[face,cropped(texture,pixels)]))};
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
      const pose=([x,y,z])=>[16-x,9-z,16-y]; // BedRenderer.preparePose, facing south.
      const elements=[cube(skin,[0,0,0],[16,16,6],[0,part==="head"?0:22],pose)];
      if(part==="head") elements.push(
        cube(skin,[0,6,0],[3,3,3],[50,6],([x,y,z])=>pose([z,x,y])),
        cube(skin,[-16,6,0],[3,3,3],[50,18],([x,y,z])=>pose([-x,z,y]))
      );
      else elements.push(
        cube(skin,[0,6,-16],[3,3,3],[50,0],([x,y,z])=>pose([x,-z,y])),
        cube(skin,[-16,6,-16],[3,3,3],[50,12],([x,y,z])=>pose([-z,-x,y]))
      );
      const reference=model(`${color}_bed_${part}`,elements);
      for(const [facing,y] of Object.entries(cardinal)) variants[`facing=${facing},part=${part}`]={model:reference,y};
    }
    write(`minecraft/blockstates/${color}_bed.json`,{variants});
  }
  for(const wood of ["oak","spruce","birch","jungle","acacia","dark_oak","mangrove","cherry","pale_oak","bamboo","crimson","warped"]) {
    const skin=`entity/signs/${wood}`;
    const pose=([x,y,z])=>[8+x*2/3,8-y*2/3,8-z*2/3];
    const board=cube(skin,[-12,-14,-1],[24,12,2],[0,0],pose);
    const stick=cube(skin,[-1,-2,-1],[2,14,2],[0,14],pose);
    const standing=model(`${wood}_sign`,[board,stick]);
    write(`minecraft/blockstates/${wood}_sign.json`,{variants:Object.fromEntries(Array.from({length:16},(_,rotation)=>[`rotation=${rotation}`,{model:standing,y:rotation*22.5}]))});
    const wall=model(`${wood}_wall_sign`,[{...board,from:[0,13/3,1/3],to:[16,37/3,5/3]}]);
    write(`minecraft/blockstates/${wood}_wall_sign.json`,{variants:Object.fromEntries(Object.entries(cardinal).map(([facing,y])=>[`facing=${facing}`,{model:wall,y}]))});
  }
  for(const [id,value] of models) write(`${id.replace(":","/models/")}.json`,value);
  return {models:models.size,textures:textures.size};
}

module.exports={nativeBlockModels};
