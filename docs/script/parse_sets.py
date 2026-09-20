"""Parse a WOD item-set bonus HTML page into its persisted JSON payload."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from bs4 import BeautifulSoup

def parse_set_html(html: str) -> dict:
    soup = BeautifulSoup(html, 'html.parser')

    def normalized_heading(value) -> str:
        """Ignore whitespace introduced when heading text is split by inline tags."""
        text = value.get_text(' ', strip=True) if hasattr(value, 'get_text') else str(value)
        return re.sub(r'\s+', '', text)

    # 1. 套装名称
    h1 = soup.find('h1')
    if not h1:
        return {}
    full_name = h1.get_text(strip=True)
    set_name = re.sub(r'^套件\s*', '', full_name).strip()
    if not set_name:
        set_name = full_name

    # 2. 通用效果解析（修正版）
    def parse_effects(start_text, end_text=None):
        """
        从 start_text 所在的 h2 开始，到 end_text 所在的 h2 结束（不含该 h2）。
        若 end_text 为 None，则一直解析到文档末尾。
        返回效果条目列表，每个条目包含 '类型'（h3 文本）和表格各列键值对。
        """
        normalized_start = normalized_heading(start_text)
        normalized_end = normalized_heading(end_text) if end_text is not None else None
        start = next((h2 for h2 in soup.find_all('h2')
                      if normalized_start in normalized_heading(h2)), None)
        if start is None:
            return []

        effects = []
        current_type = None

        # 从 start_idx 的下一个兄弟开始遍历
        for sibling in start.find_next_siblings():
            # 遇到 h2 时判断是否为结束标志
            if sibling.name == 'h2':
                if normalized_end is not None and normalized_end in normalized_heading(sibling):
                    break          # 找到结束标记，停止
                else:
                    continue       # 不是结束标记，跳过该 h2，继续往后找

            if sibling.name == 'h3':
                current_type = sibling.get_text(strip=True)
            elif sibling.name == 'table' and current_type:
                rows = sibling.find_all('tr')
                if len(rows) < 2:
                    continue
                headers = [th.get_text(strip=True) for th in rows[0].find_all('th')]
                for row in rows[1:]:
                    cells = row.find_all('td')
                    if len(cells) != len(headers):
                        continue
                    entry = {'类型': current_type}
                    for idx, header in enumerate(headers):
                        val = cells[idx].get_text(separator=' ', strip=True)
                        if val == '\xa0' or val == '':
                            val = ''
                        entry[header] = val
                    effects.append(entry)
        return effects

    # 3. 分别解析两个区域
    holder_effects = parse_effects(
        '作用在人物',                          # 起始标记（部分匹配即可）
        '作用在被此影响的目标上的效果'         # 结束标记
    )
    target_effects = parse_effects(
        '作用在被此影响的目标上的效果',        # 起始标记
        None                                  # 无结束标记，直到文档末尾
    )

    # 4. 构建结果
    result = {
        "套装名称": set_name,
        "作用在装备者上的效果": holder_effects,
        "作用在被影响的目标上的效果": target_effects
    }
    return result

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('html', type=Path, help='套装效果 HTML 文件')
    args = parser.parse_args()
    data = parse_set_html(args.html.read_text(encoding='utf-8'))
    print(json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
