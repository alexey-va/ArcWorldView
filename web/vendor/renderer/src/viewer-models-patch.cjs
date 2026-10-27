"use strict";

const AIR_SUBSTRING_CHECK = "if (block.name.includes('air')) return []";
const AIR_BLOCK_CHECK = "if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') return []";

function patchPrismarineModelsSource(source) {
  if (!source.includes(AIR_SUBSTRING_CHECK)) {
    throw new Error("prismarine-viewer air-block check changed; review the stairs patch");
  }
  return source.replace(AIR_SUBSTRING_CHECK, AIR_BLOCK_CHECK);
}

module.exports = { patchPrismarineModelsSource };
