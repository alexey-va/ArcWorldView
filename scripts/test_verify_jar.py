"""Synthetic ZIP checks for the production artifact guard; no JVM is needed."""

import importlib.util
import io
import sys
import tempfile
import unittest
import zipfile
from contextlib import redirect_stdout
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("verify_jar", Path(__file__).with_name("verify-jar.py"))
verifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verifier)


def class_file(internal_name: str, *utf8_values: str) -> bytes:
    """Build a minimal class file whose constant pool contains the given strings."""
    pool = bytearray()
    count = 1

    def add_utf8(value: str) -> int:
        nonlocal count
        raw = value.encode("ascii")
        pool.extend(b"\x01" + len(raw).to_bytes(2, "big") + raw)
        count += 1
        return count - 1

    this_name = add_utf8(internal_name)
    pool.extend(b"\x07" + this_name.to_bytes(2, "big"))
    count += 1
    object_name = add_utf8("java/lang/Object")
    pool.extend(b"\x07" + object_name.to_bytes(2, "big"))
    count += 1
    for value in utf8_values:
        add_utf8(value)

    header = bytearray(b"\xca\xfe\xba\xbe\x00\x00\x00\x3d")
    header.extend(count.to_bytes(2, "big"))
    header.extend(pool)
    header.extend(b"\x00\x21")
    header.extend((2).to_bytes(2, "big"))
    header.extend((4).to_bytes(2, "big"))
    header.extend(b"\x00\x00\x00\x00\x00\x00\x00\x00")
    return bytes(header)


class VerifyJarTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.feature = self.root / "ArcWorldView-0.1.0.jar"
        self.host = self.root / "ArcCore.jar"
        self.make_feature()
        self.make_host()

    def tearDown(self):
        self.temp.cleanup()

    def make_feature(self, *, omit=(), extra=(), descriptor="name: ArcWorldView\ndepend: [ArcCore]\n",
                     feature_api="ru/arc/paper/api/ArcSceneEntity",
                     helper_api="ru/arc/paper/api/ArcSceneEquipment"):
        entries = {
            "plugin.yml": descriptor.encode(),
            "kotlin/collections/CollectionsKt.class": b"runtime",
            verifier.MAIN_CLASS: class_file(
                "ru/arc/worldview/ArcWorldViewPlugin",
                f"L{feature_api};",
            ),
            "ru/arc/worldview/ActorWire.class": class_file(
                "ru/arc/worldview/ActorWire", "Lru/arc/paper/api/ArcSceneEntity;"
            ),
            verifier.SCENE_SNAPSHOT_HELPER: class_file(
                "ru/arc/paper/scene/PaperSceneSnapshots",
                f"L{helper_api};",
            ),
            "web/index.html": b"<script src='app.js'></script>",
            "web/THIRD_PARTY_NOTICES.txt": b"Bundled dependency license notices",
            "web/app.js": b"app",
            "web/worker.js": b"worker",
            "web/fonts/golos.woff2": b"font",
        }
        entries.update(dict(extra))
        with zipfile.ZipFile(self.feature, "w") as archive:
            for name, content in entries.items():
                if name not in omit:
                    archive.writestr(name, content)

    def make_host(self, *, omit=(), descriptor="name: ArcCore\n"):
        entries = {"plugin.yml": descriptor.encode(), verifier.SCENE_PROVIDER: b"provider"}
        entries.update({name: b"api" for name in verifier.SCENE_API_CLASSES})
        with zipfile.ZipFile(self.host, "w") as archive:
            for name, content in entries.items():
                if name not in omit:
                    archive.writestr(name, content)

    def verify(self):
        verifier.verify(self.feature, self.host)

    def test_valid_feature_and_exact_host_pass(self):
        self.verify()

    def test_feature_plugin_name_and_arc_core_dependency_are_required(self):
        self.make_feature(descriptor="name: AnotherPlugin\ndepend: [ArcCore]\n")
        with self.assertRaisesRegex(ValueError, "exactly one top-level name: ArcWorldView"):
            self.verify()
        self.make_feature(descriptor="name: ArcWorldView\n")
        with self.assertRaisesRegex(ValueError, "must declare ArcCore in depend"):
            self.verify()

    def test_shaded_runtime_and_feature_entrypoints_are_required(self):
        self.make_feature(omit=(verifier.MAIN_CLASS,))
        with self.assertRaisesRegex(ValueError, "ArcWorldViewPlugin.class"):
            self.verify()
        self.make_feature(omit=("web/index.html",))
        with self.assertRaisesRegex(ValueError, "web/index.html"):
            self.verify()
        self.make_feature(omit=("web/THIRD_PARTY_NOTICES.txt",))
        with self.assertRaisesRegex(ValueError, "THIRD_PARTY_NOTICES"):
            self.verify()
        self.make_feature(omit=("web/worker.js",))
        with self.assertRaisesRegex(ValueError, "worker JavaScript"):
            self.verify()
        self.make_feature(omit=("web/app.js",))
        with self.assertRaisesRegex(ValueError, "browser JavaScript"):
            self.verify()
        self.make_feature(omit=("kotlin/collections/CollectionsKt.class",))
        with self.assertRaisesRegex(ValueError, "bundled Kotlin runtime"):
            self.verify()

    def test_platform_shared_api_and_provider_classes_cannot_be_shaded(self):
        self.make_feature(extra=(("org/bukkit/Bukkit.class", b"platform"),))
        with self.assertRaisesRegex(ValueError, "platform/Core API/provider classes were shaded"):
            self.verify()
        self.make_feature(extra=(("ru/arc/paper/api/ArcSceneEntity.class", b"api"),))
        with self.assertRaisesRegex(ValueError, "platform/Core API/provider classes were shaded"):
            self.verify()
        self.make_feature(extra=(("ru/arc/metrics/ArcMetrics.class", b"api"),))
        with self.assertRaisesRegex(ValueError, "platform/Core API/provider classes were shaded"):
            self.verify()
        self.make_feature(extra=((verifier.SCENE_PROVIDER, b"provider"),))
        with self.assertRaisesRegex(ValueError, "platform/Core API/provider classes were shaded"):
            self.verify()

    def test_host_name_scene_types_provider_and_api_references_are_checked(self):
        self.make_host(descriptor="name: AnotherPlugin\n")
        with self.assertRaisesRegex(ValueError, "name: ArcCore"):
            self.verify()
        self.make_host(omit=(verifier.SCENE_API_CLASSES[4],))
        with self.assertRaisesRegex(ValueError, "missing required ArcScene API types: ArcSceneEquipment"):
            self.verify()
        self.make_host(omit=(verifier.SCENE_PROVIDER,))
        with self.assertRaisesRegex(ValueError, "missing the shared scene provider"):
            self.verify()
        self.make_host(omit=(verifier.SCENE_API_CLASSES[2],))
        with self.assertRaisesRegex(ValueError, "ArcCore host is missing required ArcScene API types"):
            self.verify()

    def test_used_core_helper_constant_pool_is_checked_against_the_host(self):
        self.make_feature(helper_api="ru/arc/paper/api/ArcSceneExtension")
        with self.assertRaisesRegex(ValueError, "host API linkage is incomplete:.*ArcSceneExtension"):
            self.verify()

    def test_private_manifests_textures_and_native_assets_cannot_be_packaged(self):
        for name in (
            "assets/revision/manifest.json",
            "web/manifest.json",
            "web/assets/minecraft/textures/block/stone.png",
            "data/minecraft/models/block/cube.json",
            "native/linux-x64/libexample.so",
        ):
            with self.subTest(name=name):
                self.make_feature(extra=((name, b"private"),))
                with self.assertRaisesRegex(ValueError, "private/native Minecraft assets were bundled"):
                    self.verify()

    def test_production_jar_selection_ignores_plain_and_requires_one_shaded_jar(self):
        libs = self.root / "build" / "libs"
        libs.mkdir(parents=True)
        (libs / "ArcWorldView-0.1.0.jar").write_bytes(b"artifact")
        (libs / "ArcWorldView-0.1.0-plain.jar").write_bytes(b"plain")
        self.assertEqual(verifier.runtime_jar(self.root).name, "ArcWorldView-0.1.0.jar")
        (libs / "ArcWorldView-0.1.1.jar").write_bytes(b"second")
        with self.assertRaisesRegex(ValueError, "expected exactly one shaded ArcWorldView"):
            verifier.runtime_jar(self.root)

    def test_github_output_receives_the_verified_absolute_jar_path(self):
        output = self.root / "github-output"
        argv = [
            "verify-jar.py", "--jar", str(self.feature),
            "--arc-core-jar", str(self.host), "--github-output", str(output),
        ]
        original_argv = sys.argv
        try:
            sys.argv = argv
            with redirect_stdout(io.StringIO()):
                self.assertEqual(verifier.main(), 0)
        finally:
            sys.argv = original_argv
        self.assertEqual(output.read_text(), f"path={self.feature.resolve()}\n")


if __name__ == "__main__":
    unittest.main()
