# Formulo

**Darmowy asystent matematyczny po polsku, oparty na modelu Bielik.**

Rozwiązuje zadania krok po kroku i tłumaczy sposób rozwiązywania. Zakres: matura rozszerzona z matematyki oraz zadania akademickie (teoria liczb, równania diofantyczne, optymalizacja, dowody, algebra).

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Website](https://img.shields.io/badge/Website-formulo.pl-667eea)](https://formulo.pl)

---

## Co to jest?

Formulo to aplikacja webowa z wieloetapowym pipeline AI, która:

- rozwiązuje zadania matematyczne krok po kroku z wyjaśnieniami
- wykonuje dokładne obliczenia symboliczne przez SymPy (nie zgaduje)
- tworzy formalne dowody matematyczne w Lean 4
- generuje diagramy geometryczne (SVG) dla zadań konstrukcyjnych
- działa w przeglądarce, za darmo, w całości po polsku

## Architektura

Jeden publiczny endpoint: `POST /api/solve` (SSE). Wszystkie wewnętrzne serwisy (MCP proxy, RAG, LLM proxy, Lean proxy) działają wyłącznie na localhost w ramach jednego dynosa Heroku.

```
Klient (przeglądarka)
    |
    | POST /api/solve (SSE stream)
    v
heroku-start.js ─────────────────────────────────────────
    |                                                     |
    v                                                     |
solve-pipeline.js  (jedyny punkt wejścia)                 |
    |                                                     |
    ├──> LLM proxy (vLLM, port 8011)  ← OpenAI SDK       |
    ├──> MCP proxy (port 3001) ──> mcp-sympy-server       |
    ├──> RAG service (port 3003, Python FastAPI + TF-IDF) |
    └──> Lean proxy (port 3002) ──> lean-proxy-server.js  |
                                                          |
──────────────────────────────────────────────────────────
```

## Pipeline

Każde zapytanie przechodzi przez następujące etapy. Każdy krok wysyła status przez SSE do przeglądarki.

```
Pytanie użytkownika
      |
      v
 Step 0: Guardrail
 Walidacja: czy to zadanie matematyczne? Odrzuca spam/prompt injection.
      |
      v
 Step 0.5: Generator Intent
 Wykrywa komendy typu "daj mi zadania z trygonometrii".
 Jeśli tak, losuje zadania z datasetu CKE i kończy pipeline.
      |
      v
 Step 0.6: Arithmetic Scheme
 Wykrywa mnożenie pisemne (np. 123 × 456). Bezpośredni wynik, bez LLM.
      |
      v
 RAG Service (port 3003)
 Wyszukuje metody i podobne zadania (TF-IDF). Wynik:
   - ragContext: kontekst dla Agenta Analitycznego
   - sympyHints: podpowiedzi kodu dla Agenta Wykonawczego
   - retryHint: kompaktowa podpowiedź dla retry loop
 Wysyła podsumowanie do SSE (kategorie, metody, liczba trafień).
      |
      v
 Step 0.7: Deterministic Solver (deterministic-solvers.js)
 Regex-based, zero LLM. 4 wzorce: digit_counting, triangle_optimization,
 parametric_quadratic, tetrahedron_sphere. Jeśli match: callSymPy → summary → return.
      |
      v
 Step 0.8: Lean Proof Solver
 Jeśli zadanie to dowód (isProofProblem) i Lean zdrowy:
 LLM formalizuje w Lean 4 → leanVerify → jeśli verified: summary → return.
      |
      v
 Step 1: Classifier
 LLM klasyfikuje typ zadania (JSON). Ustawia problemType, confidence, mc_options.
      |
      v
 Step 1.5: Extraction Template (extraction-templates.js, 45 szablonów)
 Keyword matching (score >= 2) → LLM ekstrahuje JSON z wartościami →
 szablon generuje kod SymPy → callSymPy. Jeśli ODPOWIEDZ: pomija analytical+executor.
      |
      v
 Step 2: Agent Analityczny
 LLM planuje rozwiązanie (metoda, kroki, SymPy hint).
 Prompt wzbogacony o ragContext.
      |
      v
 Step 3: Agent Wykonawczy (executor, max 3 próby)
 LLM generuje kod SymPy → sanitizeGeneratedCode → callSymPy.
 Prompt wzbogacony o sympyHints.
 Retry loop: isOutputSuspicious wykrywa ukryte błędy i wymusza retry.
 Retry prompt zawiera retryHint z RAG.
      |
      v
 Step 3.5: Decomposition Fallback (decomposer.js)
 Jeśli executor nie dał wyniku: LLM rozbija problem na 2-4 pod-zadań
 z formułami SymPy. Każde pod-zadanie: direct formula → LLM code fallback.
      |
      v
 Step 3.7: Brute-force Verification
 Dla odpowiedzi liczbowych (kombinatoryka): deterministyczna weryfikacja
 przez wyliczenie (generateDigitCountingVerification). Jeśli nie pasuje:
 LLM brute-force fallback (bruteForceViaLLM).
      |
      v
 Step 4: Agent Podsumowujący
 LLM tłumaczy rozwiązanie krok po kroku, podaje odpowiedź.
      |
      v
 Step 5: Lean Post-Solve Verification (tylko dowody)
 Jeśli zadanie dotyczy dowodu i jest wynik: LLM formalizuje rozwiązanie
 w Lean 4 → leanVerify → raportuje czy przeszło.
      |
      v
 Step 6: Geometry Diagram (tylko zadania konstrukcyjne)
 Jeśli isConstructionTask: LLM generuje kod Python → sympy.geometry →
 SVG diagram → callSymPyPlot → wysyłka SVG przez SSE.
```

## Zakres tematyczny

Zgodny z Informatorami CKE dla matury rozszerzonej:

| Kategoria | Skuteczność | Uwagi |
|---|---|---|
| Równania parametryczne | 95% | Pełna automatyzacja |
| Wielomiany i funkcje | 90% | |
| Geometria analityczna | 90% | |
| Trygonometria | 85% | |
| Optymalizacja | 85% | Pochodne i analiza |
| Ciągi i granice | 80% | |
| Prawdopodobieństwo | 80% | Rozkłady i Bayes |
| Kombinatoryka | 75% | |
| Geometria płaska | 70% | Wymaga opisu diagramów |
| Geometria przestrzenna | 65% | Wymaga opisu wizualizacji |

## Szybki start

**Linux/macOS:**

```bash
git clone https://github.com/yourusername/formulo.git
cd formulo
./setup.sh    # Instalacja wszystkiego
./start.sh    # Uruchomienie aplikacji
```

**Windows:**

```cmd
git clone https://github.com/yourusername/formulo.git
cd formulo
setup.bat
start.bat
```

Otwórz http://localhost:5173 i zacznij rozwiązywać zadania.

### Wymagania

- Node.js 18+
- Python 3.8+ (dla SymPy)
- Dla Lean (opcjonalne): Lean 4 zainstalowany lokalnie
- vLLM lub kompatybilne API obsługujące speakleash/Bielik-11B-v3.0-Instruct

### Co robi `setup.sh`?

- Sprawdza zależności (Node.js, Python)
- Instaluje zależności Node.js
- Konfiguruje środowisko Python z SymPy
- Instaluje RAG Service (baza wiedzy)
- Buduje serwery MCP

### Co robi `start.sh`?

- Uruchamia MCP Proxy (SymPy) na porcie 3001
- Uruchamia Lean Proxy (weryfikacja) na porcie 3002
- Uruchamia RAG Service (baza wiedzy) na porcie 3003
- Uruchamia aplikację webową na porcie 5173

## Przykłady zadań

**Algebra i równania:**

```
Rozwiąż układ równań z parametrem m:
mx + y = m²
4x + my = 8
Dla jakich wartości m układ ma dokładnie jedno rozwiązanie?
```

**Analiza matematyczna:**

```
Funkcja f(x) = -t³ + 16.5t² + 180t opisuje położenie Syzyfa.
Znajdź minimalną odległość od startu i maksymalną prędkość.
```

**Optymalizacja:**

```
Znajdź minimum funkcji f(x) = x⁴ + 0.5(2x+1)⁴
```

**Dowody formalne:**

```
Udowodnij, że funkcja f(x) = 3x/(x+1) jest rosnąca na przedziale (-1, +∞)
```

## Narzędzia SymPy

System ma dostęp do 10 narzędzi: `sympy_calculate`, `sympy_solve`, `sympy_differentiate`, `sympy_integrate`, `sympy_simplify`, `sympy_expand`, `sympy_factor`, `sympy_limit`, `sympy_matrix`, `sympy_plot`.

## Struktura plików

```
formulo/
├── solve-pipeline.js              # Jedyny punkt wejścia, cały pipeline
├── extraction-templates.js        # 45 szablonów ekstrakcji (keyword → JSON → SymPy)
├── deterministic-solvers.js       # 4 deterministyczne solvery (regex, zero LLM)
├── decomposer.js                  # Dekompozycja na pod-zadania z formułami
├── heroku-start.js                # HTTP server, SSE endpoint /api/solve
├── mcp-proxy-server.js            # Proxy HTTP → MCP stdio (port 3001)
├── lean-proxy-server.js           # Lean 4 proxy (port 3002)
├── mcp-sympy-server/              # Serwer SymPy (MCP, 10 narzędzi)
├── rag_service/                   # Baza wiedzy (FastAPI + TF-IDF, port 3003)
├── datasets/                      # Zadania maturalne CKE (JSON)
├── prompts.json                   # Prompty dla agentów
├── src/services/
│   └── threeAgentSystem.ts        # Thin client: wywołuje POST /api/solve (SSE)
└── start.sh                       # Uruchamianie lokalne
```

## Sanityzacja kodu

Kod generowany przez Bielik przechodzi przez dwa etapy sanityzacji:

1. `sanitizeGeneratedCode()` w solve-pipeline.js: naprawia f-stringi z polskim tekstem, usuwa luźny tekst polski, naprawia niezamknięte nawiasy, zamienia wolne funkcje geometry API na metody Triangle (incenter → tri.incenter, semiperimeter → tri.perimeter/2), dodaje brakujący print ODPOWIEDZ.

2. `sanitizeCode()` w mcp-sympy-server: naprawia ^ → **, filtruje halucynowane importy, naprawia cos**2(x) → cos(x)**2, zamienia polskie pętle, poprawia Piecewise z chainowanymi porównaniami, i wiele innych wzorców specyficznych dla Bielik.

## Technologie

- React 18, TypeScript (frontend)
- speakleash/Bielik-11B-v3.0-Instruct (polski model LLM)
- SymPy (obliczenia symboliczne)
- Lean 4 + Mathlib (formalne dowody)
- FastAPI + scikit-learn (RAG Service, TF-IDF)
- MCP (Model Context Protocol)
- dd-trace / LLM Observability (Datadog)
- Heroku (deployment, jeden dyno)

## Dokumentacja

- [MLX_GUIDE.md](MLX_GUIDE.md) - Przewodnik po MLX (lokalny inference)
- [docs/informator_analysis.md](docs/informator_analysis.md) - Analiza Informatora Maturalnego CKE

## Licencja

[AGPL-3.0](LICENSE)
