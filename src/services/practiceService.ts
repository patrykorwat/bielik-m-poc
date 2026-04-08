/**
 * Formulo Practice Service
 * Detects the topic of a solved problem and suggests related CKE exam problems.
 * Creates a practice loop: solve → get suggestions → solve another → ...
 */

export interface PracticeProblem {
  question: string;
  answer: string;
  options?: Record<string, string>;
  year: number;
  level: 'podstawowa' | 'rozszerzona';
  taskNumber: number;
}

export type MathTopic =
  | 'logarytmy'
  | 'trygonometria'
  | 'funkcja_kwadratowa'
  | 'geometria_plaska'
  | 'stereometria'
  | 'ciagi'
  | 'prawdopodobienstwo'
  | 'rownania'
  | 'potegi_pierwiastki'
  | 'wielomiany'
  | 'pochodne'
  | 'calki'
  | 'statystyka'
  | 'funkcja_liniowa'
  | 'uklady_rownan'
  | 'ogolne';

interface TopicPattern {
  topic: MathTopic;
  label: string;
  patterns: RegExp[];
}

const TOPIC_PATTERNS: TopicPattern[] = [
  {
    topic: 'logarytmy',
    label: 'Logarytmy',
    patterns: [/log/i, /logarytm/i, /\\log/i],
  },
  {
    topic: 'trygonometria',
    label: 'Trygonometria',
    patterns: [/sin/i, /cos/i, /tan/i, /tg\b/i, /ctg/i, /trygonometr/i, /\\sin/i, /\\cos/i, /\\tan/i],
  },
  {
    topic: 'pochodne',
    label: 'Pochodne i ekstrema',
    patterns: [/pochodn/i, /różniczk/i, /ekstr/i, /monotoniczn/i, /styczna/i, /f'\s*\(/i],
  },
  {
    topic: 'calki',
    label: 'Całki',
    patterns: [/całk/i, /\\int/i, /∫/i, /prymityw/i],
  },
  {
    topic: 'stereometria',
    label: 'Stereometria',
    patterns: [/ostrosłup/i, /graniastosłup/i, /walec/i, /stożek/i, /kula/i, /sfer/i, /objętość/i, /bryły/i, /prostopadłościan/i],
  },
  {
    topic: 'ciagi',
    label: 'Ciągi',
    patterns: [/ciąg/i, /arytmetyczn/i, /geometryczn/i, /\\{a_n\\}/i, /a_n/i, /szereg/i],
  },
  {
    topic: 'prawdopodobienstwo',
    label: 'Prawdopodobieństwo i kombinatoryka',
    patterns: [/prawdopodobie/i, /losow/i, /kostk/i, /kombinacj/i, /permutacj/i, /wariacj/i, /\\bP\s*\(/i, /dwumian/i],
  },
  {
    topic: 'funkcja_kwadratowa',
    label: 'Funkcja kwadratowa',
    patterns: [/kwadratow/i, /parabol/i, /wierzchołek/i, /x\^2/i, /x²/i, /delta/i, /dyskryminant/i, /\\Delta/i],
  },
  {
    topic: 'wielomiany',
    label: 'Wielomiany',
    patterns: [/wielomian/i, /stopnia/i, /horner/i, /dziel.*wielom/i],
  },
  {
    topic: 'geometria_plaska',
    label: 'Geometria',
    patterns: [/trójkąt/i, /prostokąt/i, /okrąg/i, /koło/i, /pole/i, /obwód/i, /kąt/i, /równoległo/i, /romb/i, /trapez/i, /pitagoras/i, /twierdzenie/i, /symetr/i],
  },
  {
    topic: 'statystyka',
    label: 'Statystyka',
    patterns: [/średni/i, /median/i, /odchylen/i, /wariancj/i, /histogram/i, /diagram/i],
  },
  {
    topic: 'potegi_pierwiastki',
    label: 'Potęgi i pierwiastki',
    patterns: [/potęg/i, /pierwiastk/i, /\\sqrt/i, /√/i, /\\frac\{1\}\{.*\}\)\^/i],
  },
  {
    topic: 'uklady_rownan',
    label: 'Układy równań',
    patterns: [/układ.*równ/i, /\\begin\{cases\}/i],
  },
  {
    topic: 'funkcja_liniowa',
    label: 'Funkcja liniowa',
    patterns: [/liniow/i, /prosta/i, /nachyleni/i, /y\s*=\s*ax\s*\+\s*b/i],
  },
  {
    topic: 'rownania',
    label: 'Równania i nierówności',
    patterns: [/równan/i, /nierównoś/i, /rozwiąz/i],
  },
];

const TOPIC_LABELS: Record<MathTopic, string> = {
  logarytmy: 'Logarytmy',
  trygonometria: 'Trygonometria',
  funkcja_kwadratowa: 'Funkcja kwadratowa',
  geometria_plaska: 'Geometria',
  stereometria: 'Stereometria',
  ciagi: 'Ciągi',
  prawdopodobienstwo: 'Prawdopodobieństwo',
  rownania: 'Równania i nierówności',
  potegi_pierwiastki: 'Potęgi i pierwiastki',
  wielomiany: 'Wielomiany',
  pochodne: 'Pochodne',
  calki: 'Całki',
  statystyka: 'Statystyka',
  funkcja_liniowa: 'Funkcja liniowa',
  uklady_rownan: 'Układy równań',
  ogolne: 'Matematyka',
};

export function getTopicLabel(topic: MathTopic): string {
  return TOPIC_LABELS[topic] || 'Matematyka';
}

/**
 * Detect mathematical topic from text (user question + AI response).
 * Returns the best matching topic based on pattern frequency.
 */
export function detectTopic(text: string): MathTopic {
  const scores: Partial<Record<MathTopic, number>> = {};

  for (const tp of TOPIC_PATTERNS) {
    let score = 0;
    for (const pattern of tp.patterns) {
      const matches = text.match(new RegExp(pattern, 'gi'));
      if (matches) {
        score += matches.length;
      }
    }
    if (score > 0) {
      scores[tp.topic] = score;
    }
  }

  // Return topic with highest score
  let bestTopic: MathTopic = 'ogolne';
  let bestScore = 0;
  for (const [topic, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestTopic = topic as MathTopic;
    }
  }

  return bestTopic;
}

/**
 * Map from our fine-grained topics to the backend TOPIC_KEYWORDS keys.
 * The backend uses simpler topic names.
 */
const TOPIC_TO_API: Partial<Record<MathTopic, string>> = {
  logarytmy: 'logarytmy',
  trygonometria: 'trygonometria',
  funkcja_kwadratowa: 'funkcje',
  geometria_plaska: 'geometria',
  stereometria: 'geometria',
  ciagi: 'ciagi',
  prawdopodobienstwo: 'prawdopodobienstwo',
  rownania: 'rownania',
  potegi_pierwiastki: 'potegi',
  wielomiany: 'rownania',
  pochodne: 'pochodne',
  calki: 'pochodne',
  statystyka: 'prawdopodobienstwo',
  funkcja_liniowa: 'funkcje',
  uklady_rownan: 'rownania',
};

/**
 * Get practice suggestions via the /api/practice endpoint.
 * Detects the topic from the conversation text and fetches related CKE problems.
 */
export async function getPracticeSuggestions(
  conversationText: string,
  count: number = 3
): Promise<{ topic: MathTopic; problems: PracticeProblem[] }> {
  const topic = detectTopic(conversationText);
  const apiTopic = TOPIC_TO_API[topic] || '';

  // Extract first ~100 chars of user question for exclusion
  const firstLine = conversationText.slice(0, 200).replace(/\n/g, ' ');

  try {
    const params = new URLSearchParams({
      topic: apiTopic,
      count: String(count),
      exclude: firstLine,
    });
    const res = await fetch(`/api/practice?${params}`);
    if (res.ok) {
      const data = await res.json();
      if (data.problems && data.problems.length > 0) {
        return {
          topic,
          problems: data.problems.map((p: any) => ({
            question: p.question,
            answer: p.answer,
            options: p.options,
            year: p.metadata?.year || 0,
            level: p.metadata?.level === 2 ? 'rozszerzona' as const : 'podstawowa' as const,
            taskNumber: p.metadata?.task_number || 0,
          })),
        };
      }
    }
  } catch {
    // Fallback to inline problems below
  }

  // Fallback: pick from inline problems
  const shuffled = [...FALLBACK_PROBLEMS].sort(() => Math.random() - 0.5);
  return { topic, problems: shuffled.slice(0, count) };
}

// Curated fallback problems for when datasets can't be loaded
const FALLBACK_PROBLEMS: PracticeProblem[] = [
  {
    question: 'Rozwiąż równanie: x² - 5x + 6 = 0',
    answer: 'x = 2 lub x = 3',
    year: 0,
    level: 'podstawowa',
    taskNumber: 0,
  },
  {
    question: 'Oblicz pochodną funkcji f(x) = 3x² + 2x - 1',
    answer: "f'(x) = 6x + 2",
    year: 0,
    level: 'podstawowa',
    taskNumber: 0,
  },
  {
    question: 'Oblicz log₂(32)',
    answer: '5',
    year: 0,
    level: 'podstawowa',
    taskNumber: 0,
  },
  {
    question: 'Oblicz sin(60°)',
    answer: '√3/2',
    year: 0,
    level: 'podstawowa',
    taskNumber: 0,
  },
  {
    question: 'Ile wynosi suma 20 pierwszych wyrazów ciągu arytmetycznego, którego pierwszy wyraz to 3 a różnica to 2?',
    answer: '440',
    year: 0,
    level: 'podstawowa',
    taskNumber: 0,
  },
  {
    question: 'Pole trójkąta o bokach 3, 4, 5 wynosi',
    answer: '6',
    year: 0,
    level: 'podstawowa',
    taskNumber: 0,
  },
  {
    question: 'Oblicz całkę ∫(2x + 3)dx',
    answer: 'x² + 3x + C',
    year: 0,
    level: 'podstawowa',
    taskNumber: 0,
  },
  {
    question: 'Średnia arytmetyczna liczb 4, 7, 10, 3, 6 wynosi',
    answer: '6',
    year: 0,
    level: 'podstawowa',
    taskNumber: 0,
  },
  {
    question: 'Rozwiąż nierówność: 2x - 3 > 5',
    answer: 'x > 4',
    year: 0,
    level: 'podstawowa',
    taskNumber: 0,
  },
  {
    question: 'Wyznacz dziedzinę funkcji f(x) = √(x - 2)',
    answer: 'x ≥ 2',
    year: 0,
    level: 'podstawowa',
    taskNumber: 0,
  },
  {
    question: 'Oblicz √(48) w postaci a√b',
    answer: '4√3',
    year: 0,
    level: 'podstawowa',
    taskNumber: 0,
  },
  {
    question: 'Ile jest sposobów na wybranie 3 osób z grupy 8?',
    answer: 'C(8,3) = 56',
    year: 0,
    level: 'podstawowa',
    taskNumber: 0,
  },
];
