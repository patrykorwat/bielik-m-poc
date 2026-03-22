/**
 * RAG Service Client - komunikacja z Python RAG microservice (port 3003).
 *
 * Wyszukuje metody matematyczne i historyczne zadania maturalne
 * pasujące do zapytania użytkownika, formatuje kontekst dla Agent 1 (Analityczny).
 */

import { logDebug, logWarn } from './logger';

export interface RAGResult {
  id: string;
  score: number;
  source: string;       // "methods" | "informator" | "dataset"
  category: string;
  title: string;
  content: string;
  sympy_hint: string;
  tips: string;
  metadata: Record<string, any>;
}

interface RAGQueryResponse {
  results: RAGResult[];
  query: string;
  total_chunks: number;
  retrieval_ms: number;
}

export class RAGService {
  private baseUrl: string;
  private timeoutMs: number;
  private cache: Map<string, { results: RAGResult[]; timestamp: number }>;
  private cacheTtlMs: number;

  constructor(
    baseUrl: string = 'http://127.0.0.1:3003',
    timeoutMs: number = 3000,
    cacheTtlMs: number = 600_000 // 10 minut
  ) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();
    this.cacheTtlMs = cacheTtlMs;
  }

  /**
   * Sprawdź czy serwis RAG jest dostępny.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      const res = await fetch(`${this.baseUrl}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        return data.ready === true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Wyszukaj pasujące metody/zadania w bazie RAG.
   */
  async query(userMessage: string, topK: number = 3): Promise<RAGResult[]> {
    // Sprawdź cache
    const cacheKey = `${userMessage}:${topK}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.results;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      const res = await fetch(`${this.baseUrl}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: userMessage, k: topK }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        logWarn(`⚠️ RAG query failed: ${res.status}`);
        return [];
      }

      const data: RAGQueryResponse = await res.json();

      // Cache wyników
      this.cache.set(cacheKey, { results: data.results, timestamp: Date.now() });

      logDebug(`📚 RAG: ${data.results.length} wyników w ${data.retrieval_ms}ms`);
      return data.results;
    } catch (err) {
      logWarn('⚠️ RAG query error (non-blocking):', err);
      return [];
    }
  }

  /**
   * Detect problem category from question text for targeted RAG injection.
   */
  /**
   * Detect ALL matching categories for a problem (supports multi-category problems).
   * Returns array of category names, or empty array if none detected.
   */
  detectCategories(questionText: string): string[] {
    const lower = questionText.toLowerCase();
    const categories: Array<{ name: string; keywords: string[] }> = [
      { name: 'stereometria', keywords: ['graniastosłup', 'ostrosłup', 'walec', 'stożek', 'kula', 'bryła', 'objętość', 'pole powierzchni', 'przekrój', 'krawędź boczna', 'ściana boczna', 'wysokość bryły', 'podstawa bryły', 'sześciokąt'] },
      { name: 'parametric', keywords: ['parametr', 'wartości m', 'wartości a', 'wartości p', 'dla jakich', 'warunek na', 'wyróżnik', 'delta'] },
      { name: 'ciagi', keywords: ['ciąg arytmetyczny', 'ciąg geometryczny', 'ciąg', 'wyraz ciągu', 'różnica ciągu', 'iloraz ciągu', 'suma ciągu', 'n-ty wyraz'] },
      { name: 'trygonometria', keywords: ['sinus', 'cosinus', 'tangens', 'sin', 'cos', 'tg', 'trygonometr', 'kąt', 'stopni'] },
      { name: 'dowody', keywords: ['wykaż', 'udowodnij', 'dowód', 'indukcja', 'pokaż że', 'pokaż, że'] },
      { name: 'optymalizacja', keywords: ['największ', 'najmniejsz', 'maksymaln', 'minimaln', 'optymal', 'ekstremum', 'wartość największa', 'wartość najmniejsza'] },
      { name: 'prawdopodobienstwo', keywords: ['prawdopodobień', 'losow', 'rzut kostk', 'rzut monet', 'urna', 'kula z urny', 'zdarzeni'] },
      { name: 'granice', keywords: ['granica', 'lim', 'granicy', 'dąży do', 'zbieżn'] },
      { name: 'nierownosci', keywords: ['nierówność', 'nierównoś', 'leq', 'geq', '\\leq', '\\geq', 'rozwiąż nierówność'] },
      { name: 'geometria_analityczna', keywords: ['okrąg', 'prosta', 'współrzędn', 'równoległobok', 'przekątne', 'środek odcinka', 'punkt przeci'] },
      { name: 'kombinatoryka', keywords: ['ile jest', 'na ile sposobów', 'liczba naturalna', 'zapis dziesiętny', 'cyfr', 'kombinacj', 'permutacj'] },
      { name: 'logarytmy', keywords: ['logarytm', 'log_', 'log ', '\\log'] },
      { name: 'funkcja_kwadratowa', keywords: ['funkcja kwadratowa', 'parabola', 'oś symetrii', 'wierzchołek', 'f(x) = x**2', 'x^2 + bx'] },
    ];
    const matched: string[] = [];
    for (const cat of categories) {
      if (cat.keywords.some(kw => lower.includes(kw))) matched.push(cat.name);
    }
    return matched;
  }

  /**
   * Backward-compatible single-category detection (returns first match).
   */
  detectCategory(questionText: string): string | null {
    const cats = this.detectCategories(questionText);
    return cats.length > 0 ? cats[0] : null;
  }

  /**
   * Category-specific strategy hints injected into agent prompts.
   */
  private getCategoryStrategy(category: string | null): string {
    if (!category) return '';
    const strategies: Record<string, string> = {
      'stereometria': 'STRATEGIA STEREOMETRIA:\n- Zidentyfikuj typ bryły (graniastosłup/ostrosłup/walec/stożek/kula)\n- Wyznacz pole podstawy (S) i wysokość (h)\n- V = S * h (graniastosłup/walec) lub V = (1/3) * S * h (ostrosłup/stożek)\n- Twierdzenie Pitagorasa 3D: a² + b² + c² = d² (przekątna prostopadłościanu)\n- Przekrój: znajdź płaszczyznę cięcia, oblicz wymiary przekroju\nSymPy: from sympy import *; a, h = symbols("a h", positive=True); V = a**2 * h',
      'parametric': 'STRATEGIA PARAMETR:\n- Wyciągnij parametr (m, a, p) z równania\n- Utwórz wielomian w x: Poly(eq, x)\n- Oblicz wyróżnik: delta = discriminant(poly)\n- Jedno rozw. → delta = 0; dwa różne → delta > 0; brak → delta < 0\n- UWAGA: sprawdź edge case gdy współczynnik przy x² = 0 (liniowe!)\nSymPy: from sympy import *; m = symbols("m"); poly = Poly(eq, x); delta = discriminant(poly); solve(delta > 0, m)',
      'ciagi': 'STRATEGIA CIĄGI:\n- Arytmetyczny: a_n = a_1 + (n-1)*d, S_n = n*(a_1 + a_n)/2\n- Geometryczny: a_n = a_1 * q**(n-1), S_n = a_1*(1 - q**n)/(1 - q)\n- Jeśli (x, y, z) geometryczny → y² = x*z\n- Jeśli (x, y, z) arytmetyczny → 2y = x + z\n- UWAGA: ciąg ROSNĄCY geometryczny → q > 1 i a_1 > 0\nSymPy: from sympy import *; a1, d, q, n = symbols("a1 d q n"); solve([eq1, eq2], [a1, d])',
      'trygonometria': 'STRATEGIA TRYGONOMETRIA:\n- Tożsamości: sin²x + cos²x = 1, sin(2x) = 2sin(x)cos(x), cos(2x) = 2cos²(x)-1\n- Równania trygonometryczne: użyj solveset(eq, x, Interval(0, 2*pi))\n- UWAGA: solve() może zwrócić tylko główne rozwiązanie, użyj solveset dla pełnego zbioru\nSymPy: from sympy import *; x = symbols("x", real=True); solveset(sin(x) - Rational(1,2), x, Interval(0, 2*pi))',
      'dowody': 'STRATEGIA DOWODY:\n- Bezpośredni: przekształć lewą stronę do prawej\n- Sprzeczność: załóż NOT(teza), doprowadź do sprzeczności\n- Indukcja: base case n=1 + krok indukcyjny (n → n+1)\n- KAŻDY krok musi być UZASADNIONY — zakaz "oczywiste"\n- Numeryczne sprawdzenie: print() wartości na konkretnych przykładach\nSymPy: from sympy import *; simplify(LHS - RHS)  # powinno dać 0',
      'optymalizacja': 'STRATEGIA OPTYMALIZACJA:\n- Wyraź funkcję celu f(x) jednej zmiennej\n- Pochodna: f\'(x) = diff(f, x)\n- Punkty krytyczne: solve(f\'(x), x)\n- Sprawdź znak f\'\'(x) w punktach krytycznych (min/max)\n- Sprawdź wartości na krańcach przedziału!\nSymPy: from sympy import *; x = symbols("x", positive=True); f = ...; fp = diff(f, x); crits = solve(fp, x); print("f\'\':", diff(f, x, 2).subs(x, crits[0]))',
      'prawdopodobienstwo': 'STRATEGIA PRAWDOPODOBIEŃSTWO:\n- Zidentyfikuj: ze zwracaniem czy bez, porządek ma znaczenie?\n- P(A) = |A| / |Ω| — policz zdarzenia sprzyjające i wszystkie\n- Kombinacje: binomial(n, k); Permutacje: factorial(n)/factorial(n-k)\n- Prawdopodobieństwo warunkowe: P(A|B) = P(A∩B)/P(B)\n- Jeśli dane osobne P dla elementów: P(A) = suma P(elementów spełniających warunek)\n- Użyj Rational(a,b) NIE float — na maturze wynik musi być ułamkiem\nSymPy: from sympy import *; binomial(n, k); Rational(sprzyjające, wszystkie)',
      'granice': 'STRATEGIA GRANICE:\n- KLUCZOWE: limit(expr, x, a, \'-\') dla lewostronnej, limit(expr, x, a, \'+\') dla prawostronnej\n- Bez kierunku limit(expr, x, a) daje granicę obustronną\n- Rozłóż na czynniki: factor(licznik), factor(mianownik)\n- Jeśli 0/0: uprość ułamek (factor + cancel)\n- Jeśli k/0: sprawdź znak → ±∞\n- Wynik -oo zapisz: print("ODPOWIEDZ: $-\\\\infty$")\nSymPy: from sympy import *; x = symbols("x"); limit((x**3-8)/(x-2)**2, x, 2, "-")',
      'nierownosci': 'STRATEGIA NIERÓWNOŚCI:\n- KLUCZOWE: NIGDY nie rób arytmetyki na obiektach Relational (>=, <=)!\n- Przenieś WSZYSTKO na jedną stronę: wyrażenie ≤ 0\n- Użyj solve_univariate_inequality(expr <= 0, x, relational=False)\n- Alternatywa: solve(expr, x) → miejsca zerowe, ręcznie sprawdź znak\n- factor(expr) może rozłożyć na czynniki → łatwiejsze znalezienie przedziałów\nSymPy: from sympy import *; from sympy.solvers.inequalities import solve_univariate_inequality; solve_univariate_inequality(x**2 - 3*x - 4 <= 0, x, relational=False)',
      'geometria_analityczna': 'STRATEGIA GEOMETRIA ANALITYCZNA:\n- Odległość: sqrt((x2-x1)²+(y2-y1)²)\n- Środek odcinka: ((x1+x2)/2, (y1+y2)/2)\n- W równoległoboku: przekątne dzielą się na połowy → C = 2P - A\n- Okrąg: (x-a)²+(y-b)²=r², NIE (x-a)²+(y-b)²=r!\n- Punkt na prostej y=ax+b: podstaw współrzędne parametrycznie\nSymPy: from sympy import *; sqrt((x2-x1)**2 + (y2-y1)**2)',
      'kombinatoryka': 'STRATEGIA KOMBINATORYKA:\n- Cyfry bez powtórzeń: rozważ OSOBNO przypadek z cyfrą 0!\n- 0 nie może stać na pierwszym miejscu → odejmij złe przypadki\n- binomial(n,k) = C(n,k), factorial(n) = n!\n- Permutacje n elementów: factorial(n)\n- NIGDY: "0 not in 5" (int nie jest iterable!). Pracuj na zbiorach/listach\nSymPy: from sympy import *; binomial(5,3) * factorial(5)',
      'logarytmy': 'STRATEGIA LOGARYTMY:\n- log(x, base) w SymPy — NIE log_base(x)!\n- Zmiana podstawy: log_b(x) = log(x)/log(b)\n- log(a*b) = log(a) + log(b); log(a^n) = n*log(a)\n- Dla dowodów: wyraź WSZYSTKO przez jedną zmienną (np. log(5))\n- expand_log(expr, force=True) rozwija; logcombine(expr) łączy\nSymPy: from sympy import *; log(9, sqrt(3)); simplify(...)',
      'funkcja_kwadratowa': 'STRATEGIA FUNKCJA KWADRATOWA:\n- f(x) = ax² + bx + c\n- Oś symetrii: x = -b/(2a)\n- Wierzchołek: W = (-b/(2a), f(-b/(2a)))\n- Wyróżnik: delta = b²-4ac\n- Miejsca zerowe: (-b±√delta)/(2a)\n- Z warunków (np. oś symetrii x=-2, f(1)=-10) twórz układ i solve()\nSymPy: from sympy import *; b, c = symbols("b c"); solve([Eq(-b/2, -2), Eq(1+b+c, -10)], [b, c])',
    };
    return strategies[category] || '';
  }

  /**
   * Formatuj wyniki RAG jako kontekst dla agenta analitycznego.
   * Zwraca pusty string jeśli brak wyników.
   */
  formatContextForAgent(results: RAGResult[], problemCategory?: string | null | string[]): string {
    // Normalize to array of categories
    const categories: string[] = Array.isArray(problemCategory)
      ? problemCategory
      : problemCategory ? [problemCategory] : [];

    if (!results.length && !categories.length) return '';

    const sections: string[] = [];

    // Category-specific strategies (inject ALL matching — multi-category support)
    for (const cat of categories) {
      const strategy = this.getCategoryStrategy(cat);
      if (strategy) {
        sections.push(strategy);
      }
    }
    // If multi-category, add a combination hint
    if (categories.length > 1) {
      sections.push(`UWAGA: To zadanie łączy ${categories.length} kategorii: ${categories.join(' + ')}. Najpierw rozwiąż każdą część osobno, potem połącz wyniki.`);
    }

    // Metody matematyczne — najcenniejsze (how to solve, not what the answer is)
    const methods = results.filter(r => r.source === 'methods' && r.score > 0.10);
    if (methods.length > 0) {
      const methodLines = methods.slice(0, 3).map(m => {
        let line = `- ${m.title}`;
        if (m.tips) line += `\n  Wskazowki: ${m.tips.substring(0, 250)}`;
        if (m.sympy_hint) line += `\n  SymPy: ${m.sympy_hint.substring(0, 250)}`;
        // Include worked example if available
        if (m.metadata?.worked_example?.sympy_code) {
          line += `\n  Przyklad:\n${m.metadata.worked_example.sympy_code.substring(0, 300)}`;
        }
        return line;
      });
      sections.push(`METODY ROZWIAZANIA:\n${methodLines.join('\n')}`);
    }

    // Informator PDF — rozwiązania wzorcowe z informatora CKE
    const pdfChunks = results.filter(r => r.source === 'informator_pdf' && r.score > 0.10);
    if (pdfChunks.length > 0) {
      const pdfLines = pdfChunks.slice(0, 2).map(p => {
        let line = `- ${p.title} [${p.category}]`;
        if (p.sympy_hint) line += `\n  Kod SymPy: ${p.sympy_hint.substring(0, 200)}`;
        return line;
      });
      sections.push(`PODOBNE ZADANIA (informator CKE):\n${pdfLines.join('\n')}`);
    }

    // Podobne zadania z datasetów — only the category/title, never the answer
    const examples = results.filter(r => r.source === 'dataset' && r.score > 0.15);
    if (examples.length > 0) {
      const exLines = examples.slice(0, 2).map(e =>
        `- ${e.title} [${e.category}]`
      );
      sections.push(`PODOBNE ZADANIA HISTORYCZNE:\n${exLines.join('\n')}`);
    }

    if (!sections.length) return '';

    return `\n--- KONTEKST RAG ---\n${sections.join('\n\n')}\n---\n`;
  }

  /**
   * Wyciągnij podpowiedzi SymPy z wyników RAG (dla Agenta Executor).
   * Enhanced: provides concrete code patterns + common pitfalls.
   */
  formatSymPyHints(results: RAGResult[], problemCategory?: string | null | string[]): string {
    const hints = results
      .filter(r => r.sympy_hint && r.score > 0.10)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);  // was 3 — more context for 11B

    const sections: string[] = [];

    // Category-specific code patterns (ALL matching categories)
    const categories: string[] = Array.isArray(problemCategory)
      ? problemCategory
      : problemCategory ? [problemCategory] : [];

    for (const cat of categories) {
      const strategy = this.getCategoryStrategy(cat);
      if (strategy) {
        const sympyLine = strategy.split('\n').find(l => l.startsWith('SymPy:'));
        if (sympyLine) {
          sections.push(`# WZORZEC (${cat}):\n${sympyLine.replace('SymPy: ', '')}`);
        }
      }
    }

    for (const h of hints) {
      let section = `# ${h.title || h.category}`;
      section += `\n${h.sympy_hint}`;

      // Add tips as code comments if available
      if (h.tips) {
        const tipLines = h.tips.substring(0, 250).split(/[.;]/).filter(t => t.trim());
        if (tipLines.length > 0) {
          section += '\n# WAZNE: ' + tipLines.slice(0, 2).map(t => t.trim()).join('; ');
        }
      }

      // Add worked example code if available
      if (h.metadata?.worked_example?.sympy_code) {
        section += `\n# PRZYKLAD ROZWIAZANIA:\n${h.metadata.worked_example.sympy_code.substring(0, 250)}`;
      }

      sections.push(section);
    }

    if (!sections.length) return '';

    // Add universal patterns for common pitfalls
    const pitfallHints = [
      '# PAMIETAJ: solve() moze zwrocic liste, dict, And, Or, lub Relational — zawsze sprawdz typ!',
      '# PAMIETAJ: NIGDY nie pisz f(x) gdzie f = symbols("f") → TypeError! Uzyj f_expr = ...; f_expr.subs(x, val)',
      '# PAMIETAJ: NIGDY nie rob arytmetyki na nierownosci (>=, <=) → TypeError! Przenies na jedna strone PRZED',
      '# PAMIETAJ: Rational(1,3) nie 1/3 (Python: 1/3=0!); cos(x)**2 nie cos**2(x)',
      '# PAMIETAJ: limit(expr, x, a, "-") dla lewostronnej; solveset() nie solve() dla trygonom.',
      '# PAMIETAJ: Dla WIELU zmiennych: print(f"ODPOWIEDZ: x = {x_val}, y = {y_val}")',
      '# PAMIETAJ: Na koniec ZAWSZE print("ODPOWIEDZ: ...")',
    ];

    return `\n--- PODPOWIEDZI SYMPY ---\n${sections.join('\n\n')}\n\n${pitfallHints.join('\n')}\n--- KONIEC PODPOWIEDZI ---\n`;
  }

  /**
   * Compact retry hint: pick the single best SymPy snippet for the problem.
   * Designed to be tiny — just a one-liner injected into a retry prompt.
   * Returns empty string if nothing relevant.
   */
  formatRetryHint(results: RAGResult[]): string {
    // Pick the top 2 highest-scoring results with sympy_hints
    const best = results
      .filter(r => r.sympy_hint && r.score > 0.10)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);

    if (!best.length) return '';

    const hints = best.map(b => b.sympy_hint.substring(0, 150).trim()).join('\n');
    return `\nPodpowiedzi SymPy:\n${hints}\n# WAZNE: solve() zwraca liste — uzyj [0] i sprawdz czy nie pusta. Uzyj Line() nie line().`;
  }

  /**
   * Pełny pipeline: query + format. Zwraca kontekst gotowy do wstrzyknięcia w prompt.
   */
  async getContext(userMessage: string, topK: number = 5): Promise<string> {
    const results = await this.query(userMessage, topK);
    return this.formatContextForAgent(results);
  }
}
