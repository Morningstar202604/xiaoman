"""Agnes AI 压力测试脚本（用户授权试用）
- 阶段1：单发质量/延迟（3 个模型 × 3 个理财场景问题）
- 阶段2：并发压力（10 并发 × 5 轮 = 50 请求，测吞吐/错误率/限流）
- 阶段3：连续稳定性（30 个串行请求）
"""

import json
import os
import statistics
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import httpx

BASE = "https://apihub.agnes-ai.com/v1"
KEY = os.environ.get("AGNES_API_KEY", "").strip()
if not KEY:
    raise SystemExit("请先设置环境变量 AGNES_API_KEY（勿把 Key 写进代码）")
HEADERS = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

QUESTIONS = [
    "我的组合现在赚还是亏？帮我看看持仓风险（简要回答，100字内）",
    "这个月钱都花到哪了？怎么分析支出？（简要回答，100字内）",
    "紧急备用金应该留多少？为什么？（简要回答，100字内）",
]


def once(model: str, question: str, timeout: float = 60.0):
    t0 = time.perf_counter()
    try:
        r = httpx.post(
            f"{BASE}/chat/completions",
            headers=HEADERS,
            json={
                "model": model,
                "messages": [
                    {
                        "role": "system",
                        "content": "你是小满的财务助手，用中文简洁回答，基于事实不夸大。",
                    },
                    {"role": "user", "content": question},
                ],
                "max_tokens": 300,
                "temperature": 0.3,
            },
            timeout=timeout,
        )
        dt = time.perf_counter() - t0
        if r.status_code != 200:
            return {
                "model": model,
                "ok": False,
                "status": r.status_code,
                "sec": round(dt, 2),
                "err": r.text[:200],
                "content": "",
            }
        data = r.json()
        content = data["choices"][0]["message"].get("content") or ""
        usage = data.get("usage", {})
        return {
            "model": model,
            "ok": True,
            "status": 200,
            "sec": round(dt, 2),
            "chars": len(content),
            "content": content[:120],
            "prompt_tokens": usage.get("prompt_tokens"),
            "completion_tokens": usage.get("completion_tokens"),
        }
    except Exception as e:
        return {
            "model": model,
            "ok": False,
            "status": -1,
            "sec": round(time.perf_counter() - t0, 2),
            "err": str(e)[:200],
        }


def main():
    print("=" * 60)
    print("阶段1：单发质量/延迟")
    print("=" * 60)
    models = ["agnes-3.0-flash", "agnes-2.5-flash"]
    single = []
    for m in models:
        for q in QUESTIONS:
            res = once(m, q)
            single.append(res)
            tag = "OK " if res["ok"] else "ERR"
            print(
                f"[{tag}] {m} {res['sec']}s  tok:{res.get('completion_tokens', '-')}  {res['content'][:80]!r}"
            )
    ok_single = [s for s in single if s["ok"]]
    if ok_single:
        lat = [s["sec"] for s in ok_single]
        print(
            f"单发：成功 {len(ok_single)}/{len(single)}，平均 {statistics.mean(lat):.2f}s，P95 {sorted(lat)[int(len(lat) * 0.95) - 1]:.2f}s"
        )

    print()
    print("=" * 60)
    print("阶段2：并发压力（10 并发 × 5 轮 = 50 请求，模型 agnes-2.5-flash）")
    print("=" * 60)
    t0 = time.perf_counter()
    results = []
    with ThreadPoolExecutor(max_workers=10) as ex:
        futs = [
            ex.submit(once, "agnes-3.0-flash", QUESTIONS[i % len(QUESTIONS)])
            for i in range(50)
        ]
        for f in as_completed(futs):
            results.append(f.result())
    total = time.perf_counter() - t0
    ok = [r for r in results if r["ok"]]
    err = [r for r in results if not r["ok"]]
    lats = [r["sec"] for r in ok]
    print(
        f"总耗时 {total:.1f}s，成功 {len(ok)}/50，失败 {len(err)}，吞吐 {len(ok) / total:.1f} req/s"
    )
    if lats:
        print(
            f"延迟：平均 {statistics.mean(lats):.2f}s，P50 {statistics.median(lats):.2f}s，P95 {sorted(lats)[47]:.2f}s"
        )
    if err:
        from collections import Counter

        print("错误分布:", Counter(e["status"] for e in err))
        for e in err[:3]:
            print("  示例:", e["status"], e["err"][:150])

    print()
    print("=" * 60)
    print("阶段3：连续稳定性（30 个串行，模型 agnes-3.0-flash）")
    print("=" * 60)
    seq = []
    for i in range(30):
        res = once("agnes-3.0-flash", QUESTIONS[i % len(QUESTIONS)])
        seq.append(res)
        if i % 6 == 0:
            tag = "OK " if res["ok"] else "ERR"
            print(f"  [{i + 1:2d}] {tag} {res['sec']}s")
    ok_seq = [s for s in seq if s["ok"]]
    print(f"串行：成功 {len(ok_seq)}/30")
    if ok_seq:
        lat = [s["sec"] for s in ok_seq]
        print(f"延迟：平均 {statistics.mean(lat):.2f}s，最大 {max(lat):.2f}s")

    print()
    print("=" * 60)
    print("结论摘要")
    print("=" * 60)
    all_ok = ok_single + ok + ok_seq
    print(
        f"总请求 {len(single) + 50 + 30}，总成功 {len(all_ok)}，成功率 {len(all_ok) / (len(single) + 50 + 30) * 100:.1f}%"
    )
    if lats and ok_seq:
        print(
            f"典型延迟：单发均值 {statistics.mean([s['sec'] for s in ok_single]):.2f}s / 并发 P95 {sorted(lats)[47]:.2f}s / 串行均值 {statistics.mean([s['sec'] for s in ok_seq]):.2f}s"
        )


if __name__ == "__main__":
    main()
