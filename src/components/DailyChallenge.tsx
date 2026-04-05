import React, { useState, useEffect } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import './DailyChallenge.css';

interface DailyChallengeProps {
  onSolveInChat: (query: string) => void;
}

interface Option {
  label: 'A' | 'B' | 'C' | 'D';
  content: string;
  isCorrect: boolean;
}

interface DailyChallengeData {
  question: string;
  options: Option[];
  correctOption: 'A' | 'B' | 'C' | 'D';
  year: number;
  taskNumber: number;
}

function renderLatex(text: string): string {
  let result = text.replace(/\$\$(.+?)\$\$/gs, (_m, tex) => {
    try {
      return katex.renderToString(tex.trim(), {
        displayMode: true,
        throwOnError: false,
      });
    } catch {
      return tex;
    }
  });

  result = result.replace(/\$(.+?)\$/g, (_m, tex) => {
    try {
      return katex.renderToString(tex.trim(), {
        displayMode: false,
        throwOnError: false,
      });
    } catch {
      return tex;
    }
  });

  return result;
}

function CalendarIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
      <line x1="16" y1="2" x2="16" y2="6"></line>
      <line x1="8" y1="2" x2="8" y2="6"></line>
      <line x1="3" y1="10" x2="21" y2="10"></line>
    </svg>
  );
}

const DailyChallenge: React.FC<DailyChallengeProps> = ({ onSolveInChat }) => {
  const [challenge, setChallenge] = useState<DailyChallengeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selectedAnswer, setSelectedAnswer] = useState<'A' | 'B' | 'C' | 'D' | null>(null);
  const [isCorrect, setIsCorrect] = useState<boolean | null>(null);

  useEffect(() => {
    const fetchChallenge = async () => {
      try {
        setLoading(true);
        setError(false);
        const response = await fetch('/api/daily-challenge');
        if (!response.ok) {
          setError(true);
          setLoading(false);
          return;
        }
        const data = await response.json();
        setChallenge(data);
      } catch (err) {
        setError(true);
      } finally {
        setLoading(false);
      }
    };

    fetchChallenge();
  }, []);

  const handleOptionClick = (label: 'A' | 'B' | 'C' | 'D') => {
    if (selectedAnswer !== null) return; // Already answered

    setSelectedAnswer(label);
    setIsCorrect(label === challenge?.correctOption);
  };

  const handleSolveInChat = () => {
    if (challenge) {
      onSolveInChat(challenge.question);
    }
  };

  if (loading) {
    return (
      <div className="daily-challenge-card">
        <div className="daily-challenge-skeleton">
          <div className="skeleton-header"></div>
          <div className="skeleton-content"></div>
        </div>
      </div>
    );
  }

  if (error || !challenge) {
    return null;
  }

  return (
    <div className="daily-challenge-card">
      <div className="daily-challenge-header">
        <div className="header-icon">
          <CalendarIcon />
        </div>
        <h2 className="header-title">Zadanie dnia</h2>
      </div>

      <div className="daily-challenge-content">
        <div
          className="question-text"
          dangerouslySetInnerHTML={{ __html: renderLatex(challenge.question) }}
        />

        <div className="options-grid">
          {challenge.options.map((option) => {
            const isSelected = selectedAnswer === option.label;
            const showFeedback = selectedAnswer !== null;
            const isCorrectAnswer = option.label === challenge.correctOption;

            let buttonClass = 'option-button';
            if (showFeedback) {
              if (isCorrectAnswer) {
                buttonClass += ' correct';
              } else if (isSelected && !isCorrect) {
                buttonClass += ' incorrect';
              }
            }
            if (isSelected) {
              buttonClass += ' selected';
            }

            return (
              <button
                key={option.label}
                className={buttonClass}
                onClick={() => handleOptionClick(option.label)}
                disabled={selectedAnswer !== null}
              >
                <span className="option-label">{option.label}</span>
                <span
                  className="option-content"
                  dangerouslySetInnerHTML={{ __html: renderLatex(option.content) }}
                />
              </button>
            );
          })}
        </div>

        {selectedAnswer !== null && (
          <div className={`feedback ${isCorrect ? 'correct' : 'incorrect'}`}>
            <span className="feedback-text">
              {isCorrect ? 'Poprawnie!' : 'Błędnie!'}
            </span>
          </div>
        )}

        <div className="metadata">
          Matura podstawowa {challenge.year}, zadanie {challenge.taskNumber}
        </div>

        {selectedAnswer !== null && (
          <button className="solve-button" onClick={handleSolveInChat}>
            Rozwiąż krok po kroku
          </button>
        )}
      </div>
    </div>
  );
};

export default DailyChallenge;
