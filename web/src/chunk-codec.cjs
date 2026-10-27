"use strict";

const { Vec3 } = require("vec3");

function decodeChunk(source, version = "1.21.11") {
  const height = Number(source.height);
  if (!Number.isInteger(height) || height < 16 || height > 256 || height % 16 !== 0) throw Error("Unsupported scene height");
  if (!Number.isInteger(source.x) || !Number.isInteger(source.z)) throw Error("Invalid chunk coordinates");
  if (!Array.isArray(source.palette) || source.palette.length < 1 || source.palette.length > 65536) throw Error("Invalid block palette");
  const Chunk = require("prismarine-chunk")(version);
  const Block = require("prismarine-block")(version);
  const states = source.palette.map((description) => {
    if (typeof description !== "string" || description.length > 1024) throw Error("Invalid block descriptor");
    const block = Block.fromString(description, 1);
    if (!block || !Number.isInteger(block.stateId)) throw Error(`Unknown block: ${description}`);
    return block.stateId;
  });
  const total = height * 256;
  if (!Array.isArray(source.runs) || source.runs.length % 2 !== 0 || source.runs.length > total * 2) throw Error("Invalid chunk runs");
  const column = new Chunk({ minY: 0, worldHeight: height });
  const pos = new Vec3(0, 0, 0);
  let offset = 0;
  for (let run = 0; run < source.runs.length; run += 2) {
    const count = source.runs[run], paletteIndex = source.runs[run + 1];
    if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(paletteIndex) || paletteIndex < 0 || paletteIndex >= states.length || offset + count > total) throw Error("Chunk run is out of range");
    const stateId = states[paletteIndex];
    if (stateId !== 0) {
      for (let index = offset; index < offset + count; index++) {
        pos.x = index & 15; pos.z = (index >> 4) & 15; pos.y = index >> 8;
        column.setBlockStateId(pos, stateId);
      }
    }
    offset += count;
  }
  if (offset !== total) throw Error("Chunk payload is incomplete");
  for (let y = 0; y < height; y += 4) for (let z = 0; z < 16; z += 4) for (let x = 0; x < 16; x += 4) {
    pos.x = x; pos.y = y; pos.z = z;
    column.setBiome(pos, 1);
  }
  return column.toJson();
}

module.exports = { decodeChunk };
