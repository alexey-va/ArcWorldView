# Native model compatibility

The browser uses unmodified `prismarine-viewer@1.33.0` and `three@0.128.0`.
`native-entity-models.cjs` adapts their model data for the pinned Java 1.21.11
client (`ba2df812c2d12e0219c489c4cd9a5e1f0760f5bd`). The official mappings
checksum is `031a68bebf55d824f66d6573d8c752f0e1bf232a`.

## Verified compatibility corrections

| Native source | Adaptation |
| --- | --- |
| CowModel (`hak`), PigModel (`hch`), humanoid/zombie layers | Canonical 64×64 UV space; current cow muzzle is a separate 6×3×1 cuboid. |
| SheepFurModel (`hcn`) | Both sheep layers use 64×32; the old wool-template row offset is removed. |
| ChickenModel (`hag`) | Body rotates around its native joint at Y=8 in upward coordinates, rather than the world origin. |
| AbstractEquineModel (`hap`) | Current 64×64 horse geometry, complete legs and the head/mane/muzzle/ear hierarchy replace the incompatible older segmented template. |
| GhastModel (`hei`) | UV space remains 64×32 even though the native image is 128×64. Image dimensions are not used as a layout heuristic. |
| MagmaCubeModel (`hfi`), LlamaSpitModel (`hbv`) | Canonical UV spaces are 64×64 and 64×32 respectively. |

The dependency bakes each bone's rest rotation into its vertices before
creating the skeleton. Keeping that rotation on a parent while normalizing
absolute pivots rotates a child joint a second time. `mob-pose.cjs` therefore
keeps those baked vertices, binds unrotated joints at their absolute native
positions, and applies only the current pose. Lower segments share the upper
joint; folded villager arms are not treated as independent walking arms.

Bat and fishing-bobber templates have incompatible native layouts. Billboard
templates without cuboid UVs and invalid skeletons (including the bundled
zombie-villager duplicate bone) are also rejected. `manifest.json` and
`coverage.json` expose `unsupportedEntities` with the reason. Missing models
produce the visible coverage notice; no silhouette or coloured-cube substitute
is rendered. Resource-pack image scaling does not change this compatibility
decision.

## Verification boundary

`test/mob-pose.test.cjs` executes the actual pinned entity builder with only
texture I/O replaced. It checks every eligible existing template's neutral
vertices and joint locations, six representative species through 25 walking
frames, a segmented legacy limb chain, and the production player/armour
geometry through the same cycle. These checks catch detached pivots and
incorrect attachments; they do not replace native-texture visual inspection.

The local inspection scene includes cow, sheep (base and wool), pig, chicken,
horse, zombie and a player in full iron armour. Review it at multiple angles
while moving, stopping and resuming. Tests of the bounded pose do not claim
support for every species-specific animation, baby shape, saddle, mob variant
or resource-pack custom entity model.
