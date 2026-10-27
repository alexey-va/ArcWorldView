"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { decodeChunk } = require("../src/chunk-codec.cjs");
const { sampleActor, interpolationDelay, rememberActorFrame } = require("../src/actor-motion.cjs");
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

test("one-Hz snapshots keep a continuous gait until the buffered movement ends", () => {
  const frame = (at, x, capturedAt = at) => ({ at, capturedAt, actors:new Map([["npc",{ position:[x,64,0] }]]) });
  const history = [frame(1000,0),frame(2000,1),frame(3000,2)];
  assert.equal(interpolationDelay(history),1000);
  for (const now of [3000,3250,3500,3750,3999]) {
    const value = sampleActor(history,"npc",now);
    assert.equal(value.speed,1);
    assert.ok(value.position[0] >= .85 && value.position[0] < 2);
  }
  assert.equal(sampleActor(history,"npc",4151).position[0],2);
  assert.equal(sampleActor(history,"npc",4151).speed,0,"no extrapolated gait after the bounded jitter buffer runs out");
  const fast = [frame(1000,0),frame(1200,1),frame(1400,2)];
  assert.equal(interpolationDelay(fast),250,"5 Hz retains the existing delay");
  assert.equal(interpolationDelay([frame(1000,0,1000),frame(2800,1,1200)]),250,"network jitter does not set source cadence");
  assert.equal(interpolationDelay([frame(1000,0),frame(20000,1)]),1250,"a source outage cannot grow the buffer without a bound");
});

test("display scale, translation and both quaternions interpolate between snapshots", () => {
  const record = (scale, angle) => ({ position:[0,64,0], display:{ kind:"item",scale:[scale,scale,1],translation:[scale,0,0],leftRotation:[0,Math.sin(angle/2),0,Math.cos(angle/2)],rightRotation:[Math.sin(angle/2),0,0,Math.cos(angle/2)] } });
  const history = [{at:1000,actors:new Map([["portal",record(1,Math.PI-.2)]])},{at:1200,actors:new Map([["portal",record(3,-Math.PI+.2)]])}];
  const middle = sampleActor(history,"portal",1350).display;
  assert.deepEqual(middle.scale,[2,2,1]);
  assert.deepEqual(middle.translation,[2,0,0]);
  assert.ok(Math.abs(Math.abs(middle.leftRotation[1])-1)<1e-10,"short quaternion path crosses PI");
  assert.ok(Math.abs(Math.abs(middle.rightRotation[0])-1)<1e-10);
  assert.notDeepEqual(sampleActor(history,"portal",1300).display.scale,sampleActor(history,"portal",1400).display.scale,"display transforms move between poll boundaries");
});

test("view changes refresh the same source snapshot without adding a false zero-speed observation",()=>{
  const frame = (at, capturedAt, x) => ({at,capturedAt,actors:new Map([["npc",{position:[x,64,0]}]])});
  const history = [];
  rememberActorFrame(history,frame(1000,1000,0));
  rememberActorFrame(history,frame(1200,1200,1));
  const view = frame(1400,1200,1);
  view.actors.set("entered",{position:[2,64,0]});
  rememberActorFrame(history,view);
  assert.equal(history.length,2);
  assert.equal(history.at(-1).at,1200);
  assert.equal(history.at(-1).actors.has("entered"),true);
  assert.equal(sampleActor(history,"npc",1350).speed,5);
  assert.equal(sampleActor(history,"npc",1451).speed,0);
});
