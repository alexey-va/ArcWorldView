"use strict";

const fs = require("node:fs");
const path = require("node:path");

function viewerSource() {
  const resolved = path.resolve(__dirname, "../vendor/renderer");
  const pin = fs.readFileSync(path.resolve(__dirname, "../../renderer-source.ref"), "utf8").trim();
  const provenance = JSON.parse(fs.readFileSync(path.join(resolved, "PROVENANCE.json"), "utf8"));
  if (provenance.upstream_commit !== pin) throw Error("Bundled renderer source does not match its pinned revision");
  if (!fs.existsSync(path.join(resolved, "scripts", "generate-viewer-assets.cjs"))) {
    throw new Error("Bundled renderer source is missing");
  }
  return resolved;
}

module.exports = { viewerSource };
