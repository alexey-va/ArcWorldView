"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { terrainInstallQueue } = require("../src/terrain-install-queue.cjs");

function fixture() {
  const received = [], worker = {onmessage:event=>received.push(event.data),postMessage(){}};
  const terrain = {workers:[worker],sectionMeshs:{}};
  let clock = 0;
  const queue = terrainInstallQueue(terrain,()=>clock);
  const geometry = (key, value = 1, generation = queue.generation) => worker.onmessage({data:{worldViewGeneration:generation,type:"geometry",key,geometry:{positions:new Float32Array(value ? [value,0,0] : [])}}});
  return {terrain,queue,received,geometry,worker,advance:ms=>clock+=ms};
}

test("worker bursts coalesce by section and install at most four GPU buffers per frame",()=>{
  const {queue,received,geometry,worker} = fixture();
  for(let index=0;index<10;index++) geometry(String(index));
  geometry("0",2);
  worker.onmessage({data:{worldViewGeneration:0,type:"sectionFinished",key:"0"}});
  assert.deepEqual(received,[{worldViewGeneration:0,type:"sectionFinished",key:"0"}],"worker control messages are immediate");
  assert.equal(queue.size,10);
  assert.equal(queue.drain(),4);
  assert.equal(received[1].geometry.positions[0],2,"obsolete geometry is never installed");
  assert.equal(queue.size,6);
  queue.drain(); queue.drain();
  assert.equal(queue.size,0); assert.equal(received.length,11);
});

test("late results from a cleared epoch are rejected and visible sections install first",()=>{
  const {queue,received,geometry,worker} = fixture();
  const old = queue.generation;
  queue.clear();
  geometry("old",1,old);
  worker.onmessage({data:{worldViewGeneration:old,type:"sectionFinished",key:"old"}});
  geometry("far"); geometry("near");
  queue.prioritize(key=>key==="near"?0:1000);
  queue.drain(1);
  assert.equal(received.length,1); assert.equal(received[0].key,"near");
  assert.equal(queue.size,1);
});

test("the time budget stops a burst and scene clearing discards pending results",()=>{
  const {queue,received,geometry,advance} = fixture();
  for(let index=0;index<8;index++) geometry(String(index));
  const original = received.push.bind(received);
  received.push = data => { advance(2); return original(data); };
  assert.equal(queue.drain(),2);
  assert.equal(queue.size,6);
  queue.clear(); queue.drain();
  assert.equal(received.length,2);
});

test("air sections remove former geometry without constructing an empty mesh",()=>{
  const {terrain,queue,received,geometry} = fixture();
  let removed = 0, disposed = 0;
  terrain.sectionMeshs.air={parent:{remove(){removed++}},geometry:{dispose(){disposed++}}};
  geometry("air",0); geometry("empty",0);
  assert.equal(queue.drain(),0);
  assert.equal(removed,1); assert.equal(disposed,1);
  assert.deepEqual(terrain.sectionMeshs,{}); assert.equal(received.length,0);
});
