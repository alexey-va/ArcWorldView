"use strict";

// Local visual fixture only. Its named synthetic scene is never bundled into the plugin.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const root = path.resolve(__dirname, "..");
const assetsRoot = path.resolve(process.env.ARC_WORLDVIEW_ASSETS ?? path.join(root, ".assets"));
const current = JSON.parse(fs.readFileSync(path.join(assetsRoot, "current.json"), "utf8"));
const revision = current.revision;
const manifest=JSON.parse(fs.readFileSync(path.join(assetsRoot,revision,"manifest.json"),"utf8"));
const websiteRoot=process.env.WEBSITE_DIST ? path.resolve(process.env.WEBSITE_DIST) : null;
const blocks = new Map();
const set = (x, y, z, block) => blocks.set(`${x},${y},${z}`, block.startsWith("minecraft:") ? block : `minecraft:${block}`);
const fill = (x0,y0,z0,x1,y1,z1,block) => { for(let y=y0;y<y1;y++) for(let z=z0;z<z1;z++) for(let x=x0;x<x1;x++) set(x,y,z,block); };
fill(-24,56,-24,24,61,24,"stone"); fill(-24,61,-24,24,62,24,"dirt"); fill(-24,62,-24,24,63,24,"grass_block[snowy=false]");
for (let x=-24;x<24;x++) for(let z=-2;z<3;z++) set(x,62,z,"dirt_path");
for (let z=-24;z<24;z++) for(let x=-2;x<3;x++) set(x,62,z,"dirt_path");

function house(x,z,width=8,depth=8) {
  fill(x,63,z,x+width,64,z+depth,"cobblestone");
  for(let y=64;y<68;y++) {
    for(let xx=x;xx<x+width;xx++) { set(xx,y,z,"oak_planks"); set(xx,y,z+depth-1,"oak_planks"); }
    for(let zz=z;zz<z+depth;zz++) { set(x,y,zz,"oak_planks"); set(x+width-1,y,zz,"oak_planks"); }
  }
  for(const xx of [x,x+width-1]) for(const zz of [z,z+depth-1]) fill(xx,64,zz,xx+1,68,zz+1,"oak_log[axis=y]");
  const door=x+Math.floor(width/2);
  set(door,64,z,"oak_door[facing=north,half=lower,hinge=left,open=false,powered=false]");
  set(door,65,z,"oak_door[facing=north,half=upper,hinge=left,open=false,powered=false]");
  for(const xx of [x+2,x+width-3]) { set(xx,65,z,"glass"); set(xx,66,z,"glass"); }
  set(x,65,z+3,"glass");set(x,66,z+3,"glass");
  for(let step=0;step<=Math.ceil(width/2);step++) {
    const west=x-1+step, east=x+width-step;
    if(west>east) break;
    for(let zz=z-1;zz<=z+depth;zz++) {
      set(west,68+step,zz,"spruce_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]");
      set(east,68+step,zz,"spruce_stairs[facing=west,half=bottom,shape=straight,waterlogged=false]");
    }
    for(let xx=west+1;xx<east;xx++) { set(xx,68+step,z,"oak_planks"); set(xx,68+step,z+depth-1,"oak_planks"); }
  }
  fill(x+width-2,68,z+depth-3,x+width-1,74,z+depth-2,"bricks");
  for(let zz=z-1;zz>2;zz--) for(let xx=door-1;xx<=door+1;xx++) set(xx,62,zz,"dirt_path");
}
house(-16,6,8,8);house(6,7,9,8);house(-15,-17,8,9);

function tree(x,z,h=5) {
  fill(x,63,z,x+1,63+h,z+1,"oak_log[axis=y]");
  for(let dy=-1;dy<=2;dy++) for(let dz=-2;dz<=2;dz++) for(let dx=-2;dx<=2;dx++) {
    if(Math.abs(dx)+Math.abs(dz)>(dy===2?1:3) || dx===0&&dz===0&&dy<0)continue;
    set(x+dx,63+h+dy,z+dz,"oak_leaves[distance=1,persistent=true,waterlogged=false]");
  }
}
for(const [x,z,h] of [[-20,-2,5],[-19,18,5],[19,17,6],[20,-18,5],[-3,-21,5],[17,3,4]]) tree(x,z,h);
fill(7,62,-19,18,63,-8,"farmland[moisture=7]");
for(let z=-19;z<-8;z++) for(let x=7;x<18;x++) set(x,63,z,x===12?"air":"wheat[age=7]");
fill(12,62,-19,13,63,-8,"water[level=0]");
for(let x=5;x<=20;x++) for(const z of [-21,-6])set(x,63,z,`oak_fence[east=${x<20},north=${z===-6&&(x===5||x===20)},south=${z===-21&&(x===5||x===20)},west=${x>5},waterlogged=false]`);
for(let z=-20;z<-6;z++) for(const x of [5,20])set(x,63,z,"oak_fence[east=false,north=true,south=true,west=false,waterlogged=false]");
fill(-2,63,5,3,64,10,"cobblestone");fill(-1,64,6,2,65,9,"water[level=0]");
for(const x of [-2,2])for(const z of [5,9])fill(x,64,z,x+1,67,z+1,"oak_fence[east=false,north=false,south=false,west=false,waterlogged=false]");
fill(-3,67,4,4,68,11,"spruce_slab[type=bottom,waterlogged=false]");
for(const [x,z] of [[-5,4],[4,4],[-4,-4],[4,-4]]) { set(x,63,z,"cobblestone_wall[east=none,north=none,south=none,west=none,up=true,waterlogged=false]");set(x,64,z,"lantern[hanging=false,waterlogged=false]"); }
for(let i=0;i<30;i++){const x=(i*13)%45-22,z=(i*19)%45-22;if(blocks.get(`${x},62,${z}`)==="minecraft:grass_block[snowy=false]")set(x,63,z,i%3?"short_grass":"poppy");}
set(6,63,4,"chest[facing=north,type=single,waterlogged=false]");
set(8,63,4,"chest[facing=north,type=left,waterlogged=false]");
set(9,63,4,"chest[facing=north,type=right,waterlogged=false]");
set(-15,63,4,"red_bed[facing=south,occupied=false,part=foot]");
set(-15,63,5,"red_bed[facing=south,occupied=false,part=head]");
set(-4,63,-3,"oak_sign[rotation=4,waterlogged=false]");
set(-11,65,5,"oak_wall_sign[facing=north,waterlogged=false]");

function encodeChunks(sceneBlocks) {
  const chunks = new Map();
  for(let z=-2;z<2;z++) for(let x=-2;x<2;x++) {
  const palette=[],indices=new Map(),runs=[];
  let last=-1,count=0;
  for(let y=56;y<88;y++) for(let zz=0;zz<16;zz++) for(let xx=0;xx<16;xx++) {
    const block=sceneBlocks.get(`${x*16+xx},${y},${z*16+zz}`)??"minecraft:air";
    if(!indices.has(block)){indices.set(block,palette.length);palette.push(block);}
    const index=indices.get(block);
    if(index===last)count++;else{if(count)runs.push(count,last);last=index;count=1;}
  }
  if(count)runs.push(count,last);
  chunks.set(`${x},${z}`,{x,z,minY:56,height:32,palette,runs});
  }
  return chunks;
}
// Different native roof material makes scene reset visible in both directions.
// Chunk coordinates and revisions deliberately stay equal across the scenes.
const spawnBlocks = new Map([...blocks].map(([position,block]) => [position,block.replace("minecraft:spruce_stairs[","minecraft:brick_stairs[").replace("minecraft:spruce_slab[","minecraft:brick_slab[")]));
const sceneChunks = new Map([["village",encodeChunks(blocks)],["spawn",encodeChunks(spawnBlocks)]]);
const scene={id:"village",name:"Деревня · тестовая сцена",kind:"settlement",world:"fixture",bounds:{minX:-24,maxX:24,minY:56,maxY:88,minZ:-24,maxZ:24},camera:{target:[0,64,0],azimuthDegrees:42,elevationDegrees:35.264,spanBlocks:58},status:"available"};
const inspectionCameras = [
  ["actors","Модели и движение",[8,64,18.5],25,17,18],
  ["hands","Предметы в руках",[9.5,64,21],25,7,22],
  ["chests_front","Сундуки · спереди",[8,63.6,4.5],205,9],
  ["chests_back","Сундуки · сзади",[8,63.6,4.5],285,6,75],
  ["bed","Кровать",[-14.5,63.5,5],135,7],
  ["corner","Угол забора",[5.5,63.5,-6],220,7],
  ["wall","Стена",[10,65,7],220,9]
];
const locations=[scene,{...scene,id:"spawn",name:"Спавн · тестовая сцена",kind:"spawn",camera:{...scene.camera,azimuthDegrees:135}},...inspectionCameras.map(([id,name,target,azimuthDegrees,spanBlocks,elevationDegrees=35.264])=>({...scene,id,name:name+" · тестовая сцена",kind:"inspection",camera:{target,azimuthDegrees,spanBlocks,elevationDegrees}}))];
const start=Date.now();
const files=new Map();
const display=(id,name,position,content)=>({ id,kind:"display",type:`${content.kind}_display`,name,position,yawDegrees:0,headYawDegrees:0,pitchDegrees:0,scale:1,display:{ translation:[0,0,0],scale:[1,1,1],leftRotation:[0,0,0,1],rightRotation:[0,0,0,1],billboard:"FIXED",...content } });
const displays=[display("block:1","Бочка",[4,63,9],{kind:"block",blockData:"minecraft:barrel[facing=north,open=false]"}),display("text:1","Колодец",[0,69,7],{kind:"text",text:"Колодец",billboard:"VERTICAL"})];
if(manifest.items?.["minecraft:paper|10837|none"]) displays.push(display("ia:1","Точильный станок",[-6,63.5717531435684543,7],{kind:"item",item:{material:"minecraft:paper",customModelData:10837,amount:1},mode:"NONE"}));
if(manifest.items?.["minecraft:paper|10764|none"]) displays.push(display("ia:2","Бочки",[16,64.53826834323651,8],{kind:"item",item:{material:"minecraft:paper",customModelData:10764,amount:1},mode:"NONE"}));
function send(response,body,type="application/json; charset=utf-8") {
  const raw=Buffer.isBuffer(body)?body:Buffer.from(typeof body==="string"?body:JSON.stringify(body));
  const bytes=raw.length>1024?zlib.gzipSync(raw):raw;
  response.writeHead(200,{"Content-Type":type,"Cache-Control":"no-store",...(bytes!==raw?{"Content-Encoding":"gzip"}:{})});response.end(bytes);
}
const server=http.createServer((request,response)=>{
  response.setHeader("Content-Security-Policy","default-src 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'");
  response.setHeader("X-Content-Type-Options","nosniff");
  const url=new URL(request.url,"http://localhost");
  if(url.pathname.startsWith("/worldview/")) url.pathname=url.pathname.slice(10);
  else if(websiteRoot && (url.pathname==="/world" || url.pathname==="/world/" || url.pathname==="/ruscrafting-mark.png" || url.pathname.startsWith("/_astro/") || url.pathname.startsWith("/fonts/"))) {
    const file=path.resolve(websiteRoot,url.pathname.startsWith("/world")?"world/index.html":url.pathname.slice(1));
    if(file.startsWith(websiteRoot+path.sep)&&fs.existsSync(file)) return send(response,fs.readFileSync(file),({".html":"text/html; charset=utf-8",".js":"application/javascript",".css":"text/css",".png":"image/png",".woff2":"font/woff2"})[path.extname(file)]??"application/octet-stream");
  }
  if(url.pathname==="/v1/scenes")return send(response,{schemaVersion:1,minecraftVersion:"1.21.11",assetRevision:revision,assetsUrl:`assets/${revision}/manifest.json`,scenes:locations});
  if(/^\/v1\/scenes\/[a-z_]+\/frame$/.test(url.pathname) && locations.some(location=>location.id===url.pathname.split('/')[3])) {
    const sceneId=url.pathname.split('/')[3],chunks=sceneChunks.get(sceneId)??sceneChunks.get("village");
    const t=(Date.now()-start)/1000;
    const inspectHands=sceneId==="hands",inspecting=sceneId==="actors"||inspectHands,motionTime=inspecting?Math.floor(t/16)*10+Math.min(t%16,10):t;
    const walk=(id,kind,type,name,x,z,phase=0)=>{
      const angle=motionTime*(inspecting ? .9 : .45)+phase,rx=inspecting ? 1 : 4,rz=inspecting ? .25 : 2;
      const yaw=Math.atan2(-Math.cos(angle)*rx,-Math.sin(angle)*rz)*180/Math.PI;
      return {id,kind,type,name,position:[x+Math.sin(angle)*rx,63,z+Math.cos(angle)*rz],yawDegrees:yaw,headYawDegrees:yaw,pitchDegrees:0,pose:"STANDING",scale:1,seated:false,skin:type==="player"?{url:`assets/${revision}/native/assets/minecraft/textures/entity/player/wide/steve.png`,model:"default"}:null,equipment:{}};
    };
    const equipment=[{slot:"HAND",material:"minecraft:iron_axe",amount:1},...(["HEAD","CHEST","LEGS","FEET"].map((slot,index)=>({slot,material:`minecraft:iron_${["helmet","chestplate","leggings","boots"][index]}`,amount:1})))];
    const entities=inspectHands?[
      {...walk("hand:right","player","player","Правая рука",8,21),equipment},
      {...walk("hand:left","player","player","Левая рука",11,21),equipment:equipment.map(item=>item.slot==="HAND"?{...item,slot:"OFF_HAND"}:item)}
    ]:inspecting?[
      walk("cow:1","mob","cow","Корова",3,16),walk("sheep:1","mob","sheep","Овца",6,16),walk("pig:1","mob","pig","Свинья",9,16),walk("chicken:1","mob","chicken","Курица",12,16),
      walk("horse:1","mob","horse","Лошадь",4,21),walk("zombie:1","mob","zombie","Зомби",8,21),{...walk("player:1","player","player","Игрок в броне",12,21),equipment}
    ]:[{...walk("player:1","player","player","Игрок",-5,0),equipment:equipment.slice(0,2)},walk("npc:1","npc","player","Житель",6,0,2),walk("cow:1","mob","cow","Корова",-6,-7,1),walk("sheep:1","mob","sheep","Овца",-9,-6,3),walk("pig:1","mob","pig","Свинья",13,18,2)];
    return send(response,{sceneId,epoch:"fixture-2",seq:Math.floor(t*5),capturedAt:Date.now(),reset:!url.searchParams.has("after"),loadedChunks:chunks.size,totalChunks:chunks.size,entities:[...entities,...displays],chunks:[...chunks.values()].map(({x,z})=>({x,z,revision:"1",url:`v1/scenes/${sceneId}/chunks/${x}/${z}/1.json`})),removedChunks:[]});
  }
  const chunkMatch=url.pathname.match(/^\/v1\/scenes\/([a-z_]+)\/chunks\/(-?\d+)\/(-?\d+)\/1\.json$/);
  const chunk=chunkMatch&&locations.some(location=>location.id===chunkMatch[1])&&(sceneChunks.get(chunkMatch[1])??sceneChunks.get("village")).get(`${chunkMatch[2]},${chunkMatch[3]}`);
  if(chunk)return send(response,chunk);
  const prefix=url.pathname.startsWith("/assets/")?assetsRoot:path.join(root,"dist");
  const relative=url.pathname.startsWith("/assets/")?url.pathname.slice(8):url.pathname==="/"?"index.html":url.pathname.slice(1);
  const file=path.resolve(prefix,relative);
  if(!file.startsWith(prefix+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){response.writeHead(404);response.end();return;}
  if(!files.has(file))files.set(file,fs.readFileSync(file));
  send(response,files.get(file),({".html":"text/html; charset=utf-8",".js":"application/javascript",".css":"text/css",".png":"image/png",".json":"application/json",".woff2":"font/woff2"})[path.extname(file)]??"application/octet-stream");
});
server.listen(Number(process.env.PORT??3094),"127.0.0.1",()=>console.log(`ArcWorldView synthetic visual fixture: http://127.0.0.1:${server.address().port}/`));
