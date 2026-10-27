"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const THREE=require("three");
const {rememberActorFrame,sampleActor,interpolationDelay,actorWalk}=require("../src/actor-motion.cjs");
const epoch=1_800_000_000_000;
function harness(){
  const history=[],tracks=new Map();
  const push=(captured,received,x,sampled=captured,extra={})=>rememberActorFrame(history,{at:received,capturedAt:epoch+captured,
    actors:new Map([["p",{id:"p",kind:"player",type:"player",position:[x,64,0],yawDegrees:0,headYawDegrees:0,pitchDegrees:0,pose:"STANDING",scale:1,sampledAt:epoch+sampled,...extra}]])},tracks);
  return {history,tracks,push,sample:now=>sampleActor(history,"p",now,interpolationDelay(history),tracks.get("p"))};
}

test("sparse native caches retain true capture samples rather than manufacturing stationary observations",()=>{
  const h=harness();
  for(let time=0;time<=2400;time+=200){const sampled=Math.floor(time/1000)*1000;h.push(time,time+100,sampled/1000,sampled);h.sample(time+100);}
  assert.deepEqual(h.tracks.get("p").samples.map(sample=>sample.at-epoch),[0,1000,2000]);
  const values=[];for(let now=2500;now<3100;now+=16)values.push(h.sample(now));
  assert.ok(values.every(value=>Math.abs(value.speed-1)<1e-10));
  assert.ok(values.at(-1).position[0]>values[0].position[0]+.4);
  h.push(3000,3100,2,3000);
  for(let now=3100;now<=4400;now+=16)h.sample(now);
  assert.equal(h.sample(4450).position[0],2);assert.equal(h.sample(4450).speed,0,"a real new stationary capture confirms the stop");
});

test("jittered arrivals preserve source velocity and monotonic continuous rendered movement",()=>{
  const h=harness(),schedule=Array.from({length:10},(_,index)=>({source:index*1000,arrival:index*1000+[100,280,120,240,100][index%5]}));
  let next=0,previous=null,maxStep=0,moving=0;
  for(let now=0;now<9500;now+=16){
    while(schedule[next]?.arrival<=now){const frame=schedule[next++];h.push(frame.source,frame.arrival,frame.source/500);}
    const value=h.sample(now);if(!value)continue;
    if(previous){const step=value.position[0]-previous.position[0];assert.ok(step>=-1e-10,"receive jitter cannot rewind the actor");maxStep=Math.max(maxStep,step);}
    if(value.speed){assert.ok(Math.abs(value.speed-2)<1e-10,"velocity uses source capture intervals");moving++;}
    previous=value;
  }
  assert.ok(maxStep<=2*1.15*.016+1e-8,`packet arrival must not cause a position pop: ${maxStep}`);
  assert.ok(moving>350,"one-Hz packets still render many continuous moving frames");
});

test("changing capture cadence cannot rewind or jump the playhead",()=>{
  const h=harness();let last=0,maxStep=0;
  const source=[0,200,400,600,800,1000,2000,3000,3200,3400,3600,3800,4000];let index=0;
  for(let now=0;now<=4800;now+=16){
    while(source[index]!==undefined&&source[index]+100<=now){const time=source[index++];h.push(time,time+100,time/1000);}
    const value=h.sample(now);if(!value)continue;
    assert.ok(value.position[0]>=last-1e-10);maxStep=Math.max(maxStep,value.position[0]-last);last=value.position[0];
  }
  assert.ok(maxStep<=1.15*.016+1e-8,`bounded playback correction, found ${maxStep}`);
});

test("teleport, a long source gap and membership removal cannot leave a travelling or reappearing ghost",()=>{
  const h=harness();h.push(0,100,0);h.sample(100);h.push(1000,1100,1);for(let now=116;now<1500;now+=16)h.sample(now);
  h.push(1200,1500,30);const teleported=h.sample(1500);assert.equal(teleported.position[0],30);assert.equal(teleported.discontinuous,true);assert.equal(teleported.speed,0);
  h.push(5000,5100,31);const recovered=h.sample(5100);assert.equal(recovered.position[0],31);assert.equal(recovered.discontinuous,true);
  rememberActorFrame(h.history,{at:5300,capturedAt:epoch+5200,actors:new Map()},h.tracks);assert.equal(h.tracks.has("p"),false);assert.equal(h.sample(5350),null);
  h.push(5400,5500,-10);assert.equal(h.tracks.get("p").samples.length,1);assert.equal(h.sample(5500).position[0],-10);
  h.tracks.clear();assert.equal(h.tracks.size,0);
});

test("turning in place interpolates the short heading path without inventing a walking stride",()=>{
  const h=harness();h.push(0,100,0,0,{yawDegrees:350,headYawDegrees:355});h.sample(100);
  h.push(200,300,0,200,{yawDegrees:10,headYawDegrees:15});
  const value=h.sample(450);assert.ok(value.yawDegrees>=350&&value.yawDegrees<=370);assert.equal(value.speed,0);
  const state={};assert.equal(actorWalk(state,value,.016),0);assert.equal(actorWalk(state,h.sample(466),.016),0);
});

test("gait follows rendered distance at native cadence, fades quickly at rest and resets across discontinuities",()=>{
  const state={},value=x=>({position:[x,64,0],pose:"STANDING",scale:1});
  actorWalk(state,value(0),.016);let walk=0;
  for(let step=1;step<=60;step++)walk=actorWalk(state,value(step*.032),.016);
  assert.ok(Math.abs(state.phase-1.92*2.6648)<1e-10);assert.ok(state.walkAmplitude>.55&&state.walkAmplitude<.57);
  const amplitude=state.walkAmplitude,phase=state.phase;
  for(let step=0;step<20;step++)actorWalk(state,value(1.92),.016);
  assert.ok(state.walkAmplitude<amplitude*.01);assert.equal(state.phase,phase);assert.equal(state.walkAmplitude,0);
  actorWalk(state,{...value(30),discontinuous:true},.016);assert.equal(state.phase,0);assert.equal(state.walkAmplitude,0);
  actorWalk(state,{...value(30.1),seated:true},.016);assert.equal(state.walkAmplitude,0);
  assert.equal(actorWalk(state,value(30.2),.016,true),0);
  assert.ok(Number.isFinite(walk));
});

test("production player poses keep opposing natural arms and legs while idle and teleport return to rest",()=>{
  const source=fs.readFileSync(path.resolve(__dirname,"../src/app.cjs"),"utf8");
  const code=source.slice(source.indexOf("function applyActorPose("),source.indexOf("function viewQuery("));
  const {actorBoneRotations,offsetBoneRotation}=require("../vendor/renderer/src/actor-pose.cjs");
  const actor={mesh:new THREE.Group(),body:{material:{userData:{}}},bodies:[],bones:{},base:{}};
  for(const name of ["body","leftarm","rightarm","leftleg","rightleg","head"]){actor.bones[name]=new THREE.Bone();actor.base[name]={x:0,y:0,z:0};}
  const context=vm.createContext({THREE,actorWalk,actorBoneRotations,offsetBoneRotation,reducedMotion:false});
  vm.runInContext(code+"\nthis.pose=applyActorPose",context);
  const value=x=>({position:[x,64,0],yawDegrees:0,headYawDegrees:0,pitchDegrees:0,pose:"STANDING",scale:1});
  for(let index=0;index<30;index++)context.pose(actor,value(index*.05),.016);
  assert.ok(Math.abs(actor.bones.leftleg.rotation.x)>.1);
  assert.ok(Math.abs(actor.bones.leftleg.rotation.x+actor.bones.rightleg.rotation.x)<1e-10);
  assert.ok(Math.abs(actor.bones.leftarm.rotation.x+actor.bones.leftleg.rotation.x/1.4)<1e-10);
  for(let index=0;index<25;index++)context.pose(actor,value(1.45),.016);
  for(const name of ["leftarm","rightarm","leftleg","rightleg"])assert.equal(actor.bones[name].rotation.x,0);
  context.pose(actor,{...value(30),discontinuous:true},.016);assert.equal(actor.phase,0);
});
