"use strict";

const THREE = require("three");
const { itemModelFaces } = require("@viewer/item-model-geometry");
const { cubeVertexData } = require("@viewer/player-model");
const { configureMinecraftTexture } = require("@viewer/viewer-color");
const { assetUrl } = require("./viewer-utils.cjs");
const { isGeneratedItemFallback, validateSpriteSize, generatedItemFaces, applyNativeItemContext } = require("./native-item-geometry.cjs");
let manifest, decodeBlock;
const models = new Map(), textures = new Map(), images = new Map(), blocks = new Map(), generatedFaces = new Map();

function configureModels(value, decode) {
  if (manifest?.revision !== value.revision) {
    models.clear(); images.clear(); blocks.clear(); generatedFaces.clear();
    for (const texture of textures.values()) texture.dispose();
    textures.clear();
  }
  manifest = value; decodeBlock = decode;
}

function loadModel(file) {
  if (!file || !Object.hasOwn(manifest.files, file)) return Promise.reject(Error("Model is absent from this resource pack"));
  if (!models.has(file)) models.set(file,fetch(assetUrl(file)).then((response) => {
    if (!response.ok) throw Error(`Model returned ${response.status}`);
    return response.json();
  }).catch((error) => { models.delete(file); throw error; }));
  return models.get(file);
}

function texture(file) {
  if (!Object.hasOwn(manifest.files,file)) throw Error("Texture is absent from this resource pack");
  if (!textures.has(file)) {
    const result = new THREE.TextureLoader().load(assetUrl(file), undefined, undefined, () => window.dispatchEvent(new Event("worldview-asset-error")));
    result.magFilter = THREE.NearestFilter; result.minFilter = THREE.NearestFilter; result.generateMipmaps = false;
    configureMinecraftTexture(result, THREE); textures.set(file,result);
  }
  return textures.get(file);
}

function itemFile(item, mode) {
  const material = item?.material;
  const model = item?.itemModel;
  if (model && (manifest.itemModels?.[`${model}|${mode}`] || manifest.itemModels?.[`${model}|none`])) return manifest.itemModels[`${model}|${mode}`] ?? manifest.itemModels[`${model}|none`];
  const exact = `${material}|${item?.customModelData ?? ""}|${mode}`;
  if (manifest.items?.[exact]) return manifest.items[exact];
  if (manifest.items?.[`${material}|${item?.customModelData ?? ""}|none`]) return manifest.items[`${material}|${item?.customModelData ?? ""}|none`];
  if (item?.customModelData != null) {
    // Minecraft range_dispatch chooses the greatest threshold not above CMD.
    let best = -Infinity, file = null;
    for (const [key, value] of Object.entries(manifest.items ?? {})) {
      const [candidate, threshold, context] = key.split("|");
      if (candidate === material && (context === mode || context === "none") && threshold !== "" && Number(threshold) <= item.customModelData && Number(threshold) > best) { best = Number(threshold); file = value; }
    }
    if (file) return file;
  }
  return manifest.items?.[`${material}||${mode}`] ?? manifest.items?.[`${material}||none`];
}

async function itemMesh(item, requestedMode = "none") {
  const mode = String(requestedMode).toLowerCase();
  const file = itemFile(item,mode), model = await loadModel(file);
  let faces;
  if (isGeneratedItemFallback(model)) {
    if (!generatedFaces.has(file)) generatedFaces.set(file, (async () => {
      const textureFile = model.textures.layer0, image = await loadImage(textureFile);
      validateSpriteSize(image.width, image.height);
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
      return generatedItemFaces(context.getImageData(0, 0, image.width, image.height).data, image.width, image.height, textureFile);
    })().catch(error => { generatedFaces.delete(file); throw error; }));
    faces = await generatedFaces.get(file);
  } else faces = itemModelFaces(model, "none");
  const grouped = new Map();
  for (const face of applyNativeItemContext(faces, model, mode)) {
    if (!grouped.has(face.texture)) grouped.set(face.texture,[]);
    grouped.get(face.texture).push(face);
  }
  if (!grouped.size) throw Error("Item model has no supported geometry");
  const group = new THREE.Group();
  for (const [file,faces] of grouped) {
    const positions = [], uvs = [];
    for (const face of faces) for (const index of [0,1,2,0,2,3]) { positions.push(...face.positions[index]); uvs.push(...face.uvs[index]); }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));
    geometry.setAttribute("uv",new THREE.Float32BufferAttribute(uvs,2));
    geometry.computeVertexNormals();
    const material = new THREE.MeshLambertMaterial({ map:texture(file),alphaTest:0.1,side:THREE.DoubleSide });
    group.add(new THREE.Mesh(geometry,material));
  }
  return group;
}

async function blockMesh(blockData) {
  if (!blocks.has(blockData)) blocks.set(blockData,decodeBlock(blockData).catch((error) => { blocks.delete(blockData); throw error; }));
  const attributes = await blocks.get(blockData);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position",new THREE.Float32BufferAttribute(attributes.positions,3));
  geometry.setAttribute("normal",new THREE.Float32BufferAttribute(attributes.normals,3));
  geometry.setAttribute("uv",new THREE.Float32BufferAttribute(attributes.uvs,2));
  geometry.setAttribute("color",new THREE.Float32BufferAttribute(attributes.colors,3));
  geometry.setIndex(attributes.indices);
  const map=texture(manifest.atlas); map.flipY=false;
  return new THREE.Mesh(geometry,new THREE.MeshLambertMaterial({ map,vertexColors:true,alphaTest:0.1,side:THREE.DoubleSide }));
}

function armorParts(item, slot) {
  const material=String(item.material).replace(/^minecraft:/,"");
  const match=material.match(/^(leather|chainmail|iron|golden|diamond|netherite|turtle)_(helmet|chestplate|leggings|boots)$/);
  if (!match) return null;
  const name=match[1]==="golden"?"gold":match[1]==="turtle"?"turtle_scute":match[1];
  const file=`native/assets/minecraft/textures/entity/equipment/${slot==="LEGS"?"humanoid_leggings":"humanoid"}/${name}.png`;
  const map=texture(file); map.flipY=false;
  const definitions={
    head:{ bone:"head",origin:[-4,0,-4],size:[8,8,8],uv:[0,0] },
    body:{ bone:"body",origin:[-4,-12,-2],size:[8,12,4],uv:[16,16] },
    leftarm:{ bone:"leftarm",origin:[-1,-10,-2],size:[4,12,4],uv:[40,16] },
    rightarm:{ bone:"rightarm",origin:[-3,-10,-2],size:[4,12,4],uv:[40,16] },
    leftleg:{ bone:"leftleg",origin:[-2,-12,-2],size:[4,12,4],uv:[0,16] },
    rightleg:{ bone:"rightleg",origin:[-2,-12,-2],size:[4,12,4],uv:[0,16] }
  };
  const selected=({ HEAD:["head"],CHEST:["body","leftarm","rightarm"],LEGS:["body","leftleg","rightleg"],FEET:["leftleg","rightleg"] })[slot];
  if(!selected) return null;
  return selected.map((name) => {
    const definition=definitions[name];
    const data=cubeVertexData({ ...definition,inflate:slot==="LEGS"?.5:1 });
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute("position",new THREE.Float32BufferAttribute(data.positions,3));
    geometry.setAttribute("uv",new THREE.Float32BufferAttribute(data.uvs.map((value,index) => index%2 ? value*2 : value),2));
    geometry.setIndex(Array.from({ length:6 },(_,face) => [0,1,2,2,1,3].map((vertex) => face*4+vertex)).flat());
    geometry.computeVertexNormals();
    const color=match[1]==="leather" ? item.tint ?? 0xa06540 : 0xffffff;
    // Match the interior-face shadow pass used for native single-sided cuboids.
    // Rendering both depth faces makes the sun-facing armour self-shadow in r128.
    return { bone:definition.bone,mesh:new THREE.Mesh(geometry,new THREE.MeshLambertMaterial({ map,color,alphaTest:.1,side:THREE.DoubleSide,shadowSide:THREE.BackSide })) };
  });
}

function loadImage(file) {
  if (!images.has(file)) images.set(file,new Promise((resolve,reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = assetUrl(file); }));
  return images.get(file);
}

async function textMesh(text) {
  const font = await loadModel(manifest.font);
  const lines = String(text ?? "").slice(0,1024).split("\n").slice(0,32);
  const glyphs = new Map();
  for (const character of new Set(lines.join(""))) {
    const glyph = font.glyphs[character.codePointAt(0).toString(16).toUpperCase().padStart(4,"0")];
    if (!glyph || character === " ") { glyphs.set(character,{ advance:4 }); continue; }
    const image = await loadImage(glyph.url);
    const width = image.width / glyph.columns, height = image.height / glyph.rows;
    const canvas = document.createElement("canvas"); canvas.width=width; canvas.height=height;
    const context = canvas.getContext("2d"); context.drawImage(image,glyph.column*width,glyph.row*height,width,height,0,0,width,height);
    const pixels = context.getImageData(0,0,width,height).data;
    let ink=0; for(let x=0;x<width;x++) for(let y=0;y<height;y++) if(pixels[(y*width+x)*4+3]) ink=Math.max(ink,x+1);
    glyphs.set(character,{ canvas,height:glyph.height,ascent:glyph.ascent,width:width*glyph.height/height,advance:Math.ceil(ink*glyph.height/height)+1 });
  }
  const lineWidths = lines.map((line) => [...line].reduce((sum,character) => sum+glyphs.get(character).advance,0));
  const canvas = document.createElement("canvas"); canvas.width=Math.max(1,...lineWidths)+4; canvas.height=lines.length*10+4;
  const context = canvas.getContext("2d"); context.imageSmoothingEnabled=false;
  context.fillStyle="rgba(0,0,0,.25)"; context.fillRect(0,0,canvas.width,canvas.height);
  lines.forEach((line,index) => { let x=(canvas.width-lineWidths[index])/2; for(const character of line) { const glyph=glyphs.get(character); if(glyph.canvas) context.drawImage(glyph.canvas,x,2+index*10+7-glyph.ascent,glyph.width,glyph.height); x+=glyph.advance; } });
  const map = new THREE.CanvasTexture(canvas); map.magFilter=THREE.NearestFilter; map.minFilter=THREE.NearestFilter;
  configureMinecraftTexture(map,THREE);
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(canvas.width*.025,canvas.height*.025),new THREE.MeshBasicMaterial({ map,transparent:true,alphaTest:.01,side:THREE.DoubleSide }));
  mesh.position.y=canvas.height*.0125; mesh.userData.ownedTexture=map;
  return mesh;
}

module.exports = { configureModels,itemMesh,blockMesh,textMesh,armorParts };
