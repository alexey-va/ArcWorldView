"use strict";

// Generate the Prismarine viewer data for a protocol version from the matching
// Mojang client jar.  The viewer package currently ships older generated data;
// using the exact client assets keeps new block state IDs and models aligned.
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { makeTextureAtlas } = require("prismarine-viewer/viewer/lib/atlas");
const { prepareBlocksStates } = require("prismarine-viewer/viewer/lib/modelsBuilder");
const { mergedBlockAssets } = require("../src/resource-pack-block-assets.cjs");

const DEFAULT_VERSION = "1.21.11";
const DEFAULT_SHA1 = "ba2df812c2d12e0219c489c4cd9a5e1f0760f5bd";
const DEFAULT_CLIENT_URL = "https://piston-data.mojang.com/v1/objects/ba2df812c2d12e0219c489c4cd9a5e1f0760f5bd/client.jar";
const DEFAULT_CLIENT_JAR = path.join(__dirname, "..", ".cache", `minecraft-${DEFAULT_VERSION}-client.jar`);
const DEFAULT_OUTPUT = path.join(
  __dirname,
  "..",
  "node_modules",
  "prismarine-viewer",
  "public",
);

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] ?? fallback;
}

function sha1(file) {
  return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
}

async function ensureClientJar(clientJar = DEFAULT_CLIENT_JAR) {
  if (fs.existsSync(clientJar) && sha1(clientJar) === DEFAULT_SHA1) return clientJar;
  if (clientJar !== DEFAULT_CLIENT_JAR) return clientJar;
  const response = await fetch(DEFAULT_CLIENT_URL);
  if (!response.ok) throw new Error(`Mojang client download failed with HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(clientJar), { recursive: true });
  const temporary = `${clientJar}.part`;
  fs.writeFileSync(temporary, bytes);
  if (sha1(temporary) !== DEFAULT_SHA1) {
    fs.rmSync(temporary, { force: true });
    throw new Error(`downloaded client jar SHA-1 does not match pinned ${DEFAULT_SHA1}`);
  }
  fs.renameSync(temporary, clientJar);
  return clientJar;
}

function readJsonFiles(root, directory) {
  const result = {};
  for (const file of fs.readdirSync(path.join(root, directory)).filter((name) => name.endsWith(".json"))) {
    result[file.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(root, directory, file), "utf8"));
  }
  return result;
}

function particleArchiveEntries(entries) {
  return entries.filter((entry) =>
    /^assets\/minecraft\/(?:particles\/.+\.json|textures\/particle\/.+\.png)$/.test(entry));
}

function readParticleDefinitions(root) {
  const directory = path.join(root, "particles");
  if (!fs.existsSync(directory)) throw new Error("Mojang client jar has no assets/minecraft/particles definitions");
  const definitions = {};
  const visit = (current, prefix = "") => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = path.join(prefix, entry.name);
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        const key = relative.slice(0, -5).split(path.sep).join("/");
        definitions[key] = JSON.parse(fs.readFileSync(absolute, "utf8"));
      }
    }
  };
  visit(directory);
  return definitions;
}

function copyParticleTextures(sourceRoot, targetRoot) {
  let copied = 0;
  const visit = (source, target) => {
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const from = path.join(source, entry.name);
      const to = path.join(target, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        visit(from, to);
      } else if (entry.isFile() && entry.name.endsWith(".png")) {
        fs.copyFileSync(from, to);
        copied += 1;
      }
    }
  };
  if (fs.existsSync(sourceRoot)) {
    fs.mkdirSync(targetRoot, { recursive: true });
    visit(sourceRoot, targetRoot);
  }
  return copied;
}

function copyParticleAssets(minecraftRoot, versionRoot) {
  const particleRoot = path.join(minecraftRoot, "textures", "particle");
  const definitions = readParticleDefinitions(minecraftRoot);
  const textureRoot = path.join(versionRoot, "particle");
  fs.rmSync(textureRoot, { recursive: true, force: true });
  const textures = copyParticleTextures(particleRoot, textureRoot);
  fs.writeFileSync(path.join(versionRoot, "particles.json"), JSON.stringify(definitions));
  return { particles: Object.keys(definitions).length, particleTextures: textures };
}

function generateViewerAssets({ clientJar, output = DEFAULT_OUTPUT, version = DEFAULT_VERSION, expectedSha1 = DEFAULT_SHA1, resourcePackRoot = null }) {
  if (!clientJar || !fs.existsSync(clientJar)) throw new Error(`client jar does not exist: ${clientJar}`);
  const digest = sha1(clientJar);
  if (expectedSha1 && digest !== expectedSha1) {
    throw new Error(`client jar SHA-1 ${digest} does not match expected ${expectedSha1}`);
  }

  const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rc-viewer-assets-"));
  try {
    const resources = resourcePackRoot
      ? ["assets/minecraft/blockstates/*", "assets/minecraft/models/*", "assets/minecraft/textures/*", "assets/minecraft/atlases/*"]
      : ["assets/minecraft/blockstates/*", "assets/minecraft/models/block/*", "assets/minecraft/textures/block/*"];
    execFileSync("unzip", ["-q", clientJar, ...resources, "-d", extractionRoot], { stdio: "ignore" });
    const particleEntries = particleArchiveEntries(
      execFileSync("unzip", ["-Z1", clientJar], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
        .split(/\r?\n/),
    );
    if (particleEntries.length === 0) throw new Error("Mojang client jar has no particle definitions or textures");
    execFileSync("unzip", ["-q", "-o", clientJar, ...particleEntries, "-d", extractionRoot], { stdio: "ignore" });
    const minecraftRoot = path.join(extractionRoot, "assets", "minecraft");
    const textureRoot = path.join(minecraftRoot, "textures", "block");
    const rawStates = readJsonFiles(minecraftRoot, "blockstates");
    let states = structuredClone(rawStates);
    let models = readJsonFiles(minecraftRoot, "models/block");
    const blockDirectory = path.join(extractionRoot, "blocks");
    fs.mkdirSync(blockDirectory, { recursive: true });
    if (resourcePackRoot) {
      const merged = mergedBlockAssets({ vanillaRoot: extractionRoot, resourcePackRoot, outputBlocks: blockDirectory });
      states = merged.states;
      models = merged.models;
    } else {
      for (const file of fs.readdirSync(textureRoot).filter((name) => name.endsWith(".png"))) {
        fs.copyFileSync(path.join(textureRoot, file), path.join(blockDirectory, file));
      }
    }

    const atlas = makeTextureAtlas({ directory: extractionRoot, blocksStates: states, blocksModels: models });
    const preparedStates = prepareBlocksStates({ directory: extractionRoot, blocksStates: states, blocksModels: models }, atlas);
    const versionRoot = path.join(output, "textures", version);
    fs.mkdirSync(versionRoot, { recursive: true });
    fs.mkdirSync(path.join(output, "blocksStates"), { recursive: true });
    const particleAssets = copyParticleAssets(minecraftRoot, versionRoot);
    fs.writeFileSync(path.join(versionRoot, "blocks_states.json"), JSON.stringify(rawStates));
    fs.writeFileSync(path.join(versionRoot, "blocks_models.json"), JSON.stringify(models));
    fs.writeFileSync(path.join(output, "blocksStates", `${version}.json`), JSON.stringify(preparedStates));
    fs.writeFileSync(path.join(output, "textures", `${version}.png`), atlas.image);
    return { version, output, sha1: digest, blocks: Object.keys(states).length, models: Object.keys(models).length, ...particleAssets };
  } finally {
    fs.rmSync(extractionRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  (async () => {
   try {
    const result = generateViewerAssets({
      clientJar: await ensureClientJar(option(args, "--client-jar", DEFAULT_CLIENT_JAR)),
      output: option(args, "--output", DEFAULT_OUTPUT),
      version: option(args, "--version", DEFAULT_VERSION),
      expectedSha1: option(args, "--sha1", DEFAULT_SHA1),
      resourcePackRoot: option(args, "--resource-pack", null),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
   } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
   }
  })();
}

module.exports = { copyParticleAssets, generateViewerAssets, particleArchiveEntries };
