from __future__ import annotations

import importlib.util
import json
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "import_summon_skill.py"
SPEC = importlib.util.spec_from_file_location("import_summon_skill", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class ImportSummonSkillTests(unittest.TestCase):
    def test_build_skill_url_encodes_exact_name(self):
        url = MODULE.build_skill_url(MODULE.DEFAULT_URL, "自然发芽")
        self.assertEqual(
            url,
            "https://delta.world-of-dungeons.org/wod/spiel/hero/skill.php?name=%E8%87%AA%E7%84%B6%E5%8F%91%E8%8A%BD",
        )

    def test_read_names_strips_bom_blanks_and_duplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "skills.txt"
            path.write_text("\ufeff自然发芽\n\n 自然发芽 \n藤蔓抽击\n", encoding="utf-8")
            self.assertEqual(MODULE.read_skill_names(path), (["自然发芽", "藤蔓抽击"], 1))

    def test_import_writes_database_record_metadata_and_matching_json_shape(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "game.sqlite"
            output = root / "summon_skills"
            output.mkdir()
            shutil.copyfile(ROOT / "tests" / "fixtures" / "runtime-template.sqlite", database)
            parsed = {
                "技能名称": "自然发芽",
                "类型": "辅助",
                "可以被用于": "回合前",
                "目标": "自身",
                "技能类型": "自然魔法",
                "作用在技能拥有者上的效果": [],
                "作用在被此技能影响的目标上的效果": [],
            }
            payload = MODULE.normalized_payload(
                parsed,
                "自然发芽",
                MODULE.build_skill_url(MODULE.DEFAULT_URL, "自然发芽"),
            )
            game = sqlite3.connect(database)
            try:
                game.execute("PRAGMA foreign_keys = ON")
                with game:
                    record_id, json_path = MODULE.import_payload(game, payload, output)
                row = game.execute(
                    "SELECT skill_name,skill_type FROM summon_skills WHERE id=?",
                    (record_id,),
                ).fetchone()
                metadata = game.execute(
                    "SELECT scope,skill_name,source_table FROM skill_detail_metadata WHERE scope='summon' AND skill_id=?",
                    (record_id,),
                ).fetchone()
            finally:
                game.close()
            self.assertEqual(row, ("自然发芽", "自然魔法"))
            self.assertEqual(metadata, ("summon", "自然发芽", "summon_skills"))
            saved = json.loads(json_path.read_text(encoding="utf-8"))
            self.assertEqual(
                list(saved),
                [
                    "技能名称", "类型", "可以被用于", "目标", "可影响队友的最大数量",
                    "可影响敌人的最大数量", "物品", "技能类型", "描述", "详细属性",
                    "职业要求", "注释", "作用在技能拥有者上的效果",
                    "作用在被此技能影响的目标上的效果", "技能ID", "来源", "原始缓存表",
                ],
            )


if __name__ == "__main__":
    unittest.main()
