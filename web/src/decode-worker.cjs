"use strict";
const { decodeChunk } = require("./chunk-codec.cjs");
const { blockGeometry } = require("./block-geometry.cjs");
let blockStates;
self.onmessage = ({ data }) => {
  try {
    if (data.type === "models") { blockStates=data.blockStates; return; }
    if (data.type === "block") {
      self.postMessage({ id:data.id,result:blockGeometry(data.blockData,data.version,blockStates) });
    } else self.postMessage({ id: data.id, result: decodeChunk(data.chunk, data.version) });
  }
  catch (error) { self.postMessage({ id: data.id, error: error.message }); }
};
