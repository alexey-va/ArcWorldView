"use strict";

// Build private runtime resources; never include this output in the source repository.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { viewerSource } = require("./viewer-source.cjs");
const { nativeBlockModels } = require("./native-block-models.cjs");
const root = path.resolve(__dirname, "..");
const VERSION = "1.21.11";
const CLIENT_SHA1 = "ba2df812c2d12e0219c489c4cd9a5e1f0760f5bd";
const option = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
const hash = (value, algorithm = "sha256") => crypto.createHash(algorithm).update(value).digest("hex");

function walk(directory, prefix = "") {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) return walk(path.join(directory, entry.name), relative + "/");
    return entry.isFile() ? [relative] : [];
  });
}

(async () => {
  const viewerRoot = viewerSource();
  const packRoot = option("--resource-pack", null);
  const jar = path.resolve(option("--client-jar", path.join(root, ".cache", `minecraft-${VERSION}-client.jar`)));
  if (!fs.existsSync(jar)) {
    const response = await fetch(`https://piston-data.mojang.com/v1/objects/${CLIENT_SHA1}/client.jar`);
    if (!response.ok) throw Error(`Minecraft asset download returned ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes, "sha1") !== CLIENT_SHA1) throw Error("Minecraft client checksum mismatch");
    fs.mkdirSync(path.dirname(jar), { recursive: true });
    fs.writeFileSync(jar, bytes);
  }
  if (hash(fs.readFileSync(jar), "sha1") !== CLIENT_SHA1) throw Error("Minecraft client checksum mismatch");
  const inputDigest = crypto.createHash("sha256").update(CLIENT_SHA1).update(fs.readFileSync(path.join(root,"package-lock.json")));
  for (const file of [__filename, path.join(__dirname,"item-assets.cjs"),path.join(__dirname,"native-block-models.cjs"), ...["scripts/generate-viewer-assets.cjs", "scripts/build-font-glyphs.py", "src/resource-pack-block-assets.cjs", "src/enhanced-viewer.cjs"].map((file) => path.join(viewerRoot,file))]) inputDigest.update(fs.readFileSync(file));
  if (packRoot) for (const file of walk(packRoot).sort()) if (/\.(json|png|mcmeta)$/.test(file)) inputDigest.update(file).update(fs.readFileSync(path.join(packRoot,file)));
  const revision = inputDigest.digest("hex").slice(0,20);
  const destination = path.resolve(option("--output", path.join(root, ".assets")));
  const output = path.join(destination, revision);
  fs.mkdirSync(output, { recursive: true });
  const env = { ...process.env, NODE_PATH: path.join(root, "node_modules") };
  execFileSync("unzip", ["-q", "-o", jar, "assets/minecraft/blockstates/*","assets/minecraft/atlases/*","assets/minecraft/textures/entity/*", "assets/minecraft/textures/item/*", "assets/minecraft/textures/block/*", "assets/minecraft/textures/font/*", "assets/minecraft/models/*", "assets/minecraft/items/*", "-d", path.join(output, "native")]);
  if (packRoot) {
    const { packRoots } = require(path.join(viewerRoot,"src/resource-pack-block-assets.cjs"));
    for (const layer of packRoots(packRoot)) {
      const assetsDirectory = path.join(layer,"assets");
      if (!fs.existsSync(assetsDirectory)) continue;
      for (const file of walk(assetsDirectory)) {
        if (!/\.(json|png|mcmeta)$/.test(file)) continue;
        const destinationFile = path.join(output,"native/assets",file);
        fs.mkdirSync(path.dirname(destinationFile),{ recursive:true });
        fs.copyFileSync(path.join(assetsDirectory,file),destinationFile);
      }
    }
  }
  console.log(JSON.stringify({nativeBlockModels:nativeBlockModels(path.join(output,"native"))}));
  execFileSync(process.execPath, [path.join(viewerRoot,"scripts/generate-viewer-assets.cjs"),"--client-jar",jar,"--output",output,"--resource-pack",path.join(output,"native")],{env,stdio:"inherit"});
  const itemAssets = JSON.parse(execFileSync(process.execPath,[path.join(__dirname,"item-assets.cjs"),viewerRoot,output],{ env,encoding:"utf8",maxBuffer:32*1024*1024 }));
  const fontPath = path.join(output,"font.json");
  execFileSync("python3",[path.join(viewerRoot,"scripts/build-font-glyphs.py"),jar,"--minecraft-version",VERSION,"--expected-sha1",CLIENT_SHA1,"--output",fontPath],{ stdio:"inherit" });
  const font = JSON.parse(fs.readFileSync(fontPath,"utf8"));
  for (const glyph of Object.values(font.glyphs)) glyph.url = `native/assets/minecraft/textures/font/${path.basename(glyph.url)}`;
  fs.writeFileSync(fontPath,JSON.stringify(font));
  const aliases = {
    "entity/steve": "entity/player/wide/steve",
    "entity/alex": "entity/player/slim/alex",
    "entity/chicken": "entity/chicken/temperate_chicken",
    "entity/cow/cow": "entity/cow/temperate_cow",
    "entity/pig/pig": "entity/pig/temperate_pig",
    "entity/sheep/sheep_fur": "entity/sheep/sheep_wool"
  };
  const models = require("prismarine-viewer/viewer/lib/entity/entities.json");
  const entityTextures = {};
  // Entity geometry names and texture variant names are separate in upstream data.
  const entityTemplateTextures = {
    horse: { default: "textures/entity/horse/horse_brown" },
    cat: { default:"textures/entity/cat/tabby" },
    rabbit: { default:"textures/entity/rabbit/brown" },
    villager: { default:"textures/entity/villager/villager" },
    zombie_villager: { default:"textures/entity/zombie_villager/zombie_villager" }
  };
  const supportedEntities = [];
  for (const [type, model] of Object.entries(models)) {
    let supported = true, renderedParts = 0;
    for (const variant of Object.keys(model.geometry ?? {})) {
      const texture = entityTemplateTextures[type]?.[variant] ?? model.textures?.[variant];
      if (!texture) continue; // Optional geometry such as a player's cape has no default texture.
      renderedParts++;
      const relative = texture.replace(/^textures\//, "");
      const file = `native/assets/minecraft/textures/${aliases[relative] ?? relative}.png`;
      if (!fs.existsSync(path.join(output, file))) { supported = false; continue; }
      entityTextures[relative] = file;
    }
    const validSkeleton = Object.values(model.geometry ?? {}).every((part) => {
      const names = new Set((part.bones ?? []).map((bone) => bone.name));
      return (part.bones ?? []).every((bone) => !bone.parent || names.has(bone.parent));
    });
    if (supported && renderedParts && validSkeleton) supportedEntities.push(type);
  }
  for(const required of ["player","cow","pig","sheep","chicken"]) if(!supportedEntities.includes(required)) throw Error(`Required entity assets are missing: ${required}`);
  const prepared=JSON.parse(fs.readFileSync(path.join(output,"blocksStates",`${VERSION}.json`),"utf8"));
  const intentionallyEmpty=new Set(["air","cave_air","void_air","water","lava","light","structure_void","barrier"]);
  const unsupportedBlocks=Object.entries(prepared).filter(([name,state]) => {
    if(intentionallyEmpty.has(name)) return false;
    const variants=state.variants ? Object.values(state.variants).flat() : (state.multipart ?? []).flatMap((part) => part.apply);
    return variants.length>0 && variants.every((variant) => !variant.model?.elements?.length);
  }).map(([name]) => name).sort();
  // Ship only runtime dependencies. Native source models, item definitions,
  // unused textures and generator intermediates remain build inputs, not HTTP assets.
  const required=new Set([`textures/${VERSION}.png`,`blocksStates/${VERSION}.json`,"font.json",...Object.values(entityTextures),...Object.values(itemAssets.items),...Object.values(itemAssets.itemModels)]);
  for(const file of [...required]) if(file.startsWith("models/")) {
    const model=JSON.parse(fs.readFileSync(path.join(output,file),"utf8"));
    for(const texture of Object.values(model.textures ?? {})) if(texture) required.add(texture);
  }
  for(const glyph of Object.values(font.glyphs)) required.add(glyph.url);
  for(const file of walk(output)) {
    if(/^native\/assets\/minecraft\/textures\/entity\/equipment\/humanoid(?:_leggings)?\/.+\.png$/.test(file)) required.add(file);
    if(!required.has(file)) fs.rmSync(path.join(output,file));
  }
  const files = Object.fromEntries(walk(output).filter((file) => /\.(png|json)$/.test(file) && file !== "manifest.json").map((file) => {
    const bytes = fs.readFileSync(path.join(output, file));
    return [file, { sha256: hash(bytes), size: bytes.length, contentType: file.endsWith(".png") ? "image/png" : "application/json; charset=utf-8" }];
  }));
  const manifest = { schemaVersion: 1, minecraftVersion: VERSION, revision, packName: packRoot ? "RusCrafting" : "Minecraft", atlas: `textures/${VERSION}.png`, blockStates: `blocksStates/${VERSION}.json`, font:"font.json", entityTextures, entityTemplateTextures, supportedEntities, unsupportedBlocks, items: itemAssets.items, itemModels: itemAssets.itemModels, files };
  fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(destination, "current.json"), JSON.stringify({ revision, manifest: `${revision}/manifest.json` }));
  fs.writeFileSync(path.join(destination,"coverage.json"),JSON.stringify({ revision, unsupportedItems:itemAssets.unsupported,unsupportedBlocks }));
  console.log(JSON.stringify({ revision, output, supportedEntities: supportedEntities.length, itemModels: Object.keys(itemAssets.items).length, unsupportedItems:itemAssets.unsupported.length }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
