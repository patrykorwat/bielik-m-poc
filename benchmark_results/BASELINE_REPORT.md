# Bielik-M-POC Benchmark Baseline Report

**Benchmark ID:** bench_20260217_112700
**Date:** 2026-02-17
**System:** Bielik-11B-v3 (Q4 MLX) + 3-Agent Pipeline + RAG (TF-IDF, 538 chunks)

---

## 1. Executive Summary

| Component | Metric | Score | Status |
|-----------|--------|-------|--------|
| RAG Retrieval | Hit@3 | **64.4%** | Needs improvement |
| RAG Retrieval | MRR | **0.589** | Moderate |
| Answer Validator | Accuracy | **100%** | Excellent |
| Dataset Coverage | Problems | **339** across 10 years | Good |

**E2E pipeline** requires Bielik server running locally (Apple Silicon + MLX). Run with:
```bash
python3 benchmark.py --component e2e --year 2024 --all
```

---

## 2. RAG Retrieval Quality

538 chunks indexed from 4 sources:
- **mathematical_methods.json**: 73 chunks (method descriptions + SymPy hints)
- **informator_analysis.md**: 28 chunks (exam info in English)
- **informator_pdf_chunks.json**: 98 chunks (raw PDF extraction, Polish)
- **datasets/*.json**: 339 chunks (historical matura problems)

### 2.1 Aggregate Metrics

| Metric | Value | Target |
|--------|-------|--------|
| Hit@1 | 53.3% | >70% |
| Hit@3 | 64.4% | >85% |
| Hit@5 | 68.9% | >90% |
| MRR | 0.589 | >0.75 |
| Avg top score | 0.456 | >0.5 |

### 2.2 Source Distribution (in top-5 results)

| Source | Count | % |
|--------|-------|---|
| dataset | 205 | 91% |
| informator_pdf | 12 | 5% |
| methods | 8 | 4% |

**Issue:** Dataset chunks dominate results. Method chunks (with SymPy hints) appear too rarely — this is the most valuable source for the Executor agent.

### 2.3 Per-Category Performance

| Category | Hit@3 | Queries | Notes |
|----------|-------|---------|-------|
| funkcje | 100% | 5 | Excellent |
| geometria_analityczna | 100% | 1 | Small sample |
| logarytmy | 100% | 1 | Small sample |
| prawdopodobieństwo | 100% | 1 | Small sample |
| procenty | 100% | 3 | Good |
| rachunek_różniczkowy | 100% | 1 | Small sample |
| równania | 100% | 12 | Excellent (large sample) |
| stereometria | 100% | 1 | Small sample |
| trygonometria | 100% | 1 | Small sample |
| ciągi | 75% | 4 | Good |
| **geometria_płaska** | **0%** | 1 | **Needs data** |
| **inne** | **0%** | 11 | **Category detection issue** |
| **kombinatoryka** | **0%** | 1 | **Needs data** |
| **optymalizacja** | **0%** | 1 | **Needs data** |
| **wielomiany** | **0%** | 1 | **Needs data** |

### 2.4 Key Issues

1. **"inne" category too large (15% of dataset)** — many problems aren't recognized by the category detector. Need better keyword coverage.
2. **Method chunks underrepresented** — they appear in only 4% of results, but contain the most actionable info (SymPy code hints).
3. **No semantic matching** — TF-IDF with char n-grams catches morphological variants well, but misses semantic similarity (e.g., "największa wartość" ↔ "optymalizacja").

---

## 3. Answer Validator

| Metric | Value |
|--------|-------|
| Accuracy | **100%** (14/14) |
| MC letter match | ✅ |
| MC value match | ✅ |
| Numeric comparison | ✅ |
| Symbolic comparison | ✅ |
| Edge cases (None, empty) | ✅ |

The validator is robust. No false positives or false negatives on the test suite.

---

## 4. Dataset Analysis

### 4.1 Coverage

| Year | Questions | MC | Open | Points |
|------|-----------|-----|------|--------|
| 2015 | 34 | 25 | 9 | 50 |
| 2016 | 34 | 25 | 9 | 50 |
| 2017 | 34 | 25 | 9 | 50 |
| 2018 | 34 | 25 | 9 | 50 |
| 2019 | 34 | 25 | 9 | 50 |
| 2020 | 34 | 25 | 9 | 50 |
| 2021 | 35 | 28 | 7 | 45 |
| 2022 | 35 | 28 | 7 | 45 |
| 2023 | 32 | 25 | 7 | 42 |
| 2024 | 33 | 26 | 7 | 43 |
| **Total** | **339** | **257** | **82** | **475** |

### 4.2 Category Distribution

| Category | Count | % |
|----------|-------|---|
| trygonometria | 88 | 26% |
| równania | 71 | 21% |
| inne | 51 | 15% |
| funkcje | 51 | 15% |
| ciągi | 41 | 12% |
| geometria_płaska | 18 | 5% |
| procenty | 6 | 2% |
| geometria_analityczna | 4 | 1% |
| prawdopodobieństwo | 3 | 1% |
| stereometria | 3 | 1% |
| logarytmy | 2 | 1% |
| rachunek_różniczkowy | 1 | 0% |

**Note:** These are basic-level (poziom podstawowy) matura datasets. The system targets extended-level (rozszerzony). Extended-level datasets would have more open-ended problems and harder categories (proofs, optimization, calculus).

---

## 5. Improvement Roadmap

### Priority 1: RAG Quality (Highest Impact)

| Action | Expected Impact | Effort |
|--------|----------------|--------|
| Boost method chunk scores (weighting) | Hit@3 +15% | Low |
| Add category-aware retrieval | Hit@3 +10% | Medium |
| Improve "inne" category detection | Hit@3 +5% | Low |
| Add extended-level matura datasets | Coverage +100% | Medium |

### Priority 2: Pipeline Improvements

| Action | Expected Impact | Effort |
|--------|----------------|--------|
| RAG context → Executor (not just Analytical) | Accuracy +5-10% | Low |
| Better LaTeX→text conversion in prompts | Code gen +5% | Low |
| Category-specific executor prompts | Accuracy +5% | Medium |
| Add retry with RAG-guided hints on failure | Recovery +10% | Medium |

### Priority 3: Scoring & Validation

| Action | Expected Impact | Effort |
|--------|----------------|--------|
| Partial credit scoring for open-ended | Better metrics | Medium |
| Proof validation via Lean | Open accuracy +10% | High |
| Add more validator test cases | Regression safety | Low |

---

## 6. How to Run Benchmarks

```bash
# Full benchmark (RAG + validator + E2E if server running)
python3 benchmark.py

# RAG only
python3 benchmark.py --component rag

# Validator only
python3 benchmark.py --component validator

# E2E on 2024 (all questions)
python3 benchmark.py --component e2e --year 2024 --all

# E2E on all years (3 samples each)
python3 benchmark.py --component e2e --year all --sample 3

# E2E only MC questions
python3 benchmark.py --component e2e --year 2024 --all --only-mc

# Save results to specific file
python3 benchmark.py --output my_results.json
```

Results are automatically saved to `benchmark_results/bench_YYYYMMDD_HHMMSS.json` for tracking improvements over time.

---

## 7. Comparing Benchmarks Over Time

Each benchmark run produces a JSON file with a unique ID. To track improvement:

1. Run benchmark before making changes (baseline)
2. Make improvements to RAG, prompts, or pipeline
3. Run benchmark again
4. Compare the two JSON files

Key metrics to track:
- **RAG MRR** — measures retrieval quality
- **E2E accuracy** — overall correctness
- **E2E points_pct** — weighted by difficulty
- **Per-category accuracy** — find weak spots
