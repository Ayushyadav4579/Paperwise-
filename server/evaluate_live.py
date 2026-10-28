"""Run a small, transparent grading regression benchmark against a live Paperwise API.

This is a smoke/regression set, not a teacher-certified accuracy benchmark. Review and
replace the expected scores with teacher-approved values before using results as evidence.
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

import httpx

CASES = [
    {
        "id": 1, "prompt": "State Ohm's law.", "answer": "At constant temperature, current is directly proportional to potential difference; V = IR.",
        "marks": 2, "criteria": "1 mark for current directly proportional to potential difference; 1 mark for constant physical conditions or V=IR.",
        "expected_min": 2, "expected_max": 2, "label": "complete"
    },
    {
        "id": 2, "prompt": "State Ohm's law.", "answer": "Current flows through a wire.",
        "marks": 2, "criteria": "1 mark for current directly proportional to potential difference; 1 mark for constant physical conditions or V=IR.",
        "expected_min": 0, "expected_max": 0.5, "label": "irrelevant"
    },
    {
        "id": 3, "prompt": "Why do plants need sunlight?", "answer": "Sunlight provides energy for photosynthesis, allowing plants to make food.",
        "marks": 2, "criteria": "1 mark for energy/light; 1 mark for photosynthesis or food production.",
        "expected_min": 2, "expected_max": 2, "label": "complete"
    },
    {
        "id": 4, "prompt": "Why do plants need sunlight?", "answer": "Sunlight makes plants warm.",
        "marks": 2, "criteria": "1 mark for energy/light; 1 mark for photosynthesis or food production.",
        "expected_min": 0, "expected_max": 0.5, "label": "misconception"
    },
    {
        "id": 5, "prompt": "What is photosynthesis?", "answer": "Plants use light energy to make glucose from carbon dioxide and water; oxygen is released.",
        "marks": 3, "criteria": "Credit glucose/food formation, light energy, carbon dioxide and water inputs, and oxygen release; max 3.",
        "expected_min": 3, "expected_max": 3, "label": "complete"
    },
    {
        "id": 6, "prompt": "What is photosynthesis?", "answer": "It is a process in plants.",
        "marks": 3, "criteria": "Credit glucose/food formation, light energy, carbon dioxide and water inputs, and oxygen release; max 3.",
        "expected_min": 0, "expected_max": 0.5, "label": "insufficient"
    },
    {
        "id": 7, "prompt": "Define a renewable resource.", "answer": "A resource that is naturally replenished on a human timescale, such as sunlight or wind.",
        "marks": 2, "criteria": "1 mark for naturally replenished; 1 mark for suitable example or clear human-timescale meaning.",
        "expected_min": 2, "expected_max": 2, "label": "complete"
    },
    {
        "id": 8, "prompt": "Define a renewable resource.", "answer": "Coal, because it can be burned to produce electricity.",
        "marks": 2, "criteria": "1 mark for naturally replenished; 1 mark for suitable example or clear human-timescale meaning.",
        "expected_min": 0, "expected_max": 0, "label": "incorrect"
    },
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8000", help="Paperwise API base URL")
    parser.add_argument("--output", default="paperwise-evaluation-report.json")
    args = parser.parse_args()
    base = args.url.rstrip("/")

    with httpx.Client(timeout=600) as client:
        health = client.get(base + "/health")
        health.raise_for_status()
        print("API health:", json.dumps(health.json(), ensure_ascii=False))
        payload = {
            "board": "CBSE",
            "grade": "10",
            "questions": [
                {k: c[k] for k in ("id", "prompt", "answer", "marks", "criteria")}
                for c in CASES
            ],
        }
        response = client.post(base + "/api/grade", json=payload)
        response.raise_for_status()
        body = response.json()

    by_id = {int(r["id"]): r for r in body.get("results", [])}
    if set(by_id) != {c["id"] for c in CASES}:
        raise RuntimeError("API response IDs do not match benchmark case IDs")

    report = []
    errors = []
    for case in CASES:
        result = by_id[case["id"]]
        score = float(result["score"])
        max_marks = float(result["max"])
        lo, hi = float(case["expected_min"]), float(case["expected_max"])
        passed = lo <= score <= hi and 0 <= score <= max_marks
        errors.append(min(abs(score - lo), abs(score - hi)) if score < lo or score > hi else 0.0)
        report.append({
            "id": case["id"], "label": case["label"], "score": score,
            "max": max_marks, "expected_range": [lo, hi], "passed_range": passed,
            "rationale": result.get("rationale", "")
        })

    summary = {
        "model": body.get("model", health.json().get("model", "unknown")),
        "cases": len(report),
        "passed_expected_ranges": sum(1 for row in report if row["passed_range"]),
        "mean_range_error": round(statistics.mean(errors), 3),
        "results": report,
        "warning": "Small regression smoke test only; not a teacher-certified accuracy claim."
    }
    Path(args.output).write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    print(f"Saved report: {args.output}")
    return 0 if summary["passed_expected_ranges"] == len(CASES) else 2


if __name__ == "__main__":
    raise SystemExit(main())
