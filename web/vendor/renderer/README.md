# Pinned project renderer inputs

This directory contains the small project-owned renderer and asset-builder
subset needed by ArcWorldView. The public build is self-contained and does not
authenticate to the private operations repository.

`PROVENANCE.json` records nine unchanged source files, their original paths,
the upstream revision and byte hashes. `renderer-source.ref` at the project
root pins that revision. Source tests verify the copied bytes.

`src/item-model-assets.cjs` contains ten unchanged pure helper function bodies
from the same revision plus a file-only model resolver. Its provenance records
the individual function hashes. It resolves models and CMD mappings from the
explicit captured resource pack. Server configuration/cache lookup is outside
this standalone builder.

No Minecraft assets, resource-pack files, server profiles or credentials belong
in this directory. Generated resources remain in the ignored private assets
directory. Upstream npm libraries remain normal pinned dependencies, with their
notices included by the browser build.
