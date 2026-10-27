"use strict";
const THREE = require("three");
const view = new THREE.Euler(0, 0, 0, "YXZ"), rotation = new THREE.Euler(0, 0, 0, "YXZ");

// DisplayRenderer.calculateOrientation, pinned Java 1.21.11: the constrained
// axes use camera orientation, including for an orthographic browser camera.
function displayQuaternion(billboard, yaw, pitch, camera, result) {
  if (billboard === "CENTER") return result.copy(camera);
  view.setFromQuaternion(camera, "YXZ");
  const x = billboard === "HORIZONTAL" ? view.x : THREE.MathUtils.degToRad(pitch);
  const y = billboard === "VERTICAL" ? view.y : -THREE.MathUtils.degToRad(yaw);
  return result.setFromEuler(rotation.set(x, y, 0, "YXZ"));
}

module.exports = { displayQuaternion };
