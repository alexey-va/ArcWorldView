"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createRequire } = require("node:module");
const { createCanvas, Image } = require("canvas");
const THREE = require("three");
const { renderTextDisplay, layoutText, textRuns } = require("../src/native-text-display.cjs");
const { displayQuaternion } = require("../src/display-pose.cjs");

const glyphImage = createCanvas(8,8);
glyphImage.getContext("2d").fillStyle = "white";
glyphImage.getContext("2d").fillRect(0,0,5,7);
const font = {glyphs:Object.fromEntries(["A","B"].map(char=>[char.codePointAt(0).toString(16).padStart(4,"0"),{url:"glyph.png",columns:1,rows:1,column:0,row:0,height:8,ascent:7}]))};
const run = (text, overrides = {}) => ({text,color:0xffffff,font:"minecraft:default",...overrides});
const render = (text, style = {}) => renderTextDisplay(text,style,font,async()=>glyphImage,createCanvas);
const pixel = (canvas,x,y) => [...canvas.getContext("2d").getImageData(x,y,1,1).data];

test("native text keeps its pixel scale, ten-pixel line pitch and lower anchor",async()=>{
  const result = await render("A\nAA",{backgroundColor:0});
  assert.equal(result.canvas.width,19); assert.equal(result.canvas.height,26);
  assert.ok(Math.abs(result.width-.475)<1e-10); assert.ok(Math.abs(result.height-.65)<1e-10);
  assert.equal(result.x,.0125); assert.equal(result.y,.25);
  assert.deepEqual(pixel(result.canvas,3,3),[0,0,0,0],"transparent native background remains transparent");
  assert.equal(await render("",{backgroundColor:0xff000000}),null,"empty text makes no black rectangle");
});

test("style runs tint native glyphs and retain independent background, opacity and shadow",async()=>{
  const styled = await render("A",{backgroundColor:0,runs:[run("A",{color:0xffaa00})],shadow:true});
  assert.deepEqual(pixel(styled.canvas,4,4),[255,170,0,255]);
  assert.deepEqual(pixel(styled.canvas,9,11),[63,42,0,255],"one-pixel shadow uses native quarter RGB");
  const translucent = await render("A",{backgroundColor:0,opacity:128});
  assert.equal(pixel(translucent.canvas,4,4)[3],128);
  const background = await render("A",{backgroundColor:0xff112233,opacity:0});
  assert.deepEqual(pixel(background.canvas,3,3),[17,34,51,255],"text opacity does not dim the background");
  const bold = await render("A A",{backgroundColor:0,runs:[run("A A",{bold:true,underlined:true})]});
  assert.equal(bold.canvas.width,26,"native bold advance also applies to space glyphs");
  assert.equal(pixel(bold.canvas,4,12)[3],255,"underline remains within the native line extent");
});

test("native wrapping and alignment use measured styled advances, with a bounded plain fallback",()=>{
  const cells = [..."AA AA"].map(character=>({character,advance:character===" "?4:6}));
  const layout = layoutText(cells,16,"CENTER");
  assert.deepEqual(layout.lines.map(line=>line.cells.map(c=>c.character).join("")),["AA","AA"]);
  assert.deepEqual(layoutText(cells,12).lines.map(line=>line.cells.map(c=>c.character).join("")),["AA","AA"],"an overflowing space is the break, not the next line's leading space");
  assert.deepEqual(layoutText([..."AAA"].map(character=>({character,advance:6})),1).lines.map(line=>line.width),[6,6,6],"one overwide glyph still makes progress");
  const uneven = [{character:"A",advance:6},{character:"\n",advance:0},{character:"A",advance:6},{character:"A",advance:6}];
  assert.deepEqual(layoutText(uneven,200,"LEFT").lines.map(line=>line.x),[0,0]);
  assert.deepEqual(layoutText(uneven,200,"RIGHT").lines.map(line=>line.x),[6,0]);
  assert.deepEqual(layoutText(uneven,200,"CENTER").lines.map(line=>line.x),[3,0]);
  assert.equal(textRuns("<img>",{runs:[run("different",{color:0xff0000})]})[0].text,"<img>");
  assert.equal(textRuns("<img>",{runs:[run("different",{color:0xff0000})]})[0].color,0xffffff);
});

test("native alpha discard applies independently to glyphs and background",async()=>{
  const invisible = await render("A",{backgroundColor:0x19112233,opacity:25});
  assert.equal(invisible.canvas.getContext("2d").getImageData(0,0,invisible.canvas.width,invisible.canvas.height).data.some(Boolean),false);
  const visible = await render("A",{backgroundColor:0x1a112233,opacity:26});
  assert.equal(pixel(visible.canvas,3,3)[3],26);
  assert.ok(pixel(visible.canvas,4,4)[3]>26,"text survives the same threshold above the background");
  const defaults = await render("A",{defaultBackground:true,backgroundColor:0xff112233,opacity:0});
  assert.deepEqual(pixel(defaults.canvas,3,3),[0,0,0,63],"default background follows the native .25 opacity fallback");
});

test("bitmap glyph advance uses native nearest rounding for scaled glyphs",async()=>{
  const scaledFont = {glyphs:{"0041":{...font.glyphs["0041"],height:5}}};
  const result = await renderTextDisplay("AA",{backgroundColor:0},scaledFont,async()=>glyphImage,createCanvas);
  assert.equal(result.canvas.width,15,"5 ink pixels at 5/8 scale advance by round(3.125)+1, not ceil(3.125)+1");
});

test("billboard constraints retain native entity axes and use the orthographic camera orientation",()=>{
  const camera = new THREE.Quaternion().setFromEuler(new THREE.Euler(.4,.7,0,"YXZ"));
  const result = new THREE.Quaternion();
  const expected = (x,y)=>new THREE.Quaternion().setFromEuler(new THREE.Euler(x,y,0,"YXZ"));
  const pitch = 10*Math.PI/180, yaw=-60*Math.PI/180;
  assert.ok(displayQuaternion("FIXED",60,10,camera,result).angleTo(expected(pitch,yaw))<1e-7);
  assert.ok(displayQuaternion("VERTICAL",60,10,camera,result).angleTo(expected(pitch,.7))<1e-7);
  assert.ok(displayQuaternion("HORIZONTAL",60,10,camera,result).angleTo(expected(.4,yaw))<1e-7);
  assert.ok(displayQuaternion("CENTER",60,10,camera,result).angleTo(camera)<1e-7);
});

test("production display poses retain translation, both SRT rotations and native text anchor",()=>{
  const source=fs.readFileSync(path.resolve(__dirname,"../src/app.cjs"),"utf8");
  const actorCode=source.slice(source.indexOf("function displayActor("),source.indexOf("async function updateDisplay("));
  const poseCode=source.slice(source.indexOf("function applyActorPose("),source.indexOf("function viewQuery("));
  const camera=new THREE.OrthographicCamera(-5,5,5,-5,.1,100);
  camera.position.set(5,4,8); camera.lookAt(0,0,0);
  const context=vm.createContext({THREE,displayQuaternion,actors:new Map(),scene:new THREE.Scene(),camera});
  vm.runInContext(actorCode+poseCode+"\nthis.displayActor=displayActor; this.applyActorPose=applyActorPose",context);
  const left=new THREE.Quaternion().setFromEuler(new THREE.Euler(.2,.5,0));
  const right=new THREE.Quaternion().setFromEuler(new THREE.Euler(0,-.3,.4));
  const record={id:"caption",type:"minecraft:text_display",position:[4,6,8],yawDegrees:60,pitchDegrees:10,
    display:{kind:"text",billboard:"VERTICAL",translation:[.5,.8,-.2],scale:[2,3,.75],leftRotation:left.toArray(),rightRotation:right.toArray()}};
  const actor=context.displayActor(record);
  context.applyActorPose(actor,record,0); actor.mesh.updateMatrixWorld(true);
  const orientation=displayQuaternion("VERTICAL",60,10,camera.quaternion,new THREE.Quaternion());
  const expected=new THREE.Vector3(.0125,.25,0).applyQuaternion(right).multiply(new THREE.Vector3(2,3,.75)).applyQuaternion(left)
    .add(new THREE.Vector3(.5,.8,-.2)).applyQuaternion(orientation).add(new THREE.Vector3(4,6,8));
  assert.ok(actor.display.content.localToWorld(new THREE.Vector3(.0125,.25,0)).distanceTo(expected)<1e-10);
  const before=actor.mesh.quaternion.clone();
  record.position=[-40,6,-30]; context.applyActorPose(actor,record,0);
  assert.ok(actor.mesh.quaternion.angleTo(before)<1e-7,"orthographic billboard rotation does not depend on entity position");
});

test("production text meshes cull their back face and retain native see-through semantics",async()=>{
  const file = require.resolve("../src/model-renderer.cjs"), dependencyRequire=createRequire(file), mod={exports:{}};
  const rendererRoot=require("../scripts/viewer-source.cjs").viewerSource();
  class GlyphImage extends Image { set src(_value) { super.src=glyphImage.toBuffer("image/png"); } }
  vm.runInNewContext(fs.readFileSync(file,"utf8"),{
    module:mod,exports:mod.exports,Image:GlyphImage,
    document:{createElement:()=>createCanvas(1,1)},
    fetch:async()=>({ok:true,json:async()=>font}),
    require:name=>name.startsWith("@viewer/")?require(path.join(rendererRoot,"src",name.slice(8)+".cjs")):
      name==="./viewer-utils.cjs"?{assetUrl:value=>value}:dependencyRequire(name)
  });
  mod.exports.configureModels({revision:"text-native",font:"font.json",files:{"font.json":{}}});
  const mesh=await mod.exports.textMesh("A",{backgroundColor:0});
  mesh.updateMatrixWorld(true);
  assert.equal(mesh.material.side,THREE.FrontSide);
  assert.equal(new THREE.Raycaster(new THREE.Vector3(0,.1,10),new THREE.Vector3(0,0,-1)).intersectObject(mesh).length>0,true);
  assert.equal(new THREE.Raycaster(new THREE.Vector3(0,.1,-10),new THREE.Vector3(0,0,1)).intersectObject(mesh).length,0,"a paired caption's rear plane cannot bleed through");
  const seeThrough=await mod.exports.textMesh("A",{seeThrough:true});
  assert.equal(seeThrough.material.depthTest,false); assert.equal(seeThrough.material.depthWrite,false);
});

test("changing only native text style invalidates the displayed content",async()=>{
  const source=fs.readFileSync(path.resolve(__dirname,"../src/app.cjs"),"utf8");
  const code=source.slice(source.indexOf("async function updateDisplay("),source.indexOf("async function updateEquipment("));
  const actor={display:{content:new THREE.Group()}}, actors=new Map([["caption",actor]]), calls=[];
  const scope=vm.createContext({actors,disposeMesh(){},textMesh:async(text,style)=>{calls.push({text,style});return new THREE.Group()}});
  vm.runInContext(code+"\nthis.updateDisplay=updateDisplay",scope);
  await scope.updateDisplay(actor,{id:"caption",display:{kind:"text",text:"A",textStyle:{opacity:255}}});
  await scope.updateDisplay(actor,{id:"caption",display:{kind:"text",text:"A",textStyle:{opacity:128}}});
  assert.equal(calls.length,2); assert.equal(calls[1].style.opacity,128);
});
