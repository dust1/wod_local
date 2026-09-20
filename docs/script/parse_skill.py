import json
import re
from bs4 import BeautifulSoup

def parse_skill_html(html):
    soup = BeautifulSoup(html, 'html.parser')

    # 1. 技能名称
    h1 = soup.find('h1')
    if not h1:
        return {}
    skill_name = h1.get_text(strip=True).replace('技能', '').strip()

    # 2. 定位属性表格：查找包含“类型”的 <th>，然后向上找到父级 <table>
    type_th = soup.find('th', string='类型')  # 精确匹配
    if not type_th:
        # 如果精确匹配失败，使用正则（防止有空格）
        type_th = soup.find('th', text=re.compile(r'类型'))
    if not type_th:
        # 如果还是找不到，尝试另一种方式：查找所有表格，检查是否包含“类型” th
        for table in soup.find_all('table'):
            if table.find('th', text=re.compile(r'类型')):
                attr_table = table
                break
        else:
            return {}
    else:
        attr_table = type_th.find_parent('table')
        if not attr_table:
            return {}

    # 把属性表的所有键值都保留下来。除了下面的通用字段，页面还可能
    # 包含“体力损失”等可选的技能属性，不能用固定字段白名单丢弃它们。
    detailed_attributes = {}
    for tr in attr_table.find_all('tr'):
        th = tr.find('th')
        td = tr.find('td')
        if not th or not td:
            continue
        label = th.get_text(separator=' ', strip=True)
        if not label:
            continue
        detailed_attributes[label] = td.get_text(separator=' ', strip=True)

    def get_attr_value(label):
        return detailed_attributes.get(label)

    # 3. 提取所有基本字段
    skill_type = get_attr_value('类型')
    can_be_used = get_attr_value('可以被用于')
    target = get_attr_value('目标')
    max_enemies = get_attr_value('可影响敌人的最大数量')
    max_allies = get_attr_value('可影响队友的最大数量')
    item = get_attr_value('物品')
    skill_category = get_attr_value('技能类型')

    # 4. 效果解析（与之前一致）
    def parse_effects(start_text, end_text=None):
        h2s = soup.find_all('h2')
        start_idx = None
        for i, h2 in enumerate(h2s):
            if start_text in h2.get_text():
                start_idx = i
                break
        if start_idx is None:
            return []

        effects = []
        current_type = None
        for sibling in h2s[start_idx].find_next_siblings():
            if sibling.name == 'h2':
                if end_text and end_text in sibling.get_text():
                    break
                else:
                    break
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

    holder_effects = parse_effects('作用在技能拥有者上的效果', '作用在被此技能影响的目标上的效果')
    target_effects = parse_effects('作用在被此技能影响的目标上的效果', None)

    # 5. 构建最终 JSON
    result = {
        "技能名称": skill_name,
        "类型": skill_type if skill_type else "",
        "可以被用于": can_be_used if can_be_used else "",
        "目标": target if target else "",
        "可影响队友的最大数量": max_allies if max_allies else "",
        "可影响敌人的最大数量": max_enemies if max_enemies else "",
        "物品": item if item else "",
        "技能类型": skill_category if skill_category else "",
        "详细属性": detailed_attributes,
        "作用在技能拥有者上的效果": holder_effects,
        "作用在被此技能影响的目标上的效果": target_effects
    }
    return result


if __name__ == '__main__':
    with open('./tests/test_skill.html', 'r', encoding='utf-8') as f:
        html_content = f.read()
    data = parse_skill_html(html_content)
    print(json.dumps(data, ensure_ascii=False, indent=2))
