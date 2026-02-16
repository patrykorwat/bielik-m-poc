"""Ładowanie i chunkowanie danych z 3 źródeł dla RAG."""
import json
import re
from pathlib import Path
from typing import List, Dict, Any
from dataclasses import dataclass, field, asdict

from config import METHODS_JSON, INFORMATOR_MD, INFORMATOR_PDF_CHUNKS, DATASETS_DIR


@dataclass
class Chunk:
    """Pojedynczy chunk wiedzy dla RAG."""
    id: str
    source: str           # "methods" | "informator" | "dataset"
    category: str         # kategoria tematyczna
    title: str            # tytuł/nazwa
    content: str          # pełna treść do wyszukiwania
    sympy_hint: str = ""  # podpowiedź SymPy
    tips: str = ""        # wskazówki dla agenta 11B
    exam_problems: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_search_text(self) -> str:
        """Tekst do indeksowania TF-IDF."""
        parts = [self.title, self.content]
        if self.sympy_hint:
            parts.append(self.sympy_hint)
        if self.tips:
            parts.append(self.tips)
        if self.category:
            parts.append(self.category)
        return " ".join(parts)

    def to_dict(self) -> dict:
        return asdict(self)


def load_methods_chunks() -> List[Chunk]:
    """Ładuj chunki z mathematical_methods.json — 1 chunk per metoda."""
    chunks = []

    with open(METHODS_JSON, "r", encoding="utf-8") as f:
        data = json.load(f)

    for cat in data.get("categories", []):
        cat_id = cat["id"]
        cat_name = cat.get("name", cat_id)

        for method in cat.get("methods", []):
            method_id = method["id"]

            # Buduj treść chunka
            content_parts = [
                method.get("description", ""),
                f"Kiedy używać: {method.get('when_to_use', '')}",
            ]
            if method.get("exam_problems"):
                content_parts.append(f"Zadania egzaminacyjne: {', '.join(method['exam_problems'])}")

            chunk = Chunk(
                id=f"method_{cat_id}_{method_id}",
                source="methods",
                category=cat_name,
                title=f"{method.get('name', method_id)} ({method.get('name_en', '')})",
                content=" ".join(content_parts),
                sympy_hint=method.get("sympy_approach", ""),
                tips=method.get("tips_for_11b", ""),
                exam_problems=method.get("exam_problems", []),
                metadata={
                    "sympy_functions": method.get("sympy_functions", []),
                    "category_id": cat_id,
                    "method_id": method_id,
                }
            )
            chunks.append(chunk)

    # Dodaj też mapowania typ_zadania → metody
    problem_map = data.get("problem_type_to_method_map", {})
    for problem_type, method_ids in problem_map.items():
        readable = problem_type.replace("_", " ")
        chunk = Chunk(
            id=f"mapping_{problem_type}",
            source="methods",
            category="mapowanie",
            title=f"Typ zadania: {readable}",
            content=f"Dla zadania typu '{readable}' użyj metod: {', '.join(method_ids)}",
            metadata={"problem_type": problem_type, "method_ids": method_ids}
        )
        chunks.append(chunk)

    # Dodaj cheatsheet jako jeden chunk
    cheatsheet = data.get("sympy_cheatsheet", {})
    if cheatsheet:
        cs_lines = [f"{k}: {v}" for k, v in cheatsheet.items()]
        chunk = Chunk(
            id="sympy_cheatsheet",
            source="methods",
            category="SymPy",
            title="SymPy Cheatsheet - najważniejsze komendy",
            content="\n".join(cs_lines),
            sympy_hint="\n".join(cs_lines),
        )
        chunks.append(chunk)

    return chunks


def load_informator_chunks() -> List[Chunk]:
    """Ładuj chunki z informator_analysis.md — 1 chunk per zadanie/sekcja."""
    chunks = []

    if not INFORMATOR_MD.exists():
        print(f"⚠️  Brak pliku {INFORMATOR_MD}")
        return chunks

    text = INFORMATOR_MD.read_text(encoding="utf-8")

    # Podziel na sekcje po nagłówkach zadań (#### **Zadanie X.**)
    task_pattern = re.compile(
        r'####\s+\*\*Zadanie\s+(\d+)\.\s*\(([^)]+)\)\*\*\s*\n(.*?)(?=####\s+\*\*Zadanie|\n##\s|\Z)',
        re.DOTALL
    )

    for match in task_pattern.finditer(text):
        task_num = match.group(1)
        points = match.group(2)
        body = match.group(3).strip()

        # Wyciągnij kategorie z body
        topic_match = re.search(r'\*\*Topic\*\*:\s*(.+)', body)
        topic = topic_match.group(1).strip() if topic_match else ""

        skills_match = re.search(r'\*\*Math Skills Needed\*\*:\s*(.+?)(?=\n\*\*|\Z)', body, re.DOTALL)
        skills = skills_match.group(1).strip() if skills_match else ""

        sympy_match = re.search(r'\*\*SymPy.*?\*\*:\s*(.+?)(?=\n\*\*|\Z)', body, re.DOTALL)
        sympy_info = sympy_match.group(1).strip() if sympy_match else ""

        complexity_match = re.search(r'\*\*Computational Complexity\*\*:\s*(.+)', body)
        complexity = complexity_match.group(1).strip() if complexity_match else ""

        chunk = Chunk(
            id=f"informator_zadanie_{task_num}",
            source="informator",
            category=topic or "matura",
            title=f"Zadanie {task_num} ({points}) - {topic}",
            content=body[:800],  # Ogranicz rozmiar
            sympy_hint=sympy_info,
            tips=f"Złożoność: {complexity}. Umiejętności: {skills}",
            metadata={
                "task_number": int(task_num),
                "points": points,
                "topic": topic,
            }
        )
        chunks.append(chunk)

    # Dodaj sekcje ogólne (Exam Structure, etc.)
    section_pattern = re.compile(
        r'##\s+(\d+)\.\s+(.+?)\n(.*?)(?=\n##\s+\d|\Z)',
        re.DOTALL
    )

    for match in section_pattern.finditer(text):
        sec_num = match.group(1)
        sec_title = match.group(2).strip()
        sec_body = match.group(3).strip()

        # Pomijamy sekcję z zadaniami (już przetworzona)
        if "EXAMPLE PROBLEMS" in sec_title.upper():
            continue

        if len(sec_body) > 100:  # Tylko niepuste sekcje
            chunk = Chunk(
                id=f"informator_section_{sec_num}",
                source="informator",
                category="struktura_egzaminu",
                title=sec_title,
                content=sec_body[:1000],
                metadata={"section_number": int(sec_num)}
            )
            chunks.append(chunk)

    return chunks


def load_dataset_chunks() -> List[Chunk]:
    """Ładuj chunki z historycznych zestawów maturalnych (datasets/*.json)."""
    chunks = []

    if not DATASETS_DIR.exists():
        print(f"⚠️  Brak katalogu {DATASETS_DIR}")
        return chunks

    for json_file in sorted(DATASETS_DIR.glob("*.json")):
        try:
            with open(json_file, "r", encoding="utf-8") as f:
                tasks = json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            print(f"⚠️  Błąd ładowania {json_file}: {e}")
            continue

        year = json_file.stem.split("_")[0]

        for task in tasks:
            meta = task.get("metadata", {})
            task_num = meta.get("task_number", 0)
            max_points = meta.get("max_points", 1)

            question = task.get("question", "")
            answer = task.get("answer", "")
            options = task.get("options", {})

            # Buduj treść
            content = question
            if options:
                opts_str = "; ".join(f"{k}) {v}" for k, v in options.items())
                content += f" Opcje: {opts_str}"
            content += f" Odpowiedź: {answer}"

            # Kategoryzuj na podstawie treści
            category = _infer_category(question)

            chunk = Chunk(
                id=f"dataset_{year}_{task_num}",
                source="dataset",
                category=category,
                title=f"Matura {year}, Zadanie {task_num} ({max_points}pkt)",
                content=content,
                metadata={
                    "year": int(year),
                    "task_number": task_num,
                    "max_points": max_points,
                    "has_options": bool(options),
                    "answer": answer,
                }
            )
            chunks.append(chunk)

    return chunks


def _infer_category(question: str) -> str:
    """Heurystyczna kategoryzacja zadania na podstawie treści."""
    q = question.lower()

    # Kolejność ma znaczenie - bardziej specyficzne najpierw
    if any(w in q for w in ["prawdopodobie", "losow", "rzut", "kuli", "urna"]):
        return "prawdopodobieństwo"
    if any(w in q for w in ["kombinacj", "permutacj", "wariacj", "na ile sposob"]):
        return "kombinatoryka"
    if any(w in q for w in ["graniastosłup", "ostrosłup", "stożek", "walec", "kula", "sferze", "bryły"]):
        return "stereometria"
    if any(w in q for w in ["sin", "cos", "tg", "ctg", "trygonometr", "kąt"]):
        return "trygonometria"
    if any(w in q for w in ["pochodn", "całk", "granica", "ciągło"]):
        return "rachunek różniczkowy"
    if any(w in q for w in ["prosta", "okrąg", "współrzędn", "wektor", "odległość punkt"]):
        return "geometria analityczna"
    if any(w in q for w in ["trójkąt", "czworokąt", "pole", "obwód", "równoległ", "prostokąt"]):
        return "geometria płaska"
    if any(w in q for w in ["ciąg", "arytmetycz", "geometrycz", "a_n", "suma.*wyraz"]):
        return "ciągi"
    if any(w in q for w in ["funkcj", "wykres", "dziedzin", "monotoniczn", "f(x)"]):
        return "funkcje"
    if any(w in q for w in ["log", "logarytm"]):
        return "logarytmy"
    if any(w in q for w in ["wielomian", "stopni", "pierwiastk"]):
        return "wielomiany"
    if any(w in q for w in ["równani", "rozwi", "nierównoś"]):
        return "równania i nierówności"
    if any(w in q for w in ["procent", "zysk", "strat", "cen"]):
        return "procenty i zastosowania"

    return "algebra"


def load_pdf_chunks() -> List[Chunk]:
    """Ładuj chunki wyekstrahowane z Informator PDF (zadania, rozwiązania, kryteria, wzory)."""
    chunks = []

    if not INFORMATOR_PDF_CHUNKS.exists():
        print(f"⚠️  Brak pliku {INFORMATOR_PDF_CHUNKS}")
        return chunks

    with open(INFORMATOR_PDF_CHUNKS, "r", encoding="utf-8") as f:
        data = json.load(f)

    for item in data.get("chunks", []):
        chunk = Chunk(
            id=item["id"],
            source="informator_pdf",
            category=item.get("category", "matura_rozszerzona"),
            title=item.get("title", ""),
            content=item.get("content", ""),
            sympy_hint=item.get("sympy_hint", ""),
            tips=item.get("tips", ""),
            metadata=item.get("metadata", {}),
        )
        chunks.append(chunk)

    return chunks


def load_all_chunks() -> List[Chunk]:
    """Ładuj wszystkie chunki ze wszystkich źródeł."""
    all_chunks = []

    print("📚 Ładowanie mathematical_methods.json...")
    methods = load_methods_chunks()
    print(f"   → {len(methods)} chunków z metod")
    all_chunks.extend(methods)

    print("📚 Ładowanie informator_analysis.md...")
    informator = load_informator_chunks()
    print(f"   → {len(informator)} chunków z informatora")
    all_chunks.extend(informator)

    print("📚 Ładowanie informator_pdf_chunks.json...")
    pdf_chunks = load_pdf_chunks()
    print(f"   → {len(pdf_chunks)} chunków z PDF informatora")
    all_chunks.extend(pdf_chunks)

    print("📚 Ładowanie datasets/*.json...")
    datasets = load_dataset_chunks()
    print(f"   → {len(datasets)} chunków z datasetów")
    all_chunks.extend(datasets)

    print(f"\n✅ Łącznie: {len(all_chunks)} chunków")
    return all_chunks


if __name__ == "__main__":
    chunks = load_all_chunks()
    for c in chunks[:5]:
        print(f"\n--- {c.id} [{c.source}] ---")
        print(f"  Tytuł: {c.title}")
        print(f"  Kategoria: {c.category}")
        print(f"  Treść: {c.content[:120]}...")
