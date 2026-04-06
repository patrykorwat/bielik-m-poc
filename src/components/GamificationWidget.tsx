/**
 * Formulo Gamification Widget
 * Displays gamification stats: streak, level, XP, and badges
 */

import React, { useState } from 'react';
import {
  GamificationState,
  getLevel,
  getRecentBadges,
  getEarnedBadges,
  getBadgeById,
} from '../services/gamificationService';
import './GamificationWidget.css';

interface GamificationWidgetProps {
  state: GamificationState;
  compact?: boolean; // if true, show just streak + level inline
}

// Flame icon SVG
const FlameIcon = () => (
  <svg
    className="flame-icon"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M12 2C12 2 7 8 7 13c0 2.76 2.24 5 5 5s5-2.24 5-5c0-5-5-11-5-11z"
      fill="currentColor"
    />
  </svg>
);

// Star icon SVG
const StarIcon = () => (
  <svg
    className="star-icon"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
      fill="currentColor"
    />
  </svg>
);

// Trophy icon SVG
const TrophyIcon = () => (
  <svg
    className="trophy-icon"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M12 1l8 5h-2v3h2l-2 8H6l-2-8h2V6h-2l8-5zm0 4l-3 2h6l-3-2z"
      fill="currentColor"
    />
  </svg>
);

// Badge circular icon with gradient
const BadgeCircle: React.FC<{ badgeId: string }> = ({ badgeId }) => {
  const badge = getBadgeById(badgeId);
  if (!badge) return null;

  return (
    <div className="badge-circle" title={badge.name}>
      <svg className="badge-svg" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id={`grad-${badgeId}`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#667eea" />
            <stop offset="100%" stopColor="#764ba2" />
          </linearGradient>
        </defs>
        <circle cx="32" cy="32" r="30" fill={`url(#grad-${badgeId})`} />
        <circle cx="32" cy="32" r="28" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="1" />
        <text
          x="32"
          y="40"
          textAnchor="middle"
          fill="white"
          fontSize="24"
          fontWeight="bold"
          dominantBaseline="middle"
        >
          {badge.icon}
        </text>
      </svg>
    </div>
  );
};

// Tooltip component for badges
const BadgeTooltip: React.FC<{ badgeId: string }> = ({ badgeId }) => {
  const badge = getBadgeById(badgeId);
  if (!badge) return null;

  return (
    <div className="badge-tooltip">
      <div className="badge-tooltip-name">{badge.name}</div>
      <div className="badge-tooltip-desc">{badge.description}</div>
    </div>
  );
};

/**
 * Main widget component
 */
export const GamificationWidget: React.FC<GamificationWidgetProps> = ({
  state,
  compact = false,
}) => {
  const [showBadgesModal, setShowBadgesModal] = useState(false);
  const [badgeHovered, setBadgeHovered] = useState<string | null>(null);

  const level = getLevel(state.xp);
  const recentBadges = getRecentBadges(state, 3);
  const allBadges = getEarnedBadges(state);

  if (compact) {
    return (
      <div className="gamification-widget compact">
        <div className="widget-streak">
          <FlameIcon />
          <span className="streak-count">{state.currentStreak}</span>
        </div>
        <div className="widget-level">
          <span className="level-number">{level.level}</span>
          <span className="level-name">{level.name}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="gamification-widget">
      {/* Streak Section */}
      <div className="widget-section streak-section">
        <div className="section-header">
          <FlameIcon />
          <span className="section-title">Seria</span>
        </div>
        <div className="section-content">
          <div className="streak-display">
            <div className="streak-current">
              <span className="streak-label">Dzisiaj</span>
              <span className="streak-value">{state.currentStreak}</span>
            </div>
            <div className="streak-longest">
              <span className="streak-label">Najdłużej</span>
              <span className="streak-value">{state.longestStreak}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Level Section */}
      <div className="widget-section level-section">
        <div className="section-header">
          <StarIcon />
          <span className="section-title">Poziom</span>
        </div>
        <div className="section-content">
          <div className="level-display">
            <div className="level-main">
              <span className="level-number">{level.level}</span>
              <span className="level-text">{level.name}</span>
            </div>
            <div className="xp-bar-container">
              <div className="xp-bar-background">
                <div
                  className="xp-bar-fill"
                  style={{
                    width: `${(level.xpInLevel / 100) * 100}%`,
                  }}
                />
              </div>
              <span className="xp-text">
                {level.xpInLevel}/100 XP
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Stats Section */}
      <div className="widget-section stats-section">
        <div className="section-header">
          <TrophyIcon />
          <span className="section-title">Statystyki</span>
        </div>
        <div className="section-content">
          <div className="stats-grid">
            <div className="stat-item">
              <span className="stat-label">Rozwiązane</span>
              <span className="stat-value">{state.totalSolved}</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">Quizy</span>
              <span className="stat-value">{state.totalQuizzes}</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">Idealne</span>
              <span className="stat-value">{state.perfectQuizzes}</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">Tematy</span>
              <span className="stat-value">{Object.keys(state.topicStats).length}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Badges Section */}
      <div className="widget-section badges-section">
        <div className="section-header">
          <span className="section-title">Odznaki ({allBadges.length})</span>
        </div>
        <div className="section-content">
          <div className="badges-display">
            {recentBadges.length > 0 ? (
              <>
                <div className="recent-badges">
                  {recentBadges.map((badge) => (
                    <div
                      key={badge.id}
                      className="badge-wrapper"
                      onMouseEnter={() => setBadgeHovered(badge.id)}
                      onMouseLeave={() => setBadgeHovered(null)}
                    >
                      <BadgeCircle badgeId={badge.id} />
                      {badgeHovered === badge.id && <BadgeTooltip badgeId={badge.id} />}
                    </div>
                  ))}
                </div>
                {allBadges.length > 3 && (
                  <button
                    className="view-all-badges-btn"
                    onClick={() => setShowBadgesModal(!showBadgesModal)}
                  >
                    +{allBadges.length - 3} więcej
                  </button>
                )}
              </>
            ) : (
              <div className="no-badges">Brak odznak. Zacznij rozwiązywać zadania!</div>
            )}
          </div>
        </div>
      </div>

      {/* All Badges Modal */}
      {showBadgesModal && (
        <div className="badges-modal-overlay" onClick={() => setShowBadgesModal(false)}>
          <div className="badges-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Wszystkie Odznaki ({allBadges.length})</h3>
              <button
                className="modal-close"
                onClick={() => setShowBadgesModal(false)}
              >
                ✕
              </button>
            </div>
            <div className="modal-content">
              <div className="badges-grid">
                {allBadges.map((badge) => (
                  <div
                    key={badge.id}
                    className="badge-card"
                    onMouseEnter={() => setBadgeHovered(badge.id)}
                    onMouseLeave={() => setBadgeHovered(null)}
                  >
                    <BadgeCircle badgeId={badge.id} />
                    {badgeHovered === badge.id && <BadgeTooltip badgeId={badge.id} />}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default GamificationWidget;
