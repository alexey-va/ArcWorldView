"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const THREE = require("three");
const { rememberDisplayClock, sampleDisplayAnimation } = require("../src/display-animation.cjs");

const epoch = 1_800_000_000_000;
const pose = frame => ({ position:[frame,64,2],yawDegrees:frame,pitchDegrees:frame/2,translation:[0,frame/10,0],scale:[1+frame/10,1,1],
  leftRotation:[0,0,0,1],rightRotation:[0,0,0,1],itemIndex:frame<4?0:1 });
const item = material => ({material:`minecraft:${material}`,amount:1});
const record = (capturedAt = epoch, first = 0) => ({id:"crate:reward:0",kind:"display",type:"item_display",position:[first,64,2],
  yawDegrees:first,pitchDegrees:first/2,display:{kind:"item",mode:"GROUND",billboard:"CENTER",item:item("diamond"),
    animation:{capturedAt,capturedFrame:first,sampleMillis:100,items:[item("diamond"),item("emerald")],
      itemSwitches:[{offsetMillis:0,itemIndex:0},{offsetMillis:350,itemIndex:1}],samples:Array.from({length:21},(_,index)=>pose(first+index))}}});
const clock = () => {const value={}; rememberDisplayClock(value,epoch,1000); return value;};

test("forward keyframes interpolate in rAF independently of the snapshot interpolation delay",()=>{
  const value=sampleDisplayAnimation(record(),1150,clock());
  assert.deepEqual(value.position,[1.5,64,2]);
  assert.equal(value.yawDegrees,1.5); assert.equal(value.pitchDegrees,.75);
  assert.ok(Math.abs(value.display.translation[1]-.15)<1e-10);
  assert.ok(Math.abs(value.display.scale[0]-1.15)<1e-10);
  assert.equal(value.display.item.material,"minecraft:diamond");
  assert.equal(value.id,"crate:reward:0");
});

test("discrete palette switches occur at their native 50ms boundary between 100ms poses",()=>{
  const source=record(), time=clock();
  assert.equal(sampleDisplayAnimation(source,1349.999,time).display.item.material,"minecraft:diamond");
  assert.equal(sampleDisplayAnimation(source,1350,time).display.item.material,"minecraft:emerald");
  assert.equal(sampleDisplayAnimation(source,1399,time).display.item.material,"minecraft:emerald");
  delete source.display.animation.itemSwitches;
  assert.equal(sampleDisplayAnimation(source,1399,time).display.item.material,"minecraft:diamond","old sample-only windows retain discrete left-keyframe selection");
  assert.equal(sampleDisplayAnimation(source,1400,time).display.item.material,"minecraft:emerald");
});

test("clock mapping survives cached polls, clock skew and delayed window refreshes without restarting phase",()=>{
  const time=clock(), source=record();
  rememberDisplayClock(time,epoch,1700);
  assert.equal(time.offset,epoch-1000,"cached source timestamp cannot reset receive origin");
  assert.equal(sampleDisplayAnimation(source,1800,time).position[0],8);
  const next=record(epoch+1000,10);
  const before=sampleDisplayAnimation(source,2300,time);
  rememberDisplayClock(time,epoch+1000,2200);
  assert.equal(time.offset,epoch-1000,"a slower response cannot rewind the server clock");
  assert.equal(sampleDisplayAnimation(next,2300,time).position[0],before.position[0]);
  assert.equal(sampleDisplayAnimation(next,2300,time).position[0],13,"a new window retains 300ms of elapsed server time");
  const shifted=record(epoch+86_400_000), shiftedClock={};
  rememberDisplayClock(shiftedClock,epoch+86_400_000,1000);
  assert.deepEqual(sampleDisplayAnimation(shifted,2300,shiftedClock).position,sampleDisplayAnimation(source,2300,clock()).position,"absolute epoch skew cannot change monotonic playback");
});

test("stale windows freeze at the two-second horizon and a stale first frame never replays old effects",()=>{
  const source=record(), time=clock();
  for(const now of [3000,5000,1e9]) {
    assert.equal(sampleDisplayAnimation(source,now,time).position[0],20);
    assert.equal(sampleDisplayAnimation(source,now,time).display.item.material,"minecraft:emerald");
  }
  const staleClock={}; rememberDisplayClock(staleClock,epoch,1000,true);
  assert.equal(sampleDisplayAnimation(source,1000,staleClock).position[0],20);
  rememberDisplayClock(staleClock,epoch,1500,false);
  assert.equal(sampleDisplayAnimation(source,1500,staleClock).position[0],20,"cached stale window stays frozen");
  rememberDisplayClock(staleClock,epoch+1000,2000,false);
  assert.equal(sampleDisplayAnimation(record(epoch+1000,10),2100,staleClock).position[0],11,"a fresh source window resumes current phase");
});

test("keyframes use the short yaw and quaternion paths and reject malformed pose windows",()=>{
  const source=record(), animation=source.display.animation;
  animation.samples=[{...pose(0),yawDegrees:350,leftRotation:new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),Math.PI-.2).toArray()},
    {...pose(2),yawDegrees:10,leftRotation:new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),-Math.PI+.2).toArray()}];
  const middle=sampleDisplayAnimation(source,1050,clock());
  assert.equal(middle.yawDegrees,360);
  assert.ok(Math.abs(Math.abs(middle.display.leftRotation[1])-1)<1e-10);
  for(const overrides of [{sampleMillis:0},{sampleMillis:Infinity},{capturedAt:"invalid"},{samples:Array(22).fill(pose(0))},{samples:[{...pose(0),position:[NaN,0,0]}]}]) {
    assert.equal(sampleDisplayAnimation({...source,display:{...source.display,animation:{...animation,...overrides}}},1050,clock()),null);
  }
});

test("rAF samples the latest display window while ordinary actors keep their existing history path",()=>{
  const source=fs.readFileSync(path.resolve(__dirname,"../src/app.cjs"),"utf8");
  const code=source.slice(source.indexOf("function animate("),source.indexOf("async function start("));
  const observed=[], content=[], actor={record:record(),display:{},mesh:{visible:true}}, historyCalls=[];
  const scope=vm.createContext({requestAnimationFrame(){},document:{hidden:false},workerFailed:false,lastLoopAt:0,controls:{update(){}},selectedScene:null,
    terrainInstalls:{drain(){}},currentView:null,actors:new Map([[actor.record.id,actor]]),history:[],interpolationDelay:()=>1000,displayClock:clock(),
    sampleDisplayAnimation,sampleActor:(...args)=>{historyCalls.push(args);return {position:[100,64,2]};},updateDisplay:(_actor,value)=>content.push(value),
    applyActorPose:(_actor,value)=>observed.push(value),hasGeometry:true,lastTransportAt:0,animateModelTextures(){},atmosphere:{render(){}}});
  vm.runInContext(code+"\nthis.animate=animate",scope); scope.animate(1500);
  assert.equal(observed[0].position[0],5); assert.equal(content[0].display.item.material,"minecraft:emerald"); assert.equal(historyCalls.length,0);
  delete actor.record.display.animation; scope.animate(1600);
  assert.equal(historyCalls.length,1); assert.equal(historyCalls[0][3],1000,"existing .3 delay remains in use for ordinary/native actors");
});

test("refreshing animation samples preserves the current mesh until its selected item changes",async()=>{
  const source=fs.readFileSync(path.resolve(__dirname,"../src/app.cjs"),"utf8");
  const code=source.slice(source.indexOf("async function updateDisplay("),source.indexOf("async function updateEquipment("));
  const actor={display:{content:new THREE.Group()}}, records=new Map([["crate:reward:0",actor]]), calls=[];
  const scope=vm.createContext({actors:records,disposeMesh(mesh){mesh.parent?.remove(mesh);},itemMesh:async(value)=>{calls.push(value);return new THREE.Group();}});
  vm.runInContext(code+"\nthis.updateDisplay=updateDisplay",scope);
  await scope.updateDisplay(actor,record());
  await scope.updateDisplay(actor,record(epoch+1000,10));
  assert.equal(calls.length,1,"timestamps, sample windows and capturedFrame do not rebuild geometry");
  await scope.updateDisplay(actor,sampleDisplayAnimation(record(),1400,clock()));
  assert.equal(calls.length,2); assert.equal(calls[1].material,"minecraft:emerald");
});
