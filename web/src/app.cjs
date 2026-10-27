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
const { playerHandBone, playerHandGripMatrix, heldItemArmRotation } = require("./native-item-geometry.cjs");
const { createAtmosphere } = require("./atmosphere.cjs");
const { cameraView, cameraBounds, chunkInBounds, chunkPriority, actorPriority, frameConnection } = require("./view-priority.cjs");

const $ = (id) => document.getElementById(id);
const viewport = $("viewport");
const baseUrl = new URL("./", window.location.href);
const sceneSelect = $("scene");
const viewerId = crypto.randomUUID();
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const actors = new Map(), actorRecords = new Map(), loadedChunks = new Map(), pendingChunks = new Map(), decodeRequests = new Map(), skinTextures = new Map();
const chunkDescriptors = new Map(), chunkRetries = new Map(), modelIssues = new Map();
const terrainWarnings=new Map();
const history = [];
let assets, catalog, selectedScene, renderer, scene, camera, controls, terrain, terrainRoot, decoder, atmosphere;
let generation = 0, epoch = null, sequence = -1, lastFrameAt = 0, lastLoopAt = 0, chunkRequestId = 0, loadedCount = 0, totalCount = 0;
let cameraMode = "isometric", selectedActor = null, hoveredActor = null, pinnedActor = null, pollController = null, hasGeometry = false, span = 64, failedAssets = false;
let lastTransportAt = 0, capturedAt = null, lastWorkAt = -Infinity, currentView = null, lastAcceptedView = null;
let liveFramesSeen = false, sourceState = {}, bootstrapController = null;
let catalogRefreshing = null;
let workerFailed = false, actorsDirty = true;
let actorQueue = [];
const compatibility = new Map();
let pinnedRecord = null, detailData = null, detailController = null, detailTimer = null, detailToken = 0;

function relativeUrl(value, parent = baseUrl) {
  const result = new URL(value, parent);
  if (result.origin !== window.location.origin) throw Error("A resource is outside this viewer");
  return result.href;
}

async function json(url, signal, cache = "no-store") {
  const response = await fetch(url, { signal, credentials: "same-origin", cache });
  if (!response.ok) throw Object.assign(Error(`HTTP ${response.status}`), { status: response.status });
  return response.json();
}

function connection(state, text) {
  const element = $("connection-text");
  if (element.textContent !== text) element.textContent = text;
  if (element.parentElement.dataset.state !== state) element.parentElement.dataset.state = state;
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
  for (const job of pendingChunks.values()) job.controller.abort();
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
  atmosphere?.reset();
  bootstrapController?.abort(); bootstrapController = null;
  liveFramesSeen = false; sourceState = {};
  history.length = 0;
  for (const actor of actors.values()) disposeMesh(actor.mesh);
  actors.clear();
  for (const key of loadedChunks.keys()) {
    const [x, z] = key.split(",").map(Number);
    terrain.removeColumn(x * 16, z * 16);
  }
  for (const job of pendingChunks.values()) job.controller.abort();
  loadedChunks.clear(); pendingChunks.clear(); chunkDescriptors.clear(); chunkRetries.clear();
  actorRecords.clear(); modelIssues.clear(); terrainWarnings.clear();
  actorQueue = []; actorsDirty = true; currentView = null; lastWorkAt = -Infinity; lastAcceptedView = null;
  for (const pending of decodeRequests.values()) pending.reject(Error("Scene changed"));
  decodeRequests.clear();
  stopActorDetails();
  selectedActor = hoveredActor = pinnedActor = null; pinnedRecord = detailData = null;
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
  atmosphere?.resize(width, height);
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
  camera = new THREE.OrthographicCamera(-40, 40, 30, -30, 0.1, 1800);
  atmosphere = createAtmosphere({ renderer, scene, camera });
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
  let pointerDown = null;
  const activePointers = new Set();
  const hitActor = event => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects([...actors.values()].filter(actor => actor.mesh.visible).map(actor => actor.mesh), true)[0];
    let object = hit?.object;
    while (object && !object.userData.actorId) object = object.parent;
    return object?.userData.actorId ?? null;
  };
  renderer.domElement.addEventListener("pointermove", event => {
    if (event.buttons || event.pointerType === "touch") return;
    hoveredActor = hitActor(event);
    renderer.domElement.style.cursor = hoveredActor ? "pointer" : "grab";
    if (!pinnedActor) { selectedActor = hoveredActor; showActor(); }
  });
  renderer.domElement.addEventListener("pointerdown", event => {
    activePointers.add(event.pointerId);
    pointerDown = activePointers.size === 1 ? { x: event.clientX, y: event.clientY, id: event.pointerId, button: event.button } : null;
  });
  renderer.domElement.addEventListener("pointerup", event => {
    if (pointerDown?.id === event.pointerId && pointerDown.button === 0 && Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) < 6) pinActor(hitActor(event));
    activePointers.delete(event.pointerId); pointerDown = null;
  });
  renderer.domElement.addEventListener("pointercancel", event => { activePointers.delete(event.pointerId); pointerDown = null; });
  renderer.domElement.addEventListener("pointerleave", () => { hoveredActor = null; if (!pinnedActor) { selectedActor = null; showActor(); } });
  renderer.domElement.addEventListener("keydown", event => {
    if (event.key === "Enter" && hoveredActor) { event.preventDefault(); pinActor(hoveredActor); }
  });
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
  } catch (error) { if (actors.get(record.id)===actor) actor.modelError=error.message; }
}

async function updateEquipment(actor,record) {
  const equipment=Array.isArray(record.equipment) ? Object.fromEntries(record.equipment.map((item) => [item.slot,item])) : record.equipment ?? {};
  const signature=JSON.stringify(equipment);
  if(actor.equipmentSignature===signature) return;
  actor.equipmentSignature=signature;
  actor.heldHands = Object.fromEntries(["HAND","OFF_HAND"].map(slot => [playerHandBone(slot), equipment[slot]?.material && equipment[slot].material !== "minecraft:air"]));
  actor.modelError=false;
  for(const mesh of actor.equipmentMeshes ?? []) disposeMesh(mesh);
  actor.equipmentMeshes=[];
  for(const [slot,item] of Object.entries(equipment)) {
    if(!item || item.material==="minecraft:air") continue;
    if(["HEAD","CHEST","LEGS","FEET"].includes(slot)) {
      try {
        const armor=armorParts(item,slot);
        if(armor) { for(const {bone,mesh} of armor) { actor.bones[bone].add(mesh); actor.equipmentMeshes.push(mesh); } continue; }
      } catch (error) { actor.modelError=`${item.material}: ${error.message}`; continue; }
    }
    if(!["HAND","OFF_HAND","HEAD"].includes(slot)) continue;
    const bone=actor.bones[slot==="HEAD"?"head":playerHandBone(slot)];
    if(!bone) continue;
    try {
      const mesh=await itemMesh(item,slot==="HEAD"?"head":slot==="HAND"?"thirdperson_righthand":"thirdperson_lefthand");
      if(actors.get(record.id)!==actor || actor.equipmentSignature!==signature) { disposeMesh(mesh); return; }
      if(slot==="HEAD") { mesh.scale.setScalar(16); mesh.rotation.y=Math.PI; }
      else { mesh.matrixAutoUpdate=false; mesh.matrix.copy(playerHandGripMatrix(slot,record.skin?.model==="slim")); }
      bone.add(mesh); actor.equipmentMeshes.push(mesh);
    } catch (error) { actor.modelError=`${item.material}: ${error.message}`; }
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
  if (!compatibility.has(type) || compatibility.get(type)) return null;
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

function actorType(record) { return String(record.type).replace(/^minecraft:/, "").toLowerCase(); }

function modelIssue(record, reason) {
  const type = actorType(record);
  const previous = modelIssues.get(record.id);
  if (previous?.reason !== reason) console.warn("ArcWorldView model unavailable", { type, reason });
  modelIssues.set(record.id, { type, reason });
}

function updateModelNotice() {
  const unavailable = [...new Set([...modelIssues.values()].map(issue => issue.type))];
  viewport.dataset.missingModels = unavailable.join(",");
  if (unavailable.length) {
    const names = unavailable.slice(0,3).map(type => typeLabels[type] || type);
    notice(`Пока не отображаются: ${names.join(", ")}${unavailable.length > 3 ? " и ещё несколько моделей" : ""}.`);
  } else if (failedAssets) notice("Часть текстур не загрузилась.");
  else if ([...terrainWarnings.values()].some(blocks => blocks.length)) notice("Часть блоков ещё не поддерживается просмотром.");
  else notice("");
}

function updateActors(records, at) {
  const current = new Map(records.map(record => [record.id, record]));
  history.push({ at, actors: current });
  while (history.length > 8) history.shift();
  actorRecords.clear();
  for (const [id, record] of current) {
    actorRecords.set(id, record);
    const type = actorType(record);
    const reason = record.kind === "display" ? null : compatibility.get(type) ?? "native-model-unavailable";
    if (reason) modelIssue(record, reason);
    const actor = actors.get(id);
    if (actor && actor.type !== type) { disposeMesh(actor.mesh); actors.delete(id); }
    else if (actor) actor.record = record;
  }
  for (const [id, actor] of actors) if (!current.has(id)) { disposeMesh(actor.mesh); actors.delete(id); }
  for (const id of modelIssues.keys()) if (!current.has(id)) modelIssues.delete(id);
  if (pinnedActor && current.has(pinnedActor)) pinnedRecord = current.get(pinnedActor);
  actorsDirty = true;
  showActor(); updateModelNotice();
}

function syncActors() {
  if (actorsDirty) {
    actorQueue = [];
    for (const record of actorRecords.values()) {
      const priority = actorPriority(record, currentView);
      const wanted = Number.isFinite(priority);
      const actor = actors.get(record.id);
      if (actor) {
        actor.mesh.visible = wanted;
        if (wanted) {
          if (actor.body) { loadSkin(actor, record).catch(() => { failedAssets = true; }); void updateEquipment(actor, record); }
          if (actor.display) void updateDisplay(actor, record);
          if (actor.modelError) modelIssue(record, typeof actor.modelError === "string" ? actor.modelError : "equipment-or-display-unavailable");
          else modelIssues.delete(record.id);
        }
      } else if (wanted && !modelIssues.has(record.id)) actorQueue.push({ record, priority });
    }
    actorQueue.sort((a,b) => a.priority - b.priority);
    actorsDirty = false; updateModelNotice();
  }
  // Mesh construction and its asset requests cannot monopolise a live frame.
  const started = performance.now();
  for (let count = 0; count < 2 && actorQueue.length && performance.now() - started < 3; count++) {
    const { record } = actorQueue.shift();
    if (!actorRecords.has(record.id) || actors.has(record.id)) continue;
    try {
      const actor = createActor(record);
      if (!actor) { modelIssue(record, "native-model-unavailable"); continue; }
      actor.record = actorRecords.get(record.id);
      if (actor.body) void updateEquipment(actor, actor.record);
      if (actor.display) void updateDisplay(actor, actor.record);
    } catch (error) { modelIssue(record, error.message); }
  }
  viewport.dataset.actors = String(actors.size);
}

const typeLabels = { cow: "Корова", sheep: "Овца", pig: "Свинья", chicken: "Курица", horse: "Лошадь", villager: "Житель", wolf: "Волк", cat: "Кошка", rabbit: "Кролик", iron_golem: "Железный голем", player: "Житель", pillager: "Разбойник", squid: "Спрут", item: "Предметы на земле" };
function showActor() {
  const record = actorRecords.get(selectedActor) ?? (selectedActor === pinnedActor ? pinnedRecord : null);
  $("actor-info").hidden = !record;
  if (!record) return;
  $("actor-info").dataset.pinned = String(Boolean(pinnedActor));
  $("actor-close").hidden = !pinnedActor;
  $("actor-name").textContent = (pinnedActor && detailData?.title) || record.name || typeLabels[actorType(record)] || "Существо";
  $("actor-kind").textContent = record.kind === "player" ? "Игрок" : record.kind === "npc" ? "Житель поселения" : typeLabels[actorType(record)] || "Обитатель мира";
  $("actor-select-hint").hidden = Boolean(pinnedActor);
  if (pinnedActor) renderActorDetails(record);
}

function stopActorDetails() {
  detailToken++; clearTimeout(detailTimer); detailTimer = null;
  detailController?.abort(); detailController = null;
}

function renderActorDetails(record) {
  const fields = detailData?.fields ?? [];
  const list = $("actor-details"), signature = JSON.stringify(fields);
  if (list.dataset.fields !== signature || !list.lastElementChild) {
    const rows = document.createDocumentFragment();
    for (const field of fields) {
      if (typeof field.label !== "string" || typeof field.value !== "string") continue;
      const label = document.createElement("dt"), value = document.createElement("dd");
      label.textContent = field.label; value.textContent = field.value;
      rows.append(label, value);
    }
    rows.append(document.createElement("dt"), document.createElement("dd"));
    list.replaceChildren(rows); list.dataset.fields = signature;
  }
  const label = actorRecords.has(record.id) ? "Положение" : "Последняя позиция";
  const value = record.position.map(Math.floor).join(", ");
  if (list.lastElementChild.previousElementSibling.textContent !== label) list.lastElementChild.previousElementSibling.textContent = label;
  if (list.lastElementChild.textContent !== value) list.lastElementChild.textContent = value;
}

function pinActor(id) {
  stopActorDetails();
  pinnedActor = selectedActor = id;
  pinnedRecord = id ? actorRecords.get(id) : null;
  detailData = null;
  $("actor-details").replaceChildren();
  $("actor-detail-state").hidden = true;
  $("actor-retry").hidden = true;
  showActor();
  if (pinnedRecord) void loadActorDetails(detailToken, generation, selectedScene.id, id, 0);
}

async function loadActorDetails(token, sceneGeneration, sceneId, id, failures) {
  const current = () => token === detailToken && sceneGeneration === generation && pinnedActor === id;
  if (!current()) return;
  if (document.hidden) { detailTimer = setTimeout(() => loadActorDetails(token, sceneGeneration, sceneId, id, failures), 1000); return; }
  const state = $("actor-detail-state");
  if (!detailData) { state.hidden = false; state.textContent = "Загружаем сведения…"; }
  const controller = new AbortController(); detailController = controller;
  const timeout = setTimeout(() => controller.abort(), 5000);
  let again = true, nextFailures = 0;
  try {
    const url = new URL(`v1/scenes/${encodeURIComponent(sceneId)}/entities/${encodeURIComponent(id)}`, baseUrl);
    const result = await json(url, controller.signal);
    if (!current()) return;
    if (result.id !== id || !Array.isArray(result.fields)) throw Error("Unexpected entity details");
    detailData = result;
    $("actor-retry").hidden = true;
    state.hidden = true;
    showActor();
  } catch (error) {
    if (!current()) return;
    state.hidden = false;
    if (error.status === 404) {
      state.textContent = "Больше не находится в этой области."; again = false;
    } else {
      nextFailures = failures + 1;
      state.textContent = error.status === 425 ? "Сведения о жителе ещё готовятся." : "Не удалось обновить сведения.";
      again = nextFailures < 4;
      $("actor-retry").hidden = again;
    }
  } finally {
    clearTimeout(timeout);
    if (detailController === controller) detailController = null;
    if (current() && again) detailTimer = setTimeout(() => loadActorDetails(token, sceneGeneration, sceneId, id, nextFailures), 1000);
  }
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
      const resolved = offsetBoneRotation(actor.base[name], actor.heldHands?.[name] ? heldItemArmRotation(rotation) : rotation);
      actor.bones[name].rotation.set(resolved.x, resolved.y, resolved.z);
    }
    if (actor.bones.head) { actor.bones.head.rotation.y = actor.base.head.y - THREE.MathUtils.degToRad(value.headYawDegrees - value.yawDegrees); actor.bones.head.rotation.x = actor.base.head.x - THREE.MathUtils.degToRad(value.pitchDegrees); }
  } else {
    poseMobSkeletons(actor.bodies, walk, THREE.MathUtils.degToRad(value.headYawDegrees - value.yawDegrees), THREE.MathUtils.degToRad(value.pitchDegrees));
  }
}

function viewQuery(url) {
  const view = cameraBounds(camera, selectedScene.bounds);
  url.searchParams.set("view", [view.minX, view.minZ, view.maxX, view.maxZ].join(","));
  return url;
}

async function bootstrapTerrain(expectedGeneration) {
  const sceneId = selectedScene.id, controller = new AbortController();
  bootstrapController = controller;
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const url = viewQuery(new URL(`v1/scenes/${encodeURIComponent(sceneId)}/terrain`, baseUrl));
    const saved = await json(url, controller.signal);
    if (expectedGeneration !== generation || selectedScene.id !== sceneId || liveFramesSeen || epoch !== null && epoch !== saved.epoch) return;
    if (saved.sceneId !== sceneId || !Array.isArray(saved.chunks)) return;
    epoch = saved.epoch;
    for (const chunk of saved.chunks) chunkDescriptors.set(`${chunk.x},${chunk.z}`, chunk);
    loadedCount = saved.loadedChunks; totalCount = saved.totalChunks;
    connection("saved", "Сохранённая местность");
    $("coverage").textContent = "Подключаемся к живому миру";
    pumpChunks();
  } catch { /* A missing saved snapshot never delays the independent live loop. */ }
  finally {
    clearTimeout(timeout);
    if (bootstrapController === controller) bootstrapController = null;
  }
}

function pumpChunks() {
  if (document.hidden || workerFailed || !selectedScene || !camera || pendingChunks.size >= 2) return;
  currentView = cameraView(camera, controls.target, selectedScene.bounds);
  const now = performance.now();
  const needed = [...chunkDescriptors.values()].filter(chunk => {
    const key = `${chunk.x},${chunk.z}`;
    return loadedChunks.get(key) !== chunk.revision && !pendingChunks.has(key) && (chunkRetries.get(key)?.at ?? 0) <= now;
  }).map(chunk => ({ chunk, priority: chunkPriority(chunk, currentView) })).filter(entry => Number.isFinite(entry.priority)).sort((a,b) => a.priority - b.priority);
  for (const { chunk } of needed.slice(0, 2 - pendingChunks.size)) void fetchChunk(chunk, generation);
}

async function fetchChunk(descriptor, expectedGeneration) {
  const expectedEpoch = epoch;
  const key = `${descriptor.x},${descriptor.z}`;
  if (loadedChunks.get(key) === descriptor.revision || pendingChunks.has(key)) return;
  const controller = new AbortController();
  const job = { revision: descriptor.revision, controller };
  pendingChunks.set(key, job);
  const current = () => expectedGeneration === generation && expectedEpoch === epoch && pendingChunks.get(key) === job && chunkDescriptors.get(key)?.revision === descriptor.revision && !controller.signal.aborted;
  const timeout = setTimeout(() => controller.abort(), 8000);
  let decodeId;
  try {
    const chunk = await json(relativeUrl(descriptor.url), controller.signal, "default");
    if (!current()) return;
    if (chunk.minY !== selectedScene.bounds.minY || chunk.height !== selectedScene.bounds.maxY - selectedScene.bounds.minY) throw Error("Chunk height differs from scene bounds");
    decodeId = ++chunkRequestId;
    const decoded = await new Promise((resolve, reject) => {
      const abort = () => { decodeRequests.delete(decodeId); reject(Error("Chunk work cancelled")); };
      controller.signal.addEventListener("abort", abort, { once: true });
      const finish = callback => value => { controller.signal.removeEventListener("abort", abort); callback(value); };
      decodeRequests.set(decodeId, { resolve: finish(resolve), reject: finish(reject) });
      decoder.postMessage({ id: decodeId, chunk, version: catalog.minecraftVersion });
    });
    if (!current()) return;
    terrain.addColumn(descriptor.x * 16, descriptor.z * 16, decoded);
    atmosphere.setChunk(key, chunk);
    terrainWarnings.set(key, chunk.palette.filter(block => assets.unsupportedBlocks?.includes(block.replace(/^minecraft:/, "").split("[")[0])));
    loadedChunks.set(key, descriptor.revision);
    chunkRetries.delete(key);
    viewport.dataset.chunks = String(loadedChunks.size);
    updateModelNotice();
  } catch (error) {
    if (expectedGeneration === generation && expectedEpoch === epoch && pendingChunks.get(key) === job && chunkDescriptors.get(key)?.revision === descriptor.revision) {
      chunkRetries.set(key, { at: performance.now() + 1000 });
      if (error.status !== 410 && !controller.signal.aborted) notice("Не все участки успели загрузиться. Повторяем загрузку.");
    }
  } finally {
    clearTimeout(timeout);
    if (decodeId) decodeRequests.delete(decodeId);
    if (pendingChunks.get(key) === job) pendingChunks.delete(key);
    if (expectedGeneration === generation && expectedEpoch === epoch) pumpChunks();
  }
}

async function receiveFrame(frame, expectedGeneration) {
  if (expectedGeneration !== generation || frame.sceneId !== selectedScene.id) return;
  if (epoch !== null && epoch !== frame.epoch) {
    await refreshCatalog();
    if (expectedGeneration !== generation) return;
  }
  if (epoch !== frame.epoch || frame.reset && sequence >= 0 && sequence !== frame.seq) { clearWorld(); epoch = frame.epoch; }
  const acceptedView = frame.view ?? selectedScene.bounds;
  const viewKey = JSON.stringify([acceptedView.minX, acceptedView.minZ, acceptedView.maxX, acceptedView.maxZ]);
  const fresh = sequence !== frame.seq || lastAcceptedView !== viewKey;
  lastAcceptedView = viewKey;
  sequence = frame.seq;
  liveFramesSeen = true; bootstrapController?.abort();
  lastTransportAt = performance.now(); capturedAt = frame.capturedAt;
  sourceState = { stale: Boolean(frame.stale), frozen: Boolean(frame.frozen) };
  if(fresh) lastFrameAt = lastTransportAt;
  loadedCount = frame.loadedChunks; totalCount = frame.totalChunks;
  if(fresh) updateActors(frame.entities, lastFrameAt);
  chunkDescriptors.clear();
  for (const chunk of frame.chunks) chunkDescriptors.set(`${chunk.x},${chunk.z}`, chunk);
  for (const [key, job] of pendingChunks) if (chunkDescriptors.get(key)?.revision !== job.revision) job.controller.abort();
  const current = new Set(chunkDescriptors.keys());
  const removed = new Set((frame.removedChunks ?? []).map(chunk => `${chunk.x},${chunk.z}`));
  for (const key of loadedChunks.keys()) {
    const [x, z] = key.split(",").map(Number);
    if (removed.has(key) || frame.terrainComplete !== false && !current.has(key) && chunkInBounds(x, z, acceptedView)) {
      terrain.removeColumn(x * 16, z * 16); loadedChunks.delete(key); terrainWarnings.delete(key);
      atmosphere.removeChunk(key);
    }
  }
  pumpChunks();
  $("coverage").textContent = sourceState.frozen ? "Последнее доступное состояние мира" : loadedCount < totalCount ? `Доступно ${loadedCount} из ${totalCount} участков` : "Игроки и жители в реальном времени";
  const status = frameConnection(performance.now(), lastTransportAt, lastFrameAt, capturedAt, Date.now(), sourceState);
  connection(status.state, status.text);
  if (!hasGeometry && frame.entities.length && !frame.chunks.length) message("Мир ещё загружается", "В этой локации пока нет загруженных участков.");
  if (!hasGeometry && !frame.chunks.length && !frame.entities.length) message("Здесь пока тихо", "Локация появится, когда сервер загрузит её участки.");
}

async function poll(expectedGeneration) {
  while (expectedGeneration === generation) {
    const started = performance.now();
    if (!document.hidden) {
      const controller = new AbortController(); pollController = controller;
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const url = viewQuery(new URL(`v1/scenes/${encodeURIComponent(selectedScene.id)}/frame`, baseUrl));
        if (sequence >= 0) url.searchParams.set("after", String(sequence));
        url.searchParams.set("viewer", viewerId);
        const frame = await json(url, controller.signal);
        await receiveFrame(frame, expectedGeneration);
      } catch (error) {
        if (expectedGeneration !== generation) return;
        if (!liveFramesSeen && chunkDescriptors.size) connection("saved", "Сохранённая местность");
        else if (error.status === 425) {
          connection("idle", "Мир загружается");
          if (!hasGeometry) message("Открываем локацию", "Сервер готовит первые участки.");
        } else {
          connection("stale", "Восстанавливаем связь");
          if (!hasGeometry) message("Пока нет связи с миром", "Повторяем подключение автоматически. Локация останется выбранной.", true);
        }
      } finally { clearTimeout(timeout); }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(20, (document.hidden ? 1000 : 200) - (performance.now() - started))));
  }
}

function navigateScene(id) {
  if (id === selectedScene?.id || !catalog.scenes.some(item => item.id === id)) return;
  // A different world gets a fresh renderer/worker document. Reusing the loaded
  // world's WebGL/worker lifecycle can stall both terrain and live polling.
  // Ordinary navigation keeps HTTP caches and only replaces this viewer iframe.
  const url = new URL(window.location.href);
  url.searchParams.set("scene", id);
  window.location.assign(url.href);
}

function selectScene(id) {
  if (workerFailed) return;
  const next = catalog.scenes.find((item) => item.id === id);
  if (!next) return;
  generation++; pollController?.abort();
  selectedScene = next; sequence = -1; epoch = null; lastFrameAt = 0; lastTransportAt = 0; capturedAt = null;
  clearWorld(); terrainRoot.position.y = next.bounds.minY;
  atmosphere.setBounds(next.bounds);
  $("scene-name").textContent = next.name;
  $("scene-caption").hidden = false;
  $("coverage").textContent = "Загружаем местность";
  message("Открываем локацию", next.name);
  frameScene("isometric");
  const url = new URL(window.location.href); url.searchParams.set("scene", id); historyReplace(url);
  void bootstrapTerrain(generation);
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
  const nextAssets = { ...await json(manifestUrl, undefined, "default"), manifestUrl };
  if (nextAssets.minecraftVersion !== nextCatalog.minecraftVersion) throw Error("Asset version differs from the world");
  const blockStates = await json(relativeUrl(nextAssets.blockStates,manifestUrl), undefined, "default");
  return { assets:nextAssets,blockStates };
}

function applyAssets(nextAssets) {
  assets = nextAssets;
  failedAssets=false;
  setAssets(assets);
  compatibility.clear();
  for (const type of assets.supportedEntities) compatibility.set(type, entityModels[type] ? nativeEntityCompatibility(type, entityModels[type]) || "" : "native-model-unavailable");
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
  if (selectedScene && now - lastWorkAt >= 120) {
    currentView = cameraView(camera, controls.target, selectedScene.bounds);
    pumpChunks(); actorsDirty = true; lastWorkAt = now;
    const visibleColumns = new Set();
    for (const key of loadedChunks.keys()) {
      const [x,z] = key.split(",").map(Number);
      if (Number.isFinite(chunkPriority({ x,z }, currentView))) visibleColumns.add(key);
    }
    for (const [key, mesh] of Object.entries(terrain.sectionMeshs)) {
      const [x,,z] = key.split(",").map(Number);
      mesh.visible = visibleColumns.has(`${x / 16},${z / 16}`);
    }
  }
  if (currentView) syncActors();
  for (const [id, actor] of actors) {
    if (!actor.mesh.visible) continue;
    const value = sampleActor(history, id, now);
    if (value) applyActorPose(actor, value, delta);
  }
  if (!hasGeometry && Object.keys(terrain.sectionMeshs).length && loadedChunks.size) {
    hasGeometry = true; $("scene-message").hidden = true; viewport.dataset.state = "ready";
  }
  if (lastTransportAt) { const status = frameConnection(now, lastTransportAt, lastFrameAt, capturedAt, Date.now(), sourceState); connection(status.state, status.text); }
  atmosphere.render(now);
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

sceneSelect.addEventListener("change", () => navigateScene(sceneSelect.value));
$("actor-close").addEventListener("click", () => { pinActor(null); renderer?.domElement.focus(); });
$("actor-retry").addEventListener("click", () => { if (pinnedActor) { stopActorDetails(); $("actor-retry").hidden = true; void loadActorDetails(detailToken, generation, selectedScene.id, pinnedActor, 0); } });
window.addEventListener("keydown", event => { if (event.key === "Escape" && pinnedActor) pinActor(null); });
$("isometric").addEventListener("click", () => frameScene("isometric"));
$("top-view").addEventListener("click", () => frameScene("top"));
$("reset-view").addEventListener("click", () => frameScene());
$("zoom-in").addEventListener("click", () => { if (camera) { camera.zoom = Math.min(camera.zoom * 1.3, controls.maxZoom); camera.updateProjectionMatrix(); } });
$("zoom-out").addEventListener("click", () => { if (camera) { camera.zoom = Math.max(camera.zoom / 1.3, controls.minZoom); camera.updateProjectionMatrix(); } });
$("fullscreen").addEventListener("click", async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { notice("Полный экран недоступен в этом браузере."); } });
$("retry").addEventListener("click", () => window.location.reload());
window.addEventListener("worldview-asset-error", () => { failedAssets = true; notice("Часть текстур не загрузилась."); });
window.addEventListener("pagehide", (event) => { if (!event.persisted) atmosphere?.dispose(); });
if (window.parent !== window) window.parent.postMessage({ type: "arc-worldview-ready" }, window.location.origin);
void start();
