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

    // Metody matematyczne (z methods source)
    const methods = results.filter(r => r.source === 'methods' && r.score > 0.15);
    if (methods.length > 0) {
      const methodLines = methods.map(m => {
        let line = `- ${m.title}: ${m.content.substring(0, 200)}`;
        if (m.sympy_hint) line += `\n  SymPy: ${m.sympy_hint.substring(0, 150)}`;
        if (m.tips) line += `\n  Tip: ${m.tips.substring(0, 150)}`;
        return line;
      });
      sections.push(`METODY:\n${methodLines.join('\n')}`);
    }

    // Podobne zadania historyczne (z dataset source)
    const examples = results.filter(r => r.source === 'dataset' && r.score > 0.2);
    if (examples.length > 0) {
      const exLines = examples.slice(0, 2).map(e =>
        `- ${e.title}: ${e.content.substring(0, 150)}`
      );
      sections.push(`PODOBNE ZADANIA:\n${exLines.join('\n')}`);
    }

    // Informacje z informatora
    const informator = results.filter(r => r.source === 'informator' && r.score > 0.2);
    if (informator.length > 0) {
      const infLines = informator.slice(0, 1).map(i =>
        `- ${i.title}: ${i.tips || i.content.substring(0, 150)}`
      );
      sections.push(`KONTEKST EGZAMINACYJNY:\n${infLines.join('\n')}`);
    }

    if (!sections.length) return '';

    return `\n--- KONTEKST Z BAZY WIEDZY ---\n${sections.join('\n\n')}\n--- KONIEC KONTEKSTU ---\n`;
  }

  /**
   * Pełny pipeline: query + format. Zwraca kontekst gotowy do wstrzyknięcia w prompt.
   */
  async getContext(userMessage: string, topK: number = 5): Promise<string> {
    const results = await this.query(userMessage, topK);
    return this.formatContextForAgent(results);
  }
}
