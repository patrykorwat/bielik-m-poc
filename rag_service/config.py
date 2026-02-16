"""Konfiguracja RAG service dla bielik-m-poc."""
import os
from pathlib import Path

# Ścieżki
PROJECT_ROOT = Path(__file__).parent.parent
DOCS_DIR = PROJECT_ROOT / "docs"
DATASETS_DIR = PROJECT_ROOT / "datasets"

# Pliki źródłowe
METHODS_JSON = DOCS_DIR / "mathematical_methods.json"
INFORMATOR_MD = DOCS_DIR / "informator_analysis.md"
INFORMATOR_PDF_CHUNKS = DOCS_DIR / "informator_pdf_chunks.json"

# Indeks
INDEX_DIR = Path(__file__).parent / "index"
TFIDF_INDEX_PATH = INDEX_DIR / "tfidf_index.pkl"
CHUNKS_PATH = INDEX_DIR / "chunks.pkl"

# Serwer
PORT = int(os.environ.get("RAG_PORT", 3003))
HOST = os.environ.get("RAG_HOST", "127.0.0.1")

# Retrieval
DEFAULT_TOP_K = 3
MAX_TOP_K = 10
TFIDF_NGRAM_RANGE = (2, 4)  # character n-grams - dobre dla polskiej fleksji
TFIDF_ANALYZER = "char_wb"   # word boundary-aware character n-grams
