# Formulo

**Darmowy asystent matematyczny po polsku, oparty na modelu Bielik.**

Rozwiązuje zadania krok po kroku i tłumaczy sposób rozwiązywania. Zakres: matura rozszerzona z matematyki oraz zadania akademickie (teoria liczb, równania diofantyczne, optymalizacja, dowody, algebra).

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Website](https://img.shields.io/badge/Website-formulo.pl-667eea)](https://formulo.pl)

---

## Co to jest?

Formulo to aplikacja webowa z systemem agentów AI, która:

- rozwiązuje zadania matematyczne krok po kroku z wyjaśnieniami
- wykonuje dokładne obliczenia symboliczne przez SymPy (nie zgaduje)
- tworzy formalne dowody matematyczne w Lean 4
- działa w przeglądarce, za darmo, w całości po polsku

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

## Jak działa?

System przetwarza zadanie przez wieloetapowy pipeline:

```
Pytanie użytkownika
      |
      +---> Lean Prover (TYLKO dla zadań-dowodów, opcjonalny)
      |     Próbuje udowodnić formalnie. Jeśli się uda, kończy pipeline.
      |     Jeśli nie, przechodzi do normalnego pipeline.
      |
      v
 Input Guardrail
 Walidacja: czy to zadanie matematyczne? Odrzuca spam/prompt injection.
      |
      v
 RAG Service (port 3003)
 Wyszukuje metodę + podobne zadania (TF-IDF)
      |
      v
 Academic Pre-Router (problemDecomposer.ts)
 Rozpoznaje zadania, których nie należy dekomponować
 (dowody, optymalizacja, istnienie rozwiązań, kontrprzykłady,
  równania diofantyczne) i rozwiązuje je jednym skryptem SymPy.
      |
      +---> [direct solver] jeśli rozpoznano kategorię akademicką
      |
      +---> [standard]      domyślna ścieżka, dekompozycja
            Rozbija problem na 2-4 pod-zadania z formułami SymPy
                  |
                  v
            Klasyfikator -> typ zadania (równanie/geometria/...)
                  |
                  +---> Deterministyczny solver (bez LLM!)
                  |     (równania, pochodne, całki przez SymPy)
                  |
                  +---> Chain ekstrakcji (LLM -> kod SymPy -> wynik)
                  |
                  +---> Multi-step chain (LLM wielokrokowy)
                  |
                  +---> Agent Analityczny + Agent Wykonawczy (fallback)
                              |
                              v
            Walidacja substytucyjna
            Podstawia odpowiedź do oryginalnego równania
                              |
                              v
            Weryfikacja brute-force (kombinatoryka)
            Wyliczenie wszystkich przypadków bez LLM
                              |
                              v
                       Agent Podsumowujący
                       (wyjaśnienie krok po kroku)
                              |
                              v
                       Lean Verifier (Agent 4)
                       Formalizuje i weryfikuje dowód przez Lean 4
```

RAG jest używany dwukrotnie: przed analizą (kontekst metody trafia do promptu Agenta Analitycznego) i przy generowaniu kodu (wskazówki SymPy wstrzykiwane do promptu Agenta Wykonawczego).

Academic pre-router rozwiązuje zadanie jednym celowanym skryptem SymPy zamiast rozbijać go na podkroki. Wyniki dekompozycji są weryfikowane brute-force (kombinatoryka) lub substytucyjnie (algebra).

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
- Jedno z: Ollama (rekomendowane), MLX (Apple Silicon), zdalne API

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

System ma dostęp do 9 narzędzi: `sympy_calculate`, `sympy_solve`, `sympy_differentiate`, `sympy_integrate`, `sympy_simplify`, `sympy_expand`, `sympy_factor`, `sympy_limit`, `sympy_matrix`.

## Architektura

```
formulo/
├── src/services/
│   ├── threeAgentSystem.ts      # Orkiestrator, główna pętla pipeline'a
│   ├── problemDecomposer.ts     # Academic pre-router + dekompozycja złożonych zadań
│   ├── classifierService.ts     # Klasyfikacja typu zadania
│   ├── solverRouter.ts          # Router do deterministycznych solverów
│   ├── multiStepChain.ts        # Chain ekstrakcji kodu SymPy
│   ├── ragService.ts            # Klient RAG Service (port 3003)
│   ├── mlxAgent.ts              # Agent LLM (MLX/Ollama/zdalne API)
│   └── mcpClientBrowser.ts      # Klient MCP (wywołania SymPy)
├── mcp-proxy-server.js          # Proxy: SymPy + CORS proxy
├── mcp-sympy-server/            # Serwer SymPy (MCP)
├── rag_service/                 # Baza wiedzy (FastAPI + TF-IDF)
├── datasets/                    # Zadania maturalne CKE (JSON)
├── prompts.json                 # Prompty dla agentów
└── start.sh                     # Uruchamianie
```

## Technologie

- React 18, TypeScript
- Bielik 11B (polski model LLM, SpeakLeash)
- SymPy (obliczenia symboliczne)
- Lean 4 + Mathlib (formalne dowody)
- FastAPI + scikit-learn (RAG Service, TF-IDF)
- MCP (Model Context Protocol)

## Dokumentacja

- [MLX_GUIDE.md](MLX_GUIDE.md) - Przewodnik po MLX (lokalny inference)
- [docs/informator_analysis.md](docs/informator_analysis.md) - Analiza Informatora Maturalnego CKE

## Licencja

[AGPL-3.0](LICENSE)
