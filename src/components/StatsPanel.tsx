/**
 * Formulo – Panel Statystyk
 *
 * Wizualizuje historię aktywności użytkownika:
 *  - Heatmapa aktywności (GitHub-style, ostatnie 12 tygodni)
 *  - Podsumowanie: streak, XP, poziom, rozwiązane zadania
 *  - Rozkład tematów (pasek poziomy)
 *  - Odznaki (badge wall)
 *  - Motywacyjny komunikat powrotu
 */

import React, { useMemo } from 'react';
import {
  GamificationState,
  getLevel,
  getHeatmapData,
  getShortMonthPL,
  getEarnedBadges,
  BADGES,
  HeatmapDay,
} from '../services/gamificationService';
import './StatsPanel.css';

interface StatsPanelProps {
  state: GamificationState;
  onNavigateToChat: () => void;
}

// ────────────────────────────────────────────────────────────
// Heatmapa aktywności (12 tygodni × 7 dni)
// ────────────────────────────────────────────────────────────

function getHeatColor(count: number): string {
  if (count === 0) return 'var(--heat-0)';
  if (count === 1) return 'var(--heat-1)';
  if (count <= 3)  return 'var(--heat-2)';
  if (count <= 6)  return 'var(--heat-3)';
  return 'var(--heat-4)';
}

/** Grupuje dni w tygodnie (7-elementowe tablice) */
function chunkByWeek(days: HeatmapDay[]): HeatmapDay[][] {
  const weeks: HeatmapDay[][] = [];
  // Uzupełnij pierwszy tydzień pustymi dniami jeśli nie zaczyna się od niedzieli
  const first = days[0];
  const paddingBefore = first ? first.weekday : 0;
  const padded: (HeatmapDay | null)[] = [
    ...Array(paddingBefore).fill(null),
    ...days,
  ];
  for (let i = 0; i < padded.length; i += 7) {
    weeks.push(padded.slice(i, i + 7) as HeatmapDay[]);
  }
  return weeks;
}

/** Zwraca etykiety miesięcy z pozycją kolumny (dla nagłówka heatmapy) */
function getMonthLabels(weeks: HeatmapDay[][]): { label: string; col: number }[] {
  const labels: { label: string; col: number }[] = [];
  let lastMonth = '';
  weeks.forEach((week, col) => {
    const firstDay = week.find(d => d !== null);
    if (firstDay) {
      const month = firstDay.date.substring(0, 7); // YYYY-MM
      if (month !== lastMonth) {
        lastMonth = month;
        labels.push({ label: getShortMonthPL(firstDay.date), col });
      }
    }
  });
  return labels;
}

const ActivityHeatmap: React.FC<{ days: HeatmapDay[] }> = ({ days }) => {
  const weeks = useMemo(() => chunkByWeek(days), [days]);
  const monthLabels = useMemo(() => getMonthLabels(weeks), [weeks]);
  const totalActivity = days.reduce((s, d) => s + d.count, 0);

  return (
    <div className="heatmap-wrapper">
      <div className="heatmap-header">
        <span className="heatmap-title">Aktywność (ostatnie 12 tygodni)</span>
        <span className="heatmap-total">{totalActivity} aktywności</span>
      </div>

      {/* Etykiety miesięcy */}
      <div className="heatmap-months">
        {monthLabels.map(({ label, col }) => (
          <span
            key={`${label}-${col}`}
            className="heatmap-month-label"
            style={{ gridColumn: col + 1 }}
          >
            {label}
          </span>
        ))}
      </div>

      {/* Siatka tygodni */}
      <div className="heatmap-grid">
        {/* Etykiety dni tygodnia */}
        <div className="heatmap-weekdays">
          {['Nd','Pn','Wt','Śr','Cz','Pt','Sb'].map(d => (
            <span key={d} className="heatmap-weekday">{d}</span>
          ))}
        </div>

        {/* Kolumny tygodni */}
        <div className="heatmap-weeks">
          {weeks.map((week, wi) => (
            <div key={wi} className="heatmap-week">
              {Array.from({ length: 7 }).map((_, di) => {
                const day = week[di];
                if (!day) {
                  return <div key={di} className="heatmap-cell heatmap-cell--empty" />;
                }
                const tooltip = day.count > 0
                  ? `${day.date}: ${day.count} aktywności, +${day.xp} XP`
                  : `${day.date}: brak aktywności`;
                return (
                  <div
                    key={di}
                    className="heatmap-cell"
                    style={{ backgroundColor: getHeatColor(day.count) }}
                    title={tooltip}
                    aria-label={tooltip}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Legenda */}
      <div className="heatmap-legend">
        <span>Mniej</span>
        {[0, 1, 2, 4, 7].map(v => (
          <div
            key={v}
            className="heatmap-cell heatmap-legend-cell"
            style={{ backgroundColor: getHeatColor(v) }}
          />
        ))}
        <span>Więcej</span>
      </div>
    </div>
  );
};

// ────────────────────────────────────────────────────────────
// Pasek tematów
// ────────────────────────────────────────────────────────────

const TOPIC_COLORS = [
  '#667eea','#764ba2','#f093fb','#f5576c','#4facfe',
  '#43e97b','#fa709a','#fee140','#30cfd0','#a18cd1',
];

const TopicBars: React.FC<{ topicStats: Record<string, number> }> = ({ topicStats }) => {
  const entries = Object.entries(topicStats).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (entries.length === 0) {
    return (
      <div className="stats-empty-topics">
        <span>Brak danych – rozwiąż kilka zadań, żeby zobaczyć rozkład tematów 📊</span>
      </div>
    );
  }
  const max = entries[0][1];
  return (
    <div className="topic-bars">
      {entries.map(([topic, count], i) => (
        <div key={topic} className="topic-bar-row">
          <span className="topic-bar-label">{topic}</span>
          <div className="topic-bar-track">
            <div
              className="topic-bar-fill"
              style={{
                width: `${(count / max) * 100}%`,
                backgroundColor: TOPIC_COLORS[i % TOPIC_COLORS.length],
              }}
            />
          </div>
          <span className="topic-bar-count">{count}</span>
        </div>
      ))}
    </div>
  );
};

// ────────────────────────────────────────────────────────────
// Odznaki (badge wall)
// ────────────────────────────────────────────────────────────

const BadgeWall: React.FC<{ state: GamificationState }> = ({ state }) => {
  const earned = getEarnedBadges(state);
  const earnedIds = new Set(state.badges);

  return (
    <div className="badge-wall">
      {BADGES.map(badge => {
        const isEarned = earnedIds.has(badge.id);
        return (
          <div
            key={badge.id}
            className={`badge-card ${isEarned ? 'badge-card--earned' : 'badge-card--locked'}`}
            title={isEarned ? `${badge.name}: ${badge.description}` : `Zablokowane: ${badge.description}`}
          >
            <span className="badge-icon">{badge.icon}</span>
            <span className="badge-name">{badge.name}</span>
            {!isEarned && <span className="badge-lock">🔒</span>}
          </div>
        );
      })}
      {earned.length === 0 && (
        <p className="badge-wall-empty">Jeszcze nie masz odznak. Zacznij rozwiązywać zadania!</p>
      )}
    </div>
  );
};

// ────────────────────────────────────────────────────────────
// Karty statystyk
// ────────────────────────────────────────────────────────────

interface StatCardProps {
  icon: string;
  label: string;
  value: string | number;
  sub?: string;
  highlight?: boolean;
}

const StatCard: React.FC<StatCardProps> = ({ icon, label, value, sub, highlight }) => (
  <div className={`stat-card ${highlight ? 'stat-card--highlight' : ''}`}>
    <span className="stat-card-icon">{icon}</span>
    <div className="stat-card-content">
      <span className="stat-card-value">{value}</span>
      <span className="stat-card-label">{label}</span>
      {sub && <span className="stat-card-sub">{sub}</span>}
    </div>
  </div>
);

// ────────────────────────────────────────────────────────────
// Komunikat powrotu
// ────────────────────────────────────────────────────────────

function getReturnMessage(state: GamificationState): { text: string; emoji: string } | null {
  const today = new Date().toISOString().split('T')[0];
  const last = state.lastActivityDate;
  if (!last || last === today) return null;

  const daysDiff = Math.round(
    (new Date(today).getTime() - new Date(last).getTime()) / 86400000
  );

  if (daysDiff === 1) return null; // wczoraj – pasek streak

  if (daysDiff <= 3) {
    return { text: `Byłeś tu ${daysDiff} dni temu. Wróciłeś! Dokończ serię.`, emoji: '⚡' };
  }
  if (daysDiff <= 14) {
    return { text: `Przerwa ${daysDiff} dni. Czas na powrót – matura nie czeka!`, emoji: '📚' };
  }
  return { text: `Długa przerwa (${daysDiff} dni). Zacznij od nowa – pierwsze kroki są najważniejsze.`, emoji: '🚀' };
}

// ────────────────────────────────────────────────────────────
// Główny komponent
// ────────────────────────────────────────────────────────────

const StatsPanel: React.FC<StatsPanelProps> = ({ state, onNavigateToChat }) => {
  const heatmapDays = useMemo(() => getHeatmapData(state, 84), [state]);
  const levelInfo = useMemo(() => getLevel(state.xp), [state.xp]);
  const returnMsg = useMemo(() => getReturnMessage(state), [state]);
  const earnedBadgesCount = state.badges.length;

  return (
    <div className="stats-panel">
      <div className="stats-panel-header">
        <h2 className="stats-panel-title">📊 Moje Statystyki</h2>
        <button className="stats-back-btn" onClick={onNavigateToChat}>
          ← Wróć do czatu
        </button>
      </div>

      {/* Komunikat powrotu */}
      {returnMsg && (
        <div className="stats-return-banner">
          <span className="stats-return-emoji">{returnMsg.emoji}</span>
          <span>{returnMsg.text}</span>
          <button className="stats-return-cta" onClick={onNavigateToChat}>
            Rozwiąż zadanie
          </button>
        </div>
      )}

      {/* Karty z kluczowymi statystykami */}
      <div className="stat-cards-grid">
        <StatCard
          icon="🔥"
          label="Aktualna seria"
          value={`${state.currentStreak} dni`}
          sub={`Rekord: ${state.longestStreak} dni`}
          highlight={state.currentStreak >= 3}
        />
        <StatCard
          icon="⚡"
          label="Łącznie XP"
          value={state.xp}
          sub={`Poziom ${levelInfo.level} – ${levelInfo.name}`}
        />
        <StatCard
          icon="✅"
          label="Rozwiązane zadania"
          value={state.totalSolved}
          sub={`${state.totalQuizzes} quizów`}
        />
        <StatCard
          icon="🏅"
          label="Odznaki"
          value={`${earnedBadgesCount} / ${BADGES.length}`}
          sub={state.perfectQuizzes > 0 ? `${state.perfectQuizzes} idealnych quizów` : undefined}
        />
      </div>

      {/* Pasek poziomu */}
      <div className="stats-level-bar-wrapper">
        <div className="stats-level-bar-labels">
          <span>Poziom {levelInfo.level}: <strong>{levelInfo.name}</strong></span>
          <span>{levelInfo.xpInLevel} / 100 XP do następnego poziomu</span>
        </div>
        <div className="stats-level-bar-track">
          <div
            className="stats-level-bar-fill"
            style={{ width: `${levelInfo.xpInLevel}%` }}
          />
        </div>
      </div>

      {/* Heatmapa */}
      <section className="stats-section">
        <ActivityHeatmap days={heatmapDays} />
      </section>

      {/* Rozkład tematów */}
      <section className="stats-section">
        <h3 className="stats-section-title">📐 Tematy</h3>
        <TopicBars topicStats={state.topicStats} />
        {Object.keys(state.topicStats).length === 0 && (
          <p className="stats-tip">
            💡 Wskazówka: możesz śledzić tematy wpisując np. „Rozwiąż zadanie z geometrii"
          </p>
        )}
      </section>

      {/* Odznaki */}
      <section className="stats-section">
        <h3 className="stats-section-title">🏅 Odznaki ({earnedBadgesCount}/{BADGES.length})</h3>
        <BadgeWall state={state} />
      </section>

      {/* CTA na dole */}
      <div className="stats-cta-footer">
        <button className="stats-cta-btn" onClick={onNavigateToChat}>
          🎯 Rozwiąż zadanie i zdobądź XP
        </button>
      </div>
    </div>
  );
};

export default StatsPanel;
