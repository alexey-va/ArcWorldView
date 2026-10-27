"use strict";

const THREE = require("three");
globalThis.THREE = THREE;
const { WorldRenderer } = require("prismarine-viewer/viewer/lib/worldrenderer");
const { MapControls } = require("prismarine-viewer/viewer/lib/controls");
const Entity = require("prismarine-viewer/viewer/lib/entity/Entity");
const entityModels = require("prismarine-viewer/viewer/lib/entity/entities.json");
const { installNativeEntityModels, nativeEntityCompatibility } = require("./native-entity-models.cjs");
const { prepareMobSkeletons, poseMobSkeletons } = require("./mob-pose.cjs");
installNativeEntityModels(entityModels);
const { configureMinecraftRenderer, configureMinecraftTexture } = require("@viewer/viewer-color");
const { playerBodyMesh, playerBones, normalizePlayerSkeleton, applyPlayerGeometry } = require("@viewer/player-model");
const { actorBoneRotations, offsetBoneRotation } = require("@viewer/actor-pose");
const { normalizePlayerSkinImage } = require("@viewer/player-skin");
const { setAssets, assetUrl } = require("./viewer-utils.cjs");
const { sampleActor } = require("./actor-motion.cjs");
const { configureModels,itemMesh,blockMesh,textMesh,armorParts } = require("./model-renderer.cjs");

const $ = (id) => document.getElementById(id);
const viewport = $("viewport");
const baseUrl = new URL("./", window.location.href);
const sceneSelect = $("scene");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const actors = new Map(), loadedChunks = new Map(), pendingChunks = new Map(), decodeRequests = new Map(), skinTextures = new Map(), chunkControllers = new Set();
const terrainWarnings=new Map();
const history = [];
let assets, catalog, selectedScene, renderer, scene, camera, controls, terrain, terrainRoot, decoder;
let generation = 0, epoch = null, sequence = -1, lastFrameAt = 0, lastLoopAt = 0, chunkRequestId = 0, loadedCount = 0, totalCount = 0;
let cameraMode = "isometric", selectedActor = null, pollController = null, hasGeometry = false, span = 64, failedAssets = false;
let catalogRefreshing = null;
let workerFailed = false;

function relativeUrl(value, parent = baseUrl) {
  const result = new URL(value, parent);
  if (result.origin !== window.location.origin) throw Error("A resource is outside this viewer");
  return result.href;
}

async function json(url, signal) {
  const response = await fetch(url, { signal, credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw Object.assign(Error(`HTTP ${response.status}`), { status: response.status });
  return response.json();
}

function connection(state, text) {
  const element = $("connection-text");
  if (element.textContent !== text) element.textContent = text;
  element.parentElement.dataset.state = state;
}

function message(title, detail, retry = false) {
  $("message-title").textContent = title;
  $("message-detail").textContent = detail;
  $("scene-message").hidden = false;
  $("retry").hidden = !retry;
}

function notice(text) { $("scene-notice").textContent = text; $("scene-notice").hidden = !text; }

function workerFailure(event) {
  if (workerFailed) return;
  workerFailed = true;
  generation++; pollController?.abort();
  for (const controller of chunkControllers) controller.abort();
  for (const pending of decodeRequests.values()) pending.reject(Error("Rendering worker stopped"));
  decodeRequests.clear();
  console.error("ArcWorldView rendering worker:", event.message || "Worker communication failed");
  connection("error", "Просмотр недоступен");
  message("Не удалось построить мир", "Обнови просмотр. Если ошибка повторится, попробуй другой браузер.", true);
}

function disposeMesh(root) {
  root.traverse((part) => {
    part.geometry?.dispose();
    part.userData.ownedTexture?.dispose();
    for (const material of Array.isArray(part.material) ? part.material : [part.material]) material?.dispose();
  });
  root.parent?.remove(root);
}

function clearWorld() {
  hasGeometry = false;
  history.length = 0;
  for (const actor of actors.values()) disposeMesh(actor.mesh);
  actors.clear();
  for (const key of loadedChunks.keys()) {
    const [x, z] = key.split(",").map(Number);
    terrain.removeColumn(x * 16, z * 16);
  }
  loadedChunks.clear(); pendingChunks.clear();
  terrainWarnings.clear();
  for (const controller of chunkControllers) controller.abort();
  chunkControllers.clear();
  for (const pending of decodeRequests.values()) pending.reject(Error("Scene changed"));
  decodeRequests.clear();
  selectedActor = null;
  $("actor-info").hidden = true;
  viewport.dataset.state = "loading";
}

function resize() {
  if (!renderer) return;
  const { width, height } = viewport.getBoundingClientRect();
  const aspect = width / Math.max(height, 1);
  const visibleSpan = span * Math.max(1, (cameraMode==="top"?1:1.55) / aspect);
  camera.left = -visibleSpan * aspect / 2; camera.right = visibleSpan * aspect / 2;
  camera.top = visibleSpan / 2; camera.bottom = -visibleSpan / 2;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
}

function frameScene(mode = cameraMode) {
  if (!selectedScene) return;
  cameraMode = mode;
  const defaults = selectedScene.camera;
  const target = new THREE.Vector3(...defaults.target);
  const azimuth = THREE.MathUtils.degToRad(defaults.azimuthDegrees ?? 45);
  const elevation = THREE.MathUtils.degToRad(mode === "top" ? 89.7 : defaults.elevationDegrees ?? 35.264);
  span = defaults.spanBlocks ?? 64;
  if(mode==="top") {
    const width=selectedScene.bounds.maxX-selectedScene.bounds.minX,depth=selectedScene.bounds.maxZ-selectedScene.bounds.minZ;
    const projectedWidth=Math.abs(width*Math.cos(azimuth))+Math.abs(depth*Math.sin(azimuth));
    const projectedDepth=Math.abs(width*Math.sin(azimuth))+Math.abs(depth*Math.cos(azimuth));
    span=Math.max(span,Math.max(projectedWidth,projectedDepth)*1.12);
  }
  camera.zoom = 1;
  controls.target.copy(target);
  const distance = Math.max(span * 2, 180);
  camera.position.set(target.x + Math.cos(elevation) * Math.sin(azimuth) * distance, target.y + Math.sin(elevation) * distance, target.z + Math.cos(elevation) * Math.cos(azimuth) * distance);
  camera.lookAt(target);
  controls.update(); resize();
  $("isometric").setAttribute("aria-pressed", String(mode === "isometric"));
  $("top-view").setAttribute("aria-pressed", String(mode === "top"));
}

function initRenderer() {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  configureMinecraftRenderer(renderer, THREE);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute("aria-label", "3D-сцена. Мышь поворачивает камеру, WASD перемещает её.");
  $("canvas-host").append(renderer.domElement);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xc9d4cd);
  scene.add(new THREE.AmbientLight(0xffffff, 0.73));
  const sunlight = new THREE.DirectionalLight(0xfff4dc, 0.63);
  sunlight.position.set(-80, 140, 50); scene.add(sunlight);
  camera = new THREE.OrthographicCamera(-40, 40, 30, -30, 0.1, 1800);
  controls = new MapControls(camera, renderer.domElement);
  controls.enableDamping = !reducedMotion; controls.dampingFactor = 0.16;
  controls.minZoom = 0.35; controls.maxZoom = 8;
  controls.minPolarAngle = 0.005; controls.maxPolarAngle = Math.PI * 0.40;
  controls.screenSpacePanning = false; controls.keyPanSpeed = 0.2; controls.verticalTranslationSpeed = 0;
  terrainRoot = new THREE.Group(); scene.add(terrainRoot);
  terrain = new WorldRenderer(terrainRoot, Math.min(4, navigator.hardwareConcurrency || 2));
  for (const worker of terrain.workers) {
    worker.addEventListener("error", workerFailure);
    worker.addEventListener("messageerror", workerFailure);
  }
  terrain.texturesDataUrl = assetUrl(assets.atlas);
  decoder = new Worker("decode-worker.js");
  decoder.addEventListener("error", workerFailure);
  decoder.addEventListener("messageerror", workerFailure);
  decoder.onmessage = ({ data }) => {
    const request = decodeRequests.get(data.id);
    if (!request) return;
    decodeRequests.delete(data.id);
    if (data.error) request.reject(Error(data.error)); else request.resolve(data.result);
  };
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  renderer.domElement.addEventListener("pointermove", (event) => {
    if (event.buttons) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects([...actors.values()].map((actor) => actor.mesh), true)[0];
    let object = hit?.object;
    while (object && !object.userData.actorId) object = object.parent;
    selectedActor = object?.userData.actorId ?? null;
    renderer.domElement.style.cursor = selectedActor ? "pointer" : "grab";
    showActor();
  });
  renderer.domElement.addEventListener("pointerleave", () => { selectedActor = null; showActor(); });
  for (const type of ["keydown", "keyup"]) document.querySelector(".world-toolbar").addEventListener(type, (event) => event.stopPropagation());
  new ResizeObserver(resize).observe(viewport);
  requestAnimationFrame(animate);
}

function configureModelData(blockStates) {
  decoder.postMessage({ type:"models",blockStates });
  configureModels(assets,(blockData) => new Promise((resolve,reject) => {
    const id=++chunkRequestId; decodeRequests.set(id,{ resolve,reject });
    decoder.postMessage({ id,type:"block",blockData,version:catalog.minecraftVersion });
  }));
}

function displayActor(record) {
  const mesh=new THREE.Group(),translation=new THREE.Group(),left=new THREE.Group(),scale=new THREE.Group(),right=new THREE.Group(),content=new THREE.Group();
  mesh.add(translation); translation.add(left); left.add(scale); scale.add(right); right.add(content);
  mesh.userData.actorId=record.id;
  const actor={ mesh,type:String(record.type).replace(/^minecraft:/,""),record,display:{ translation,left,scale,right,content },bodies:[] };
  scene.add(mesh); actors.set(record.id,actor);
  return actor;
}

async function updateDisplay(actor,record) {
  const display=record.display;
  const signature=JSON.stringify([display.kind,display.item,display.mode,display.blockData,display.text]);
  if (actor.contentSignature===signature) return;
  actor.contentSignature=signature; actor.modelError=false;
  try {
    const mesh=display.kind==="item" ? await itemMesh(display.item,display.mode) : display.kind==="block" ? await blockMesh(display.blockData) : await textMesh(display.text);
    if (actors.get(record.id)!==actor || actor.contentSignature!==signature) { disposeMesh(mesh); return; }
    for(const child of [...actor.display.content.children]) disposeMesh(child);
    actor.display.content.rotation.y=display.kind==="item" ? Math.PI : 0;
    actor.display.content.add(mesh);
  } catch { if (actors.get(record.id)===actor) actor.modelError=true; }
}

async function updateEquipment(actor,record) {
  const equipment=Array.isArray(record.equipment) ? Object.fromEntries(record.equipment.map((item) => [item.slot,item])) : record.equipment ?? {};
  const signature=JSON.stringify(equipment);
  if(actor.equipmentSignature===signature) return;
  actor.equipmentSignature=signature;
  actor.modelError=false;
  for(const mesh of actor.equipmentMeshes ?? []) disposeMesh(mesh);
  actor.equipmentMeshes=[];
  for(const [slot,item] of Object.entries(equipment)) {
    if(!item || item.material==="minecraft:air") continue;
    if(["HEAD","CHEST","LEGS","FEET"].includes(slot)) {
      try {
        const armor=armorParts(item,slot);
        if(armor) { for(const {bone,mesh} of armor) { actor.bones[bone].add(mesh); actor.equipmentMeshes.push(mesh); } continue; }
      } catch { actor.modelError=true; continue; }
    }
    if(!["HAND","OFF_HAND","HEAD"].includes(slot)) continue;
    const bone=actor.bones[slot==="HAND"?"rightarm":slot==="OFF_HAND"?"leftarm":"head"];
    if(!bone) continue;
    try {
      const mesh=await itemMesh(item,slot==="HEAD"?"head":slot==="HAND"?"thirdperson_righthand":"thirdperson_lefthand");
      if(actors.get(record.id)!==actor || actor.equipmentSignature!==signature) { disposeMesh(mesh); return; }
      mesh.scale.setScalar(16);
      if(slot==="HEAD") mesh.rotation.y=Math.PI;
      else { mesh.position.set(slot==="HAND"?-1:1,-10,-1); mesh.rotation.set(-Math.PI/2,Math.PI,0); }
      bone.add(mesh); actor.equipmentMeshes.push(mesh);
    } catch { actor.modelError=true; }
  }
}

async function loadSkin(actor, record) {
  if (!record.skin?.url || actor.skinUrl === record.skin.url) return;
  actor.skinUrl = record.skin.url;
  const url = relativeUrl(record.skin.url);
  let pending = skinTextures.get(url);
  if (!pending) {
    pending = new Promise((resolve, reject) => new THREE.TextureLoader().load(url, (texture) => {
      texture.image = normalizePlayerSkinImage(texture.image);
      texture.magFilter = THREE.NearestFilter; texture.minFilter = THREE.NearestFilter; texture.flipY = false;
      configureMinecraftTexture(texture, THREE); texture.needsUpdate = true; resolve(texture);
    }, undefined, reject));
    skinTextures.set(url, pending);
  }
  const texture = await pending;
  if (actors.get(record.id) !== actor || actor.skinUrl !== record.skin.url) return;
  actor.body.material.map = texture; actor.body.material.needsUpdate = true;
  actor.skinTexture = texture;
}

function createActor(record) {
  if(record.kind==="display" && record.display) return displayActor(record);
  const type = String(record.type).replace(/^minecraft:/, "").toLowerCase();
  if (!assets.supportedEntities.includes(type) || nativeEntityCompatibility(type, entityModels[type])) return null;
  const mesh = new Entity(catalog.minecraftVersion, type, scene).mesh;
  mesh.userData.actorId = record.id;
  const actor = { mesh, type, record, phase: 0, bodies: [] };
  if (type === "player") {
    actor.body = playerBodyMesh(mesh);
    normalizePlayerSkeleton(actor.body);
    applyPlayerGeometry(actor.body, record.skin?.model === "slim" ? "slim" : "default");
    actor.bones = playerBones(actor.body);
    actor.base = Object.fromEntries(Object.entries(actor.bones).map(([name, bone]) => [name, { x: bone.rotation.x, y: bone.rotation.y, z: bone.rotation.z }]));
  } else {
    actor.bodies = prepareMobSkeletons(mesh, entityModels[type], type);
  }
  mesh.position.set(...record.position);
  scene.add(mesh);
  actors.set(record.id, actor);
  if (actor.body) loadSkin(actor, record).catch(() => { failedAssets = true; });
  return actor;
}

function updateActors(records, at) {
  const current = new Map(records.map((record) => [record.id, record]));
  history.push({ at, actors: current });
  while (history.length > 8) history.shift();
  let missing = 0;
  for (const record of records) {
    let actor = actors.get(record.id);
    if (actor && actor.type !== String(record.type).replace(/^minecraft:/, "").toLowerCase()) { disposeMesh(actor.mesh); actors.delete(record.id); actor = null; }
    actor ??= createActor(record);
    if (!actor) { missing++; continue; }
    actor.record = record;
    if (actor.body) { loadSkin(actor, record).catch(() => { failedAssets = true; }); void updateEquipment(actor,record); }
    if (actor.display) void updateDisplay(actor,record);
    if (actor.modelError) missing++;
  }
  for (const [id, actor] of actors) if (!current.has(id)) { disposeMesh(actor.mesh); actors.delete(id); }
  viewport.dataset.actors = String(actors.size);
  if (missing || failedAssets || [...terrainWarnings.values()].some(Boolean)) notice("Часть моделей пока недоступна.");
  else notice("");
}

const typeLabels = { cow: "Корова", sheep: "Овца", pig: "Свинья", chicken: "Курица", horse: "Лошадь", villager: "Житель", wolf: "Волк", cat: "Кошка", rabbit: "Кролик", iron_golem: "Железный голем" };
function showActor() {
  const actor = actors.get(selectedActor);
  $("actor-info").hidden = !actor;
  if (!actor) return;
  $("actor-name").textContent = actor.record.name || typeLabels[actor.type] || "Существо";
  $("actor-kind").textContent = actor.record.kind === "player" ? "Игрок" : actor.record.kind === "npc" ? "Житель поселения" : typeLabels[actor.type] || "Обитатель мира";
}

function applyActorPose(actor, value, delta) {
  if(actor.display) {
    actor.mesh.position.set(...value.position);
    const display=value.display;
    actor.display.translation.position.set(...(display.translation ?? [0,0,0]));
    actor.display.left.quaternion.set(...(display.leftRotation ?? [0,0,0,1])).normalize();
    actor.display.scale.scale.set(...(display.scale ?? [1,1,1]));
    actor.display.right.quaternion.set(...(display.rightRotation ?? [0,0,0,1])).normalize();
    const yaw=-THREE.MathUtils.degToRad(value.yawDegrees),pitch=THREE.MathUtils.degToRad(value.pitchDegrees);
    if(display.billboard==="CENTER") actor.mesh.quaternion.copy(camera.quaternion);
    else if(display.billboard==="VERTICAL") actor.mesh.rotation.set(0,Math.atan2(camera.position.x-value.position[0],camera.position.z-value.position[2]),0);
    else if(display.billboard==="HORIZONTAL") actor.mesh.rotation.set(camera.rotation.x,yaw,0,"ZYX");
    else actor.mesh.rotation.set(pitch,yaw,0,"YXZ");
    return;
  }
  for (const body of [actor.body, ...actor.bodies.map((part) => part.mesh)].filter(Boolean)) {
    const material = body.material;
    if (material.map && material.map !== material.userData.worldViewMap) {
      material.userData.worldViewMap = material.map;
      material.needsUpdate = true;
    }
  }
  actor.mesh.position.set(...value.position);
  actor.mesh.rotation.y = Math.PI - THREE.MathUtils.degToRad(value.yawDegrees);
  actor.mesh.scale.setScalar(Number(value.scale) > 0 ? Number(value.scale) : 1);
  actor.phase += value.speed * delta * 5.5;
  const walk = reducedMotion ? 0 : Math.sin(actor.phase) * 0.62 * Math.min(value.speed / 1.4, 1);
  const crouching = value.pose === "SNEAKING" || value.pose === "CROUCHING" || value.pose?.crouching;
  if (actor.body) {
    if (actor.skinTexture && actor.body.material.map !== actor.skinTexture) actor.body.material.map = actor.skinTexture;
    const pose = actorBoneRotations({ riding: Boolean(value.seated), crouching: Boolean(crouching), walk, swingProgress: 0 });
    for (const [name, rotation] of Object.entries(pose)) {
      if (!actor.bones[name]) continue;
      const resolved = offsetBoneRotation(actor.base[name], rotation);
      actor.bones[name].rotation.set(resolved.x, resolved.y, resolved.z);
    }
    if (actor.bones.head) { actor.bones.head.rotation.y = actor.base.head.y - THREE.MathUtils.degToRad(value.headYawDegrees - value.yawDegrees); actor.bones.head.rotation.x = actor.base.head.x - THREE.MathUtils.degToRad(value.pitchDegrees); }
  } else {
    poseMobSkeletons(actor.bodies, walk, THREE.MathUtils.degToRad(value.headYawDegrees - value.yawDegrees), THREE.MathUtils.degToRad(value.pitchDegrees));
  }
}

async function fetchChunk(descriptor, expectedGeneration) {
  const expectedEpoch = epoch;
  const key = `${descriptor.x},${descriptor.z}`;
  if (loadedChunks.get(key) === descriptor.revision || pendingChunks.get(key) === descriptor.revision) return;
  pendingChunks.set(key, descriptor.revision);
  const controller = new AbortController();
  chunkControllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const chunk = await json(relativeUrl(descriptor.url), controller.signal);
    if (expectedGeneration !== generation || expectedEpoch !== epoch) return;
    if (chunk.minY !== selectedScene.bounds.minY || chunk.height !== selectedScene.bounds.maxY - selectedScene.bounds.minY) throw Error("Chunk height differs from scene bounds");
    const id = ++chunkRequestId;
    const decoded = await new Promise((resolve, reject) => { decodeRequests.set(id, { resolve, reject }); decoder.postMessage({ id, chunk, version: catalog.minecraftVersion }); });
    if (expectedGeneration !== generation || expectedEpoch !== epoch || pendingChunks.get(key) !== descriptor.revision) return;
    terrain.addColumn(descriptor.x * 16, descriptor.z * 16, decoded);
    terrainWarnings.set(key,chunk.palette.some((block) => assets.unsupportedBlocks?.includes(block.replace(/^minecraft:/,"").split("[")[0])));
    loadedChunks.set(key, descriptor.revision);
    viewport.dataset.chunks = String(loadedChunks.size);
  } catch (error) {
    if (expectedGeneration === generation && expectedEpoch === epoch && error.status !== 410) notice("Не все участки успели загрузиться. Повторяем загрузку.");
  } finally { clearTimeout(timeout); chunkControllers.delete(controller); if (expectedGeneration === generation && expectedEpoch === epoch && pendingChunks.get(key) === descriptor.revision) pendingChunks.delete(key); }
}

async function receiveFrame(frame, expectedGeneration) {
  if (expectedGeneration !== generation || frame.sceneId !== selectedScene.id) return;
  if (epoch !== null && epoch !== frame.epoch) {
    await refreshCatalog();
    if (expectedGeneration !== generation) return;
  }
  if (epoch !== frame.epoch || frame.reset && sequence >= 0 && sequence !== frame.seq) { clearWorld(); epoch = frame.epoch; }
  const fresh=sequence!==frame.seq;
  sequence = frame.seq;
  if(fresh) lastFrameAt = performance.now();
  loadedCount = frame.loadedChunks; totalCount = frame.totalChunks;
  if(fresh) updateActors(frame.entities, lastFrameAt);
  const current = new Set(frame.chunks.map((chunk) => `${chunk.x},${chunk.z}`));
  for (const key of loadedChunks.keys()) if (!current.has(key)) {
    const [x, z] = key.split(",").map(Number); terrain.removeColumn(x * 16, z * 16); loadedChunks.delete(key); terrainWarnings.delete(key);
  }
  // Only two new chunks in flight keeps the browser responsive during the first panorama.
  const needed = frame.chunks.filter((chunk) => loadedChunks.get(`${chunk.x},${chunk.z}`) !== chunk.revision && !pendingChunks.has(`${chunk.x},${chunk.z}`));
  for (const chunk of needed.slice(0, Math.max(0, 2 - pendingChunks.size))) void fetchChunk(chunk, expectedGeneration);
  $("coverage").textContent = loadedCount < totalCount ? `Доступно ${loadedCount} из ${totalCount} участков` : "Игроки и жители в реальном времени";
  if(performance.now()-lastFrameAt<3000) connection("live", "В прямом эфире");
  if (frame.entities.length && !frame.chunks.length) message("Мир ещё загружается", "В этой локации пока нет загруженных участков.");
  if (!frame.chunks.length && !frame.entities.length) message("Здесь пока тихо", "Локация появится, когда сервер загрузит её участки.");
}

async function poll(expectedGeneration) {
  while (expectedGeneration === generation) {
    const started = performance.now();
    if (!document.hidden) {
      pollController = new AbortController();
      const timeout = setTimeout(() => pollController?.abort(), 5000);
      try {
        const url = new URL(`v1/scenes/${encodeURIComponent(selectedScene.id)}/frame`, baseUrl);
        if (sequence >= 0) url.searchParams.set("after", String(sequence));
        const frame = await json(url, pollController.signal);
        await receiveFrame(frame, expectedGeneration);
      } catch (error) {
        if (expectedGeneration !== generation) return;
        connection("stale", "Восстанавливаем связь");
        if (!hasGeometry) message("Пока нет связи с миром", "Повторяем подключение автоматически. Локация останется выбранной.", true);
      } finally { clearTimeout(timeout); }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(20, (document.hidden ? 1000 : 200) - (performance.now() - started))));
  }
}

function selectScene(id) {
  if (workerFailed) return;
  const next = catalog.scenes.find((item) => item.id === id);
  if (!next) return;
  generation++; pollController?.abort();
  selectedScene = next; sequence = -1; epoch = null; lastFrameAt = 0;
  clearWorld(); terrainRoot.position.y = next.bounds.minY;
  $("scene-name").textContent = next.name;
  $("scene-caption").hidden = false;
  $("coverage").textContent = "Загружаем местность";
  message("Открываем локацию", next.name);
  frameScene("isometric");
  const url = new URL(window.location.href); url.searchParams.set("scene", id); historyReplace(url);
  void poll(generation);
}

function historyReplace(url) { window.history.replaceState({}, "", url); }

function setSceneOptions(preferred) {
  sceneSelect.replaceChildren();
  for (const location of catalog.scenes) { const option = document.createElement("option"); option.value = location.id; option.textContent = location.name; sceneSelect.append(option); }
  sceneSelect.disabled = catalog.scenes.length === 0;
  sceneSelect.value = catalog.scenes.some((item) => item.id === preferred) ? preferred : catalog.scenes[0]?.id ?? "";
}

async function readAssets(nextCatalog) {
  const manifestUrl = relativeUrl(nextCatalog.assetsUrl);
  const nextAssets = { ...await json(manifestUrl), manifestUrl };
  if (nextAssets.minecraftVersion !== nextCatalog.minecraftVersion) throw Error("Asset version differs from the world");
  const blockStates = await json(relativeUrl(nextAssets.blockStates,manifestUrl));
  return { assets:nextAssets,blockStates };
}

function applyAssets(nextAssets) {
  assets = nextAssets;
  failedAssets=false;
  setAssets(assets);
  for (const [type, textures] of Object.entries(assets.entityTemplateTextures ?? {})) if (entityModels[type]) Object.assign(entityModels[type].textures, textures);
}

function refreshCatalog() {
  if (catalogRefreshing) return catalogRefreshing;
  catalogRefreshing = (async () => {
    const nextCatalog = await json(new URL("v1/scenes", baseUrl));
    if (nextCatalog.schemaVersion !== 1) throw Error("Unsupported protocol version");
    const previous = selectedScene;
    const assetsChanged = nextCatalog.assetRevision !== catalog.assetRevision;
    const resources=assetsChanged ? await readAssets(nextCatalog) : null;
    catalog = nextCatalog;
    setSceneOptions(previous?.id);
    const nextScene = catalog.scenes.find((item) => item.id === sceneSelect.value);
    const changed = assetsChanged || nextScene?.id !== previous?.id || JSON.stringify(nextScene?.bounds) !== JSON.stringify(previous?.bounds);
    if (assetsChanged) {
      generation++; pollController?.abort(); clearWorld();
      applyAssets(resources.assets);
      terrain.blockStatesData = resources.blockStates;
      configureModelData(resources.blockStates);
      terrain.texturesDataUrl = assetUrl(assets.atlas); terrain.setVersion(catalog.minecraftVersion);
    }
    if (changed && nextScene) selectScene(nextScene.id);
    else if (nextScene) { selectedScene = nextScene; $("scene-name").textContent = nextScene.name; }
    else { generation++; pollController?.abort(); clearWorld(); connection("idle","Нет локаций"); message("Локации ещё не выбраны", "Скоро здесь можно будет посмотреть спавн и поселения."); }
  })().finally(() => { catalogRefreshing = null; });
  return catalogRefreshing;
}

function animate(now) {
  requestAnimationFrame(animate);
  if (document.hidden || workerFailed) { lastLoopAt = now; return; }
  const delta = Math.min((now - lastLoopAt) / 1000, 0.1); lastLoopAt = now;
  controls.update();
  for (const [id, actor] of actors) {
    const value = sampleActor(history, id, now);
    if (value) applyActorPose(actor, value, delta);
  }
  if (!hasGeometry && Object.keys(terrain.sectionMeshs).length && loadedChunks.size) {
    hasGeometry = true; $("scene-message").hidden = true; viewport.dataset.state = "ready";
  }
  if (lastFrameAt && now - lastFrameAt > 3000) connection("stale", "Связь прервалась");
  renderer.render(scene, camera);
}

async function start() {
  try {
    catalog = await json(new URL("v1/scenes", baseUrl));
    if (catalog.schemaVersion !== 1) throw Error("Unsupported protocol version");
    const resources = await readAssets(catalog);
    applyAssets(resources.assets);
    initRenderer();
    terrain.blockStatesData = resources.blockStates;
    configureModelData(resources.blockStates);
    terrain.setVersion(catalog.minecraftVersion);
    setSceneOptions(new URLSearchParams(window.location.search).get("scene"));
    setInterval(() => { if (!document.hidden && !workerFailed) refreshCatalog().catch(() => {}); }, 30000);
    if (!catalog.scenes.length) { message("Локации ещё не выбраны", "Скоро здесь можно будет посмотреть спавн и поселения."); connection("idle", "Нет локаций"); return; }
    selectScene(sceneSelect.value);
  } catch (error) {
    console.error("ArcWorldView:", error.message);
    message("Не удалось открыть мир", "Проверь подключение и попробуй снова.", true);
    connection("error", "Просмотр недоступен");
  }
}

sceneSelect.addEventListener("change", () => selectScene(sceneSelect.value));
$("isometric").addEventListener("click", () => frameScene("isometric"));
$("top-view").addEventListener("click", () => frameScene("top"));
$("reset-view").addEventListener("click", () => frameScene());
$("zoom-in").addEventListener("click", () => { if (camera) { camera.zoom = Math.min(camera.zoom * 1.3, controls.maxZoom); camera.updateProjectionMatrix(); } });
$("zoom-out").addEventListener("click", () => { if (camera) { camera.zoom = Math.max(camera.zoom / 1.3, controls.minZoom); camera.updateProjectionMatrix(); } });
$("fullscreen").addEventListener("click", async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { notice("Полный экран недоступен в этом браузере."); } });
$("retry").addEventListener("click", () => window.location.reload());
window.addEventListener("worldview-asset-error", () => { failedAssets = true; notice("Часть текстур не загрузилась."); });
if (window.parent !== window) window.parent.postMessage({ type: "arc-worldview-ready" }, window.location.origin);
void start();
