import json
import re
from bs4 import BeautifulSoup

def parse_item_html(html):
    soup = BeautifulSoup(html, 'html.parser')

    # 1. 物品名称
    h1 = soup.find('h1')
    if not h1:
        return {}
    a_tag = h1.find('a', class_='item_usable')
    if not a_tag:
        return {}
    item_name = a_tag.get_text(strip=True)

    # 2. 详细信息表格
    details_div = soup.find('div', id='details')
    if not details_div:
        return {"物品名称": item_name}
    details_table = details_div.find('table', class_='content_table')
    if not details_table:
        return {"物品名称": item_name}

    def get_detail_value(key, split_by_br=False, get_links=False):
        for tr in details_table.find_all('tr'):
            tds = tr.find_all('td')
            if len(tds) >= 2 and key in tds[0].get_text(strip=True):
                td = tds[1]
                if get_links:
                    return [a.get_text(strip=True) for a in td.find_all('a')]
                if split_by_br:
                    parts = []
                    current_part = []
                    for content in td.contents:
                        if content.name == 'br':
                            if current_part:
                                parts.append(''.join(current_part).strip())
                                current_part = []
                        else:
                            if hasattr(content, 'get_text'):
                                current_part.append(content.get_text(strip=False))
                            else:
                                current_part.append(str(content).strip())
                    if current_part:
                        parts.append(''.join(current_part).strip())
                    return [p for p in parts if p]
                else:
                    return td.get_text(separator='\n', strip=True)
        return None

    # ---- 套装 ----
    set_value = None
    for tr in details_table.find_all('tr'):
        tds = tr.find_all('td')
        if len(tds) >= 2 and '套装' in tds[0].get_text(strip=True):
            a = tds[1].find('a')
            set_value = a.get_text(strip=True) if a else tds[1].get_text(strip=True)
            break

    # ---- 职业限制 ----
    profession = None
    for tr in details_table.find_all('tr'):
        tds = tr.find_all('td')
        if len(tds) >= 2 and '职业限制' in tds[0].get_text(strip=True):
            lis = tds[1].find_all('li')
            profession = [li.get_text(strip=True) for li in lis] if lis else tds[1].get_text(strip=True)
            break

    # ---- 其他简单字段 ----
    race = get_detail_value('种族限定')
    require = get_detail_value('装备要求', split_by_br=True)

    # 需配合何物使用：按 <br> 分割，清洗掉 (1x) 等后缀
    with_what_raw = get_detail_value('需配合何物使用', split_by_br=True)
    if with_what_raw and isinstance(with_what_raw, list):
        with_what = [re.sub(r'\s*\(\d+x?\)\s*$', '', item).strip() for item in with_what_raw if item.strip()]
    else:
        with_what = []

    slot = get_detail_value('装备位置')

    # ---- 物品类别及限制（精确提取 <span> 标记的限制条件） ----
    categories = []          # 所有类别名称
    category_limits = []     # 仅包含有限制的类别及限制条件

    for tr in details_table.find_all('tr'):
        tds = tr.find_all('td')
        if len(tds) >= 2 and '物品类别' in tds[0].get_text(strip=True):
            td = tds[1]
            # 按 <br> 分割内容
            parts = []
            current = []
            for content in td.contents:
                if content.name == 'br':
                    if current:
                        parts.append(current)
                        current = []
                else:
                    current.append(content)
            if current:
                parts.append(current)

            for part in parts:
                # 寻找 <a> 标签（类别名称）
                a_tag = None
                for elem in part:
                    if elem.name == 'a':
                        a_tag = elem
                        break
                if not a_tag:
                    continue

                category_name = a_tag.get_text(strip=True)
                categories.append(category_name)

                # 检查该片段中是否有 <span> 标签包含限制条件
                limit = ''
                for elem in part:
                    if elem.name == 'span':
                        span_text = elem.get_text(strip=True)
                        # 检查关键词
                        if '只能装备' in span_text or '最多' in span_text or '至多' in span_text or '不超过' in span_text:
                            # 提取括号内的内容（去除括号）
                            match = re.search(r'\(([^)]*)\)', span_text)
                            if match:
                                limit = match.group(1).strip()
                            else:
                                # 如果没有括号，直接使用整个文本（但通常有括号）
                                limit = span_text.strip()
                            break
                # 只有有限制时才加入 category_limits
                if limit:
                    category_limits.append({
                        "物品类别": category_name,
                        "限制条件": limit
                    })
            break  # 找到后跳出循环

    # ---- 效果解析 ----
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
                        if header == '评注' and val == '\xa0':
                            val = ''
                        entry[header] = val
                    effects.append(entry)
        return effects

    holder_effects = parse_effects('作用在物品持有者上的效果', '作用在被此物品影响的目标上的效果')
    target_effects = parse_effects('作用在被此物品影响的目标上的效果', None)

    # ---- 构建最终 JSON ----
    result = {
        "物品名称": item_name,
        "所属套装": set_value,
        "职业限制": profession if profession else "",
        "种族限定": race if race else "",
        "装备要求": require if require else [],
        "需配合何物使用": with_what,
        "装备位置": slot if slot else "",
        "物品类别": categories,
        "物品类别限制": category_limits,
        "作用在物品持有者上的效果": holder_effects,
        "作用在被此物品影响的目标上的效果": target_effects
    }
    return result


if __name__ == '__main__':
    with open('./tests/test_item.html', 'r', encoding='utf-8') as f:
        html_content = f.read()
    data = parse_item_html(html_content)
    print(json.dumps(data, ensure_ascii=False, indent=2))