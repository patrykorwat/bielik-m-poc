/**
 * RAG Service Client - komunikacja z Python RAG microservice (port 3003).
 *
 * Wyszukuje metody matematyczne i historyczne zadania maturalne
 * pasujące do zapytania użytkownika, formatuje kontekst dla Agent 1 (Analityczny).
 */

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
        console.warn(`⚠️ RAG query failed: ${res.status}`);
        return [];
      }

      const data: RAGQueryResponse = await res.json();

      // Cache wyników
      this.cache.set(cacheKey, { results: data.results, timestamp: Date.now() });

      console.log(`📚 RAG: ${data.results.length} wyników w ${data.retrieval_ms}ms`);
      return data.results;
    } catch (err) {
      console.warn('⚠️ RAG query error (non-blocking):', err);
      return [];
    }
  }

  /**
   * Formatuj wyniki RAG jako kontekst dla agenta analitycznego.
   * Zwraca pusty string jeśli brak wyników.
   */
  formatContextForAgent(results: RAGResult[]): string {
    if (!results.length) return '';

    const sections: string[] = [];

    // Metody matematyczne — najcenniejsze (how to solve, not what the answer is)
    const methods = results.filter(r => r.source === 'methods' && r.score > 0.10);
    if (methods.length > 0) {
      const methodLines = methods.slice(0, 3).map(m => {
        let line = `- ${m.title}`;
        if (m.tips) line += `\n  Wskazowki: ${m.tips.substring(0, 200)}`;
        if (m.sympy_hint) line += `\n  SymPy: ${m.sympy_hint.substring(0, 200)}`;
        return line;
      });
      sections.push(`METODY ROZWIAZANIA:\n${methodLines.join('\n')}`);
    }

    // Informator PDF — rozwiązania wzorcowe z informatora CKE
    const pdfChunks = results.filter(r => r.source === 'informator_pdf' && r.score > 0.15);
    if (pdfChunks.length > 0) {
      const pdfLines = pdfChunks.slice(0, 2).map(p => {
        let line = `- ${p.title} [${p.category}]`;
        if (p.sympy_hint) line += `\n  SymPy: ${p.sympy_hint.substring(0, 150)}`;
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

    return `\n--- KONTEKST RAG ---\n${sections.join('\n')}\n---\n`;
  }

  /**
   * Wyciągnij podpowiedzi SymPy z wyników RAG (dla Agenta Executor).
   * Enhanced: provides concrete code patterns + common pitfalls.
   */
  formatSymPyHints(results: RAGResult[]): string {
    const hints = results
      .filter(r => r.sympy_hint && r.score > 0.10)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    if (!hints.length) return '';

    const sections: string[] = [];

    for (const h of hints) {
      let section = `# ${h.title || h.category}`;
      section += `\n${h.sympy_hint}`;

      // Add tips as code comments if available
      if (h.tips) {
        const tipLines = h.tips.substring(0, 200).split(/[.;]/).filter(t => t.trim());
        if (tipLines.length > 0) {
          section += '\n# WAZNE: ' + tipLines[0].trim();
        }
      }
      sections.push(section);
    }

    // Add universal patterns for common pitfalls
    const pitfallHints = [
      '# PAMIETAJ: solve() moze zwrocic liste, And, Or, lub Relational — zawsze sprawdz typ!',
      '# PAMIETAJ: Uzyj Line() nie line(), Point() nie point() (wielka litera)',
      '# PAMIETAJ: cos(x)**2 nie cos**2(x)',
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
