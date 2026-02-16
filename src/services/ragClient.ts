/**
 * RAG Client - łączy się z serwisem RAG (port 3003)
 * aby wyszukać relevantne metody matematyczne dla zadania
 */

const RAG_URL = 'http://localhost:3003';

export interface RAGResult {
  id: string;
  score: number;
  source: string;
  category: string;
  title: string;
  content: string;
  sympy_hint: string;
  tips: string;
  metadata: Record<string, any>;
}

export interface RAGQueryResponse {
  results: RAGResult[];
  query: string;
  total_chunks: number;
  retrieval_ms: number;
}

export class RAGClient {
  private baseUrl: string;
  private isAvailable: boolean = false;

  constructor(baseUrl: string = RAG_URL) {
    this.baseUrl = baseUrl;
  }

  /**
   * Sprawdź czy serwis RAG jest dostępny
   */
  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      });

      if (response.ok) {
        const data = await response.json();
        this.isAvailable = data.ready === true;
        return this.isAvailable;
      }
    } catch (error) {
      console.warn('RAG Service not available:', error);
      this.isAvailable = false;
    }

    return false;
  }

  /**
   * Wyszukaj relevantne metody dla zadania
   */
  async query(question: string, k: number = 3): Promise<RAGResult[]> {
    if (!this.isAvailable) {
      const available = await this.checkHealth();
      if (!available) {
        console.warn('RAG Service unavailable - skipping knowledge retrieval');
        return [];
      }
    }

    try {
      const response = await fetch(`${this.baseUrl}/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: question, k }),
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        throw new Error(`RAG query failed: ${response.statusText}`);
      }

      const data: RAGQueryResponse = await response.json();
      console.log(`✅ RAG retrieved ${data.results.length} methods in ${data.retrieval_ms}ms`);

      return data.results;
    } catch (error) {
      console.error('RAG query error:', error);
      return [];
    }
  }

  /**
   * Formatuj wyniki RAG do promptu dla agenta
   */
  formatForPrompt(results: RAGResult[]): string {
    if (results.length === 0) {
      return '';
    }

    const lines: string[] = [
      '\n📚 RELEVANTNE METODY Z BAZY WIEDZY MATURALNEJ:\n',
    ];

    results.forEach((result, idx) => {
      lines.push(`${idx + 1}. ${result.title}`);
      lines.push(`   Kategoria: ${result.category}`);

      if (result.content) {
        lines.push(`   Opis: ${result.content}`);
      }

      if (result.sympy_hint) {
        lines.push(`   SymPy: ${result.sympy_hint}`);
      }

      if (result.tips) {
        lines.push(`   Wskazówki: ${result.tips}`);
      }

      lines.push('');
    });

    lines.push('Użyj tych metod jeśli pasują do zadania.\n');

    return lines.join('\n');
  }
}

// Singleton instance
export const ragClient = new RAGClient();
