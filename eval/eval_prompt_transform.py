"""Offline eval harness for the 白話中文 → FLUX English prompt transform.

Runs each case through the real production path (app.prompt_transform), then has an
LLM judge score the result on three axes (1-5). Prints a summary table and writes a
markdown report. Hits the real Gemini API, so it is NOT a pytest test — run manually:

    python eval/eval_prompt_transform.py
    python eval/eval_prompt_transform.py --limit 5        # quick subset
    python eval/eval_prompt_transform.py --out eval/report-after.md

Requires GEMINI_API_KEY in .env (same key the app uses).
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime
from pathlib import Path

import httpx

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _load_env() -> None:
    env_path = PROJECT_ROOT / ".env"
    if not env_path.exists():
        return
    import os

    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


_load_env()

import sys  # noqa: E402

sys.path.insert(0, str(PROJECT_ROOT))

from app.prompt_transform import transform_plain_prompt  # noqa: E402
from app.settings import get_settings  # noqa: E402

AXES = ("faithfulness", "flux_format", "fluency")
FLAG_THRESHOLD = 4  # any axis strictly below this is flagged for review
PACING_SECONDS = 1.0  # gentle spacing to avoid free-tier 429s

# Independent judge via the local Codex proxy (different model family from the
# Gemini generator, so it does not self-grade). Falls back to Gemini with --judge.
import os  # noqa: E402

CODEX_BASE_URL = os.getenv("CODEX_PROXY_BASE", "http://127.0.0.1:8317/v1")
CODEX_API_KEY = os.getenv("CODEX_API_KEY", "").strip()
CODEX_MODEL = os.getenv("CODEX_JUDGE_MODEL", "gpt-5.4-mini")

JUDGE_SYSTEM_INSTRUCTION = (
    "You are a strict evaluator of an image-prompt translator. You are given a user's "
    "original casual description (usually Traditional Chinese) and the English FLUX.1 "
    "prompt produced from it. Score three axes from 1 (poor) to 5 (excellent):\n"
    "- faithfulness: every concrete detail the user gave (subject, count, colour, "
    "object, place, time, negation) is preserved with no contradictions or dropped "
    "elements; invented detail that does not conflict is fine.\n"
    "- flux_format: a flowing natural-language description (ideal for FLUX's T5 "
    "encoder), NOT a comma-separated tag dump, and it names a concrete visual medium "
    "or style.\n"
    "- fluency: natural, idiomatic, fully-English prose with no leftover non-English "
    "words or JSON/markdown artefacts.\n"
    "Be critical; reserve 5 for genuinely excellent results. Reply with ONLY a JSON "
    'object: {"faithfulness": int, "flux_format": int, "fluency": int, "issues": '
    '"one short sentence on the biggest problem, or empty if none"}.'
)

JUDGE_SCHEMA = {
    "type": "object",
    "properties": {
        "faithfulness": {"type": "integer"},
        "flux_format": {"type": "integer"},
        "fluency": {"type": "integer"},
        "issues": {"type": "string"},
    },
    "required": ["faithfulness", "flux_format", "fluency", "issues"],
}


def judge(source: str, prompt: str, backend: str) -> dict:
    if backend == "gemini":
        return _judge_gemini(source, prompt)
    return _judge_codex(source, prompt)


def _judge_user_text(source: str, prompt: str) -> str:
    return f"Original description:\n{source}\n\nGenerated English prompt:\n{prompt}"


def _parse_judge_json(text: str) -> dict:
    cleaned = text.strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start != -1 and end > start:
        cleaned = cleaned[start : end + 1]
    return json.loads(cleaned)


def _judge_codex(source: str, prompt: str) -> dict:
    if not CODEX_API_KEY:
        raise SystemExit("缺少 CODEX_API_KEY，請以環境變數提供 judge API key")
    payload = {
        "model": CODEX_MODEL,
        "messages": [
            {"role": "system", "content": JUDGE_SYSTEM_INSTRUCTION},
            {"role": "user", "content": _judge_user_text(source, prompt)},
        ],
        "reasoning_effort": "low",
    }
    with httpx.Client(timeout=60.0) as client:
        response = client.post(
            f"{CODEX_BASE_URL.rstrip('/')}/chat/completions",
            headers={
                "Authorization": f"Bearer {CODEX_API_KEY}",
                "Content-Type": "application/json",
            },
            json=payload,
        )
    response.raise_for_status()
    content = response.json()["choices"][0]["message"]["content"]
    return _parse_judge_json(content)


def _judge_gemini(source: str, prompt: str) -> dict:
    settings = get_settings()
    api_key = settings.gemini_api_key.strip()
    if not api_key:
        raise SystemExit("GEMINI_API_KEY missing — add it to .env before running the eval.")

    url = (
        f"{settings.gemini_base_url.rstrip('/')}"
        f"/models/{settings.gemini_prompt_model}:generateContent"
    )
    payload = {
        "system_instruction": {"parts": [{"text": JUDGE_SYSTEM_INSTRUCTION}]},
        "contents": [{"role": "user", "parts": [{"text": _judge_user_text(source, prompt)}]}],
        "generationConfig": {
            "temperature": 0.0,
            "maxOutputTokens": 300,
            "responseMimeType": "application/json",
            "responseSchema": JUDGE_SCHEMA,
        },
    }
    with httpx.Client(timeout=settings.prompt_llm_timeout_seconds) as client:
        response = client.post(
            url,
            headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
            json=payload,
        )
    response.raise_for_status()
    data = response.json()
    text = "".join(
        part.get("text", "")
        for part in (data["candidates"][0].get("content") or {}).get("parts", [])
    )
    return json.loads(text)


def missing_keywords(prompt: str, must_keep: list[str]) -> list[str]:
    lower = prompt.lower()
    return [kw for kw in must_keep if kw.lower() not in lower]


def run(cases: list[dict], out_path: Path, backend: str) -> None:
    rows = []
    print(f"Judge backend: {backend}\n")
    for index, case in enumerate(cases, start=1):
        source = case["source"]
        style = case.get("style", "auto")
        result = transform_plain_prompt(source, style)
        time.sleep(PACING_SECONDS)

        try:
            scores = judge(source, result.prompt, backend)
        except Exception as exc:  # noqa: BLE001 - eval should not crash on one bad call
            scores = {axis: None for axis in AXES}
            scores["issues"] = f"judge failed: {exc}"
        time.sleep(PACING_SECONDS)

        missing = missing_keywords(result.prompt, case.get("must_keep", []))
        rows.append(
            {
                "id": case["id"],
                "source": source,
                "style": style,
                "provider": result.provider,
                "prompt": result.prompt,
                "scores": scores,
                "missing_keywords": missing,
            }
        )
        avg = _row_avg(scores)
        flag = "  <-- REVIEW" if _is_flagged(scores, missing) else ""
        print(
            f"[{index:>2}/{len(cases)}] {case['id']:<14} "
            f"{result.provider:<10} avg={avg}  "
            f"F={scores.get('faithfulness')} X={scores.get('flux_format')} "
            f"E={scores.get('fluency')}{flag}"
        )

    _print_summary(rows)
    _write_report(rows, out_path)
    print(f"\nReport written to {out_path}")


def _row_avg(scores: dict):
    values = [scores.get(axis) for axis in AXES]
    if any(v is None for v in values):
        return "n/a"
    return round(sum(values) / len(values), 2)


def _is_flagged(scores: dict, missing: list[str]) -> bool:
    values = [scores.get(axis) for axis in AXES]
    if any(v is None or v < FLAG_THRESHOLD for v in values):
        return True
    # Missing keywords are a secondary, synonym-blind signal: only escalate when the
    # judge's faithfulness score is not already top-marks.
    faithfulness = scores.get("faithfulness")
    return bool(missing) and (faithfulness is None or faithfulness < 5)


def _print_summary(rows: list[dict]) -> None:
    print("\n=== Summary ===")
    for axis in AXES:
        values = [r["scores"].get(axis) for r in rows if isinstance(r["scores"].get(axis), int)]
        mean = round(sum(values) / len(values), 2) if values else "n/a"
        print(f"  mean {axis:<13}: {mean}  (n={len(values)})")

    providers = {}
    for r in rows:
        providers[r["provider"]] = providers.get(r["provider"], 0) + 1
    print(f"  providers       : {providers}")

    flagged = [r for r in rows if _is_flagged(r["scores"], r["missing_keywords"])]
    print(f"  flagged for review: {len(flagged)}/{len(rows)}")
    for r in flagged:
        reason = r["scores"].get("issues") or ""
        if r["missing_keywords"]:
            reason = f"missing {r['missing_keywords']}; " + reason
        print(f"    - {r['id']}: {reason}")


def _write_report(rows: list[dict], out_path: Path) -> None:
    lines = [
        f"# Prompt-transform eval — {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        "",
        "| id | provider | faith | flux | fluency | missing | issues |",
        "|----|----------|:----:|:----:|:------:|---------|--------|",
    ]
    for r in rows:
        s = r["scores"]
        missing = ", ".join(r["missing_keywords"]) or "—"
        issues = (s.get("issues") or "").replace("|", "/")
        lines.append(
            f"| {r['id']} | {r['provider']} | {s.get('faithfulness')} | "
            f"{s.get('flux_format')} | {s.get('fluency')} | {missing} | {issues} |"
        )
    lines += ["", "## Generated prompts", ""]
    for r in rows:
        lines.append(f"- **{r['id']}** ({r['style']}) — `{r['source']}`")
        lines.append(f"  - {r['prompt']}")
    out_path.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=0, help="only run the first N cases")
    parser.add_argument(
        "--out", default=str(PROJECT_ROOT / "eval" / "report.md"), help="report output path"
    )
    parser.add_argument(
        "--cases", default=str(PROJECT_ROOT / "eval" / "cases.json"), help="cases JSON path"
    )
    parser.add_argument(
        "--judge",
        choices=["codex", "gemini"],
        default="codex",
        help="judge backend (codex = independent local proxy; gemini = self-grading)",
    )
    args = parser.parse_args()

    cases = json.loads(Path(args.cases).read_text(encoding="utf-8"))
    if args.limit:
        cases = cases[: args.limit]

    run(cases, Path(args.out), args.judge)


if __name__ == "__main__":
    main()
