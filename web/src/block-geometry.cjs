"use strict";
const {getSectionGeometry}=require("prismarine-viewer/viewer/lib/models");

function blockGeometry(blockData,version,blockStates) {
  const Block=require("prismarine-block")(version);
  const block=Block.fromString(blockData,1),air=Block.fromString("minecraft:air",1);
  const world={getBlock(position) {
    const value=position.x===8&&position.y===8&&position.z===8 ? block : air;
    // The stock mesher reads neighbour.position for face culling.
    value.position=position.clone();
    return value;
  }};
  return getSectionGeometry(0,0,0,world,blockStates);
}

module.exports={blockGeometry};
