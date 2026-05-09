#!/usr/bin/env python3
"""Export an iPhone's installed app list for privacytracker imports.

This helper supports two local-only extraction paths:

1. Read installed app metadata from a Finder / Apple Devices / iTunes backup.
2. Query a connected device with `ideviceinstaller` from libimobiledevice.

It writes `.txt`, `.csv`, and `.json` outputs so the current onboarding flow can
reuse the generated list without any backend changes.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable


NAME_KEYS = (
    "CFBundleDisplayName",
    "CFBundleName",
    "DisplayName",
    "Display Name",
    "Name",
    "itemName",
)

BUNDLE_ID_KEYS = (
    "CFBundleIdentifier",
    "bundleIdentifier",
    "bundle_id",
    "bundleId",
    "appid",
    "app_id",
)


@dataclass(frozen=True)
class AppRecord:
    name: str
    bundle_id: str
    source: str

    def as_export_dict(self) -> dict[str, str]:
        return {
            "name": self.name,
            "bundle_id": self.bundle_id,
            "source": self.source,
        }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export an iPhone app list for import into privacytracker."
    )
    parser.add_argument(
        "--mode",
        choices=("auto", "backup", "device"),
        default="auto",
        help="Extraction path to use. Default: auto.",
    )
    parser.add_argument(
        "--backup-root",
        type=Path,
        help="Backup root or a specific backup directory that contains Info.plist.",
    )
    parser.add_argument(
        "--udid",
        help="Optional device UDID when querying a connected device with ideviceinstaller.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path.cwd(),
        help="Directory where txt/csv/json exports should be written.",
    )
    parser.add_argument(
        "--basename",
        default=f"ios-apps-{datetime.now().strftime('%Y%m%d-%H%M%S')}",
        help="Base filename for exported files. Default: ios-apps-<timestamp>.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    try:
        if args.mode == "backup":
            records = load_backup_records(args.backup_root)
        elif args.mode == "device":
            records = load_connected_device_records(args.udid)
        else:
            records = try_auto(args.backup_root, args.udid)
    except Exception as exc:  # noqa: BLE001 - small standalone script
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    if not records:
        print("No apps found.", file=sys.stderr)
        return 1

    output_dir = args.output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    write_outputs(records, output_dir, args.basename)

    print(f"Exported {len(records)} apps to {output_dir}")
    print(f"  - {output_dir / f'{args.basename}.txt'}")
    print(f"  - {output_dir / f'{args.basename}.csv'}")
    print(f"  - {output_dir / f'{args.basename}.json'}")
    print("Use the .txt or .csv file in privacytracker's onboarding import flow.")
    return 0


def try_auto(backup_root: Path | None, udid: str | None) -> list[AppRecord]:
    errors: list[str] = []

    try:
        return load_backup_records(backup_root)
    except Exception as exc:  # noqa: BLE001 - gather fallback context
        errors.append(f"backup mode failed: {exc}")

    try:
        return load_connected_device_records(udid)
    except Exception as exc:  # noqa: BLE001 - gather fallback context
        errors.append(f"device mode failed: {exc}")

    raise RuntimeError("; ".join(errors))


def load_backup_records(backup_root: Path | None) -> list[AppRecord]:
    backup_dir = resolve_backup_dir(backup_root)
    info_path = backup_dir / "Info.plist"
    info = read_plist(info_path)
    applications = info.get("Applications")

    if not isinstance(applications, dict) or not applications:
        raise RuntimeError(
            f"{info_path} did not contain an Applications dictionary."
        )

    records: list[AppRecord] = []
    for bundle_id, metadata in applications.items():
        if not isinstance(bundle_id, str):
            continue
        name = extract_backup_name(bundle_id, metadata)
        records.append(
            AppRecord(
                name=name,
                bundle_id=bundle_id,
                source=f"backup:{backup_dir.name}",
            )
        )

    return dedupe_and_sort(records)


def resolve_backup_dir(backup_root: Path | None) -> Path:
    roots = [backup_root] if backup_root else default_backup_roots()
    candidates: list[Path] = []

    for raw_root in roots:
        if raw_root is None:
            continue

        root = raw_root.expanduser()
        if not str(root):
            continue
        if not root.exists():
            continue

        if (root / "Info.plist").exists():
            candidates.append(root)
            continue

        for child in root.iterdir():
            if child.is_dir() and (child / "Info.plist").exists():
                candidates.append(child)

    if not candidates:
        searched = ", ".join(str(path.expanduser()) for path in roots if path is not None)
        raise RuntimeError(
            "Could not find an iPhone backup with Info.plist. "
            f"Searched: {searched}"
        )

    return max(candidates, key=backup_sort_key)


def default_backup_roots() -> list[Path]:
    roots = [Path("~/Library/Application Support/MobileSync/Backup")]

    appdata = os.environ.get("APPDATA")
    if appdata:
        roots.append(Path(appdata) / "Apple Computer" / "MobileSync" / "Backup")

    userprofile = os.environ.get("USERPROFILE")
    if userprofile:
        roots.append(Path(userprofile) / "Apple" / "MobileSync" / "Backup")
        roots.append(Path(userprofile) / "Apple Computer" / "MobileSync" / "Backup")

    return roots


def backup_sort_key(backup_dir: Path) -> float:
    info_path = backup_dir / "Info.plist"
    try:
        info = read_plist(info_path)
        value = info.get("Last Backup Date")
        if isinstance(value, datetime):
            return value.timestamp()
        if isinstance(value, str):
            try:
                return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
            except ValueError:
                pass
    except Exception:  # noqa: BLE001 - fallback below
        pass

    return info_path.stat().st_mtime


def extract_backup_name(bundle_id: str, metadata: Any) -> str:
    if isinstance(metadata, dict):
        direct_name = first_string(metadata, NAME_KEYS)
        if direct_name:
            return direct_name

        itunes_metadata = metadata.get("iTunesMetadata")
        decoded_name = extract_name_from_itunes_metadata(itunes_metadata)
        if decoded_name:
            return decoded_name

    return humanize_bundle_id(bundle_id)


def extract_name_from_itunes_metadata(value: Any) -> str | None:
    metadata: dict[str, Any] | None = None

    if isinstance(value, dict):
        metadata = value
    elif isinstance(value, (bytes, bytearray)):
        try:
            loaded = plistlib.loads(value)
            if isinstance(loaded, dict):
                metadata = loaded
        except Exception:  # noqa: BLE001 - optional metadata
            return None
    elif isinstance(value, str):
        try:
            loaded = plistlib.loads(value.encode("utf-8"))
            if isinstance(loaded, dict):
                metadata = loaded
        except Exception:  # noqa: BLE001 - optional metadata
            return None

    if not metadata:
        return None

    return first_string(metadata, NAME_KEYS)


def load_connected_device_records(udid: str | None) -> list[AppRecord]:
    if shutil.which("ideviceinstaller") is None:
        raise RuntimeError(
            "ideviceinstaller was not found. Install libimobiledevice or use backup mode."
        )

    stdout = run_ideviceinstaller(udid)
    records = parse_device_output(stdout)
    if not records:
        raise RuntimeError("ideviceinstaller returned no app records.")
    return dedupe_and_sort(records)


def run_ideviceinstaller(udid: str | None) -> str:
    command_variants = [
        ("json", ["list", "-o", "json"]),
        ("xml", ["list", "-o", "xml"]),
        ("json", ["-l", "-o", "json"]),
        ("xml", ["-l", "-o", "xml"]),
        ("text", ["list"]),
        ("text", ["-l"]),
    ]

    errors: list[str] = []
    for _, args in command_variants:
        cmd = ["ideviceinstaller"]
        if udid:
            cmd.extend(["-u", udid])
        cmd.extend(args)

        try:
            proc = subprocess.run(
                cmd,
                check=True,
                capture_output=True,
                text=True,
            )
            if proc.stdout.strip():
                return proc.stdout
        except subprocess.CalledProcessError as exc:
            stderr = exc.stderr.strip() or exc.stdout.strip() or "unknown error"
            errors.append(f"{' '.join(cmd)} -> {stderr}")

    raise RuntimeError("Unable to query the connected device. " + " | ".join(errors))


def parse_device_output(stdout: str) -> list[AppRecord]:
    text = stdout.strip()
    if not text:
        return []

    if text.startswith("{") or text.startswith("["):
        parsed = json.loads(text)
        return extract_records_from_object(parsed, "device:ideviceinstaller")

    if text.startswith("<?xml") or text.startswith("<plist"):
        parsed = plistlib.loads(text.encode("utf-8"))
        return extract_records_from_object(parsed, "device:ideviceinstaller")

    records: list[AppRecord] = []
    for line in text.splitlines():
        line = line.strip()
        if looks_like_bundle_id(line):
            records.append(
                AppRecord(
                    name=humanize_bundle_id(line),
                    bundle_id=line,
                    source="device:ideviceinstaller",
                )
            )
    return records


def extract_records_from_object(obj: Any, source: str) -> list[AppRecord]:
    records: list[AppRecord] = []
    seen: set[str] = set()

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            if all(isinstance(key, str) and looks_like_bundle_id(key) for key in node.keys()):
                for bundle_id, value in node.items():
                    name = extract_generic_name(bundle_id, value)
                    push_record(bundle_id, name)

            bundle_id = first_string(node, BUNDLE_ID_KEYS)
            if bundle_id:
                name = extract_generic_name(bundle_id, node)
                push_record(bundle_id, name)

            for value in node.values():
                visit(value)
            return

        if isinstance(node, list):
            for item in node:
                visit(item)
            return

        if isinstance(node, str) and looks_like_bundle_id(node):
            push_record(node, humanize_bundle_id(node))

    def push_record(bundle_id: str, name: str) -> None:
        if bundle_id in seen:
            return
        seen.add(bundle_id)
        records.append(
            AppRecord(
                name=name,
                bundle_id=bundle_id,
                source=source,
            )
        )

    visit(obj)
    return records


def extract_generic_name(bundle_id: str, value: Any) -> str:
    if isinstance(value, dict):
        direct_name = first_string(value, NAME_KEYS)
        if direct_name:
            return direct_name
    return humanize_bundle_id(bundle_id)


def read_plist(path: Path) -> dict[str, Any]:
    with path.open("rb") as handle:
        data = plistlib.load(handle)
    if not isinstance(data, dict):
        raise RuntimeError(f"{path} is not a property-list dictionary.")
    return data


def first_string(mapping: dict[str, Any], keys: Iterable[str]) -> str | None:
    for key in keys:
        value = mapping.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def humanize_bundle_id(bundle_id: str) -> str:
    tail = bundle_id.split(".")[-1]
    tail = re.sub(
        r"(Notification|Share|Today|Widget|Service|Intents|IntentUI|Extension)$",
        "",
        tail,
        flags=re.IGNORECASE,
    )
    tail = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", tail)
    tail = tail.replace("-", " ").replace("_", " ").strip()
    return tail.title() or bundle_id


def looks_like_bundle_id(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+", value))


def dedupe_and_sort(records: list[AppRecord]) -> list[AppRecord]:
    unique: dict[str, AppRecord] = {}
    for record in records:
        unique.setdefault(record.bundle_id, record)
    return sorted(unique.values(), key=lambda item: (item.name.casefold(), item.bundle_id))


def write_outputs(records: list[AppRecord], output_dir: Path, basename: str) -> None:
    txt_path = output_dir / f"{basename}.txt"
    csv_path = output_dir / f"{basename}.csv"
    json_path = output_dir / f"{basename}.json"

    with txt_path.open("w", encoding="utf-8", newline="") as handle:
        for record in records:
            handle.write(record.name)
            handle.write("\n")

    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["name", "bundle_id", "source"])
        writer.writeheader()
        for record in records:
            writer.writerow(record.as_export_dict())

    with json_path.open("w", encoding="utf-8") as handle:
        json.dump(
            [record.as_export_dict() for record in records],
            handle,
            indent=2,
            ensure_ascii=False,
        )
        handle.write("\n")


if __name__ == "__main__":
    raise SystemExit(main())
