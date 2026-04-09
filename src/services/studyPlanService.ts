/**
 * Formulo Study Plan Service
 * Manages study plans for matura preparation with progress tracking
 */

const STORAGE_KEY = 'formulo-study-plan';

export interface StudyTopic {
  id: string;
  name: string;
  description: string;
  category: 'algebra' | 'analiza' | 'geometria' | 'rachunek_prawdopodobienstwa' | 'inne';
  level: 'podstawowa' | 'rozszerzona';
  estimatedMinutes: number;  // estimated time to study
  prerequisiteIds: string[]; // topics that should be completed first
}

export interface TopicProgress {
  topicId: string;
  status: 'locked' | 'available' | 'in_progress' | 'completed';
  tasksCompleted: number;
  tasksTotal: number;       // typically 5
  quizScore: number | null; // percentage 0-100
  lastPracticed: string | null; // ISO date
}

export interface StudyPlan {
  level: 'podstawowa' | 'rozszerzona';
  examDate: string;           // ISO date
  createdAt: string;
  topicOrder: string[];       // ordered topic IDs
  progress: Record<string, TopicProgress>;
  dailyGoalMinutes: number;
}

// CKE-aligned topic list for matura podstawowa
export const TOPICS_PODSTAWOWA: StudyTopic[] = [
  {
    id: 'liczby-rzeczywiste',
    name: 'Liczby rzeczywiste',
    description: 'Potęgi, pierwiastki, procenty',
    category: 'algebra',
    level: 'podstawowa',
    estimatedMinutes: 120,
    prerequisiteIds: [],
  },
  {
    id: 'wyrazenia-algebraiczne',
    name: 'Wyrażenia algebraiczne',
    description: 'Wzory skróconego mnożenia',
    category: 'algebra',
    level: 'podstawowa',
    estimatedMinutes: 90,
    prerequisiteIds: ['liczby-rzeczywiste'],
  },
  {
    id: 'rownania-nierownosci-liniowe',
    name: 'Równania i nierówności liniowe',
    description: 'Rozwiązywanie równań i nierówności liniowych',
    category: 'algebra',
    level: 'podstawowa',
    estimatedMinutes: 100,
    prerequisiteIds: ['wyrazenia-algebraiczne'],
  },
  {
    id: 'funkcja-liniowa',
    name: 'Funkcja liniowa',
    description: 'Własności funkcji liniowej',
    category: 'analiza',
    level: 'podstawowa',
    estimatedMinutes: 110,
    prerequisiteIds: ['rownania-nierownosci-liniowe'],
  },
  {
    id: 'uklady-rownan',
    name: 'Układy równań',
    description: 'Układy równań liniowych',
    category: 'algebra',
    level: 'podstawowa',
    estimatedMinutes: 100,
    prerequisiteIds: ['funkcja-liniowa'],
  },
  {
    id: 'funkcja-kwadratowa',
    name: 'Funkcja kwadratowa',
    description: 'Własności paraboli, pierwiastkami, postać ogólna',
    category: 'analiza',
    level: 'podstawowa',
    estimatedMinutes: 120,
    prerequisiteIds: ['rownania-nierownosci-liniowe'],
  },
  {
    id: 'wielomiany',
    name: 'Wielomiany',
    description: 'Rozkład wielomianów, pierwiastkami wielomianów',
    category: 'algebra',
    level: 'podstawowa',
    estimatedMinutes: 110,
    prerequisiteIds: ['funkcja-kwadratowa'],
  },
  {
    id: 'funkcje',
    name: 'Funkcje',
    description: 'Dziedzina, wartości, monotoniczność',
    category: 'analiza',
    level: 'podstawowa',
    estimatedMinutes: 100,
    prerequisiteIds: ['funkcja-liniowa'],
  },
  {
    id: 'ciagi-arytmetyczne-geometryczne',
    name: 'Ciągi arytmetyczne i geometryczne',
    description: 'Wzory na wyrazy, sumy ciągów',
    category: 'analiza',
    level: 'podstawowa',
    estimatedMinutes: 110,
    prerequisiteIds: ['funkcje'],
  },
  {
    id: 'trygonometria-podstawy',
    name: 'Trygonometria (podstawy)',
    description: 'Funkcje trygonometryczne, wartości dla kątów szczególnych',
    category: 'geometria',
    level: 'podstawowa',
    estimatedMinutes: 110,
    prerequisiteIds: ['liczby-rzeczywiste'],
  },
  {
    id: 'planimetria',
    name: 'Planimetria',
    description: 'Trójkąty, czworokąty, koła, pola i obwody',
    category: 'geometria',
    level: 'podstawowa',
    estimatedMinutes: 120,
    prerequisiteIds: ['trygonometria-podstawy'],
  },
  {
    id: 'geometria-analityczna-podstawy',
    name: 'Geometria analityczna',
    description: 'Prosta, odległość punktów',
    category: 'geometria',
    level: 'podstawowa',
    estimatedMinutes: 100,
    prerequisiteIds: ['funkcja-liniowa'],
  },
  {
    id: 'stereometria',
    name: 'Stereometria',
    description: 'Graniastosłupy, ostrosłupy, bryły obrotowe',
    category: 'geometria',
    level: 'podstawowa',
    estimatedMinutes: 120,
    prerequisiteIds: ['planimetria'],
  },
  {
    id: 'prawdopodobienstwo-statystyka',
    name: 'Prawdopodobieństwo i statystyka',
    description: 'Średnia, mediana, wariancja, podstawy prawdopodobieństwa',
    category: 'rachunek_prawdopodobienstwa',
    level: 'podstawowa',
    estimatedMinutes: 100,
    prerequisiteIds: [],
  },
  {
    id: 'logarytmy',
    name: 'Logarytmy',
    description: 'Definicja i własności logarytmów',
    category: 'algebra',
    level: 'podstawowa',
    estimatedMinutes: 80,
    prerequisiteIds: ['liczby-rzeczywiste'],
  },
];

// CKE-aligned topic list for matura rozszerzona (includes all podstawowa + additional)
export const TOPICS_ROZSZERZONA: StudyTopic[] = [
  ...TOPICS_PODSTAWOWA,
  {
    id: 'wartosc-bezwzgledna',
    name: 'Wartość bezwzględna',
    description: 'Równania i nierówności z wartością bezwzględną',
    category: 'algebra',
    level: 'rozszerzona',
    estimatedMinutes: 90,
    prerequisiteIds: ['rownania-nierownosci-liniowe'],
  },
  {
    id: 'funkcje-wymierne',
    name: 'Funkcje wymierne',
    description: 'Asymptoty, dziedzina funkcji wymiernych',
    category: 'analiza',
    level: 'rozszerzona',
    estimatedMinutes: 110,
    prerequisiteIds: ['funkcje', 'wielomiany'],
  },
  {
    id: 'funkcje-wykladnicze-logarytmiczne',
    name: 'Funkcje wykładnicze i logarytmiczne',
    description: 'Równania i nierówności wykładnicze i logarytmiczne',
    category: 'analiza',
    level: 'rozszerzona',
    estimatedMinutes: 120,
    prerequisiteIds: ['logarytmy', 'funkcje'],
  },
  {
    id: 'trygonometria-rozszerzona',
    name: 'Trygonometria (rozszerzona)',
    description: 'Tożsamości trygonometryczne, równania trygonometryczne',
    category: 'geometria',
    level: 'rozszerzona',
    estimatedMinutes: 120,
    prerequisiteIds: ['trygonometria-podstawy'],
  },
  {
    id: 'ciagi-granice-szeregi',
    name: 'Ciągi - granice i szeregi',
    description: 'Granica ciągu, szeregi geometryczne nieskończone',
    category: 'analiza',
    level: 'rozszerzona',
    estimatedMinutes: 120,
    prerequisiteIds: ['ciagi-arytmetyczne-geometryczne'],
  },
  {
    id: 'pochodne-zastosowania',
    name: 'Pochodne i zastosowania',
    description: 'Reguły różniczkowania, ekstrema funkcji',
    category: 'analiza',
    level: 'rozszerzona',
    estimatedMinutes: 140,
    prerequisiteIds: ['funkcje', 'ciagi-granice-szeregi'],
  },
  {
    id: 'kombinatoryka',
    name: 'Kombinatoryka',
    description: 'Permutacje, kombinacje, wariacje',
    category: 'rachunek_prawdopodobienstwa',
    level: 'rozszerzona',
    estimatedMinutes: 100,
    prerequisiteIds: [],
  },
  {
    id: 'rachunek-prawdopodobienstwa-rozszerzona',
    name: 'Rachunek prawdopodobieństwa',
    description: 'Rozkłady probabilistyczne, prawdopodobieństwo warunkowe',
    category: 'rachunek_prawdopodobienstwa',
    level: 'rozszerzona',
    estimatedMinutes: 120,
    prerequisiteIds: ['kombinatoryka', 'prawdopodobienstwo-statystyka'],
  },
  {
    id: 'dowody-matematyczne',
    name: 'Dowody matematyczne',
    description: 'Metody dowodzenia, indukcja matematyczna',
    category: 'inne',
    level: 'rozszerzona',
    estimatedMinutes: 110,
    prerequisiteIds: ['liczby-rzeczywiste'],
  },
  {
    id: 'geometria-analityczna-stoszkowki',
    name: 'Geometria analityczna - stożkowe',
    description: 'Parabola, elipsa, hiperbola',
    category: 'geometria',
    level: 'rozszerzona',
    estimatedMinutes: 110,
    prerequisiteIds: ['geometria-analityczna-podstawy'],
  },
];

/**
 * Get topic list based on level
 */
function getTopicsByLevel(level: 'podstawowa' | 'rozszerzona'): StudyTopic[] {
  return level === 'podstawowa' ? TOPICS_PODSTAWOWA : TOPICS_ROZSZERZONA;
}

/**
 * Get next exam date (May of next year if before May, otherwise May this year)
 */
function getDefaultExamDate(): string {
  const now = new Date();
  let year = now.getFullYear();

  // If we're past May, next exam is next year
  if (now.getMonth() > 4) { // May is month 4 (0-indexed)
    year += 1;
  }

  // Return May 5th (typically when matura starts in Poland)
  return `${year}-05-05`;
}

/**
 * Create a new study plan
 */
export function createStudyPlan(
  level: 'podstawowa' | 'rozszerzona',
  examDate: string = getDefaultExamDate(),
  dailyGoalMinutes: number = 30
): StudyPlan {
  const topics = getTopicsByLevel(level);
  const topicOrder = topics.map((t) => t.id);
  const progress: Record<string, TopicProgress> = {};

  // Initialize progress for all topics
  topicOrder.forEach((topicId, index) => {
    const isFirst = index === 0;
    const status = isFirst ? 'available' : 'locked';

    progress[topicId] = {
      topicId,
      status,
      tasksCompleted: 0,
      tasksTotal: 5,
      quizScore: null,
      lastPracticed: null,
    };
  });

  const plan: StudyPlan = {
    level,
    examDate,
    createdAt: new Date().toISOString(),
    topicOrder,
    progress,
    dailyGoalMinutes,
  };

  return plan;
}

/**
 * Load study plan from localStorage
 */
export function loadStudyPlan(): StudyPlan | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const plan: StudyPlan = JSON.parse(stored);
      // Napraw datę matury jeśli jest nieaktualna (np. z poprzedniego roku szkolnego)
      const correctDate = getDefaultExamDate();
      if (plan.examDate !== correctDate) {
        plan.examDate = correctDate;
        saveStudyPlan(plan);
      }
      return plan;
    }
  } catch (error) {
    console.warn('Failed to load study plan:', error);
  }
  return null;
}

/**
 * Save study plan to localStorage
 */
export function saveStudyPlan(plan: StudyPlan): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(plan));
  } catch (error) {
    console.warn('Failed to save study plan:', error);
  }
}

/**
 * Delete study plan from localStorage
 */
export function deleteStudyPlan(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn('Failed to delete study plan:', error);
  }
}

/**
 * Update topic progress
 */
export function updateTopicProgress(
  topicId: string,
  update: Partial<TopicProgress>
): StudyPlan {
  const plan = loadStudyPlan();
  if (!plan) {
    throw new Error('No study plan loaded');
  }

  const currentProgress = plan.progress[topicId];
  if (!currentProgress) {
    throw new Error(`Topic ${topicId} not found in study plan`);
  }

  plan.progress[topicId] = {
    ...currentProgress,
    ...update,
    lastPracticed: new Date().toISOString().split('T')[0],
  };

  // Update prerequisites unlock status
  const topics = getTopicsByLevel(plan.level);
  const topicIndex = plan.topicOrder.indexOf(topicId);

  // If topic is completed, unlock next topic
  if (update.status === 'completed' && topicIndex < plan.topicOrder.length - 1) {
    const nextTopicId = plan.topicOrder[topicIndex + 1];
    const nextTopic = topics.find((t) => t.id === nextTopicId);

    if (nextTopic) {
      const prerequisitesCompleted = nextTopic.prerequisiteIds.every(
        (prereqId) => plan.progress[prereqId]?.status === 'completed'
      );

      if (prerequisitesCompleted) {
        plan.progress[nextTopicId].status = 'available';
      }
    }
  }

  saveStudyPlan(plan);
  return plan;
}

/**
 * Get recommended topics to study next (respecting prerequisites)
 */
export function getRecommendedTopics(plan: StudyPlan): string[] {
  const topics = getTopicsByLevel(plan.level);
  const topicsToReturn: string[] = [];

  // Find up to 3 available topics
  for (const topicId of plan.topicOrder) {
    const progress = plan.progress[topicId];
    const topic = topics.find((t) => t.id === topicId);

    if (!topic) continue;

    // Only recommend available or in_progress topics
    if (progress.status === 'available' || progress.status === 'in_progress') {
      if (progress.status === 'available') {
        progress.status = 'in_progress'; // Mark as in progress when first recommended
      }
      topicsToReturn.push(topicId);

      if (topicsToReturn.length >= 3) break;
    }
  }

  if (topicsToReturn.length > 0) {
    saveStudyPlan(plan);
  }

  return topicsToReturn;
}

/**
 * Calculate days until exam
 */
export function getDaysUntilExam(plan: StudyPlan): number {
  const examDate = new Date(plan.examDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  examDate.setHours(0, 0, 0, 0);

  const diffTime = examDate.getTime() - today.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  return Math.max(0, diffDays);
}

/**
 * Calculate overall progress as percentage
 */
export function getOverallProgress(plan: StudyPlan): number {
  const totalTopics = plan.topicOrder.length;
  if (totalTopics === 0) return 0;

  const completedTopics = plan.topicOrder.filter(
    (topicId) => plan.progress[topicId]?.status === 'completed'
  ).length;

  return Math.round((completedTopics / totalTopics) * 100);
}

/**
 * Get suggested daily study schedule
 */
export function getStudySchedule(
  plan: StudyPlan
): { date: string; topicIds: string[] }[] {
  const schedule: { date: string; topicIds: string[] }[] = [];
  const daysUntilExam = getDaysUntilExam(plan);

  // Get topics that still need to be completed
  const remainingTopics = plan.topicOrder.filter(
    (topicId) => plan.progress[topicId]?.status !== 'completed'
  );

  if (remainingTopics.length === 0 || daysUntilExam <= 0) {
    return schedule;
  }

  // Distribute remaining topics evenly across remaining days
  const topicsPerDay = Math.max(1, Math.ceil(remainingTopics.length / daysUntilExam));

  let topicIndex = 0;
  const today = new Date();

  for (let day = 0; day < daysUntilExam && topicIndex < remainingTopics.length; day++) {
    const scheduleDate = new Date(today);
    scheduleDate.setDate(scheduleDate.getDate() + day);
    const dateStr = scheduleDate.toISOString().split('T')[0];

    const dayTopics: string[] = [];
    for (let i = 0; i < topicsPerDay && topicIndex < remainingTopics.length; i++) {
      dayTopics.push(remainingTopics[topicIndex]);
      topicIndex += 1;
    }

    if (dayTopics.length > 0) {
      schedule.push({ date: dateStr, topicIds: dayTopics });
    }
  }

  return schedule;
}

/**
 * Get category from topic ID
 */
export function getCategoryLabel(
  category: 'algebra' | 'analiza' | 'geometria' | 'rachunek_prawdopodobienstwa' | 'inne'
): string {
  const labels: Record<string, string> = {
    algebra: 'Algebra',
    analiza: 'Analiza',
    geometria: 'Geometria',
    rachunek_prawdopodobienstwa: 'Rachunek prawdopodobieństwa',
    inne: 'Inne',
  };
  return labels[category] || 'Inne';
}

/**
 * Get category progress
 */
export function getCategoryProgress(
  plan: StudyPlan,
  category: string
): { completed: number; total: number } {
  const topics = getTopicsByLevel(plan.level).filter((t) => t.category === category);
  const completed = topics.filter(
    (t) => plan.progress[t.id]?.status === 'completed'
  ).length;

  return {
    completed,
    total: topics.length,
  };
}
