"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { decodeChunk } = require("../src/chunk-codec.cjs");
const { sampleActor } = require("../src/actor-motion.cjs");
const {blockGeometry}=require("../src/block-geometry.cjs");

test("isolated BlockDisplay geometry supplies neighbour positions to stock face culling",()=>{
  const faces=Object.fromEntries(["north","south","west","east","up","down"].map(face=>[face,{cullface:face,texture:{u:0,v:0,su:1,sv:1}}]));
  const states={barrel:{variants:{"":{model:{ao:false,elements:[{from:[0,0,0],to:[16,16,16],faces}]}}}},air:{variants:{"":{model:{elements:[]}}}}};
  const geometry=blockGeometry("minecraft:barrel[facing=north,open=false]","1.21.11",states);
  assert.equal(geometry.positions.length,72);
  assert.equal(geometry.indices.length,36);
  assert.equal(Math.min(...geometry.positions),0);
  assert.equal(Math.max(...geometry.positions),1);
});
const { Vec3 } = require("vec3");

test("bounded RLE rebases terrain and preserves orientation and stair properties", () => {
  const data = { x: -3, z: 7, minY: -32, height: 16, palette: ["minecraft:air", "minecraft:oak_stairs[facing=west,half=bottom,shape=straight,waterlogged=false]"], runs: [273,0,1,1,3822,0] };
  const Chunk = require("prismarine-chunk")("1.21.11");
  const chunk = Chunk.fromJson(decodeChunk(data));
  assert.equal(chunk.minY, 0);
  assert.equal(chunk.getBlock(new Vec3(1,1,1)).name, "oak_stairs");
  assert.equal(chunk.getBlock(new Vec3(1,1,1)).getProperties().facing, "west");
  assert.throws(() => decodeChunk({ ...data, runs: [4095,0] }), /incomplete/);
  assert.throws(() => decodeChunk({ ...data, height: 384 }), /height/);
  assert.throws(() => decodeChunk({ ...data, runs: [4096,99] }), /range/);
});

test("actors interpolate the short yaw path and stop after stale frames", () => {
  const frame = (at, x, yaw) => ({ at, actors: new Map([["npc", { position:[x,64,0],yawDegrees:yaw,headYawDegrees:yaw,pitchDegrees:0 }]]) });
  const frames = [frame(1000,0,350),frame(1200,2,10),frame(1400,4,30)];
  const sample = sampleActor(frames,"npc",1350);
  assert.equal(sample.position[0],1);
  assert.equal(sample.yawDegrees,360);
  assert.equal(sampleActor(frames,"npc",2500).position[0],4);
  assert.equal(sampleActor(frames,"npc",2500).speed,0);
});
