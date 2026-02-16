"""FastAPI RAG Service dla bielik-m-poc.

Serwis udostępnia wiedzę o metodach matematycznych z matury rozszerzonej
poprzez TF-IDF retrieval na porcie 3003.

Uruchomienie:
    cd rag_service && python main.py
    lub: uvicorn main:app --host 127.0.0.1 --port 3003
"""
import sys
import time
from pathlib import Path
from typing import List, Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# Dodaj katalog rag_service do PYTHONPATH
sys.path.insert(0, str(Path(__file__).parent))

from indexer import TFIDFIndex, SearchResult
from config import PORT, HOST


# ──────────────────────────────────────────────
# Globalny indeks (lazy init)
# ──────────────────────────────────────────────
_index = TFIDFIndex()
_init_time: float = 0.0


def _ensure_index() -> TFIDFIndex:
    """Lazy initialization: buduj indeks przy pierwszym zapytaniu."""
    global _init_time
    if not _index.is_ready:
        start = time.time()
        # Spróbuj załadować z cache
        if not _index.load():
            # Cache nie istnieje — buduj od zera
            _index.build()
            _index.save()
        _init_time = time.time() - start
        print(f"⏱️  Indeks gotowy w {_init_time:.2f}s ({_index.chunk_count} chunków)")
    return _index


# ──────────────────────────────────────────────
# FastAPI App
# ──────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifecycle: preload index at startup."""
    print(f"🚀 RAG Service startuje na {HOST}:{PORT}")
    _ensure_index()  # Preload at startup for faster first query
    yield
    print("👋 RAG Service zamyka się")


app = FastAPI(
    title="Bielik Matura RAG Service",
    description="Lokalna baza wiedzy o metodach matematycznych z matury rozszerzonej",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# ──────────────────────────────────────────────
# Modele Request/Response
# ──────────────────────────────────────────────
class QueryRequest(BaseModel):
    query: str = Field(..., min_length=2, max_length=2000, description="Zapytanie (treść zadania)")
    k: int = Field(default=3, ge=1, le=10, description="Liczba wyników")


class QueryResultItem(BaseModel):
    id: str
    score: float
    source: str
    category: str
    title: str
    content: str
    sympy_hint: str = ""
    tips: str = ""
    metadata: dict = {}


class QueryResponse(BaseModel):
    results: List[QueryResultItem]
    query: str
    total_chunks: int
    retrieval_ms: float


class HealthResponse(BaseModel):
    status: str
    chunks: int
    init_time_s: float
    ready: bool


# ──────────────────────────────────────────────
# Endpointy
# ──────────────────────────────────────────────
@app.get("/health", response_model=HealthResponse)
async def health():
    """Sprawdź status serwisu."""
    return HealthResponse(
        status="ok" if _index.is_ready else "initializing",
        chunks=_index.chunk_count,
        init_time_s=round(_init_time, 2),
        ready=_index.is_ready,
    )


@app.post("/query", response_model=QueryResponse)
async def query(req: QueryRequest):
    """Wyszukaj najbardziej pasujące metody/zadania."""
    index = _ensure_index()

    start = time.time()
    results: List[SearchResult] = index.query(req.query, top_k=req.k)
    retrieval_ms = (time.time() - start) * 1000

    return QueryResponse(
        results=[QueryResultItem(**r.to_dict()) for r in results],
        query=req.query,
        total_chunks=index.chunk_count,
        retrieval_ms=round(retrieval_ms, 2),
    )


@app.post("/rebuild")
async def rebuild():
    """Przebuduj indeks (po zmianie danych źródłowych)."""
    global _init_time
    start = time.time()
    _index.build()
    _index.save()
    _init_time = time.time() - start
    return {
        "status": "rebuilt",
        "chunks": _index.chunk_count,
        "time_s": round(_init_time, 2),
    }


# ──────────────────────────────────────────────
# Uruchomienie
# ──────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host=HOST,
        port=PORT,
        log_level="info",
        reload=False,
    )
