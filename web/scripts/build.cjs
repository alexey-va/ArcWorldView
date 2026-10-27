"use strict";

const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const { viewerSource } = require("./viewer-source.cjs");
const { browserNbtSource } = require("./browser-nbt.cjs");
const root = path.resolve(__dirname, "..");
const viewerRoot = viewerSource();
const { patchPrismarineModelsSource } = require(path.join(viewerRoot, "src/viewer-models-patch.cjs"));

function workerData() {
  const raw = require("minecraft-data/data.js").pc;
  const pc = {};
  for (const version of ["1.16.2", "1.21.4", "1.21.11"]) {
    pc[version] = {};
    for (const key of Object.keys(raw[version])) {
      if (key === "proto") continue;
      try { pc[version][key] = raw[version][key]; } catch { /* optional upstream data */ }
    }
  }
  return `module.exports = { pc: ${JSON.stringify(pc)} };`;
}

const browserImports = {
  name: "worldview-browser-imports",
  setup(build) {
    build.onResolve({ filter: /^@viewer\// }, ({ path: name }) => ({ path: path.join(viewerRoot, "src", name.slice(8) + ".cjs") }));
    build.onResolve({ filter: /^(?:\.\/|\.\.\/)utils(?:\.electron\.js)?$/ }, ({ importer }) => {
      if (importer.includes("prismarine-viewer")) return { path: path.join(root, "src/viewer-utils.cjs") };
    });
    build.onResolve({ filter: /^\.\/data\.js$/ }, ({ importer }) => {
      if (importer.includes("minecraft-data")) return { path: "minecraft-data", namespace: "worldview-data" };
    });
    build.onLoad({ filter: /.*/, namespace: "worldview-data" }, () => ({ contents: workerData(), loader: "js" }));
    build.onResolve({ filter: /^prismarine-nbt$/ }, () => ({ path: "prismarine-nbt", namespace: "worldview-json-nbt" }));
    build.onLoad({ filter: /.*/, namespace: "worldview-json-nbt" }, () => ({ contents: browserNbtSource(), loader: "js" }));
    build.onLoad({ filter: /prismarine-viewer[\\/]viewer[\\/]lib[\\/]models\.js$/ }, ({ path: file }) => ({ contents: patchPrismarineModelsSource(fs.readFileSync(file, "utf8")), loader: "js" }));
    const builtins = {
      zlib: "",
      assert: "export function ok(v,m) { if (!v) throw Error(m || 'assertion failed'); } export function strictEqual(a,b,m) { if (a !== b) throw Error(m || 'values differ'); } export default { ok, strictEqual };",
      util: "export const TextEncoder = globalThis.TextEncoder; export const TextDecoder = globalThis.TextDecoder;"
    };
    build.onResolve({ filter: /^(zlib|assert|util)$/ }, ({ path: name }) => ({ path: name, namespace: "worldview-builtin" }));
    build.onLoad({ filter: /.*/, namespace: "worldview-builtin" }, ({ path: name }) => ({ contents: builtins[name], loader: "js" }));
  }
};

(async () => {
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  const packageRoots=new Set();
  const shared = { bundle: true, metafile:true,format: "iife", minify: true, platform: "browser", target: ["es2020"], nodePaths: [path.join(root, "node_modules")], plugins: [browserImports], define: { global: "globalThis", "process.platform": '"browser"', __dirname: '"."' } };
  for (const [name, entry] of [["app", "src/app.cjs"], ["decode-worker", "src/decode-worker.cjs"], ["worker", require.resolve("prismarine-viewer/viewer/lib/worker.js")]]) {
    const result=await esbuild.build({ ...shared, entryPoints: [path.resolve(root, entry)], outfile: path.join(root, "dist", `${name}.js`) });
    for(const input of Object.keys(result.metafile.inputs)) {
      const absolute=path.resolve(input),marker=absolute.lastIndexOf(path.sep+"node_modules"+path.sep);
      if(marker<0) continue;
      const suffix=absolute.slice(marker+14).split(path.sep);
      packageRoots.add(absolute.slice(0,marker+14)+suffix.slice(0,suffix[0].startsWith("@")?2:1).join(path.sep));
    }
  }
  for (const file of ["index.html", "style.css"]) fs.copyFileSync(path.join(root, "src", file), path.join(root, "dist", file));
  const fontRoot = path.dirname(require.resolve("@fontsource-variable/golos-text/package.json"));
  packageRoots.add(fontRoot);
  // minecraft-data is replaced by a generated data module in worker bundles.
  packageRoots.add(path.dirname(require.resolve("minecraft-data/package.json")));
  // Its pure helpers are emitted into the JSON-only browser adapter at build time.
  packageRoots.add(path.dirname(require.resolve("prismarine-nbt/package.json")));
  fs.mkdirSync(path.join(root, "dist", "fonts"), { recursive: true });
  for (const subset of ["cyrillic", "latin"]) {
    const file = `golos-text-${subset}-wght-normal.woff2`;
    fs.copyFileSync(path.join(fontRoot, "files", file), path.join(root, "dist", "fonts", file));
  }
  const notices=["ArcWorldView — bundled third-party notices\n\nThis bundle contains the packages listed below. Available full license texts and exact upstream declarations follow.\n"];
  const declaredMit=JSON.parse(fs.readFileSync(path.join(root,"licenses/declared-mit.json"),"utf8"));
  for(const directory of [...packageRoots].sort()) {
    const metadata=JSON.parse(fs.readFileSync(path.join(directory,"package.json"),"utf8"));
    const licenseFiles=fs.readdirSync(directory).filter((file)=>/^(licen[cs]e|copying|notice)([._-]|$)/i.test(file)&&fs.statSync(path.join(directory,file)).isFile());
    const licenseFallback=path.join(root,"licenses",metadata.name.replaceAll("/","_")+".txt");
    const knownMit=declaredMit[metadata.name]===metadata.version&&metadata.license==="MIT";
    if(!licenseFiles.length&&!fs.existsSync(licenseFallback)&&!knownMit) throw Error(`Missing bundled license: ${metadata.name}`);
    notices.push(`\n${"=".repeat(72)}\n${metadata.name} ${metadata.version} (${typeof metadata.license==="string"?metadata.license:metadata.license?.type??"see license"})\n`);
    for(const file of licenseFiles) notices.push(`\n${file}\n${fs.readFileSync(path.join(directory,file),"utf8")}\n`);
    if(!licenseFiles.length&&fs.existsSync(licenseFallback)) notices.push(fs.readFileSync(licenseFallback,"utf8"));
    else if(!licenseFiles.length&&knownMit) {
      const author=typeof metadata.author==="string"?metadata.author:metadata.author?.name;
      notices.push(`\nAuthor: ${author??"see upstream"}\nSource: ${typeof metadata.repository==="string"?metadata.repository:metadata.repository?.url}\nThe pinned npm package and upstream repository declare MIT but provide no separate LICENSE file. The full declared license follows.\n\n${fs.readFileSync(path.join(root,"licenses/MIT.txt"),"utf8")}`);
    }
  }
  fs.writeFileSync(path.join(root,"dist","THIRD_PARTY_NOTICES.txt"),notices.join(""));
  console.log("ArcWorldView browser bundle ready");
})().catch((error) => { console.error(error); process.exitCode = 1; });
