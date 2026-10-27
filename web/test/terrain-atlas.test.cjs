"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCanvas, Image } = require("canvas");
const { padTerrainAtlas } = require("../scripts/terrain-atlas.cjs");

test("terrain atlas keeps every original texel and protects edge samples without moving geometry", (t) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"worldview-atlas-test-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,"textures"));fs.mkdirSync(path.join(root,"blocksStates"));
  const canvas=createCanvas(32,16),context=canvas.getContext("2d"),pixels=context.createImageData(32,16);
  for(let y=0;y<16;y++) for(let x=0;x<32;x++) pixels.data.set(x<16?[x,y,0,255]:[0,0,255,255],(y*32+x)*4);
  context.putImageData(pixels,0,0);fs.writeFileSync(path.join(root,"textures/test.png"),canvas.toBuffer("image/png"));
  const states={full:{u:0,v:0,su:0.5,sv:1},mirrored:{u:0.5,v:0,su:-0.5,sv:1,bu:0.25,bv:0.5},partial:{u:0.125,v:0.25,su:0.125,sv:0.25,bu:0.25,bv:0.5},element:{from:[0,0,0],to:[16,16,16]}};
  fs.writeFileSync(path.join(root,"blocksStates/test.json"),JSON.stringify(states));
  padTerrainAtlas(root,"test");
  const result=JSON.parse(fs.readFileSync(path.join(root,"blocksStates/test.json")));
  const image=new Image();image.src=fs.readFileSync(path.join(root,"textures/test.png"));
  const out=createCanvas(image.width,image.height),ctx=out.getContext("2d");ctx.drawImage(image,0,0);
  const sample=(u,v)=>[...ctx.getImageData(Math.floor(u*image.width),Math.floor(v*image.height),1,1).data];
  assert.deepEqual(result.element,states.element);
  for(let y=0;y<16;y++) for(let x=0;x<16;x++) assert.deepEqual(sample(result.full.u+(x+.5)/16*result.full.su,result.full.v+(y+.5)/16*result.full.sv),[x,y,0,255]);
  // An out-of-edge nearest sample used to hit the adjacent blue sprite.
  assert.deepEqual(sample(result.full.u+result.full.su+1/image.width,result.full.v+result.full.sv/2),[15,8,0,255]);
  assert.deepEqual(sample(result.full.u-1/image.width,result.full.v+result.full.sv/2),[0,8,0,255]);
  assert.deepEqual(sample(result.mirrored.u+result.mirrored.su/32,result.mirrored.v+result.mirrored.sv/32),[15,0,0,255]);
  assert.deepEqual(sample(result.partial.u+result.partial.su/8,result.partial.v+result.partial.sv/8),[4,4,0,255]);
});
