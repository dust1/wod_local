"""Fetch every set page listed in docs/set_list.txt into docs/sets/<set name>/<count>.html.

复现的 curl 请求（原命令为 `curl --location --request POST ...`，无请求体，参数全部在 query string 上）：

    curl --location --request POST \
      'https://delta.world-of-dungeons.org/wod/spiel/hero/set.php?name=<套装名>&simulate_item_count=<件数>&is_popup=1' \
      --header 'cookie: PHPSESSID=1w30efdkfv3fjz2ufcdasi12qb60o8d5;; world=CD'

流程：
  1. 逐行读取 set_list.txt，跳过空行与纯空白行，只取每行的文本内容；
  2. 对每个套装名，以 simulate_item_count = 1..10 各请求一次；
  3. 在 docs/sets/<套装名>/ 下写入 <件数>.html，内容为响应体的完整 HTML。

只依赖标准库，无需额外安装 requests。
"""

from __future__ import annotations

import argparse
import http.client
import json
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

HOST = "delta.world-of-dungeons.org"
REQUEST_PATH = "/wod/spiel/hero/set.php"
DEFAULT_COOKIE = "PHPSESSID=1w30efdkfv3fjz2ufcdasi12qb60o8d5;; world=CD"
PIECE_COUNTS = tuple(range(1, 11))

# 页面里 set_id 有数字才说明服务端真的识别出了这套装备；名称对不上时该值为空串。
SET_ID_PATTERN = re.compile(rb'name="set_id"\s+value="(\d+)"')

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--list", type=Path, default=ROOT / "docs" / "set_list.txt", help="套装名称清单")
    parser.add_argument("--output", type=Path, default=ROOT / "docs" / "sets", help="HTML 输出根目录")
    parser.add_argument("--cookie", default=DEFAULT_COOKIE, help="请求携带的 cookie 头")
    parser.add_argument("--timeout", type=float, default=30.0, help="单次请求超时（秒）")
    parser.add_argument("--retries", type=int, default=3, help="失败重试次数")
    parser.add_argument("--delay", type=float, default=0.2, help="每个请求之间的间隔（秒），减轻服务端压力")
    parser.add_argument("--workers", type=int, default=1, help="并发线程数，默认 1 为串行")
    parser.add_argument("--force", action="store_true", help="已存在的 html 也重新抓取（默认跳过，便于断点续跑）")
    parser.add_argument("--quiet", action="store_true", help="只输出最终汇总")
    return parser.parse_args()


def read_names(list_path: Path, dedupe: bool = True) -> tuple[list[str], int]:
    """按行读取名称，跳过空行/纯空白行，返回 (名称列表, 跳过的重复行数)。"""
    text = list_path.read_text(encoding="utf-8-sig")
    names: list[str] = []
    seen: set[str] = set()
    duplicates = 0
    for raw_line in text.splitlines():
        name = raw_line.strip()
        if not name:  # 空字符串或纯换行
            continue
        if dedupe:
            if name in seen:
                duplicates += 1
                continue
            seen.add(name)
        names.append(name)
    return names, duplicates


class SetPageFetcher:
    """带 keep-alive 与重试的请求器；每个线程持有自己的连接。"""

    def __init__(self, cookie: str, timeout: float, retries: int, delay: float) -> None:
        self.cookie = cookie
        self.timeout = timeout
        self.retries = max(1, retries)
        self.delay = max(0.0, delay)
        self._local = threading.local()

    def _connection(self) -> http.client.HTTPSConnection:
        connection = getattr(self._local, "connection", None)
        if connection is None:
            connection = http.client.HTTPSConnection(HOST, timeout=self.timeout)
            self._local.connection = connection
        return connection

    def _drop_connection(self) -> None:
        connection = getattr(self._local, "connection", None)
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass
            self._local.connection = None

    def _headers(self) -> dict[str, str]:
        return {
            "cookie": self.cookie,
            "user-agent": USER_AGENT,
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
            "connection": "keep-alive",
        }

    def build_target(self, name: str, piece_count: int) -> str:
        query = urllib.parse.urlencode(
            {"name": name, "simulate_item_count": piece_count, "is_popup": 1},
            quote_via=urllib.parse.quote,
            encoding="utf-8",
        )
        return f"{REQUEST_PATH}?{query}"

    def fetch(self, name: str, piece_count: int) -> bytes:
        target = self.build_target(name, piece_count)
        last_error: Exception | None = None
        for attempt in range(1, self.retries + 1):
            try:
                if self.delay:
                    time.sleep(self.delay)
                connection = self._connection()
                # 复现 curl 的 `--request POST` + 无请求体
                connection.request("POST", target, body=b"", headers=self._headers())
                response = connection.getresponse()
                body = response.read()
                if response.status != 200:
                    raise RuntimeError(f"HTTP {response.status}")
                return body
            except Exception as error:  # noqa: BLE001 - 网络层异常统一重试
                last_error = error
                self._drop_connection()
                if attempt < self.retries:
                    time.sleep(min(2.0 * attempt, 5.0))
        raise RuntimeError(f"请求失败（已重试 {self.retries} 次）：{last_error}")


def write_page(path: Path, body: bytes) -> None:
    """先写临时文件再原子替换，避免中断留下半截 html。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(body)
    temporary.replace(path)


def fetch_set(fetcher: SetPageFetcher, name: str, output_root: Path, force: bool) -> dict:
    set_dir = output_root / name
    set_dir.mkdir(parents=True, exist_ok=True)
    written: list[int] = []
    skipped: list[int] = []
    errors: list[dict] = []
    unresolved = False

    for piece_count in PIECE_COUNTS:
        html_path = set_dir / f"{piece_count}.html"
        if html_path.exists() and html_path.stat().st_size > 0 and not force:
            skipped.append(piece_count)
            continue
        try:
            body = fetcher.fetch(name, piece_count)
            write_page(html_path, body)
            written.append(piece_count)
            if not SET_ID_PATTERN.search(body):
                unresolved = True
        except Exception as error:  # noqa: BLE001 - 汇总后统一上报
            errors.append({"file": str(html_path), "error": str(error)})

    return {
        "name": name,
        "written": written,
        "skipped": skipped,
        "errors": errors,
        "unresolved": unresolved,
    }


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = parse_args()

    names, duplicates = read_names(args.list)
    if not names:
        print(json.dumps({"error": f"{args.list} 中没有可用的套装名称"}, ensure_ascii=False))
        raise SystemExit(1)

    args.output.mkdir(parents=True, exist_ok=True)
    fetcher = SetPageFetcher(args.cookie, args.timeout, args.retries, args.delay)
    total = len(names)
    print(
        json.dumps(
            {
                "list": str(args.list),
                "输出目录": str(args.output),
                "套装数": total,
                "跳过重复行": duplicates,
                "每套件数": list(PIECE_COUNTS),
                "并发": args.workers,
                "覆盖已有": args.force,
            },
            ensure_ascii=False,
        )
    )

    results: list[dict] = []
    lock = threading.Lock()

    def run(index_and_name: tuple[int, str]) -> dict:
        index, name = index_and_name
        result = fetch_set(fetcher, name, args.output, args.force)
        with lock:
            results.append(result)
            if not args.quiet:
                status = "ok" if not result["errors"] else f"错误 {len(result['errors'])}"
                note = "（页面未识别该套装名）" if result["unresolved"] else ""
                print(
                    f"[{index}/{total}] {name}  写入 {len(result['written'])} 新建 / "
                    f"{len(result['skipped'])} 已存在  {status}{note}",
                    flush=True,
                )
        return result

    tasks = list(enumerate(names, start=1))
    if args.workers > 1:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            list(pool.map(run, tasks))
    else:
        for task in tasks:
            run(task)

    order = {name: index for index, name in tasks}
    results.sort(key=lambda item: order[item["name"]])

    failures = [error for result in results for error in result["errors"]]
    unresolved = [result["name"] for result in results if result["unresolved"]]
    written_files = sum(len(result["written"]) for result in results)
    skipped_files = sum(len(result["skipped"]) for result in results)
    complete = [
        result["name"]
        for result in results
        if not result["errors"] and len(result["written"]) + len(result["skipped"]) == len(PIECE_COUNTS)
    ]

    print(
        json.dumps(
            {
                "套装数": total,
                "写入文件": written_files,
                "跳过文件": skipped_files,
                "完整套装": len(complete),
                "未识别名称": unresolved,
                "失败数": len(failures),
                "failures": failures,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
