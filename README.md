# Formulo

**Darmowy asystent matematyczny po polsku, oparty na modelu Bielik.**

Rozwiązuje zadania krok po kroku i tłumaczy sposób rozwiązywania. Zakres: od szkoły podstawowej, przez maturę podstawową i rozszerzoną, po zadania akademickie (teoria liczb, równania diofantyczne, optymalizacja, dowody, algebra).

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Website](https://img.shields.io/badge/Website-formulo.pl-667eea)](https://formulo.pl)

---

## Co to jest?

Aplikacja webowa z wieloetapowym pipeline AI:

- rozwiązuje zadania krok po kroku z wyjaśnieniami
- obliczenia symboliczne przez SymPy (nie zgaduje)
- formalne dowody w Lean 4
- diagramy SVG (geometria, wykresy funkcji, bryły 3D)
- generuje zadania na zamówienie (dowolny poziom, format, temat)
- wyjaśnia pojęcia matematyczne (tryb definicji)
- referencja wzorów CKE z podziałem na maturę podstawową i rozszerzoną
- kontekst konwersacji (rozumie pytania nawiązujące do poprzednich wiadomości)
- udostępnianie konwersacji przez link
- po polsku, za darmo

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

Każdy krok wysyła status przez SSE do przeglądarki.

```
Pytanie użytkownika
      |
      v
 0  Guardrail (z kontekstem konwersacji)
    Walidacja: czy to matematyka? Odrzuca spam/injection.
    Uwzględnia historię sesji przy ocenie wiadomości follow-up.
      |
      v
 0.5 Generator Intent (dwuwarstwowy)
    Warstwa 1: regex/keyword z normalizacją polskich znaków diakrytycznych.
    Warstwa 2: LLM intent classifier (uruchamiany tylko gdy warstwa 1
    nie jest pewna i wiadomość nie wygląda na konkretne zadanie).
    Trigger → losuje z datasetu CKE lub LLM generuje zadania od zera.
      |
      v
 0.55 Definition
    "co to jest pochodna", "na czym polega..." → LLM wyjaśnia
    pojęcie bez uruchamiania executora.
      |
      v
 0.6 Arithmetic Scheme
    Mnożenie pisemne (np. 123 × 456). Wynik bez LLM.
      |
      v
    RAG Service (port 3003, TF-IDF)
    Wyszukuje metody, podobne zadania, podpowiedzi SymPy.
      |
      v
 0.7 Deterministic Solver
    4 wzorce regex, zero LLM. Match → callSymPy → summary → return.
      |
      v
 0.8 Lean Proof Solver
    Dowód → LLM formalizuje w Lean 4 → leanVerify → return.
      |
      v
 1   Classifier (z kontekstem konwersacji)
    LLM klasyfikuje typ zadania (JSON): problemType, confidence, mc_options.
      |
      v
 1.5 Extraction Template (45 szablonów)
    Keyword match (score >= 2) → LLM ekstrahuje wartości →
    szablon generuje SymPy → callSymPy. Pomija analytical+executor.
      |
      v
 2   Agent Analityczny
    LLM planuje rozwiązanie. Prompt wzbogacony o ragContext.
      |
      v
 3   Agent Wykonawczy (max 3 próby)
    LLM → kod SymPy → sanitizeGeneratedCode → callSymPy.
    isOutputSuspicious wymusza retry. Retry prompt zawiera retryHint z RAG.
    Osobny prompt MC dla pytań wielokrotnego wyboru (executor_sympy_mc).
    Zadania optymalizacyjne: wymusza wartość symboliczną + numeryczną + wymiary.
      |
      v
 3.5 Decomposition Fallback
    Po 3 nieudanych próbach: LLM rozbija problem na 2-4 pod-zadania.
      |
      v
 3.7 Brute-force Verification
    Weryfikacja liczbowa (kombinatoryka): deterministyczna + LLM fallback.
      |
      v
 4   Agent Podsumowujący
    Krok po kroku wyjaśnienie + odpowiedź.
    Wartości symboliczne zawsze z przybliżeniem dziesiętnym.
      |
      v
 5   Lean Post-Solve Verification (dowody)
    Formalizacja wyniku w Lean 4 → leanVerify.
      |
      v
 6   Diagram (geometria, wykresy funkcji, bryły 3D)
    shouldGenerateDiagram wykrywa typ (trójkąt, czworokąt, okrąg,
    bryła 3D, układ współrzędnych, wykres funkcji). LLM generuje
    kod Python → SVG → callSymPyPlot. Retry z kontekstem błędu.
```

## Referencja wzorów

Zakładka "Wzory" zawiera 128 wzorów z oficjalnego arkusza CKE, podzielonych na 4 poziomy:

| Poziom | Opis | Sekcje |
|---|---|---|
| Szkoła podstawowa | Planimetria podstawowa | 1 |
| Matura podstawowa | Wartość bezwzględna, potęgi, logarytmy, wzory skróconego mnożenia, funkcja kwadratowa, ciągi, trygonometria, planimetria | 8 |
| Matura rozszerzona | Silnia/dwumian, wzór Newtona, ciągi rozszerzone, trygonometria rozszerzona, planimetria rozszerzona, geometria analityczna, stereometria, kombinatoryka, rachunek prawdopodobieństwa, statystyka, pochodna | 11 |
| Studia | Metody zaawansowane (SymPy) | zmienna |

Każdy wzór ma przycisk "Rozwiąż zadanie" generujący zadania wymagające danego wzoru.
Wzory renderowane w KaTeX (display mode). Źródło: `docs/matura-formulas.json`.

## Sesje i kontekst konwersacji

Serwer utrzymuje historię konwersacji w pamięci (Map) dla każdej sesji.

- TTL sesji: 12 godzin braku aktywności
- Maksymalnie 10 wiadomości w historii
- Historia przekazywana do guardrail, klasyfikatora i generatora LLM
- Przycisk "Nowy czat" regeneruje sessionId (izolacja kontekstu)
- Przycisk "Udostępnij" publikuje całą konwersację (Postgres, 60 dni TTL)

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

`setup.sh` instaluje zależności Node.js i Python, konfiguruje SymPy, RAG Service i buduje serwery MCP. `start.sh` uruchamia MCP Proxy (3001), Lean Proxy (3002), RAG Service (3003) i aplikację (5173).

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
Z blachy o wymiarach 20cm x 30cm wycinamy kwadraty z rogów
i zaginamy boki tworząc pudełko. Jakie wymiary dają maksymalną objętość?
```

**Dowody formalne:**

```
Udowodnij, że funkcja f(x) = 3x/(x+1) jest rosnąca na przedziale (-1, +∞)
```

**Generowanie zadań:**

```
Daj mi 5 zadań z trygonometrii z matury rozszerzonej
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
├── heroku-start.js                # HTTP server, SSE endpoint, session store, share API
├── mcp-proxy-server.js            # Proxy HTTP → MCP stdio (port 3001)
├── lean-proxy-server.js           # Lean 4 proxy (port 3002)
├── mcp-sympy-server/              # Serwer SymPy (MCP, 10 narzędzi)
├── rag_service/                   # Baza wiedzy (FastAPI + TF-IDF, port 3003)
├── datasets/                      # Zadania maturalne CKE (JSON)
├── docs/
│   └── matura-formulas.json       # 128 wzorów CKE (LaTeX), 19 sekcji, 4 poziomy
├── prompts.json                   # Prompty dla agentów
├── src/
│   ├── App.tsx                    # Główny komponent, share, session management
│   ├── components/
│   │   └── FormulaReference.tsx   # Referencja wzorów z KaTeX i generowaniem zadań
│   └── services/
│       └── threeAgentSystem.ts    # Thin client: wywołuje POST /api/solve (SSE)
└── start.sh                       # Uruchamianie lokalne
```

## Sanityzacja kodu

Dwie warstwy, obie uruchamiane przed wykonaniem kodu (executor i diagram):

1. `sanitizeGeneratedCode()` (solve-pipeline.js): zamienia wszystkie f-string printy na konkatenację, usuwa luźny tekst polski, naprawia niezamknięte nawiasy, zamienia wolne funkcje geometry API na metody Triangle, dodaje brakujący print ODPOWIEDZ.

2. `sanitizeCode()` (mcp-sympy-server): ^ → **, halucynowane importy, cos**2(x) → cos(x)**2, polskie pętle, Piecewise z chainowanymi porównaniami i inne wzorce specyficzne dla Bielik.

## Technologie

- React 18, TypeScript (frontend)
- speakleash/Bielik-11B-v3.0-Instruct (polski model LLM)
- SymPy (obliczenia symboliczne)
- Lean 4 + Mathlib (formalne dowody)
- KaTeX (renderowanie wzorów LaTeX)
- FastAPI + scikit-learn (RAG Service, TF-IDF)
- MCP (Model Context Protocol)
- PostgreSQL (udostępnione konwersacje)
- dd-trace / LLM Observability (Datadog)
- Heroku (deployment, jeden dyno)

## Dokumentacja

- [MLX_GUIDE.md](MLX_GUIDE.md) - Przewodnik po MLX (lokalny inference)
- [docs/informator_analysis.md](docs/informator_analysis.md) - Analiza Informatora Maturalnego CKE

## Licencja

[AGPL-3.0](LICENSE)
