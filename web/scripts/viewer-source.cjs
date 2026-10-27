"use strict";

const fs = require("node:fs");
const path = require("node:path");

function viewerSource() {
  const root = process.env.ARC_VIEWER_ROOT;
  if (!root) throw new Error("Set ARC_VIEWER_ROOT to the pinned ops checkout's scripts/player-bot directory");
  const resolved = path.resolve(root);
  if (!fs.existsSync(path.join(resolved, "scripts", "generate-viewer-assets.cjs"))) {
    throw new Error("ARC_VIEWER_ROOT is not a player-bot source directory");
  }
  return resolved;
}

module.exports = { viewerSource };
