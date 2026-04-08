import React, { useState, useEffect } from 'react';
import {
  getPracticeSuggestions,
  getTopicLabel,
  PracticeProblem,
  MathTopic,
} from '../services/practiceService';
import { MessageContent } from './MessageContent';
import './PracticeSuggestions.css';

interface PracticeSuggestionsProps {
  /** Combined text from user question + AI response for topic detection */
  conversationText: string;
  /** Called when user clicks a suggested problem to solve it */
  onSolve: (query: string) => void;
}

function RefreshIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

function BookIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

const PracticeSuggestions: React.FC<PracticeSuggestionsProps> = ({
  conversationText,
  onSolve,
}) => {
  const [problems, setProblems] = useState<PracticeProblem[]>([]);
  const [topic, setTopic] = useState<MathTopic>('ogolne');
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);

  const loadSuggestions = async () => {
    setLoading(true);
    try {
      const result = await getPracticeSuggestions(conversationText, 3);
      setProblems(result.problems);
      setTopic(result.topic);
    } catch {
      setProblems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSuggestions();
  }, [conversationText]);

  if (dismissed || (!loading && problems.length === 0)) {
    return null;
  }

  const handleSolve = (problem: PracticeProblem) => {
    // Format the question text for the chat input, stripping LaTeX commands for readability
    let query = problem.question;
    // If it has MC options, append them
    if (problem.options) {
      const optionLines = Object.entries(problem.options)
        .map(([key, val]) => `${key.toUpperCase()}) ${val}`)
        .join(', ');
      query += `\nOpcje: ${optionLines}`;
    }
    onSolve(query);
  };

  const handleRefresh = () => {
    loadSuggestions();
  };

  /**
   * Truncate a LaTeX question to a readable preview.
   * Keeps first ~120 characters and adds ellipsis if longer.
   */
  const truncateQuestion = (q: string): string => {
    if (q.length <= 140) return q;
    // Try to cut at a word boundary
    const cut = q.lastIndexOf(' ', 140);
    return q.slice(0, cut > 80 ? cut : 140) + '...';
  };

  return (
    <div className="practice-suggestions">
      <div className="practice-header">
        <div className="practice-title">
          <BookIcon />
          <span>Ćwicz dalej: {getTopicLabel(topic)}</span>
        </div>
        <div className="practice-actions">
          <button
            className="practice-refresh-btn"
            onClick={handleRefresh}
            disabled={loading}
            title="Załaduj inne zadania"
          >
            <RefreshIcon />
          </button>
          <button
            className="practice-dismiss-btn"
            onClick={() => setDismissed(true)}
            title="Zamknij"
          >
            ×
          </button>
        </div>
      </div>

      {loading ? (
        <div className="practice-loading">
          <div className="practice-loading-dot" />
          <div className="practice-loading-dot" />
          <div className="practice-loading-dot" />
        </div>
      ) : (
        <div className="practice-cards">
          {problems.map((problem, idx) => (
            <button
              key={idx}
              className="practice-card"
              onClick={() => handleSolve(problem)}
            >
              <div className="practice-card-content">
                <div className="practice-card-meta">
                  {problem.year > 0 && (
                    <span className="practice-badge">
                      CKE {problem.year}
                    </span>
                  )}
                  {problem.year > 0 && (
                    <span className="practice-badge practice-badge-level">
                      {problem.level === 'rozszerzona' ? 'Rozszerzona' : 'Podstawowa'}
                    </span>
                  )}
                </div>
                <div className="practice-card-question">
                  <MessageContent content={truncateQuestion(problem.question)} />
                </div>
              </div>
              <div className="practice-card-arrow">
                <ArrowRightIcon />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default PracticeSuggestions;
