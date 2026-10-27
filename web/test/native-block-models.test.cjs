"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCanvas, Image } = require("canvas");
const { nativeBlockCuboid } = require("../scripts/native-block-cuboid.cjs");
const { nativeBlockModels } = require("../scripts/native-block-models.cjs");

test("native chest lid uses its outside face and keeps the front latch UVs", () => {
  const lid = nativeBlockCuboid([1,9,1], [14,5,14], [0,0]);
  assert.deepEqual(lid.faces.up, [[28,14],[42,14],[28,0]]);
  const lock = nativeBlockCuboid([7,7,15], [2,4,1], [0,0]);
  assert.deepEqual(lock.faces.south, [[6,5],[4,5],[6,1]]);
  assert.deepEqual(lock.from, [7,7,15]);
  assert.deepEqual(lock.to, [9,11,16]);
});

test("bed's native pose puts the pillow at the head end and the mattress at 3..9 pixels", () => {
  const pose = ([x,y,z]) => [16-x,9-z,16-y];
  const head = nativeBlockCuboid([0,0,0], [16,16,6], [0,0], pose);
  assert.deepEqual(head.from, [0,3,0]);
  assert.deepEqual(head.to, [16,9,16]);
  assert.deepEqual(head.faces.up, [[22,22],[6,22],[22,6]]);
  assert.deepEqual(head.faces.south, [[22,6],[6,6],[22,0]]);
  const foot = nativeBlockCuboid([0,0,0], [16,16,6], [0,22], pose);
  assert.deepEqual(foot.faces.up, [[22,44],[6,44],[22,28]]);
});

test("generated sprites retain native texel orientation, double joins, and all four bed feet", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worldview-native-block-test-"));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const canvas = createCanvas(64,64), context = canvas.getContext("2d"), pixels = context.createImageData(64,64);
  for (let y=0; y<64; y++) for (let x=0; x<64; x++) pixels.data.set([x,y,0,255],(y*64+x)*4);
  context.putImageData(pixels,0,0);
  const inputs = [
    ...["normal","normal_left","normal_right","trapped","trapped_left","trapped_right","ender"].map((name)=>`chest/${name}`),
    ...["white","orange","magenta","light_blue","yellow","lime","pink","gray","light_gray","cyan","purple","blue","brown","green","red","black"].map((name)=>`bed/${name}`),
    ...["oak","spruce","birch","jungle","acacia","dark_oak","mangrove","cherry","pale_oak","bamboo","crimson","warped"].map((name)=>`signs/${name}`)
  ];
  for (const name of inputs) {
    const file = path.join(root, `assets/minecraft/textures/entity/${name}.png`);
    fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,canvas.toBuffer("image/png"));
  }
  nativeBlockModels(root);
  const model = (name) => JSON.parse(fs.readFileSync(path.join(root, `assets/arcworldview_native/models/block/${name}.json`)));
  const pixel = (face,x,y) => {
    const image = new Image(); image.src = fs.readFileSync(path.join(root,"assets",face.texture.replace(":","/textures/")+".png"));
    const c=createCanvas(16,16),ctx=c.getContext("2d"); ctx.drawImage(image,0,0);
    return [...ctx.getImageData(x,y,1,1).data];
  };
  const chest = model("chest_single");
  assert.deepEqual(pixel(chest.elements[1].faces.up,0,0), [28,13,0,255]);
  assert.deepEqual(pixel(chest.elements[2].faces.south,0,0), [5,4,0,255]);
  // Crop padding repeats the last texel instead of turning the narrow latch
  // or chest-edge samples transparent just outside their face's UV rectangle.
  assert.deepEqual(pixel(chest.elements[2].faces.south,15,15), [4,1,0,255]);
  for (const part of [0,1,2]) assert.equal(model("chest_right").elements[part].to[0],16);
  for (const part of [0,1,2]) assert.equal(model("chest_left").elements[part].from[0],0);
  const head=model("red_bed_head"),foot=model("red_bed_foot");
  assert.deepEqual(pixel(head.elements[0].faces.up,0,0), [21,21,0,255]);
  assert.deepEqual(pixel(head.elements[0].faces.up,0,15), [21,6,0,255]);
  assert.deepEqual(head.elements.slice(1).map(({from,to})=>({from,to})), [
    {from:[13,0,13],to:[16,3,16]}, {from:[0,0,13],to:[3,3,16]}
  ]);
  assert.deepEqual(foot.elements.slice(1).map(({from,to})=>({from,to})), [
    {from:[13,0,0],to:[16,3,3]}, {from:[0,0,0],to:[3,3,3]}
  ]);
});
