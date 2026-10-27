"use strict";

// Workers can finish many sections together. Keep only the newest result for
// each section and spread GPU-buffer installation across display frames.
function terrainInstallQueue(terrain, now = () => performance.now()) {
  let pending = new Map(), generation = 0;
  for (const worker of terrain.workers) {
    const install = worker.onmessage;
    const send = worker.postMessage.bind(worker);
    worker.postMessage = (data, ...rest) => send({ ...data, worldViewGeneration:generation }, ...rest);
    worker.onmessage = event => {
      if (event.data.worldViewGeneration !== generation) return;
      if (event.data.type === "geometry") pending.set(event.data.key, { event, install });
      else install(event);
    };
  }
  return {
    get size() { return pending.size; },
    get generation() { return generation; },
    clear() { generation++; pending.clear(); },
    prioritize(priority) {
      if (!pending.size) return;
      pending = new Map([...pending].map(([key,value])=>[key,{...value,priority:priority(key)}]).sort((a,b)=>a[1].priority-b[1].priority));
    },
    drain(maximum = 4, budgetMs = 3) {
      const started = now();
      let installed = 0, processed = 0;
      for (const [key, { event, install }] of pending) {
        if (installed >= maximum || processed && now() - started >= budgetMs) break;
        pending.delete(key); processed++;
        if (!event.data.geometry.positions.length) {
          // Empty air sections need no Three objects, draw traversal or buffers.
          const previous = terrain.sectionMeshs[key];
          if (previous) { previous.parent?.remove(previous); previous.geometry.dispose(); delete terrain.sectionMeshs[key]; }
        } else { install(event); installed++; }
      }
      return installed;
    }
  };
}

module.exports = { terrainInstallQueue };
