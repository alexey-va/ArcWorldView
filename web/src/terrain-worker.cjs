"use strict";

// Tag results at their worker origin, so an old world's queued or in-flight
// geometry cannot replace the new epoch's section with the same coordinates.
let generation = 0, version = null, blockStates = null;
const send = self.postMessage.bind(self);
self.postMessage = (data, ...rest) => send({ ...data, worldViewGeneration:generation }, ...rest);
require("prismarine-viewer/viewer/lib/worker.js");
const receive = self.onmessage;
self.onmessage = event => {
  const data = event.data;
  if (data.type === "version") version = data.version;
  if (data.type === "blockStates") blockStates = data.json;
  if (data.worldViewGeneration !== undefined && data.worldViewGeneration !== generation) {
    generation = data.worldViewGeneration;
    receive({ data:{ type:"reset" } });
    if (version) receive({ data:{ type:"version", version } });
    if (blockStates) receive({ data:{ type:"blockStates", json:blockStates } });
  }
  receive(event);
};
