import React, { useState, useEffect } from 'react';
import './StudyPlan.css';
import {
  createStudyPlan,
  loadStudyPlan,
  deleteStudyPlan,
  updateTopicProgress,
  getRecommendedTopics,
  getDaysUntilExam,
  getOverallProgress,
  StudyPlan as StudyPlanType,
  TOPICS_PODSTAWOWA,
  TOPICS_ROZSZERZONA,
  getCategoryLabel,
  getCategoryProgress,
} from '../services/studyPlanService';

interface StudyPlanProps {
  onSubmitQuery: (query: string) => void;
  onNavigateToChat: () => void;
}

type Screen = 'setup' | 'dashboard' | 'topic-detail';

function LockIcon() {
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
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12"></polyline>
    </svg>
  );
}

function ArrowBackIcon() {
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
      <line x1="19" y1="12" x2="5" y2="12"></line>
      <polyline points="12 19 5 12 12 5"></polyline>
    </svg>
  );
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

function TargetIcon() {
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
      <circle cx="12" cy="12" r="1"></circle>
      <circle cx="12" cy="12" r="5"></circle>
      <circle cx="12" cy="12" r="9"></circle>
    </svg>
  );
}


function DeleteIcon() {
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
      <polyline points="3 6 5 6 21 6"></polyline>
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      <line x1="10" y1="11" x2="10" y2="17"></line>
      <line x1="14" y1="11" x2="14" y2="17"></line>
    </svg>
  );
}

const StudyPlan: React.FC<StudyPlanProps> = ({ onSubmitQuery, onNavigateToChat }) => {
  const [screen, setScreen] = useState<Screen>('setup');
  const [plan, setPlan] = useState<StudyPlanType | null>(null);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Setup form state
  const [selectedLevel, setSelectedLevel] = useState<'podstawowa' | 'rozszerzona'>('podstawowa');
  const [examDate, setExamDate] = useState(() => {
    const nextYear = new Date();
    nextYear.setFullYear(nextYear.getFullYear() + 1);
    nextYear.setMonth(4); // May
    nextYear.setDate(5);
    return nextYear.toISOString().split('T')[0];
  });
  const [dailyGoal, setDailyGoal] = useState(30);

  useEffect(() => {
    const savedPlan = loadStudyPlan();
    if (savedPlan) {
      setPlan(savedPlan);
      setScreen('dashboard');
    } else {
      setScreen('setup');
    }
  }, []);

  const handleStartPlan = () => {
    const newPlan = createStudyPlan(selectedLevel, examDate, dailyGoal);
    setPlan(newPlan);
    setScreen('dashboard');
  };

  const handleDeletePlan = () => {
    deleteStudyPlan();
    setPlan(null);
    setScreen('setup');
    setShowDeleteConfirm(false);
  };

  const handleTopicClick = (topicId: string) => {
    setSelectedTopicId(topicId);
    setScreen('topic-detail');
  };

  const handleSubmitTask = (taskNumber: number) => {
    if (!selectedTopicId || !plan) return;

    const topics = plan.level === 'podstawowa' ? TOPICS_PODSTAWOWA : TOPICS_ROZSZERZONA;
    const topic = topics.find((t) => t.id === selectedTopicId);
    if (!topic) return;

    const query = `Wygeneruj zadanie ${taskNumber}/5 z ${topic.name} na poziomie matury ${plan.level === 'podstawowa' ? 'podstawowej' : 'rozszerzonej'}`;
    onSubmitQuery(query);
    onNavigateToChat();

    // Mark topic as in progress and increment task count
    const updatedPlan = updateTopicProgress(selectedTopicId, {
      status: 'in_progress',
      tasksCompleted: Math.max(
        plan.progress[selectedTopicId].tasksCompleted,
        taskNumber
      ),
    });
    setPlan(updatedPlan);
  };

  const handleCompleteQuiz = () => {
    if (!selectedTopicId || !plan) return;

    const topics = plan.level === 'podstawowa' ? TOPICS_PODSTAWOWA : TOPICS_ROZSZERZONA;
    const topic = topics.find((t) => t.id === selectedTopicId);
    if (!topic) return;

    const query = `Wygeneruj quiz z ${topic.name} na poziomie matury ${plan.level === 'podstawowa' ? 'podstawowej' : 'rozszerzonej'} - 5 pytań wielokrotnego wyboru`;
    onSubmitQuery(query);
    onNavigateToChat();
  };

  const handleMarkComplete = () => {
    if (!selectedTopicId) return;

    const updatedPlan = updateTopicProgress(selectedTopicId, {
      status: 'completed',
      tasksCompleted: 5,
      quizScore: 100,
    });
    setPlan(updatedPlan);
    setScreen('dashboard');
    setSelectedTopicId(null);
  };

  if (!plan) {
    return <SetupScreen {...{ selectedLevel, setSelectedLevel, examDate, setExamDate, dailyGoal, setDailyGoal, onStartPlan: handleStartPlan }} />;
  }

  if (screen === 'dashboard') {
    return <DashboardScreen {...{ plan, onTopicClick: handleTopicClick, onDeletePlan: handleDeletePlan, showDeleteConfirm, setShowDeleteConfirm }} />;
  }

  if (screen === 'topic-detail' && selectedTopicId) {
    const topics = plan.level === 'podstawowa' ? TOPICS_PODSTAWOWA : TOPICS_ROZSZERZONA;
    const topic = topics.find((t) => t.id === selectedTopicId);
    const progress = plan.progress[selectedTopicId];

    if (!topic || !progress) {
      return null;
    }

    return (
      <TopicDetailScreen
        topic={topic}
        progress={progress}
        onBack={() => {
          setScreen('dashboard');
          setSelectedTopicId(null);
        }}
        onSubmitTask={handleSubmitTask}
        onCompleteQuiz={handleCompleteQuiz}
        onMarkComplete={handleMarkComplete}
      />
    );
  }

  return null;
};

interface SetupScreenProps {
  selectedLevel: 'podstawowa' | 'rozszerzona';
  setSelectedLevel: (level: 'podstawowa' | 'rozszerzona') => void;
  examDate: string;
  setExamDate: (date: string) => void;
  dailyGoal: number;
  setDailyGoal: (goal: number) => void;
  onStartPlan: () => void;
}

const SetupScreen: React.FC<SetupScreenProps> = ({
  selectedLevel,
  setSelectedLevel,
  examDate,
  setExamDate,
  dailyGoal,
  setDailyGoal,
  onStartPlan,
}) => {
  return (
    <div className="study-plan-container">
      <div className="setup-card">
        <h1 className="setup-title">Przygotuj się do matury</h1>

        <div className="setup-section">
          <label className="setup-label">Poziom egzaminu</label>
          <div className="level-buttons">
            <button
              className={`level-btn ${selectedLevel === 'podstawowa' ? 'active' : ''}`}
              onClick={() => setSelectedLevel('podstawowa')}
            >
              Podstawowa
            </button>
            <button
              className={`level-btn ${selectedLevel === 'rozszerzona' ? 'active' : ''}`}
              onClick={() => setSelectedLevel('rozszerzona')}
            >
              Rozszerzona
            </button>
          </div>
        </div>

        <div className="setup-section">
          <label className="setup-label">Data egzaminu</label>
          <input
            type="date"
            className="date-input"
            value={examDate}
            onChange={(e) => setExamDate(e.target.value)}
          />
        </div>

        <div className="setup-section">
          <label className="setup-label">
            Dzienna norma nauki: <span className="goal-value">{dailyGoal} min</span>
          </label>
          <input
            type="range"
            min="15"
            max="120"
            step="5"
            value={dailyGoal}
            onChange={(e) => setDailyGoal(parseInt(e.target.value))}
            className="slider"
          />
          <div className="slider-labels">
            <span>15 min</span>
            <span>120 min</span>
          </div>
        </div>

        <button className="start-button" onClick={onStartPlan}>
          Rozpocznij
        </button>
      </div>
    </div>
  );
};

interface DashboardScreenProps {
  plan: StudyPlanType;
  onTopicClick: (topicId: string) => void;
  onDeletePlan: () => void;
  showDeleteConfirm: boolean;
  setShowDeleteConfirm: (show: boolean) => void;
}

const DashboardScreen: React.FC<DashboardScreenProps> = ({
  plan,
  onTopicClick,
  onDeletePlan,
  showDeleteConfirm,
  setShowDeleteConfirm,
}) => {
  const topics = plan.level === 'podstawowa' ? TOPICS_PODSTAWOWA : TOPICS_ROZSZERZONA;
  const daysUntilExam = getDaysUntilExam(plan);
  const overallProgress = getOverallProgress(plan);
  const recommendedTopicIds = getRecommendedTopics(plan);

  const categories = Array.from(new Set(topics.map((t) => t.category)));

  return (
    <div className="study-plan-container">
      <div className="dashboard-card">
        <div className="dashboard-header">
          <h1 className="dashboard-title">Plan nauki do matury</h1>
          <div className="header-info">
            <div className="info-item">
              <CalendarIcon />
              <span>{daysUntilExam} dni do egzaminu</span>
            </div>
            <div className="info-item">
              <TargetIcon />
              <span>{overallProgress}% ukończone</span>
            </div>
          </div>
        </div>

        <div className="progress-section">
          <div className="overall-progress">
            <div className="progress-bar-container">
              <div className="progress-bar-fill" style={{ width: `${overallProgress}%` }}></div>
            </div>
            <span className="progress-text">{overallProgress}%</span>
          </div>
        </div>

        {recommendedTopicIds.length > 0 && (
          <div className="recommended-section">
            <h2 className="section-title">Dzisiejsze zadania</h2>
            <div className="recommended-topics">
              {recommendedTopicIds.map((topicId) => {
                const topic = topics.find((t) => t.id === topicId);
                if (!topic) return null;
                return (
                  <div
                    key={topicId}
                    className="recommended-item"
                    onClick={() => onTopicClick(topicId)}
                  >
                    <span className="recommended-name">{topic.name}</span>
                    <span className="recommended-arrow">→</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="categories-section">
          <h2 className="section-title">Postęp według kategorii</h2>
          <div className="categories-grid">
            {categories.map((category) => {
              const { completed, total } = getCategoryProgress(plan, category);
              const categoryProgress = total > 0 ? Math.round((completed / total) * 100) : 0;

              return (
                <div key={category} className="category-card">
                  <div className="category-name">{getCategoryLabel(category as any)}</div>
                  <div className="category-progress-bar">
                    <div
                      className="category-progress-fill"
                      style={{ width: `${categoryProgress}%` }}
                    ></div>
                  </div>
                  <div className="category-stats">
                    {completed}/{total}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="topics-section">
          <h2 className="section-title">Tematy</h2>
          <div className="topics-grid">
            {plan.topicOrder.map((topicId) => {
              const topic = topics.find((t) => t.id === topicId);
              const progress = plan.progress[topicId];

              if (!topic || !progress) return null;

              const isLocked = progress.status === 'locked';
              const isCompleted = progress.status === 'completed';

              return (
                <div
                  key={topicId}
                  className={`topic-card ${isLocked ? 'locked' : ''} ${isCompleted ? 'completed' : ''}`}
                  onClick={() => !isLocked && onTopicClick(topicId)}
                >
                  {isCompleted && (
                    <div className="completed-overlay">
                      <CheckIcon />
                    </div>
                  )}

                  {isLocked && (
                    <div className="locked-overlay">
                      <LockIcon />
                    </div>
                  )}

                  <h3 className="topic-name">{topic.name}</h3>
                  <p className="topic-description">{topic.description}</p>

                  <div className="topic-progress">
                    <div className="task-count">
                      {progress.tasksCompleted}/{progress.tasksTotal} zadań
                    </div>
                    <div className="progress-bar">
                      <div
                        className="progress-fill"
                        style={{ width: `${(progress.tasksCompleted / progress.tasksTotal) * 100}%` }}
                      ></div>
                    </div>
                  </div>

                  {progress.quizScore !== null && (
                    <div className="quiz-score">Quiz: {progress.quizScore}%</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="delete-section">
          {!showDeleteConfirm ? (
            <button
              className="delete-button"
              onClick={() => setShowDeleteConfirm(true)}
            >
              <DeleteIcon />
              Usuń plan
            </button>
          ) : (
            <div className="delete-confirm">
              <p>Jesteś pewny? Wszystkie postępy zostaną usunięte.</p>
              <div className="confirm-buttons">
                <button
                  className="confirm-yes"
                  onClick={onDeletePlan}
                >
                  Tak, usuń
                </button>
                <button
                  className="confirm-no"
                  onClick={() => setShowDeleteConfirm(false)}
                >
                  Anuluj
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

interface TopicDetailScreenProps {
  topic: any;
  progress: any;
  onBack: () => void;
  onSubmitTask: (taskNumber: number) => void;
  onCompleteQuiz: () => void;
  onMarkComplete: () => void;
}

const TopicDetailScreen: React.FC<TopicDetailScreenProps> = ({
  topic,
  progress,
  onBack,
  onSubmitTask,
  onCompleteQuiz,
  onMarkComplete,
}) => {
  return (
    <div className="study-plan-container">
      <div className="topic-detail-card">
        <button className="back-button" onClick={onBack}>
          <ArrowBackIcon />
          Powrót
        </button>

        <div className="topic-header">
          <h1 className="topic-title">{topic.name}</h1>
          <p className="topic-full-description">{topic.description}</p>
        </div>

        <div className="topic-progress-section">
          <h2 className="progress-label">Postęp: {progress.tasksCompleted}/{progress.tasksTotal}</h2>
          <div className="detail-progress-bar">
            <div
              className="detail-progress-fill"
              style={{ width: `${(progress.tasksCompleted / progress.tasksTotal) * 100}%` }}
            ></div>
          </div>
        </div>

        <div className="tasks-section">
          <h2 className="section-title">Zadania</h2>
          <div className="tasks-list">
            {[1, 2, 3, 4, 5].map((num) => (
              <button
                key={num}
                className={`task-button ${progress.tasksCompleted >= num ? 'completed' : ''}`}
                onClick={() => onSubmitTask(num)}
              >
                <span className="task-icon">
                  {progress.tasksCompleted >= num ? <CheckIcon /> : num}
                </span>
                <span className="task-text">Rozwiąż zadanie {num}/5</span>
              </button>
            ))}
          </div>
        </div>

        <div className="quiz-section">
          <h2 className="section-title">Sprawdzenie</h2>
          {progress.quizScore === null ? (
            <button className="quiz-button" onClick={onCompleteQuiz}>
              Rozwiąż quiz
            </button>
          ) : (
            <div className="quiz-result">
              <p className="quiz-score-text">Twój wynik: <strong>{progress.quizScore}%</strong></p>
              <button className="quiz-button" onClick={onCompleteQuiz}>
                Powtórz quiz
              </button>
            </div>
          )}
        </div>

        {progress.tasksCompleted >= 5 && progress.quizScore !== null && progress.status !== 'completed' && (
          <button className="complete-button" onClick={onMarkComplete}>
            Oznacz jako ukończone
          </button>
        )}

        {progress.status === 'completed' && (
          <div className="completed-message">
            <CheckIcon />
            <p>Temat ukończony!</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default StudyPlan;
