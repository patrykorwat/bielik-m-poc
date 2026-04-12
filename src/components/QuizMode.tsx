import { useState, useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import './QuizMode.css';

interface QuizModeProps {
  onSubmitQuery: (query: string) => void;
  onNavigateToChat: () => void;
  onQuizComplete?: (score: number, total: number) => void;
}

interface QuizQuestion {
  year: number;
  level: string;
  task_number: number;
  question: string;
  type: 'multiple_choice' | 'open_ended';
  options?: string[] | Record<string, string>;
  correct_answer: string;
}

// Normalizuje options do tablicy ["tekst A", "tekst B", ...] niezależnie od formatu API
function normalizeOptions(options: string[] | Record<string, string> | undefined): string[] {
  if (!options) return [];
  if (Array.isArray(options)) return options;
  // Obiekt {a: '...', b: '...', c: '...', d: '...'} — sortujemy klucze alfabetycznie
  return Object.keys(options).sort().map(k => (options as Record<string, string>)[k]);
}

interface AnswerRecord {
  year: number;
  level: string;
  task_number: number;
  answer: string;
}

type Screen = 'topic_selection' | 'quiz' | 'results';

const TOPICS = [
  'Logarytmy',
  'Potęgi',
  'Równania',
  'Nierówności',
  'Trygonometria',
  'Ciągi',
  'Prawdopodobieństwo',
  'Geometria',
  'Funkcje',
  'Pochodne',
];

const LEVELS = [
  { id: 'podstawowa', label: 'Podstawowa' },
  { id: 'rozszerzona', label: 'Rozszerzona' },
];

/**
 * Renders LaTeX math expressions using KaTeX
 * Supports $...$ for inline math and $$...$$ for display math
 */
function renderLatex(text: string): string {
  if (!text) return text;
  // Replace $$...$$ with display math
  let result = text.replace(/\$\$(.+?)\$\$/gs, (_m, tex) => {
    try {
      return katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false });
    } catch {
      return tex;
    }
  });
  // Replace $...$ with inline math
  result = result.replace(/\$(.+?)\$/g, (_m, tex) => {
    try {
      return katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false });
    } catch {
      return tex;
    }
  });
  // Jeśli tekst nie zawiera$ ale wygląda jak LaTeX (np. opcje CKE bez dolarów)
  // próbujemy wyrenderować całość jako inline math
  if (result === text && /[\\{}^_]/.test(text)) {
    try {
      return katex.renderToString(text.trim(), { displayMode: false, throwOnError: false });
    } catch {
      return text;
    }
  }
  return result;
}

export function QuizMode({ onSubmitQuery, onNavigateToChat, onQuizComplete }: QuizModeProps) {
  const [screen, setScreen] = useState<Screen>('topic_selection');
  const [selectedTopic, setSelectedTopic] = useState<string>('Wszystkie tematy');
  const [selectedLevel, setSelectedLevel] = useState<string>('podstawowa');
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [userAnswers, setUserAnswers] = useState<Map<number, string>>(new Map());
  const [answered, setAnswered] = useState(false);
  const [isCorrect, setIsCorrect] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<{ correct: number; total: number; wrongQuestions: number[] }>({
    correct: 0,
    total: 0,
    wrongQuestions: [],
  });

  const currentQuestion = questions[currentQuestionIndex];
  const currentAnswer = userAnswers.get(currentQuestionIndex) || '';

  /**
   * Fetch quiz questions from API
   */
  const fetchQuiz = async () => {
    setLoading(true);
    try {
      const topic = selectedTopic === 'Wszystkie tematy' ? 'all' : selectedTopic;
      const response = await fetch(`/api/quiz?level=${selectedLevel}&count=5&topic=${topic}`);
      if (!response.ok) throw new Error('Failed to fetch quiz');
      const data = await response.json();
      // Normalizuj pytania z API — dodaj type i sprłastuj metadata
      const normalized = (data.questions || []).map((q: Record<string, unknown>) => ({
        ...q,
        type: q.options ? 'multiple_choice' : 'open_ended',
        year: (q.metadata as Record<string, unknown>)?.year ?? q.year,
        level: (q.metadata as Record<string, unknown>)?.level ?? q.level,
        task_number: (q.metadata as Record<string, unknown>)?.task_number ?? q.task_number,
      }));
      setQuestions(normalized);
      setCurrentQuestionIndex(0);
      setUserAnswers(new Map());
      setAnswered(false);
      setIsCorrect(null);
      setScreen('quiz');
    } catch (error) {
      console.error('Error fetching quiz:', error);
      alert('Nie udało się załadować quizu. Spróbuj ponownie.');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Start quiz from topic selection
   */
  const startQuiz = () => {
    if (!selectedTopic) {
      alert('Proszę wybrać temat');
      return;
    }
    fetchQuiz();
  };

  /**
   * Handle answer selection/input
   */
  const handleAnswerChange = (value: string) => {
    if (!answered) {
      setUserAnswers(new Map(userAnswers.set(currentQuestionIndex, value)));
    }
  };

  /**
   * Submit answer and check if correct
   */
  const submitAnswer = async () => {
    if (!currentAnswer) {
      alert('Proszę wybrać lub wpisać odpowiedź');
      return;
    }

    setAnswered(true);
    const hasOptions = normalizeOptions(currentQuestion.options).length > 0;
    if (!hasOptions) {
      // Pytania otwarte — nie porównujemy tekstu, pokazujemy odpowiedź modelową
      setIsCorrect(null);
    } else {
      setIsCorrect(currentAnswer === currentQuestion.correct_answer);
    }
  };

  /**
   * Move to next question
   */
  const nextQuestion = () => {
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex(currentQuestionIndex + 1);
      setAnswered(false);
      setIsCorrect(null);
    } else {
      finishQuiz();
    }
  };

  /**
   * Finish quiz and show results
   */
  const finishQuiz = async () => {
    try {
      const answers: AnswerRecord[] = questions.map((q, idx) => ({
        year: q.year,
        level: q.level,
        task_number: q.task_number,
        answer: userAnswers.get(idx) || '',
      }));

      const response = await fetch('/api/quiz/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers }),
      });

      if (!response.ok) throw new Error('Failed to check answers');
      const data = await response.json();

      const correct = data.correct_count || answers.filter((_, idx) => userAnswers.get(idx) === questions[idx].correct_answer).length;
      const wrongQuestions = questions
        .map((_, idx) => idx)
        .filter(idx => userAnswers.get(idx) !== questions[idx].correct_answer);

      setResults({
        correct,
        total: questions.length,
        wrongQuestions,
      });
      setScreen('results');
      if (onQuizComplete) {
        onQuizComplete(correct, questions.length);
      }
    } catch (error) {
      console.error('Error checking answers:', error);
      alert('Nie udało się sprawdzić odpowiedzi.');
    }
  };

  /**
   * Reset to topic selection
   */
  const returnToTopicSelection = () => {
    setScreen('topic_selection');
    setSelectedTopic('');
    setUserAnswers(new Map());
    setAnswered(false);
    setIsCorrect(null);
  };

  /**
   * Retry same topic
   */
  const retryQuiz = () => {
    setCurrentQuestionIndex(0);
    setUserAnswers(new Map());
    setAnswered(false);
    setIsCorrect(null);
    setScreen('quiz');
    fetchQuiz();
  };

  /**
   * Handle "Solve in chat" for wrong answer
   */
  const solveInChat = (questionIndex: number) => {
    const question = questions[questionIndex];
    const userAnswer = userAnswers.get(questionIndex);
    onSubmitQuery(
      `Pomóż mi rozwiązać to zadanie:\n\n${question.question}\n\nMoja odpowiedź: ${userAnswer}`
    );
    onNavigateToChat();
  };

  if (screen === 'topic_selection') {
    return <TopicSelectionScreen
      onStartQuiz={startQuiz}
      selectedTopic={selectedTopic}
      selectedLevel={selectedLevel}
      onTopicChange={setSelectedTopic}
      onLevelChange={setSelectedLevel}
      loading={loading}
    />;
  }

  if (screen === 'quiz' && currentQuestion) {
    return <QuizScreen
      question={currentQuestion}
      questionNumber={currentQuestionIndex + 1}
      totalQuestions={questions.length}
      userAnswer={currentAnswer}
      onAnswerChange={handleAnswerChange}
      onSubmitAnswer={submitAnswer}
      onNextQuestion={nextQuestion}
      answered={answered}
      isCorrect={isCorrect}
      onSolveInChat={(query: string) => { onSubmitQuery(query); onNavigateToChat(); }}
    />;
  }

  if (screen === 'results') {
    return <ResultsScreen
      correct={results.correct}
      total={results.total}
      wrongQuestions={results.wrongQuestions}
      questions={questions}
      userAnswers={userAnswers}
      onRetry={retryQuiz}
      onChangeTopic={returnToTopicSelection}
      onSolveInChat={solveInChat}
    />;
  }

  return null;
}

/**
 * Topic Selection Screen
 */
function TopicSelectionScreen({
  onStartQuiz,
  selectedTopic,
  selectedLevel,
  onTopicChange,
  onLevelChange,
  loading,
}: {
  onStartQuiz: () => void;
  selectedTopic: string;
  selectedLevel: string;
  onTopicChange: (topic: string) => void;
  onLevelChange: (level: string) => void;
  loading: boolean;
}) {
  return (
    <div className="quiz-screen">
      <div className="quiz-container">
        <div className="topic-selection-header">
          <h2>Wybierz temat quizu</h2>
          <p>Rozwijaj swoje umiejętności matematyczne</p>
        </div>

        <div className="level-selector">
          <span className="level-label">Poziom trudności:</span>
          <div className="level-buttons">
            {LEVELS.map(level => (
              <button
                key={level.id}
                className={`level-btn ${selectedLevel === level.id ? 'active' : ''}`}
                onClick={() => onLevelChange(level.id)}
              >
                {level.label}
              </button>
            ))}
          </div>
        </div>

        <div className="topic-radio-list">
          {['Wszystkie tematy', ...TOPICS].map(topic => (
            <label
              key={topic}
              className={`topic-radio-item ${selectedTopic === topic ? 'selected' : ''}`}
            >
              <input
                type="radio"
                name="topic"
                value={topic}
                checked={selectedTopic === topic}
                onChange={() => onTopicChange(topic)}
              />
              <span className="topic-radio-label">{topic}</span>
            </label>
          ))}
        </div>

        <button
          className="start-button"
          onClick={onStartQuiz}
          disabled={!selectedTopic || loading}
        >
          {loading ? 'Wczytywanie...' : 'Rozpocznij quiz'}
        </button>
      </div>
    </div>
  );
}

/**
 * Quiz Screen
 */
function QuizScreen({
  question,
  questionNumber,
  totalQuestions,
  userAnswer,
  onAnswerChange,
  onSubmitAnswer,
  onNextQuestion,
  answered,
  isCorrect,
  onSolveInChat,
}: {
  question: QuizQuestion;
  questionNumber: number;
  totalQuestions: number;
  userAnswer: string;
  onAnswerChange: (value: string) => void;
  onSubmitAnswer: () => void;
  onNextQuestion: () => void;
  answered: boolean;
  isCorrect: boolean | null;
  onSolveInChat: (query: string) => void;
}) {
  const progressPercentage = (questionNumber / totalQuestions) * 100;
  const renderedQuestion = useMemo(() => renderLatex(question.question), [question.question]);

  return (
    <div className="quiz-screen">
      <div className="quiz-container">
        <div className="quiz-header">
          <div className="question-counter">
            Pytanie {questionNumber}/{totalQuestions}
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progressPercentage}%` }}></div>
          </div>
        </div>

        <div className={`question-card ${answered ? (isCorrect ? 'correct' : 'incorrect') : ''}`}>
          <div className="question-content">
            <div
              className="question-text"
              dangerouslySetInnerHTML={{ __html: renderedQuestion }}
            />
          </div>

          {normalizeOptions(question.options).length > 0 ? (
            <div className="options-container">
              {normalizeOptions(question.options).map((option, idx) => {
                const label = String.fromCharCode(65 + idx); // A, B, C, D
                const isSelected = userAnswer === label;
                const renderedOption = renderLatex(option);
                return (
                  <button
                    key={idx}
                    className={`option-button ${isSelected ? 'selected' : ''} ${
                      answered
                        ? label === question.correct_answer
                          ? 'correct-answer'
                          : isSelected
                          ? 'wrong-answer'
                          : ''
                        : ''
                    }`}
                    onClick={() => onAnswerChange(label)}
                    disabled={answered}
                  >
                    <span className="option-label">{label}</span>
                    <span
                      className="option-text"
                      dangerouslySetInnerHTML={{ __html: renderedOption }}
                    />
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="open-ended-container">
              <input
                type="text"
                className="open-ended-input"
                placeholder="Wpisz odpowiedź..."
                value={userAnswer}
                onChange={e => onAnswerChange(e.target.value)}
                disabled={answered}
              />
            </div>
          )}

          {answered && (
            <div className={`feedback ${
              normalizeOptions(question.options).length === 0 ? 'open-feedback'
              : isCorrect ? 'correct-feedback' : 'incorrect-feedback'
            }`}>
              {normalizeOptions(question.options).length === 0 ? (
                <>
                  <span className="feedback-icon">📚</span>
                  <div className="feedback-open">
                    <span className="feedback-text"><strong>Odpowiedź modelowa:</strong></span>
                    <span
                      className="feedback-model-answer"
                      dangerouslySetInnerHTML={{ __html: renderLatex(question.correct_answer) }}
                    />
                    <button
                      className="feedback-solve-btn"
                      onClick={() => onSolveInChat(
                        `${question.question}\n\nMoja odpowiedź: ${userAnswer}\n\nCzy moja odpowiedź jest poprawna? Pokaż pełne rozwiązanie.`
                      )}
                    >
                      Sprawdź w Formulo →
                    </button>
                  </div>
                </>
              ) : isCorrect ? (
                <>
                  <span className="feedback-icon">✓</span>
                  <span className="feedback-text">Poprawnie!</span>
                </>
              ) : (
                <>
                  <span className="feedback-icon">✗</span>
                  <span className="feedback-text">
                    Niepoprawnie. Prawidłowa odpowiedź: <strong>{question.correct_answer}</strong>
                    {(() => {
                      const opts = normalizeOptions(question.options);
                      const idx = question.correct_answer.charCodeAt(0) - 65;
                      const text = opts[idx];
                      return text ? <span dangerouslySetInnerHTML={{ __html: ` (${renderLatex(text)})` }} /> : null;
                    })()}
                  </span>
                </>
              )}
            </div>
          )}
        </div>

        <div className="quiz-actions">
          {!answered ? (
            <button className="submit-button" onClick={onSubmitAnswer}>
              Sprawdź odpowiedź
            </button>
          ) : (
            <button className="next-button" onClick={onNextQuestion}>
              {questionNumber === totalQuestions ? 'Zakończ quiz' : 'Następne'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Results Screen
 */
function ResultsScreen({
  correct,
  total,
  wrongQuestions,
  questions,
  userAnswers: _userAnswers,
  onRetry,
  onChangeTopic,
  onSolveInChat,
}: {
  correct: number;
  total: number;
  wrongQuestions: number[];
  questions: QuizQuestion[];
  userAnswers: Map<number, string>;
  onRetry: () => void;
  onChangeTopic: () => void;
  onSolveInChat: (idx: number) => void;
}) {
  const percentage = Math.round((correct / total) * 100);

  return (
    <div className="quiz-screen">
      <div className="quiz-container results-container">
        <div className="results-header">
          <h2>Wyniki quizu</h2>
        </div>

        <div className="score-display">
          <div className="score-circle">
            <div className="score-number">{correct}</div>
            <div className="score-total">z {total}</div>
          </div>
          <div className="percentage">{percentage}%</div>
        </div>

        {wrongQuestions.length > 0 && (
          <div className="wrong-questions">
            <h3>Pytania do powtórzenia</h3>
            <div className="wrong-list">
              {wrongQuestions.map(idx => (
                <div key={idx} className="wrong-item">
                  <div className="wrong-question-info">
                    <span className="wrong-number">Pytanie {idx + 1}</span>
                    <span
                      className="wrong-text"
                      dangerouslySetInnerHTML={{ __html: renderLatex(questions[idx].question) }}
                    />
                  </div>
                  <button
                    className="solve-in-chat-btn"
                    onClick={() => onSolveInChat(idx)}
                  >
                    Rozwiąż w czacie
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="results-actions">
          <button className="retry-button" onClick={onRetry}>
            Spróbuj ponownie
          </button>
          <button className="change-topic-button" onClick={onChangeTopic}>
            Zmień temat
          </button>
        </div>
      </div>
    </div>
  );
}
