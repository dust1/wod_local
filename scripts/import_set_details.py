"""Parse docs/sets/<set name>/<piece count>.html and index JSON in game.sqlite."""
from __future__ import annotations

import argparse
import importlib.util
import json
import sqlite3
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_parser():
    path = ROOT / "docs" / "script" / "parse_sets.py"
    spec = importlib.util.spec_from_file_location("wod_parse_sets", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module.parse_set_html


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "docs" / "sets")
    parser.add_argument("--output", type=Path, default=ROOT / "data" / "sets")
    parser.add_argument("--database", type=Path, default=ROOT / "data" / "game.sqlite")
    return parser.parse_args()


def discover_pages(source: Path):
    for set_dir in sorted((path for path in source.iterdir() if path.is_dir()), key=lambda p: p.name):
        pages = []
        for html_path in set_dir.glob("*.html"):
            if html_path.stem.isdecimal() and int(html_path.stem) > 0:
                pages.append((int(html_path.stem), html_path))
        for piece_count, html_path in sorted(pages):
            yield set_dir.name, piece_count, html_path


def main() -> None:
    args = parse_args()
    if not args.database.is_file():
        raise SystemExit(f"database does not exist: {args.database}")
    subprocess.run(
        ["node", str(ROOT / "scripts" / "verify-database.mjs"), str(args.database)],
        cwd=ROOT,
        check=True,
    )
    parse_set_html = load_parser()
    args.output.mkdir(parents=True, exist_ok=True)
    game = sqlite3.connect(args.database, timeout=30)
    game.execute("PRAGMA busy_timeout = 30000")
    imported = 0
    failures = []

    for set_name, piece_count, html_path in discover_pages(args.source):
        try:
            payload = parse_set_html(html_path.read_text(encoding="utf-8"))
            parsed_name = payload.get("套装名称")
            if not parsed_name:
                raise ValueError("页面中未找到套装名称")
            if parsed_name != set_name:
                raise ValueError(f"页面套装名称 {parsed_name!r} 与目录名 {set_name!r} 不一致")
            payload["套装件数"] = piece_count
            set_output = args.output / set_name
            set_output.mkdir(parents=True, exist_ok=True)
            json_path = set_output / f"{piece_count}.json"
            json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            relative_path = json_path.relative_to(ROOT).as_posix() if json_path.is_relative_to(ROOT) else str(json_path.resolve())
            game.execute(
                """INSERT INTO item_sets(set_name,piece_count,effect_json_path) VALUES(?,?,?)
                   ON CONFLICT(set_name,piece_count) DO UPDATE SET effect_json_path=excluded.effect_json_path""",
                (set_name, piece_count, relative_path),
            )
            imported += 1
        except Exception as error:
            failures.append({"file": str(html_path), "error": str(error)})

    game.commit()
    game.close()
    print(json.dumps({"imported": imported, "failedCount": len(failures), "failures": failures}, ensure_ascii=False))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
