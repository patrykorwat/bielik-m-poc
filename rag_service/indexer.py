"""TF-IDF indekser dla RAG - optymalny dla polskiej terminologii matematycznej."""
import pickle
from pathlib import Path
from typing import List, Dict, Any, Optional
from dataclasses import dataclass

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

from data_loader import Chunk, load_all_chunks
from config import INDEX_DIR, TFIDF_INDEX_PATH, CHUNKS_PATH, TFIDF_NGRAM_RANGE, TFIDF_ANALYZER


# Polskie stop words (matematyczny kontekst)
POLISH_STOP_WORDS = [
    "i", "w", "na", "z", "do", "to", "że", "jest", "nie", "się",
    "o", "co", "jak", "od", "po", "za", "ze", "ale", "tak", "dla",
    "by", "tego", "ten", "ta", "te", "tym", "tej", "tych", "są",
    "być", "został", "które", "który", "która", "lub", "albo",
    "też", "jako", "np", "tzn", "itp", "etc", "może", "można",
    "gdy", "jeśli", "oraz", "więc", "czy", "każdy", "każda",
    "wszystkie", "wszystkich", "bardzo", "tylko", "już", "jeszcze",
    "przy", "pod", "nad", "między", "przez", "przed", "około",
]


@dataclass
class SearchResult:
    """Wynik wyszukiwania RAG."""
    chunk_id: str
    score: float
    source: str
    category: str
    title: str
    content: str
    sympy_hint: str
    tips: str
    metadata: Dict[str, Any]

    def to_dict(self) -> dict:
        return {
            "id": self.chunk_id,
            "score": round(self.score, 4),
            "source": self.source,
            "category": self.category,
            "title": self.title,
            "content": self.content,
            "sympy_hint": self.sympy_hint,
            "tips": self.tips,
            "metadata": self.metadata,
        }


class TFIDFIndex:
    """TF-IDF indeks z cosine similarity do wyszukiwania chunków."""

    def __init__(self):
        self.vectorizer: Optional[TfidfVectorizer] = None
        self.tfidf_matrix = None
        self.chunks: List[Chunk] = []
        self._initialized = False

    def build(self, chunks: Optional[List[Chunk]] = None) -> None:
        """Zbuduj indeks TF-IDF z chunków."""
        if chunks is None:
            chunks = load_all_chunks()

        self.chunks = chunks
        texts = [c.to_search_text() for c in chunks]

        print(f"🔨 Budowanie indeksu TF-IDF ({len(texts)} dokumentów)...")

        self.vectorizer = TfidfVectorizer(
            analyzer=TFIDF_ANALYZER,
            ngram_range=TFIDF_NGRAM_RANGE,
            max_features=50000,
            # stop_words nie działa z analyzer=char_wb, filtrujemy ręcznie w to_search_text()
            min_df=1,
            max_df=0.95,
            sublinear_tf=True,  # 1 + log(tf) — lepsze dla dłuższych dokumentów
        )

        self.tfidf_matrix = self.vectorizer.fit_transform(texts)
        self._initialized = True

        print(f"✅ Indeks zbudowany: {self.tfidf_matrix.shape[0]} docs × {self.tfidf_matrix.shape[1]} features")

    # Source boost factors — metody i informator PDF są cenniejsze niż surowe datasety
    SOURCE_BOOST = {
        "methods": 1.35,        # metody z SymPy hints — najcenniejsze dla agenta
        "informator_pdf": 1.20, # zadania z informatora rozszerzonego
        "informator": 1.10,     # analiza informatora
        "dataset": 1.00,        # historyczne zadania — bazowy score
    }

    def query(self, query_text: str, top_k: int = 3) -> List[SearchResult]:
        """Wyszukaj najbardziej pasujące chunki z source-aware boosting."""
        if not self._initialized:
            raise RuntimeError("Indeks nie jest zbudowany. Wywołaj build() najpierw.")

        query_vec = self.vectorizer.transform([query_text])
        similarities = cosine_similarity(query_vec, self.tfidf_matrix).flatten()

        # Apply source-based boosting
        boosted = similarities.copy()
        for i, chunk in enumerate(self.chunks):
            boost = self.SOURCE_BOOST.get(chunk.source, 1.0)
            boosted[i] *= boost

        # Top-K indeksów (wewnątrz bierzemy więcej, potem zapewniamy różnorodność)
        fetch_k = min(top_k * 3, len(self.chunks))
        top_indices = np.argsort(boosted)[-fetch_k:][::-1]

        # Zapewnij różnorodność źródeł: max 60% z jednego source
        results = []
        source_counts: dict = {}
        max_per_source = max(2, int(top_k * 0.6))

        for idx in top_indices:
            if len(results) >= top_k:
                break

            score = float(boosted[idx])
            if score < 0.01:
                continue

            chunk = self.chunks[idx]
            src = chunk.source
            source_counts[src] = source_counts.get(src, 0) + 1

            # Jeśli jedno źródło dominuje, pomiń (chyba że to jedyne trafienie)
            if source_counts[src] > max_per_source and len(results) >= 2:
                continue

            results.append(SearchResult(
                chunk_id=chunk.id,
                score=score,
                source=chunk.source,
                category=chunk.category,
                title=chunk.title,
                content=chunk.content[:500],
                sympy_hint=chunk.sympy_hint,
                tips=chunk.tips,
                metadata=chunk.metadata,
            ))

        return results

    def save(self) -> None:
        """Zapisz indeks do plików."""
        INDEX_DIR.mkdir(parents=True, exist_ok=True)

        with open(TFIDF_INDEX_PATH, "wb") as f:
            pickle.dump({
                "vectorizer": self.vectorizer,
                "tfidf_matrix": self.tfidf_matrix,
            }, f)

        with open(CHUNKS_PATH, "wb") as f:
            pickle.dump(self.chunks, f)

        print(f"💾 Indeks zapisany do {INDEX_DIR}")

    def load(self) -> bool:
        """Załaduj indeks z plików. Zwraca True jeśli udane."""
        if not TFIDF_INDEX_PATH.exists() or not CHUNKS_PATH.exists():
            return False

        try:
            with open(TFIDF_INDEX_PATH, "rb") as f:
                data = pickle.load(f)
                self.vectorizer = data["vectorizer"]
                self.tfidf_matrix = data["tfidf_matrix"]

            with open(CHUNKS_PATH, "rb") as f:
                self.chunks = pickle.load(f)

            self._initialized = True
            print(f"📂 Indeks załadowany: {len(self.chunks)} chunków")
            return True
        except Exception as e:
            print(f"⚠️  Błąd ładowania indeksu: {e}")
            return False

    @property
    def is_ready(self) -> bool:
        return self._initialized

    @property
    def chunk_count(self) -> int:
        return len(self.chunks) if self._initialized else 0


def build_and_save_index() -> TFIDFIndex:
    """Zbuduj i zapisz indeks (one-shot)."""
    index = TFIDFIndex()
    index.build()
    index.save()
    return index


if __name__ == "__main__":
    # Zbuduj indeks i przetestuj
    idx = build_and_save_index()

    test_queries = [
        "równanie kwadratowe z parametrem",
        "logarytm obliczanie wartości",
        "pole trójkąta trygonometria sinus",
        "prawdopodobieństwo warunkowe Bayes",
        "pochodna optymalizacja wartość największa",
        "ciąg geometryczny suma nieskończona",
        "dowód indukcja matematyczna podzielność",
    ]

    for q in test_queries:
        print(f"\n🔍 Query: '{q}'")
        results = idx.query(q, top_k=3)
        for r in results:
            print(f"  [{r.score:.3f}] {r.title} ({r.source})")
