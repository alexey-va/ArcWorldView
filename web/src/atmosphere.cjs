"use strict";

const THREE = require("three");

// Called only after the chunk codec has accepted this palette/RLE payload. Scan
// runs rather than every block, and cap retained emitters in a lantern-heavy chunk.
function chunkLanterns(chunk) {
  const palette = chunk.palette.map(block => {
    const match = /^(?:minecraft:)?(soul_lantern|lantern)(?:\[|$)/.exec(block);
    return match && { color: match[1] === "soul_lantern" ? 0x75ddff : 0xffc36b, y: block.includes("hanging=true") ? 4.5 / 16 : 3.5 / 16 };
  });
  if (!palette.some(Boolean)) return [];
  const lights = [];
  let offset = 0;
  for (let run = 0; run < chunk.runs.length && lights.length < 32; run += 2) {
    const count = chunk.runs[run], lamp = palette[chunk.runs[run + 1]];
    if (lamp) for (let index = offset; index < offset + count && lights.length < 32; index++) {
      lights.push({ color: lamp.color, position: new THREE.Vector3(chunk.x * 16 + (index & 15) + .5, chunk.minY + (index >> 8) + lamp.y, chunk.z * 16 + ((index >> 4) & 15) + .5) });
    }
    offset += count;
  }
  return lights;
}

function lanternTexture() {
  const size = 32, pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const radius = ((x + .5) / size * 2 - 1) ** 2 + ((y + .5) / size * 2 - 1) ** 2;
    const index = (y * size + x) * 4;
    pixels[index] = pixels[index + 1] = pixels[index + 2] = 255;
    pixels[index + 3] = Math.round(Math.max(0, Math.exp(-radius * 5) - Math.exp(-5)) * 255);
  }
  const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false; texture.needsUpdate = true;
  return texture;
}

// A single native lighting/shadow pass. Keep the viewer's existing linear colour
// contract and nearest-filtered Minecraft textures; there is no full-screen blur.
function createAtmosphere({ renderer, scene, camera }) {
  const previousBackground = scene.background;
  const previousShadow = renderer.shadowMap && {
    enabled: renderer.shadowMap.enabled, type: renderer.shadowMap.type,
    autoUpdate: renderer.shadowMap.autoUpdate, needsUpdate: renderer.shadowMap.needsUpdate
  };
  const supportsShadows = Boolean(renderer.shadowMap && renderer.capabilities?.maxTextureSize >= 512);
  const ambient = new THREE.AmbientLight(0xffffff, .30);
  const sky = new THREE.HemisphereLight(0xcce6ff, 0x9d8e70, .35);
  const sun = new THREE.DirectionalLight(0xffeed6, .90);
  const sunDirection = new THREE.Vector3(-.60, 1, .45).normalize();
  const materials = new Map();
  const chunkLights = new Map(), glowTexture = lanternTexture();
  const lamps = Array.from({ length:4 }, () => {
    const light = new THREE.PointLight(0xffc36b, 0, 2.75, 2);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map:glowTexture, color:0xffc36b, opacity:.24, transparent:true, depthWrite:false, blending:THREE.AdditiveBlending }));
    halo.scale.setScalar(1.05); halo.visible = false;
    scene.add(light, halo);
    return { light, halo, source:null };
  });
  let disposed = false, scanAt = -Infinity, shadowAt = -Infinity;
  let shadowDirty = true;

  scene.background = new THREE.Color(0xcbd9df);
  sun.name = "WorldView sunlight";
  sun.castShadow = supportsShadows;
  sun.shadow.bias = -.00005;
  sun.shadow.normalBias = .015;
  scene.add(ambient, sky, sun, sun.target);
  if (supportsShadows) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;
  }

  function resize(width, height) {
    if (disposed || !supportsShadows) return;
    const preferred = Math.min(width, height) < 500 ? 1024 : 2048;
    const size = Math.min(preferred, 2 ** Math.floor(Math.log2(renderer.capabilities.maxTextureSize)));
    if (sun.shadow.mapSize.x !== size) {
      sun.shadow.map?.dispose(); sun.shadow.map = null;
      sun.shadow.mapSize.set(size, size);
      shadowDirty = true;
    }
  }

  function setBounds(bounds) {
    if (disposed) return;
    const box = new THREE.Box3(
      new THREE.Vector3(bounds.minX, bounds.minY, bounds.minZ),
      new THREE.Vector3(bounds.maxX, bounds.maxY, bounds.maxZ)
    );
    const center = box.getCenter(new THREE.Vector3());
    const distance = box.getSize(new THREE.Vector3()).length() + 40;
    sun.target.position.copy(center);
    sun.position.copy(center).addScaledVector(sunDirection, distance);
    sun.updateMatrixWorld(); sun.target.updateMatrixWorld();
    const shadowCamera = sun.shadow.camera;
    shadowCamera.position.copy(sun.position);
    shadowCamera.lookAt(center); shadowCamera.updateMatrixWorld();
    const lightBox = new THREE.Box3();
    for (const x of [bounds.minX, bounds.maxX]) for (const y of [bounds.minY, bounds.maxY]) for (const z of [bounds.minZ, bounds.maxZ]) {
      lightBox.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(shadowCamera.matrixWorldInverse));
    }
    shadowCamera.left = lightBox.min.x - 3; shadowCamera.right = lightBox.max.x + 3;
    shadowCamera.bottom = lightBox.min.y - 3; shadowCamera.top = lightBox.max.y + 3;
    shadowCamera.near = Math.max(.5, -lightBox.max.z - 16);
    shadowCamera.far = -lightBox.min.z + 16;
    shadowCamera.updateProjectionMatrix();
    shadowDirty = true;
    scanAt = -Infinity;
  }

  function setChunk(key, chunk) {
    chunkLights.set(key, chunkLanterns(chunk));
    scanAt = -Infinity;
  }

  function removeChunk(key) { chunkLights.delete(key); scanAt = -Infinity; }

  function reset() {
    chunkLights.clear();
    for (const lamp of lamps) { lamp.source = null; lamp.light.intensity = 0; lamp.halo.visible = false; }
    scanAt = -Infinity;
  }

  function syncLanterns() {
    const visible = [];
    const projection = new THREE.Vector3();
    camera.updateMatrixWorld();
    for (const sources of chunkLights.values()) for (const source of sources) {
      projection.copy(source.position).project(camera);
      if (Math.abs(projection.x) <= 1.1 && Math.abs(projection.y) <= 1.1 && Math.abs(projection.z) <= 1) {
        visible.push({ source, distance:projection.x ** 2 + projection.y ** 2 });
      }
    }
    visible.sort((a,b) => a.distance - b.distance);
    lamps.forEach((lamp,index) => {
      lamp.source = visible[index]?.source;
      lamp.light.intensity = lamp.source ? .55 : 0;
      lamp.halo.visible = Boolean(lamp.source);
      if (lamp.source) {
        lamp.light.position.copy(lamp.source.position);
        lamp.light.color.setHex(lamp.source.color); lamp.halo.material.color.setHex(lamp.source.color);
      }
    });
  }

  function release(mesh, record) {
    if (mesh.customDepthMaterial === record.depth) mesh.customDepthMaterial = record.previousDepth;
    mesh.castShadow = record.castShadow; mesh.receiveShadow = record.receiveShadow;
    record.depth.dispose();
    materials.delete(mesh);
  }

  function syncMeshes() {
    const live = new Set();
    scene.traverse((mesh) => {
      const material = mesh.material;
      // Text billboards and other unlit overlays must not cast solid rectangles.
      if (!mesh.isMesh || !material?.isMeshLambertMaterial) return;
      live.add(mesh);
      let record = materials.get(mesh);
      if (!record) {
        // Leave an independently supplied depth renderer under its owner's control.
        if (mesh.customDepthMaterial) return;
        const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
        record = { depth, previousDepth: mesh.customDepthMaterial, castShadow: mesh.castShadow, receiveShadow: mesh.receiveShadow };
        materials.set(mesh, record);
        mesh.customDepthMaterial = depth;
        mesh.castShadow = true; mesh.receiveShadow = true;
        shadowDirty = true;
      }
      const depth = record.depth;
      // Three r128's default shadow depth material does not inherit the colour
      // material's alpha maps. Copy them explicitly, including asynchronously
      // loaded skins, and retain skeletal deformation for mobs and armour.
      const properties = {
        map: material.map, alphaMap: material.alphaMap, alphaTest: material.alphaTest,
        opacity: material.opacity, skinning: Boolean(mesh.isSkinnedMesh && material.skinning),
        morphTargets: material.morphTargets, morphNormals: material.morphNormals,
        displacementMap: material.displacementMap, displacementScale: material.displacementScale,
        displacementBias: material.displacementBias
      };
      for (const [key, value] of Object.entries(properties)) if (depth[key] !== value) {
        depth[key] = value; depth.needsUpdate = true; shadowDirty = true;
      }
    });
    for (const [mesh, record] of materials) if (!live.has(mesh)) { release(mesh, record); shadowDirty = true; }
  }

  function render(now) {
    if (disposed) return;
    if (now - scanAt >= 180) {
      if (supportsShadows) syncMeshes();
      syncLanterns(); scanAt = now;
    }
    for (const lamp of lamps) if (lamp.source) {
      // Put the small optical halo at the lamp's front surface. Depth testing
      // still hides it behind terrain; bright unrelated textures never bloom.
      lamp.halo.position.copy(camera.position).sub(lamp.source.position).normalize().multiplyScalar(.24).add(lamp.source.position);
    }
    if (supportsShadows) {
      // Poses animate at display rate; the expensive depth map is bounded to
      // 30 Hz and also refreshed when chunk or equipment geometry changes.
      renderer.shadowMap.needsUpdate = shadowDirty || now - shadowAt >= 1000 / 30;
      if (renderer.shadowMap.needsUpdate) { shadowAt = now; shadowDirty = false; }
    }
    renderer.render(scene, camera);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const [mesh, record] of materials) release(mesh, record);
    scene.remove(ambient, sky, sun, sun.target);
    for (const lamp of lamps) { scene.remove(lamp.light, lamp.halo); lamp.halo.material.dispose(); }
    glowTexture.dispose(); chunkLights.clear();
    sun.shadow.dispose();
    scene.background = previousBackground;
    if (previousShadow) Object.assign(renderer.shadowMap, previousShadow);
  }

  return { setBounds, setChunk, removeChunk, reset, resize, render, dispose };
}

module.exports = { createAtmosphere, chunkLanterns };
