import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PARSER_PATH = ROOT / "docs" / "script" / "parse_skill.py"
SPEC = importlib.util.spec_from_file_location("wod_parse_skill_test", PARSER_PATH)
PARSER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PARSER)


def skill_html(extra_rows=""):
    return f"""
    <html><body>
      <h1>技能 自然发芽</h1>
      <table>
        <tr><th>类型</th><td>先攻权</td></tr>
        <tr><th>可以被用于</th><td>调整出手速度</td></tr>
        <tr><th>目标</th><td>自身</td></tr>
        {extra_rows}
        <tr><th>物品</th><td>-</td></tr>
        <tr><th>技能类型</th><td>-</td></tr>
      </table>
    </body></html>
    """


class ParseSkillHtmlTests(unittest.TestCase):
    def test_preserves_optional_health_loss_in_detailed_attributes(self):
        parsed = PARSER.parse_skill_html(
            skill_html("<tr><th> 体力损失 </th><td> -3800 </td></tr>")
        )

        self.assertEqual(parsed["详细属性"]["体力损失"], "-3800")
        self.assertEqual(parsed["详细属性"]["类型"], "先攻权")

    def test_omits_health_loss_when_page_does_not_contain_it(self):
        parsed = PARSER.parse_skill_html(skill_html())

        self.assertNotIn("体力损失", parsed["详细属性"])


if __name__ == "__main__":
    unittest.main()
