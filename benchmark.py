#!/usr/bin/env python3
"""
Comprehensive Benchmark Suite for bielik-m-poc multi-agent math solver.

This benchmark measures:
  1. RAG retrieval quality (precision, recall, MRR for math categories)
  2. Answer-checking accuracy (validator correctness on known answer pairs)
  3. End-to-end pipeline accuracy (requires Bielik server running)
  4. Per-category and per-year breakdown
  5. Pipeline latency profiling

Usage:
  python3 benchmark.py                          # Full benchmark (RAG + validator + E2E if server up)
  python3 benchmark.py --component rag          # Only RAG retrieval benchmark
  python3 benchmark.py --component validator    # Only answer-checker benchmark
  python3 benchmark.py --component e2e          # Only end-to-end (needs Bielik)
  python3 benchmark.py --component e2e --year 2024 --all   # Full E2E on 2024
  python3 benchmark.py --component e2e --year all --sample 3  # 3 per year
  python3 benchmark.py --output results.json    # Save detailed results to JSON

Benchmark ID format: bench_YYYYMMDD_HHMMSS (for tracking improvements over time)
"""

import json
import os
import sys
import time
import re
import random
import argparse
import subprocess
from datetime import datetime
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError
from collections import defaultdict
from dataclasses import dataclass, field, asdict
from typing import Optional

# ── Paths ──────────────────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).parent
DATASETS_DIR = PROJECT_ROOT / "datasets"
PROMPTS_FILE = PROJECT_ROOT / "prompts.json"
RESULTS_DIR = PROJECT_ROOT / "benchmark_results"
RAG_URL = "http://127.0.0.1:3003"
MLX_URL_DEFAULT = "http://localhost:8011"


# ── Data Classes ───────────────────────────────────────────────────────

@dataclass
class BenchmarkMeta:
    benchmark_id: str
    timestamp: str
    components_run: list
    system_info: dict = field(default_factory=dict)


@dataclass
class RAGResult:
    query: str
    expected_category: str
    top_k_sources: list
    top_k_categories: list
    top_k_scores: list
    hit_at_1: bool
    hit_at_3: bool
    hit_at_5: bool
    mrr: float  # Mean Reciprocal Rank


@dataclass
class ValidatorResult:
    question_id: str
    expected_answer: str
    tested_answer: str
    should_match: bool
    did_match: bool
    correct_validation: bool  # did validator agree with should_match


@dataclass
class E2EResult:
    year: int
    task: int
    points: int
    problem_type: str  # MC or OPEN
    category: str
    correct: bool
    answer_expected: str
    answer_got: Optional[str]
    has_code: bool
    code_valid: bool
    code_executed: bool
    analytical_ok: bool
    time_analytical: float
    time_executor: float
    time_sympy: float
    time_total: float
    errors: list
    rag_used: bool
    rag_top_source: Optional[str]


# ── Category Detection ─────────────────────────────────────────────────

def detect_category(text: str) -> str:
    """Detect math category from question text (delegates to data_loader's improved v2 categorizer)."""
    try:
        sys.path.insert(0, str(PROJECT_ROOT / "rag_service"))
        from data_loader import _infer_category
        return _infer_category(text)
    except ImportError:
        # Fallback
        t = text.lower()
        for cat, keywords in {
            "trygonometria": ["sin", "cos", "tg", "trygonometr"],
            "równania": ["równani", "nierównoś"],
            "funkcje": ["funkcj", "wykres", "dziedzin"],
            "ciągi": ["ciąg", "arytmetycz", "geometrycz"],
        }.items():
            for kw in keywords:
                if kw in t:
                    return cat
        return "inne"


# ── Helper: clean LaTeX ────────────────────────────────────────────────

def clean_latex(text: str) -> str:
    t = text
    t = re.sub(r'\$\$?', '', t)
    t = re.sub(r'\\boxed\{([^}]*)\}', r'\1', t)
    t = re.sub(r'\\d?frac\{([^}]*)\}\{([^}]*)\}', r'(\1)/(\2)', t)
    t = re.sub(r'\\sqrt\[(\d+)\]\{([^}]*)\}', r'(\2)**(1/\1)', t)
    t = re.sub(r'\\sqrt\{([^}]*)\}', r'sqrt(\1)', t)
    t = re.sub(r'\\(left|right|cdot|times|text|mathrm|quad|,|\\)', ' ', t)
    t = re.sub(r'\\infty', 'inf', t)
    t = re.sub(r'\\leq', '<=', t)
    t = re.sub(r'\\geq', '>=', t)
    t = re.sub(r'\\[a-zA-Z]+', '', t)
    t = re.sub(r'[{}]', '', t)
    t = re.sub(r'\s+', ' ', t).strip()
    return t


# ═══════════════════════════════════════════════════════════════════════
# COMPONENT 1: RAG RETRIEVAL BENCHMARK
# ═══════════════════════════════════════════════════════════════════════

def build_rag_test_queries():
    """Build test queries with expected categories from real dataset problems."""
    queries = []

    # Manually curated queries with known expected categories
    curated = [
        ("Oblicz wartość logarytmu log_3(81)", "logarytmy"),
        ("Rozwiąż równanie kwadratowe x^2 - 5x + 6 = 0", "równania"),
        ("Oblicz pole trójkąta o bokach 3, 4, 5", "geometria_płaska"),
        ("Wyznacz pochodną funkcji f(x) = x^3 + 2x", "rachunek_różniczkowy"),
        ("Ile jest trzycyfrowych liczb podzielnych przez 5?", "kombinatoryka"),
        ("Prawdopodobieństwo wylosowania kuli czerwonej z urny", "prawdopodobieństwo"),
        ("Oblicz sumę ciągu arytmetycznego", "ciągi"),
        ("Wyznacz równanie prostej przechodzącej przez punkty A i B", "geometria_analityczna"),
        ("Oblicz objętość stożka o promieniu 3 i wysokości 4", "stereometria"),
        ("Cenę towaru podwyższono o 20% a potem obniżono o 10%", "procenty"),
        ("Wyznacz dziedzinę funkcji f(x) = sqrt(x-2)", "funkcje"),
        ("Oblicz sin(30°) + cos(60°)", "trygonometria"),
        ("Znajdź największą wartość funkcji na przedziale", "optymalizacja"),
        ("Wyznacz pierwiastki wielomianu W(x) = x^3 - 6x^2 + 11x - 6", "wielomiany"),
        ("Uzasadnij że dla każdej liczby naturalnej n wyrażenie jest podzielne", "równania"),
    ]

    for q, cat in curated:
        queries.append({"query": q, "expected_category": cat})

    # Also pull real questions from datasets and auto-categorize
    for year in [2024, 2023, 2022]:
        path = DATASETS_DIR / f"{year}_1.json"
        if path.exists():
            with open(path) as f:
                data = json.load(f)
            for q in data[:10]:
                text = clean_latex(q["question"])
                cat = detect_category(text)
                queries.append({
                    "query": text[:200],
                    "expected_category": cat,
                    "year": year,
                    "task": q["metadata"]["task_number"],
                })

    return queries


def run_rag_benchmark(top_k=5, verbose=True) -> dict:
    """Benchmark RAG retrieval quality."""
    print("\n" + "=" * 70)
    print("📚 RAG RETRIEVAL BENCHMARK")
    print("=" * 70)

    # Check RAG availability
    try:
        req = Request(f"{RAG_URL}/health")
        with urlopen(req, timeout=5) as resp:
            health = json.loads(resp.read())
        print(f"  RAG service: ✅ ({health.get('total_chunks', '?')} chunks)")
    except Exception as e:
        print(f"  RAG service: ❌ not available ({e})")
        return {"status": "unavailable", "error": str(e)}

    queries = build_rag_test_queries()
    print(f"  Test queries: {len(queries)}")

    results = []
    category_hits = defaultdict(lambda: {"total": 0, "hit@1": 0, "hit@3": 0, "hit@5": 0})
    source_distribution = defaultdict(int)

    for qi, qdata in enumerate(queries):
        query = qdata["query"]
        expected_cat = qdata["expected_category"]

        # Query RAG
        payload = json.dumps({"query": query, "k": top_k}).encode()
        req = Request(f"{RAG_URL}/query", data=payload,
                      headers={"Content-Type": "application/json"})

        try:
            with urlopen(req, timeout=10) as resp:
                response = json.loads(resp.read())
        except Exception as e:
            results.append(RAGResult(
                query=query[:80], expected_category=expected_cat,
                top_k_sources=[], top_k_categories=[], top_k_scores=[],
                hit_at_1=False, hit_at_3=False, hit_at_5=False, mrr=0.0
            ))
            continue

        items = response.get("results", [])
        sources = [r.get("source", "") for r in items]
        categories = [r.get("category", "") for r in items]
        scores = [r.get("score", 0) for r in items]

        for src in sources:
            source_distribution[src] += 1

        # Check category matches (flexible: match against expected or related)
        def cat_matches(result_cat, expected):
            rc = result_cat.lower().replace(" ", "_")
            exp = expected.lower().replace(" ", "_")
            if exp in rc or rc in exp:
                return True
            # Fuzzy: common word overlap
            rc_words = set(rc.split("_"))
            exp_words = set(exp.split("_"))
            return bool(rc_words & exp_words)

        mrr = 0.0
        hit1 = hit3 = hit5 = False
        for i, cat in enumerate(categories[:5]):
            if cat_matches(cat, expected_cat):
                if i == 0:
                    hit1 = True
                if i < 3:
                    hit3 = True
                hit5 = True
                if mrr == 0:
                    mrr = 1.0 / (i + 1)
                break

        r = RAGResult(
            query=query[:80], expected_category=expected_cat,
            top_k_sources=sources, top_k_categories=categories, top_k_scores=scores,
            hit_at_1=hit1, hit_at_3=hit3, hit_at_5=hit5, mrr=mrr
        )
        results.append(r)

        category_hits[expected_cat]["total"] += 1
        if hit1:
            category_hits[expected_cat]["hit@1"] += 1
        if hit3:
            category_hits[expected_cat]["hit@3"] += 1
        if hit5:
            category_hits[expected_cat]["hit@5"] += 1

    # Compute aggregates
    n = len(results)
    agg = {
        "total_queries": n,
        "hit_at_1": sum(1 for r in results if r.hit_at_1) / n if n else 0,
        "hit_at_3": sum(1 for r in results if r.hit_at_3) / n if n else 0,
        "hit_at_5": sum(1 for r in results if r.hit_at_5) / n if n else 0,
        "mean_mrr": sum(r.mrr for r in results) / n if n else 0,
        "avg_top_score": sum(r.top_k_scores[0] for r in results if r.top_k_scores) / n if n else 0,
        "source_distribution": dict(source_distribution),
        "per_category": {},
    }

    for cat, stats in sorted(category_hits.items()):
        t = stats["total"]
        agg["per_category"][cat] = {
            "total": t,
            "hit@1": stats["hit@1"] / t if t else 0,
            "hit@3": stats["hit@3"] / t if t else 0,
            "hit@5": stats["hit@5"] / t if t else 0,
        }

    if verbose:
        print(f"\n  📊 RAG Results:")
        print(f"  Hit@1:  {agg['hit_at_1']:.1%}")
        print(f"  Hit@3:  {agg['hit_at_3']:.1%}")
        print(f"  Hit@5:  {agg['hit_at_5']:.1%}")
        print(f"  MRR:    {agg['mean_mrr']:.3f}")
        print(f"  Avg top score: {agg['avg_top_score']:.3f}")
        print(f"\n  Source distribution:")
        for src, cnt in sorted(source_distribution.items(), key=lambda x: -x[1]):
            print(f"    {src}: {cnt}")
        print(f"\n  Per-category Hit@3:")
        for cat, stats in sorted(agg["per_category"].items(), key=lambda x: -x[1]["hit@3"]):
            print(f"    {cat:25s}: {stats['hit@3']:.0%} ({stats['total']} queries)")

    return {"status": "ok", "aggregates": agg, "details": [asdict(r) for r in results]}


# ═══════════════════════════════════════════════════════════════════════
# COMPONENT 2: ANSWER VALIDATOR BENCHMARK
# ═══════════════════════════════════════════════════════════════════════

def build_validator_test_cases():
    """Build test cases for the answer-checking logic."""
    cases = []

    # MC: correct letter matches
    mc_question = {
        "options": {"A": "45\\ \\text{zł}", "B": "73,63\\ \\text{zł}",
                    "C": "75\\ \\text{zł}", "D": "87,48\\ \\text{zł}"}
    }
    cases.append(("mc_letter_correct", "C", "C", True, mc_question))
    cases.append(("mc_letter_wrong", "C", "A", False, mc_question))
    cases.append(("mc_letter_case", "C", "c", True, mc_question))
    cases.append(("mc_value_match", "C", "75", True, mc_question))
    cases.append(("mc_value_wrong", "C", "45", False, mc_question))

    # Numeric comparisons
    cases.append(("numeric_exact", "4", "4", True, {}))
    cases.append(("numeric_float", "4", "4.0", True, {}))
    cases.append(("numeric_fraction", "0.5", "1/2", True, {}))
    cases.append(("numeric_wrong", "4", "5", False, {}))
    cases.append(("numeric_close", "3.14159", "3.1416", True, {}))

    # Symbolic
    cases.append(("symbolic_sqrt", "sqrt(2)", "2**(1/2)", True, {}))
    cases.append(("symbolic_fraction", "2/3", "2/3", True, {}))

    # Edge cases
    cases.append(("no_answer", "4", "", False, {}))
    cases.append(("answer_none", "4", None, False, {}))

    return cases


def run_validator_benchmark(verbose=True) -> dict:
    """Benchmark the answer-checking logic."""
    print("\n" + "=" * 70)
    print("✅ ANSWER VALIDATOR BENCHMARK")
    print("=" * 70)

    # Import check_answer from test-dataset.py
    # We'll inline it to avoid import issues
    sys.path.insert(0, str(PROJECT_ROOT))

    # Dynamically load check_answer from test-dataset.py
    import importlib.util
    spec = importlib.util.spec_from_file_location("test_dataset", PROJECT_ROOT / "test-dataset.py")
    td = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(td)
    check_answer = td.check_answer

    cases = build_validator_test_cases()
    print(f"  Test cases: {len(cases)}")

    results = []
    correct = 0

    for case_id, expected, tested, should_match, question in cases:
        if tested is None:
            did_match = False
            explanation = "No answer"
        else:
            did_match, explanation = check_answer(expected, tested, question)

        correct_validation = (did_match == should_match)
        if correct_validation:
            correct += 1

        results.append(ValidatorResult(
            question_id=case_id,
            expected_answer=expected,
            tested_answer=str(tested) if tested else "",
            should_match=should_match,
            did_match=did_match,
            correct_validation=correct_validation,
        ))

        if verbose and not correct_validation:
            print(f"  ❌ {case_id}: expected match={should_match}, got match={did_match} ({explanation})")

    accuracy = correct / len(cases) if cases else 0

    if verbose:
        print(f"\n  📊 Validator accuracy: {correct}/{len(cases)} ({accuracy:.0%})")
        failed = [r for r in results if not r.correct_validation]
        if failed:
            print(f"  Failed cases:")
            for r in failed:
                print(f"    {r.question_id}: expected_match={r.should_match}, "
                      f"got_match={r.did_match}")

    return {
        "status": "ok",
        "accuracy": accuracy,
        "total": len(cases),
        "correct": correct,
        "details": [asdict(r) for r in results],
    }


# ═══════════════════════════════════════════════════════════════════════
# COMPONENT 3: END-TO-END PIPELINE BENCHMARK
# ═══════════════════════════════════════════════════════════════════════

def check_server(base_url):
    """Check if Bielik/MLX server is reachable."""
    try:
        req = Request(f"{base_url}/v1/models")
        with urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            return True, [m["id"] for m in data.get("data", [])]
    except:
        return False, []


def run_e2e_benchmark(base_url, model, year="2024", sample=5, all_q=False,
                      task_filter=None, only_mc=False, only_open=False,
                      use_mcp=False, verbose=True) -> dict:
    """Run end-to-end benchmark through the full multi-agent pipeline."""
    print("\n" + "=" * 70)
    print("🚀 END-TO-END PIPELINE BENCHMARK")
    print("=" * 70)

    available, models = check_server(base_url)
    if not available:
        print(f"  ❌ Bielik server not available at {base_url}")
        print(f"  Start with: mlx_lm.server --model {model} --port 8011")
        return {"status": "unavailable", "error": f"Server not available at {base_url}"}

    print(f"  Server: {base_url} ✅")
    print(f"  Model:  {model}")
    print(f"  Models: {models}")

    # Load config
    with open(PROMPTS_FILE) as f:
        config = json.load(f)

    # Determine years
    if year == "all":
        years = sorted([int(f.stem.split("_")[0])
                        for f in DATASETS_DIR.glob("*_1.json")])
    else:
        years = [int(year)]

    all_results = []
    category_stats = defaultdict(lambda: {"total": 0, "correct": 0, "points_earned": 0, "points_total": 0})

    for yr in years:
        path = DATASETS_DIR / f"{yr}_1.json"
        if not path.exists():
            continue

        with open(path) as f:
            questions = json.load(f)

        # Filters
        if only_mc:
            questions = [q for q in questions if q.get("options")]
        elif only_open:
            questions = [q for q in questions if not q.get("options")]

        if task_filter:
            task_nums = [int(t) for t in task_filter.split(",")]
            questions = [q for q in questions if q["metadata"]["task_number"] in task_nums]

        if not all_q and not task_filter:
            questions = random.sample(questions, min(sample, len(questions)))
            questions.sort(key=lambda q: q["metadata"]["task_number"])

        print(f"\n  Year {yr}: {len(questions)} questions")

        # Import the test pipeline
        spec = importlib.util.spec_from_file_location("test_dataset", PROJECT_ROOT / "test-dataset.py")
        td = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(td)

        for q in questions:
            result = td.test_question(q, base_url, model, verbose=verbose, use_mcp=use_mcp)

            category = detect_category(clean_latex(q["question"]))

            e2e = E2EResult(
                year=yr,
                task=result["task"],
                points=result["points"],
                problem_type=result["type"],
                category=category,
                correct=result["correct"],
                answer_expected=result["answer_expected"],
                answer_got=result["answer_got"],
                has_code=result["has_code"],
                code_valid=result["code_valid"],
                code_executed=result["answer_got"] is not None,
                analytical_ok=result["analytical_ok"],
                time_analytical=0,
                time_executor=0,
                time_sympy=0,
                time_total=result["time_total"],
                errors=result["errors"],
                rag_used=False,
                rag_top_source=None,
            )
            all_results.append(e2e)

            # Category stats
            category_stats[category]["total"] += 1
            category_stats[category]["points_total"] += result["points"]
            if result["correct"]:
                category_stats[category]["correct"] += 1
                category_stats[category]["points_earned"] += result["points"]

    # Compute aggregates
    n = len(all_results)
    if n == 0:
        return {"status": "no_results"}

    correct = sum(1 for r in all_results if r.correct)
    has_code = sum(1 for r in all_results if r.has_code)
    code_valid = sum(1 for r in all_results if r.code_valid)
    code_executed = sum(1 for r in all_results if r.code_executed)
    analytical_ok = sum(1 for r in all_results if r.analytical_ok)
    points_earned = sum(r.points for r in all_results if r.correct)
    points_total = sum(r.points for r in all_results)
    total_time = sum(r.time_total for r in all_results)

    mc_results = [r for r in all_results if r.problem_type == "MC"]
    open_results = [r for r in all_results if r.problem_type == "OPEN"]
    mc_correct = sum(1 for r in mc_results if r.correct)
    open_correct = sum(1 for r in open_results if r.correct)

    agg = {
        "total_questions": n,
        "accuracy": correct / n,
        "points_earned": points_earned,
        "points_total": points_total,
        "points_pct": points_earned / points_total if points_total else 0,
        "analytical_ok_pct": analytical_ok / n,
        "code_generation_pct": has_code / n,
        "code_validity_pct": code_valid / n,
        "code_execution_pct": code_executed / n,
        "mc_accuracy": mc_correct / len(mc_results) if mc_results else 0,
        "mc_count": len(mc_results),
        "open_accuracy": open_correct / len(open_results) if open_results else 0,
        "open_count": len(open_results),
        "avg_time_per_question": total_time / n,
        "total_time": total_time,
        "per_category": {},
        "per_year": {},
    }

    # Per-category
    for cat, stats in sorted(category_stats.items()):
        t = stats["total"]
        agg["per_category"][cat] = {
            "total": t,
            "accuracy": stats["correct"] / t if t else 0,
            "points": f"{stats['points_earned']}/{stats['points_total']}",
        }

    # Per-year
    for yr in years:
        yr_results = [r for r in all_results if r.year == yr]
        if yr_results:
            yr_correct = sum(1 for r in yr_results if r.correct)
            yr_pts_earned = sum(r.points for r in yr_results if r.correct)
            yr_pts_total = sum(r.points for r in yr_results)
            agg["per_year"][yr] = {
                "total": len(yr_results),
                "accuracy": yr_correct / len(yr_results),
                "points": f"{yr_pts_earned}/{yr_pts_total}",
            }

    if verbose:
        print(f"\n{'='*70}")
        print(f"📊 E2E RESULTS SUMMARY")
        print(f"{'='*70}")
        print(f"  Total questions:  {n}")
        print(f"  Overall accuracy: {agg['accuracy']:.1%}")
        print(f"  Points:           {points_earned}/{points_total} ({agg['points_pct']:.1%})")
        print(f"  MC accuracy:      {agg['mc_accuracy']:.1%} ({mc_correct}/{len(mc_results)})")
        print(f"  Open accuracy:    {agg['open_accuracy']:.1%} ({open_correct}/{len(open_results)})")
        print(f"  Analytical OK:    {agg['analytical_ok_pct']:.1%}")
        print(f"  Code generation:  {agg['code_generation_pct']:.1%}")
        print(f"  Code validity:    {agg['code_validity_pct']:.1%}")
        print(f"  Code execution:   {agg['code_execution_pct']:.1%}")
        print(f"  Avg time:         {agg['avg_time_per_question']:.1f}s per question")

        print(f"\n  Per-category accuracy:")
        for cat, stats in sorted(agg["per_category"].items(), key=lambda x: -x[1]["accuracy"]):
            bar = "█" * int(stats["accuracy"] * 20) + "░" * (20 - int(stats["accuracy"] * 20))
            print(f"    {cat:25s} {bar} {stats['accuracy']:.0%} ({stats['total']}q, {stats['points']}pts)")

        if len(years) > 1:
            print(f"\n  Per-year accuracy:")
            for yr, stats in sorted(agg["per_year"].items()):
                bar = "█" * int(stats["accuracy"] * 20) + "░" * (20 - int(stats["accuracy"] * 20))
                print(f"    {yr}: {bar} {stats['accuracy']:.0%} ({stats['total']}q, {stats['points']}pts)")

        # Failed questions
        failed = [r for r in all_results if not r.correct]
        if failed and len(failed) <= 30:
            print(f"\n  Failed questions ({len(failed)}):")
            for r in failed:
                errs = f" [{'; '.join(r.errors)}]" if r.errors else ""
                print(f"    {r.year} task {r.task} ({r.problem_type}, {r.points}pt, {r.category})"
                      f" got={r.answer_got or 'None'}{errs}")

    return {
        "status": "ok",
        "aggregates": agg,
        "details": [asdict(r) for r in all_results],
    }


# ═══════════════════════════════════════════════════════════════════════
# COMPONENT 4: DATASET ANALYSIS (always runs)
# ═══════════════════════════════════════════════════════════════════════

def analyze_datasets() -> dict:
    """Analyze the available datasets for coverage info."""
    print("\n" + "=" * 70)
    print("📋 DATASET ANALYSIS")
    print("=" * 70)

    stats = {}
    all_cats = defaultdict(int)
    total_q = 0
    total_pts = 0

    for path in sorted(DATASETS_DIR.glob("*_1.json")):
        year = int(path.stem.split("_")[0])
        with open(path) as f:
            data = json.load(f)

        mc = sum(1 for q in data if q.get("options"))
        op = len(data) - mc
        pts = sum(q["metadata"]["max_points"] for q in data)
        total_q += len(data)
        total_pts += pts

        cats = defaultdict(int)
        for q in data:
            cat = detect_category(clean_latex(q["question"]))
            cats[cat] += 1
            all_cats[cat] += 1

        stats[year] = {
            "total": len(data),
            "mc": mc,
            "open": op,
            "points": pts,
            "categories": dict(cats),
        }

        print(f"  {year}: {len(data)} questions ({mc} MC, {op} open), {pts} pts")

    print(f"\n  Total: {total_q} questions, {total_pts} points across {len(stats)} years")
    print(f"\n  Category distribution (all years):")
    for cat, cnt in sorted(all_cats.items(), key=lambda x: -x[1]):
        pct = cnt / total_q * 100
        bar = "█" * int(pct / 2) + "░" * max(0, 25 - int(pct / 2))
        print(f"    {cat:25s} {bar} {cnt:3d} ({pct:.0f}%)")

    return stats


# ═══════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════

def main():
    import importlib.util

    parser = argparse.ArgumentParser(description="Benchmark suite for bielik-m-poc")
    parser.add_argument("--component", type=str, default="all",
                        choices=["all", "rag", "validator", "e2e", "dataset"],
                        help="Which component to benchmark")
    parser.add_argument("--port", type=int, default=8011)
    parser.add_argument("--api-url", type=str, default=os.environ.get("BIELIK_API_URL"),
                        help="Full API base URL. Overrides --port. Env: BIELIK_API_URL")
    parser.add_argument("--api-key", type=str, default=os.environ.get("BIELIK_API_KEY"),
                        help="API key/token for Bearer auth. Env: BIELIK_API_KEY")
    parser.add_argument("--model", type=str, default="LibraxisAI/Bielik-11B-v3.0-mlx-q4")
    parser.add_argument("--year", type=str, default="2024")
    parser.add_argument("--sample", type=int, default=5)
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--task", type=str, default=None)
    parser.add_argument("--only-mc", action="store_true")
    parser.add_argument("--only-open", action="store_true")
    parser.add_argument("--use-mcp", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--output", type=str, default=None)
    args = parser.parse_args()

    verbose = not args.quiet
    if args.api_url:
        base_url = args.api_url.rstrip('/')
    else:
        base_url = f"http://localhost:{args.port}"
    api_key = args.api_key
    now = datetime.now()
    bench_id = f"bench_{now.strftime('%Y%m%d_%H%M%S')}"

    print("=" * 70)
    print(f"🏆 BIELIK-M-POC BENCHMARK SUITE")
    print(f"   ID: {bench_id}")
    print(f"   Time: {now.strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 70)

    components_run = []
    full_results = {
        "benchmark_id": bench_id,
        "timestamp": now.isoformat(),
        "components": {},
    }

    # Dataset analysis (always)
    ds_stats = analyze_datasets()
    full_results["dataset_info"] = ds_stats

    # RAG benchmark
    if args.component in ("all", "rag"):
        rag_results = run_rag_benchmark(verbose=verbose)
        full_results["components"]["rag"] = rag_results
        components_run.append("rag")

    # Validator benchmark
    if args.component in ("all", "validator"):
        val_results = run_validator_benchmark(verbose=verbose)
        full_results["components"]["validator"] = val_results
        components_run.append("validator")

    # E2E benchmark
    if args.component in ("all", "e2e"):
        e2e_results = run_e2e_benchmark(
            base_url=base_url, model=args.model,
            year=args.year, sample=args.sample, all_q=args.all,
            task_filter=args.task, only_mc=args.only_mc, only_open=args.only_open,
            use_mcp=args.use_mcp, verbose=verbose,
        )
        full_results["components"]["e2e"] = e2e_results
        components_run.append("e2e")

    full_results["components_run"] = components_run

    # Save results
    RESULTS_DIR.mkdir(exist_ok=True)
    output_path = args.output or str(RESULTS_DIR / f"{bench_id}.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(full_results, f, ensure_ascii=False, indent=2, default=str)

    print(f"\n{'='*70}")
    print(f"💾 Results saved to: {output_path}")
    print(f"{'='*70}")

    # Print compact summary card
    print(f"\n┌─────────────────────────────────────────────┐")
    print(f"│  BENCHMARK SUMMARY: {bench_id}    │")
    print(f"├─────────────────────────────────────────────┤")

    if "rag" in full_results["components"]:
        rag = full_results["components"]["rag"]
        if rag.get("status") == "ok":
            a = rag["aggregates"]
            print(f"│  RAG: Hit@3={a['hit_at_3']:.0%}  MRR={a['mean_mrr']:.3f}        │")
        else:
            print(f"│  RAG: unavailable                           │")

    if "validator" in full_results["components"]:
        val = full_results["components"]["validator"]
        print(f"│  Validator: {val['accuracy']:.0%} ({val['correct']}/{val['total']})              │")

    if "e2e" in full_results["components"]:
        e2e = full_results["components"]["e2e"]
        if e2e.get("status") == "ok":
            a = e2e["aggregates"]
            print(f"│  E2E: {a['accuracy']:.0%} accuracy, {a['points_pct']:.0%} points        │")
            print(f"│       MC={a['mc_accuracy']:.0%} Open={a['open_accuracy']:.0%}               │")
        else:
            print(f"│  E2E: {e2e.get('status', 'error')}                         │")

    print(f"└─────────────────────────────────────────────┘")


if __name__ == "__main__":
    main()
