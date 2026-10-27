#!/usr/bin/env python3
"""Check the shaded ArcWorldView artifact and its exact ArcCore host contract."""

from __future__ import annotations

import argparse
import re
import struct
import sys
import zipfile
from pathlib import Path


FORBIDDEN_CLASS_PREFIXES = (
    "org/bukkit/",
    "io/papermc/",
    "net/kyori/adventure/",
    "org/slf4j/",
    "com/sk89q/",
    "net/citizensnpcs/",
    "ru/arc/metrics/",
    "ru/arc/paper/api/",
    "ru/arc/paper/schematics/",
    "ru/arc/paper/sql/PaperSqlServiceProvider",
    "ru/arc/paper/sql/SharedPaperSqlService",
    "ru/arc/paper/redis/PaperRedisServiceProvider",
    "ru/arc/paper/redis/SharedPaperRedisService",
    "ru/arc/paper/metrics/PaperArcMetricsProvider",
    "ru/arc/paper/packet/PaperVisualPacketRuntime",
    "ru/arc/paper/runtime/PaperNativeCleanupServiceProvider",
    "ru/arc/paper/scene/PaperSceneObservationServiceProvider",
    "ru/arc/paper/scene/PaperSceneEntityInfoServiceProvider",
)

MAIN_CLASS = "ru/arc/worldview/ArcWorldViewPlugin.class"
SCENE_SNAPSHOT_HELPER = "ru/arc/paper/scene/PaperSceneSnapshots.class"
SCENE_PROVIDER = "ru/arc/paper/scene/PaperSceneObservationServiceProvider.class"
SCENE_API_CLASSES = tuple(
    f"ru/arc/paper/api/{name}.class"
    for name in (
        "ArcSceneBounds",
        "ArcSceneChunkListener",
        "ArcSceneEntity",
        "ArcSceneEntityInfoService",
        "ArcSceneEntityInfoSource",
        "ArcSceneEntityInfo",
        "ArcSceneInfoField",
        "ArcSceneEntitySource",
        "ArcSceneEquipment",
        "ArcSceneLocation",
        "ArcSceneLocationSource",
        "ArcSceneObservationService",
        "ArcSceneDisplay", "ArcSceneDisplayPose", "ArcSceneVector3", "ArcSceneQuaternion", "ArcSceneItem",
        "ArcSceneTextRun", "ArcSceneTextContent", "ArcSceneDisplayContent", "ArcSceneDisplayContent$Item",
        "ArcSceneDisplayContent$Text", "ArcSceneDisplayTimeline", "ArcSceneDisplayKeyframe", "ArcSceneDisplayItemSwitch",
    )
)
API_REFERENCE = re.compile(rb"ru/arc/paper/api/[A-Za-z0-9_$]+")
NATIVE_SUFFIXES = (".dll", ".so", ".dylib", ".jnilib", ".node")
TEXTURE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp", ".tga", ".ktx", ".ktx2")


def plugin_fields(descriptor: str) -> tuple[list[str], list[str]]:
    """Read the top-level name and depend fields used by Bukkit plugin.yml."""
    names: list[str] = []
    dependencies: list[str] = []
    active_field = None

    def unquote(value: str) -> str:
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            return value[1:-1]
        return value

    for raw_line in descriptor.splitlines():
        line = raw_line.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line[0].isspace():
            if active_field == "depend" and line.lstrip().startswith("-"):
                item = line.lstrip()[1:].strip().split(" #", 1)[0]
                if item:
                    dependencies.append(unquote(item))
            continue

        key, separator, value = line.partition(":")
        if not separator:
            active_field = None
            continue
        active_field = key.strip()
        value = value.strip().split(" #", 1)[0].strip()
        if active_field == "name" and value:
            names.append(unquote(value))
        elif active_field == "depend" and value:
            if value.startswith("[") and value.endswith("]"):
                dependencies.extend(unquote(item) for item in value[1:-1].split(",") if item.strip())
            else:
                dependencies.append(unquote(value))
    return names, dependencies


def api_references(bytecode: bytes) -> set[str]:
    """Read ru/arc/paper/api names from a JVM constant pool."""
    if len(bytecode) < 10 or bytecode[:4] != b"\xca\xfe\xba\xbe":
        raise ValueError("invalid class file in the feature/Core linkage path")
    pool_count = struct.unpack_from(">H", bytecode, 8)[0]
    offset, index = 10, 1
    references: set[str] = set()
    sizes = {
        3: 4, 4: 4, 5: 8, 6: 8, 7: 2, 8: 2, 9: 4, 10: 4, 11: 4,
        12: 4, 15: 3, 16: 2, 17: 4, 18: 4, 19: 2, 20: 2,
    }
    while index < pool_count:
        if offset >= len(bytecode):
            raise ValueError("truncated JVM constant pool")
        tag = bytecode[offset]
        offset += 1
        if tag == 1:
            length = struct.unpack_from(">H", bytecode, offset)[0]
            offset += 2
            end = offset + length
            if end > len(bytecode):
                raise ValueError("truncated JVM constant-pool string")
            references.update(
                match.group().decode("ascii") + ".class"
                for match in API_REFERENCE.finditer(bytecode[offset:end])
            )
            offset = end
        else:
            if tag not in sizes:
                raise ValueError(f"unsupported JVM constant-pool tag {tag}")
            offset += sizes[tag]
            if offset > len(bytecode):
                raise ValueError("truncated JVM constant pool")
            if tag in (5, 6):
                index += 1
        index += 1
    return references


def runtime_jar(project_root: Path) -> Path:
    candidates = sorted(
        path
        for path in (project_root / "build" / "libs").glob("ArcWorldView-*.jar")
        if path.is_file() and not path.name.endswith("-plain.jar")
    )
    if len(candidates) != 1:
        raise ValueError(
            "expected exactly one shaded ArcWorldView-*.jar in build/libs, "
            f"found {len(candidates)}"
        )
    jar = candidates[0]
    if jar.stat().st_size == 0:
        raise ValueError(f"production JAR is empty: {jar}")
    return jar


def verify_plugin_descriptor(entries: set[str], read, expected_name: str, *, require_core: bool) -> None:
    if "plugin.yml" not in entries:
        raise ValueError("JAR is missing plugin.yml")
    names, dependencies = plugin_fields(read("plugin.yml").decode("utf-8"))
    if names != [expected_name]:
        raise ValueError(f"plugin.yml must declare exactly one top-level name: {expected_name}")
    if require_core and "ArcCore" not in dependencies:
        raise ValueError("plugin.yml must declare ArcCore in depend")


def verify_host_linkage(archive: zipfile.ZipFile, host_path: Path) -> None:
    with zipfile.ZipFile(host_path) as host:
        feature_entries = set(archive.namelist())
        host_entries = set(host.namelist())
        verify_plugin_descriptor(host_entries, host.read, "ArcCore", require_core=False)

        missing_scene = sorted(set(SCENE_API_CLASSES) - host_entries)
        if missing_scene:
            details = ", ".join(path.rsplit("/", 1)[-1][:-6] for path in missing_scene)
            raise ValueError(f"ArcCore host is missing required ArcScene API types: {details}")
        if SCENE_PROVIDER not in host_entries:
            raise ValueError(f"ArcCore host is missing the shared scene provider: {SCENE_PROVIDER}")

        consumers: list[tuple[str, bytes]] = []
        for name in sorted(feature_entries):
            if name.endswith(".class") and name.startswith("ru/arc/worldview/"):
                consumers.append((name, archive.read(name)))
        for name in (SCENE_SNAPSHOT_HELPER,):
            if name in feature_entries:
                consumers.append((name, archive.read(name)))
            elif name in host_entries:
                consumers.append((name, host.read(name)))
            else:
                raise ValueError(f"feature and ArcCore host are missing used Core class: {name}")

        missing: dict[str, str] = {}
        for source, bytecode in consumers:
            for reference in api_references(bytecode) - host_entries:
                missing.setdefault(reference, source)
        if missing:
            details = "; ".join(
                f"{api} (referenced by {source})" for api, source in sorted(missing.items())
            )
            raise ValueError(f"ArcCore host API linkage is incomplete: {details}")


def verify_asset_boundary(entries: set[str]) -> None:
    leaked = []
    for name in entries:
        parts = name.lower().split("/")
        leaf = parts[-1]
        if "assets" in parts or leaf == "manifest.json":
            leaked.append(name)
        elif parts[:2] == ["data", "minecraft"] or parts[0] == "minecraft":
            leaked.append(name)
        elif leaf.endswith(NATIVE_SUFFIXES):
            leaked.append(name)
        elif leaf.endswith(TEXTURE_SUFFIXES) and "textures" in parts:
            leaked.append(name)
    if leaked:
        preview = ", ".join(sorted(leaked)[:8])
        suffix = " ..." if len(leaked) > 8 else ""
        raise ValueError(f"private/native Minecraft assets were bundled: {preview}{suffix}")


def verify(jar_path: Path, host_path: Path) -> None:
    with zipfile.ZipFile(jar_path) as archive:
        entries = archive.namelist()
        entry_set = set(entries)
        verify_plugin_descriptor(entry_set, archive.read, "ArcWorldView", require_core=True)
        if "kotlin/collections/CollectionsKt.class" not in entry_set:
            raise ValueError("production JAR is missing the bundled Kotlin runtime")
        for required in (MAIN_CLASS, "web/index.html", "web/THIRD_PARTY_NOTICES.txt"):
            if required not in entry_set:
                raise ValueError(f"production JAR is missing required entry: {required}")
        javascript = [
            name for name in entry_set
            if name.startswith("web/") and name.lower().endswith(".js")
        ]
        if not any("worker" not in name.rsplit("/", 1)[-1].lower() for name in javascript):
            raise ValueError("production JAR is missing browser JavaScript under web/")
        if not any(
            "worker" in name.rsplit("/", 1)[-1].lower() for name in javascript
        ):
            raise ValueError("production JAR is missing a browser worker JavaScript file under web/")

        leaked_classes = sorted(
            name
            for name in entry_set
            if name.endswith(".class") and name.startswith(FORBIDDEN_CLASS_PREFIXES)
        )
        if leaked_classes:
            preview = ", ".join(leaked_classes[:8])
            suffix = " ..." if len(leaked_classes) > 8 else ""
            raise ValueError(f"platform/Core API/provider classes were shaded: {preview}{suffix}")
        verify_asset_boundary(entry_set)
        verify_host_linkage(archive, host_path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--arc-core-jar",
        type=Path,
        default=Path("build/verification/ArcCore.jar"),
        help="exact mandatory ArcCore host JAR (never use a test classpath)",
    )
    parser.add_argument("--jar", type=Path, help="production JAR path (defaults to the unique build/libs artifact)")
    parser.add_argument("--github-output", type=Path, help="append the verified artifact path to a GitHub Actions output file")
    args = parser.parse_args()

    try:
        jar = args.jar.resolve() if args.jar else runtime_jar(Path.cwd())
        host = args.arc_core_jar.resolve()
        verify(jar, host)
        if args.github_output:
            with args.github_output.open("a", encoding="utf-8") as output:
                output.write(f"path={jar}\n")
    except (OSError, UnicodeError, zipfile.BadZipFile, ValueError, IndexError, struct.error, KeyError) as error:
        print(f"ArcWorldView artifact verification failed: {error}", file=sys.stderr)
        return 1

    print(f"Verified ArcWorldView production artifact: {jar}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
