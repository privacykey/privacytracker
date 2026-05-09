from __future__ import annotations

import csv
import importlib.util
import json
import plistlib
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "export_ios_apps.py"
SPEC = importlib.util.spec_from_file_location("export_ios_apps", MODULE_PATH)
assert SPEC and SPEC.loader
export_ios_apps = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = export_ios_apps
SPEC.loader.exec_module(export_ios_apps)


class BackupImportTests(unittest.TestCase):
    def test_load_backup_records_prefers_display_names_and_sorts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            backup = Path(tmp) / "backup-a"
            backup.mkdir()
            metadata = plistlib.dumps({"itemName": "Clock"})
            with (backup / "Info.plist").open("wb") as handle:
                plistlib.dump(
                    {
                        "Applications": {
                            "com.example.zeta": {"CFBundleDisplayName": "Zeta"},
                            "com.apple.mobiletimer": {"iTunesMetadata": metadata},
                            "com.example.noName": {},
                        }
                    },
                    handle,
                )

            records = export_ios_apps.load_backup_records(Path(tmp))

        self.assertEqual(
            [(record.name, record.bundle_id) for record in records],
            [
                ("Clock", "com.apple.mobiletimer"),
                ("No Name", "com.example.noName"),
                ("Zeta", "com.example.zeta"),
            ],
        )

    def test_parse_device_output_handles_json_xml_and_plain_text(self) -> None:
        json_rows = export_ios_apps.parse_device_output(
            json.dumps(
                {
                    "Applications": [
                        {
                            "CFBundleDisplayName": "Signal",
                            "CFBundleIdentifier": "org.whispersystems.signal",
                        },
                        {
                            "displayName": "Clock",
                            "bundleIdentifier": "com.apple.mobiletimer",
                        },
                    ]
                }
            )
        )
        self.assertEqual({record.bundle_id for record in json_rows}, {
            "org.whispersystems.signal",
            "com.apple.mobiletimer",
        })

        xml_payload = plistlib.dumps({
            "Applications": {
                "com.example.weather": {"Name": "Weather"},
            }
        }).decode("utf-8")
        xml_rows = export_ios_apps.parse_device_output(xml_payload)
        self.assertEqual(xml_rows[0].name, "Weather")

        text_rows = export_ios_apps.parse_device_output(
            "not an app\ncom.example.ShareExtension\ncom.example.RealApp\n"
        )
        self.assertEqual(
            [(record.name, record.bundle_id) for record in text_rows],
            [
                ("Share", "com.example.ShareExtension"),
                ("Real App", "com.example.RealApp"),
            ],
        )

    def test_write_outputs_creates_txt_csv_and_json(self) -> None:
        records = [
            export_ios_apps.AppRecord("Clock", "com.apple.mobiletimer", "unit"),
            export_ios_apps.AppRecord("Signal", "org.whispersystems.signal", "unit"),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp)
            export_ios_apps.write_outputs(records, output_dir, "apps")

            self.assertEqual((output_dir / "apps.txt").read_text(), "Clock\nSignal\n")
            with (output_dir / "apps.csv").open(newline="", encoding="utf-8") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(rows[0]["bundle_id"], "com.apple.mobiletimer")
            self.assertEqual(json.loads((output_dir / "apps.json").read_text())[1]["name"], "Signal")


if __name__ == "__main__":
    unittest.main()
