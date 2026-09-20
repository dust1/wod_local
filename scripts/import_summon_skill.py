"""Download and import summon skills listed in docs/summon_skill_list.txt.

Each non-empty line is one exact skill name. Its WOD page is parsed with
docs/script/parse_skill.py, saved as data/summon_skills/<record id>.json, and
indexed in summon_skills plus skill_detail_metadata(scope='summon'). Skill
assignment to a summon is intentionally handled separately by
summon_archetype_skills.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_URL = "https://delta.world-of-dungeons.org/wod/spiel/hero/skill.php"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", type=Path, default=ROOT / "docs" / "summon_skill_list.txt")
    parser.add_argument("--output", type=Path, default=ROOT / "data" / "summon_skills")
    parser.add_argument("--database", type=Path, default=ROOT / "data" / "game.sqlite")
    parser.add_argument("--url", default=DEFAULT_URL, help="技能页面地址；name 参数由脚本添加")
    parser.add_argument("--cookie", default=os.environ.get("WOD_COOKIE", ""), help="可选登录 Cookie，也可使用 WOD_COOKIE")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--delay", type=float, default=0.2, help="每次请求前等待秒数")
    return parser.parse_args(argv)


def read_skill_names(path: Path) -> tuple[list[str], int]:
    if not path.is_file():
        raise FileNotFoundError(f"技能清单不存在：{path}")
    names: list[str] = []
    seen: set[str] = set()
    duplicate_count = 0
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        name = raw_line.strip()
        if not name:
            continue
        if name in seen:
            duplicate_count += 1
            continue
        seen.add(name)
        names.append(name)
    return names, duplicate_count


def load_skill_parser():
    path = ROOT / "docs" / "script" / "parse_skill.py"
    spec = importlib.util.spec_from_file_location("wod_parse_skill", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载技能解析器：{path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.parse_skill_html


def build_skill_url(base_url: str, name: str) -> str:
    parts = urllib.parse.urlsplit(base_url)
    query = dict(urllib.parse.parse_qsl(parts.query, keep_blank_values=True))
    query["name"] = name
    encoded = urllib.parse.urlencode(query, quote_via=urllib.parse.quote, encoding="utf-8")
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, encoded, parts.fragment))


def decode_response(body: bytes, charset: str | None) -> str:
    for encoding in (charset, "utf-8", "gb18030"):
        if not encoding:
            continue
        try:
            return body.decode(encoding)
        except (LookupError, UnicodeDecodeError):
            continue
    raise UnicodeError("技能页面既不是 UTF-8 也不是 GB18030")


def fetch_skill_html(
    name: str,
    base_url: str,
    cookie: str,
    timeout: float,
    retries: int,
    delay: float,
) -> tuple[str, str]:
    url = build_skill_url(base_url, name)
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
    if cookie:
        headers["Cookie"] = cookie
    last_error: Exception | None = None
    attempt_count = max(1, retries)
    for attempt in range(1, attempt_count + 1):
        try:
            if delay > 0:
                time.sleep(delay)
            request = urllib.request.Request(url, headers=headers, method="GET")
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return decode_response(response.read(), response.headers.get_content_charset()), url
        except (OSError, urllib.error.URLError, urllib.error.HTTPError) as error:
            last_error = error
            if attempt < attempt_count:
                time.sleep(min(float(attempt), 3.0))
    raise RuntimeError(f"请求失败（已重试 {attempt_count} 次）：{last_error}")


def normalized_payload(payload: dict, requested_name: str, source_url: str) -> dict:
    parsed_name = str(payload.get("技能名称", "")).strip()
    if not parsed_name:
        raise ValueError("页面中未解析出技能名称，可能需要有效的登录 Cookie")
    if parsed_name != requested_name:
        raise ValueError(f"请求技能 {requested_name!r}，页面实际返回 {parsed_name!r}")
    # Match the top-level structure used by data/profession_skills. Fields not
    # provided by the legacy parser remain present with neutral values.
    return {
        "技能名称": parsed_name,
        "类型": payload.get("类型", ""),
        "可以被用于": payload.get("可以被用于", ""),
        "目标": payload.get("目标", ""),
        "可影响队友的最大数量": payload.get("可影响队友的最大数量", ""),
        "可影响敌人的最大数量": payload.get("可影响敌人的最大数量", ""),
        "物品": payload.get("物品", ""),
        "技能类型": payload.get("技能类型", ""),
        "描述": payload.get("描述", ""),
        "详细属性": payload.get("详细属性", {}),
        "职业要求": payload.get("职业要求", []),
        "注释": payload.get("注释", ""),
        "作用在技能拥有者上的效果": payload.get("作用在技能拥有者上的效果", []),
        "作用在被此技能影响的目标上的效果": payload.get("作用在被此技能影响的目标上的效果", []),
        "技能ID": None,
        "来源": source_url,
        "原始缓存表": "summon_skills",
    }


def relative_json_path(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path.resolve())


def import_payload(
    game: sqlite3.Connection,
    payload: dict,
    output: Path,
) -> tuple[int, Path]:
    row = game.execute(
        """INSERT INTO summon_skills(
             skill_name,skill_type
           ) VALUES(?,?)
           ON CONFLICT(skill_name) DO UPDATE SET
             skill_type=excluded.skill_type,
             active=1
           RETURNING id""",
        (payload["技能名称"], payload.get("技能类型") or payload.get("类型") or None),
    ).fetchone()
    record_id = int(row[0])
    json_path = output / f"{record_id}.json"
    content = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    temporary = json_path.with_suffix(".json.tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(json_path)
    game.execute(
        """INSERT INTO skill_detail_metadata(
             scope,skill_id,skill_name,source_table,json_path,content_hash,parsed_at
           ) VALUES('summon',?,?,?,?,?,?)
           ON CONFLICT(scope,skill_id) DO UPDATE SET
             skill_name=excluded.skill_name,
             source_table=excluded.source_table,
             json_path=excluded.json_path,
             content_hash=excluded.content_hash,
             parsed_at=excluded.parsed_at""",
        (
            record_id,
            payload["技能名称"],
            "summon_skills",
            relative_json_path(json_path),
            hashlib.sha256(content.encode("utf-8")).hexdigest(),
            datetime.now(timezone.utc).isoformat(),
        ),
    )
    return record_id, json_path


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not args.database.is_file():
        raise SystemExit(f"数据库不存在：{args.database}")
    names, duplicate_count = read_skill_names(args.list)
    if not names:
        print(json.dumps({"imported": 0, "failedCount": 0, "duplicates": duplicate_count}, ensure_ascii=False))
        return 0

    parse_skill_html = load_skill_parser()
    args.output.mkdir(parents=True, exist_ok=True)
    game = sqlite3.connect(args.database, timeout=30)
    game.execute("PRAGMA foreign_keys = ON")
    game.execute("PRAGMA busy_timeout = 30000")
    imported: list[dict] = []
    failures: list[dict] = []
    try:
        for name in names:
            try:
                html, source_url = fetch_skill_html(
                    name, args.url, args.cookie, args.timeout, args.retries, args.delay
                )
                payload = normalized_payload(parse_skill_html(html), name, source_url)
                with game:
                    record_id, json_path = import_payload(game, payload, args.output)
                imported.append({"id": record_id, "name": name, "json": relative_json_path(json_path)})
            except Exception as error:  # keep importing independent skills
                failures.append({"name": name, "error": str(error)})
    finally:
        game.close()

    summary = {
        "imported": len(imported),
        "failedCount": len(failures),
        "duplicates": duplicate_count,
        "records": imported,
        "failures": failures,
    }
    print(json.dumps(summary, ensure_ascii=False))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
