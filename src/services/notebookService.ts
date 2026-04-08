/**
 * Formulo Notatnik Matematyczny – Notebook Service
 *
 * Przechowuje zapisane przez użytkownika rozwiązania AI w localStorage.
 * Każda notatka zawiera:
 *  - treść (odpowiedź agenta)
 *  - wykryty temat
 *  - datę zapisu
 *  - opcjonalną własną notatkę użytkownika
 *  - tagi
 */

const STORAGE_KEY = 'formulo-notebook';

export interface NotebookEntry {
  id: string;
  title: string;          // auto-generowany skrót treści
  content: string;        // pełna treść odpowiedzi AI
  topic: string;          // wykryty temat (np. "Logarytmy", "Trygonometria")
  note: string;           // własna notatka użytkownika (edytowalna)
  tags: string[];         // tagi dodane przez użytkownika
  savedAt: string;        // ISO timestamp
  questionText?: string;  // opcjonalnie pytanie, które wywołało odpowiedź
}

// ── Wykrywanie tematu na podstawie treści ──────────────────────────────────

const TOPIC_PATTERNS: Array<{ topic: string; patterns: RegExp[] }> = [
  { topic: 'Logarytmy',           patterns: [/log/i, /logarytm/i] },
  { topic: 'Trygonometria',       patterns: [/sin|cos|tan|tg\b|ctg|sinus|cosinus|tangens/i, /trygono/i] },
  { topic: 'Pochodne',            patterns: [/pochodn/i, /różniczk/i, /ekstr/i, /monotoniczn/i, /f'\s*\(/i] },
  { topic: 'Całki',               patterns: [/całk/i, /prymityw/i, /∫/] },
  { topic: 'Stereometria',        patterns: [/ostrosłup|graniastosłup|walec|stożek|kula|sfer|bryły|prostopadłościan/i] },
  { topic: 'Ciągi',               patterns: [/ciąg/i, /arytmetyczn/i, /geometryczn/i, /a_n/i] },
  { topic: 'Prawdopodobieństwo',  patterns: [/prawdopodobie/i, /kombinacj/i, /permutacj/i, /dwumian/i] },
  { topic: 'Funkcja kwadratowa',  patterns: [/kwadratow/i, /parabol/i, /wierzchołek/i, /delta/i, /dyskryminant/i] },
  { topic: 'Równania',            patterns: [/równan/i, /nierównoś/i, /układ równań/i] },
  { topic: 'Geometria płaska',    patterns: [/trójkąt/i, /prostokąt/i, /okrąg/i, /wielokąt/i, /pole/i, /obwód/i] },
  { topic: 'Statystyka',          patterns: [/średnia/i, /mediana/i, /odchylenie/i, /wariancj/i] },
  { topic: 'Potęgi i pierwiastki',patterns: [/potęg/i, /pierwiastek/i, /wykładnik/i] },
  { topic: 'Wielomiany',          patterns: [/wielomian/i, /stopień/i, /pierwiastek wielom/i] },
  { topic: 'Macierze i wektory',  patterns: [/macierz/i, /wektor/i, /wyznacznik/i] },
  { topic: 'Liczby zespolone',    patterns: [/zespolon/i, /imaginar/i, /rzeczywist/i, /\bi\b/] },
];

export function detectTopic(text: string): string {
  for (const { topic, patterns } of TOPIC_PATTERNS) {
    if (patterns.some(p => p.test(text))) return topic;
  }
  return 'Ogólne';
}

// ── Generowanie tytułu ────────────────────────────────────────────────────

export function generateTitle(content: string): string {
  // Usuń LaTeX i weź pierwsze ~80 znaków
  const clean = content
    .replace(/\$\$[\s\S]*?\$\$/g, '[wzór]')
    .replace(/\$[^$]*\$/g, '[wzór]')
    .replace(/```[\s\S]*?```/g, '[kod]')
    .replace(/#+\s*/g, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = clean.length > 80 ? clean.slice(0, 77) + '...' : clean;
  return cut || 'Zapisane rozwiązanie';
}

// ── CRUD na localStorage ──────────────────────────────────────────────────

function loadAll(): NotebookEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as NotebookEntry[];
  } catch {
    return [];
  }
}

function saveAll(entries: NotebookEntry[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

export function getAllEntries(): NotebookEntry[] {
  return loadAll().sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export function getEntry(id: string): NotebookEntry | undefined {
  return loadAll().find(e => e.id === id);
}

export function isBookmarked(content: string): boolean {
  // Porównuj po pierwszych 200 znakach treści
  const prefix = content.slice(0, 200);
  return loadAll().some(e => e.content.slice(0, 200) === prefix);
}

export function addEntry(
  content: string,
  options?: { questionText?: string; note?: string; tags?: string[] }
): NotebookEntry {
  const all = loadAll();
  const entry: NotebookEntry = {
    id: `nb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: generateTitle(content),
    content,
    topic: detectTopic(content),
    note: options?.note ?? '',
    tags: options?.tags ?? [],
    savedAt: new Date().toISOString(),
    questionText: options?.questionText,
  };
  all.unshift(entry);
  // Limit: max 200 notatek
  saveAll(all.slice(0, 200));
  return entry;
}

export function removeEntry(id: string): void {
  const all = loadAll().filter(e => e.id !== id);
  saveAll(all);
}

export function updateEntry(id: string, patch: Partial<Pick<NotebookEntry, 'note' | 'tags' | 'title'>>): void {
  const all = loadAll().map(e => e.id === id ? { ...e, ...patch } : e);
  saveAll(all);
}

export function getTopics(): string[] {
  const topics = new Set(loadAll().map(e => e.topic));
  return Array.from(topics).sort();
}

export function countEntries(): number {
  return loadAll().length;
}
