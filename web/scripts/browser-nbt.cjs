"use strict";

// Reuse only upstream pure JSON-tree helpers. The viewer receives Java chunk
// JSON and never needs the binary NBT/protocol compilers at browser startup.
function browserNbtSource() {
  const metadata = require("prismarine-nbt/package.json");
  if (metadata.version !== "2.8.0") throw Error("Review the browser NBT boundary before upgrading prismarine-nbt");
  const nbt = require("prismarine-nbt");
  const helpers = ["simplify", "equal", "bool", "short", "byte", "string", "comp", "int", "float", "double", "long", "list", "byteArray", "shortArray", "intArray", "longArray"];
  const declarations = helpers.map((name) => {
    const source = nbt[name].toString();
    return `const ${name} = ${source.startsWith("function") ? source : "function " + source};`;
  });
  return `${declarations.join("\n")}
function unsupportedBinaryNbt() { throw Error("Binary NBT is unsupported in the ArcWorldView JSON renderer"); }
module.exports = { ${helpers.join(", ")}, TagType: ${JSON.stringify(nbt.TagType)},
  parse: unsupportedBinaryNbt, parseAs: unsupportedBinaryNbt,
  parseUncompressed: unsupportedBinaryNbt, writeUncompressed: unsupportedBinaryNbt,
  addTypesToCompiler: unsupportedBinaryNbt, addTypesToInterpreter: unsupportedBinaryNbt };
for (const name of ["proto", "protoLE", "protos"]) Object.defineProperty(module.exports, name, { get: unsupportedBinaryNbt });
`;
}

module.exports = { browserNbtSource };
