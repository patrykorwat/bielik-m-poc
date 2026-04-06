/**
 * Formulo Gamification Service
 * Tracks user achievements, streaks, levels, and badges using localStorage
 */

const STORAGE_KEY = 'formulo-gamification';

export interface GamificationState {
  currentStreak: number;        // consecutive days with at least 1 solved task
  longestStreak: number;
  lastActivityDate: string;     // ISO date string (YYYY-MM-DD)
  totalSolved: number;
  totalQuizzes: number;
  perfectQuizzes: number;       // quizzes with 100% score
  topicStats: Record<string, number>;  // topic -> count of solved tasks
  badges: string[];             // earned badge IDs
  xp: number;                   // experience points
}

export interface Badge {
  id: string;
  name: string;
  description: string;
  icon: string;         // SVG path or icon identifier
  condition: (state: GamificationState) => boolean;
}

// Level names in Polish
const LEVEL_NAMES = [
  'Początkujący',    // 0-99 XP
  'Uczeń',           // 100-199 XP
  'Adept',           // 200-299 XP
  'Matematyk',       // 300-399 XP
  'Mistrz',          // 400-499 XP
  'Ekspert',         // 500-599 XP
  'Geniusz',         // 600+ XP
];

/**
 * All available badges
 */
export const BADGES: Badge[] = [
  {
    id: 'first_solve',
    name: 'Pierwsze Kroki',
    description: 'Rozwiąż pierwsze zadanie',
    icon: '✓',
    condition: (state) => state.totalSolved >= 1,
  },
  {
    id: 'streak_3',
    name: 'Trzy Dni',
    description: 'Rozwiązuj zadania przez 3 dni z rzędu',
    icon: '🔥',
    condition: (state) => state.longestStreak >= 3,
  },
  {
    id: 'streak_7',
    name: 'Tydzień',
    description: 'Rozwiązuj zadania przez 7 dni z rzędu',
    icon: '🔥',
    condition: (state) => state.longestStreak >= 7,
  },
  {
    id: 'streak_30',
    name: 'Miesiąc',
    description: 'Rozwiązuj zadania przez 30 dni z rzędu',
    icon: '🔥',
    condition: (state) => state.longestStreak >= 30,
  },
  {
    id: 'solver_10',
    name: 'Rozwiązywacz',
    description: 'Rozwiąż 10 zadań',
    icon: '⚡',
    condition: (state) => state.totalSolved >= 10,
  },
  {
    id: 'solver_50',
    name: 'Weteran',
    description: 'Rozwiąż 50 zadań',
    icon: '⚡',
    condition: (state) => state.totalSolved >= 50,
  },
  {
    id: 'solver_100',
    name: 'Legenda',
    description: 'Rozwiąż 100 zadań',
    icon: '⚡',
    condition: (state) => state.totalSolved >= 100,
  },
  {
    id: 'quiz_perfect',
    name: 'Idealny Quiz',
    description: 'Ukończ quiz z wynikiem 100%',
    icon: '✨',
    condition: (state) => state.perfectQuizzes >= 1,
  },
  {
    id: 'quiz_master',
    name: 'Quiz Master',
    description: 'Ukończ 10 quizów',
    icon: '✨',
    condition: (state) => state.totalQuizzes >= 10,
  },
  {
    id: 'multi_topic',
    name: 'Wszechstronny',
    description: 'Rozwiąż zadania z 5 różnych tematów',
    icon: '🎓',
    condition: (state) => Object.keys(state.topicStats).length >= 5,
  },
  {
    id: 'xp_1000',
    name: 'Tysiąc Punktów',
    description: 'Zdobądź 1000 XP',
    icon: '👑',
    condition: (state) => state.xp >= 1000,
  },
];

/**
 * Get the current date as ISO string (YYYY-MM-DD)
 */
function getTodayISO(): string {
  const now = new Date();
  return now.toISOString().split('T')[0];
}

/**
 * Get the date string for yesterday
 */
function getYesterdayISO(): string {
  const now = new Date();
  now.setDate(now.getDate() - 1);
  return now.toISOString().split('T')[0];
}

/**
 * Load gamification state from localStorage
 */
export function loadGamificationState(): GamificationState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (error) {
    console.warn('Failed to load gamification state:', error);
  }

  // Return default state
  return {
    currentStreak: 0,
    longestStreak: 0,
    lastActivityDate: '',
    totalSolved: 0,
    totalQuizzes: 0,
    perfectQuizzes: 0,
    topicStats: {},
    badges: [],
    xp: 0,
  };
}

/**
 * Save gamification state to localStorage
 */
function saveGamificationState(state: GamificationState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn('Failed to save gamification state:', error);
  }
}

/**
 * Update streak based on today's activity
 */
function updateStreak(state: GamificationState): GamificationState {
  const today = getTodayISO();
  const yesterday = getYesterdayISO();
  const { lastActivityDate, currentStreak, longestStreak } = state;

  // If no previous activity, start streak at 1
  if (!lastActivityDate) {
    return {
      ...state,
      currentStreak: 1,
      longestStreak: Math.max(longestStreak, 1),
      lastActivityDate: today,
    };
  }

  // If already did activity today, no change
  if (lastActivityDate === today) {
    return state;
  }

  // If activity was yesterday, continue streak
  if (lastActivityDate === yesterday) {
    const newStreak = currentStreak + 1;
    return {
      ...state,
      currentStreak: newStreak,
      longestStreak: Math.max(longestStreak, newStreak),
      lastActivityDate: today,
    };
  }

  // More than 1 day gap, reset streak
  return {
    ...state,
    currentStreak: 1,
    lastActivityDate: today,
  };
}

/**
 * Record a solved task
 * Call this after successful task solve
 */
export function recordSolve(topic?: string): GamificationState {
  let state = loadGamificationState();

  // Update streak
  state = updateStreak(state);

  // Increment counters
  state.totalSolved += 1;
  state.xp += 10; // +10 XP per solve

  // Add daily streak bonus (for each day in current streak)
  state.xp += Math.min(state.currentStreak, 7) * 5; // max +35 XP for streak

  // Update topic stats
  if (topic) {
    state.topicStats[topic] = (state.topicStats[topic] || 0) + 1;
  }

  saveGamificationState(state);
  return state;
}

/**
 * Record a completed quiz
 * score: number of correct answers
 * total: total number of questions
 */
export function recordQuiz(score: number, total: number): GamificationState {
  let state = loadGamificationState();

  // Update streak
  state = updateStreak(state);

  // Increment quiz counter
  state.totalQuizzes += 1;

  // Add XP for correct answers (5 XP per correct)
  state.xp += score * 5;

  // Check for perfect quiz
  if (score === total) {
    state.perfectQuizzes += 1;
    state.xp += 25; // +25 XP bonus for perfect quiz
  }

  saveGamificationState(state);
  return state;
}

/**
 * Check and award new badges
 * Returns newly earned badge IDs
 */
export function checkBadges(state: GamificationState): string[] {
  const newBadges: string[] = [];

  for (const badge of BADGES) {
    // Check if badge condition is met and not already earned
    if (badge.condition(state) && !state.badges.includes(badge.id)) {
      newBadges.push(badge.id);
      state.badges.push(badge.id);
    }
  }

  // Save updated state with new badges
  if (newBadges.length > 0) {
    saveGamificationState(state);
  }

  return newBadges;
}

/**
 * Get current level based on XP
 * Every 100 XP = 1 level
 */
export function getLevel(xp: number): {
  level: number;
  name: string;
  xpForNext: number;
  xpInLevel: number;
} {
  const level = Math.floor(xp / 100);
  const levelIndex = Math.min(level, LEVEL_NAMES.length - 1);
  const name = LEVEL_NAMES[levelIndex];

  const xpInLevel = xp % 100;
  const xpForNext = 100 - xpInLevel;

  return {
    level,
    name,
    xpForNext,
    xpInLevel,
  };
}

/**
 * Get badge by ID
 */
export function getBadgeById(id: string): Badge | undefined {
  return BADGES.find((badge) => badge.id === id);
}

/**
 * Reset all gamification data (for testing/debugging)
 */
export function resetGamification(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Get all earned badges with full info
 */
export function getEarnedBadges(state: GamificationState): Badge[] {
  return state.badges
    .map((id) => getBadgeById(id))
    .filter((badge): badge is Badge => badge !== undefined);
}

/**
 * Get recent badges (last N earned)
 */
export function getRecentBadges(state: GamificationState, count: number = 3): Badge[] {
  const earned = getEarnedBadges(state);
  return earned.slice(-count);
}
