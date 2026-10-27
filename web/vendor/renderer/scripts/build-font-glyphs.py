#!/usr/bin/env python3
"""Build the browser bitmap-glyph map from an official Minecraft client JAR."""

from __future__ import annotations

import argparse
from hashlib import sha1
import json
from pathlib import Path, PurePosixPath
from typing import Any
from zipfile import ZipFile


def split_identifier(identifier: str) -> tuple[str, str]:
    namespace, separator, resource = identifier.partition(":")
    if not separator:
        namespace, resource = "minecraft", namespace
    if not namespace or not resource or ".." in PurePosixPath(resource).parts:
        raise ValueError(f"unsafe resource identifier: {identifier!r}")
    return namespace, resource


def font_path(identifier: str) -> str:
    namespace, resource = split_identifier(identifier)
    return f"assets/{namespace}/font/{resource}.json"


def read_json(archive: ZipFile, resource: str) -> dict[str, Any]:
    value = json.loads(archive.read(resource))
    if not isinstance(value, dict):
        raise ValueError(f"expected JSON object in {resource}")
    return value


def filter_matches(value: object, options: dict[str, bool]) -> bool:
    if value is None:
        return True
    if not isinstance(value, dict):
        raise ValueError(f"invalid provider filter: {value!r}")
    return all(isinstance(expected, bool) and options.get(name, False) is expected for name, expected in value.items())


def providers(
    archive: ZipFile,
    identifier: str,
    *,
    options: dict[str, bool],
    stack: tuple[str, ...] = (),
) -> list[dict[str, Any]]:
    if identifier in stack:
        raise ValueError("cyclic font reference: " + " -> ".join((*stack, identifier)))
    resource = font_path(identifier)
    values = read_json(archive, resource).get("providers")
    if not isinstance(values, list):
        raise ValueError(f"{resource} has no provider list")
    result: list[dict[str, Any]] = []
    for value in values:
        if not isinstance(value, dict) or not filter_matches(value.get("filter"), options):
            continue
        if value.get("type") == "reference":
            target = value.get("id")
            if not isinstance(target, str):
                raise ValueError(f"reference in {resource} has no id")
            result.extend(providers(archive, target, options=options, stack=(*stack, identifier)))
        else:
            result.append(value)
    return result


def file_sha1(path: Path) -> str:
    digest = sha1()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build(client_jar: Path, version: str, expected_sha1: str | None) -> dict[str, Any]:
    actual_sha1 = file_sha1(client_jar)
    if expected_sha1 and actual_sha1.lower() != expected_sha1.lower():
        raise ValueError(f"client SHA-1 mismatch: expected {expected_sha1}, got {actual_sha1}")

    glyphs: dict[str, dict[str, object]] = {}
    with ZipFile(client_jar) as archive:
        for provider in providers(
            archive,
            "minecraft:default",
            options={"uniform": False},
        ):
            if provider.get("type") != "bitmap":
                continue
            file_id = provider.get("file")
            rows = provider.get("chars")
            if not isinstance(file_id, str) or not isinstance(rows, list) or not rows:
                raise ValueError("invalid bitmap provider")
            if not all(isinstance(row, str) for row in rows):
                raise ValueError(f"invalid char grid for {file_id}")
            columns = len(rows[0])
            if columns == 0 or any(len(row) != columns for row in rows):
                raise ValueError(f"non-rectangular char grid for {file_id}")
            namespace, texture = split_identifier(file_id)
            archive.read(f"assets/{namespace}/textures/{texture}")
            url = f"/world/textures/{version}/font/{PurePosixPath(texture).name}"
            height = provider.get("height", 8)
            ascent = provider.get("ascent", 7)
            if not isinstance(height, int) or not isinstance(ascent, int):
                raise ValueError(f"invalid dimensions for {file_id}")
            for row_index, row in enumerate(rows):
                for column_index, character in enumerate(row):
                    codepoint = ord(character)
                    if codepoint == 0:
                        continue
                    key = f"{codepoint:04X}"
                    if key in glyphs:
                        continue
                    glyphs[key] = {
                        "kind": "vanilla",
                        "url": url,
                        "column": column_index,
                        "row": row_index,
                        "columns": columns,
                        "rows": len(rows),
                        "height": height,
                        "ascent": ascent,
                    }
    return {
        "schema": 1,
        "minecraft_version": version,
        "client_sha1": actual_sha1,
        "glyphs": glyphs,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("client_jar", type=Path)
    parser.add_argument("--minecraft-version", required=True)
    parser.add_argument("--expected-sha1")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = build(args.client_jar, args.minecraft_version, args.expected_sha1)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"WROTE {args.output} glyphs={len(result['glyphs'])} client_sha1={result['client_sha1']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
