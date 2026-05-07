import React from 'react';
import './WelcomeLanding.css';

interface WelcomeLandingProps {
  onSubmitQuery: (query: string) => void;
  dailyChallengeSlot: React.ReactNode;
}

/* SVG Icons */
const StepsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="12 3 20 7.5 20 16.5 12 21 4 16.5 4 7.5 12 3"></polyline>
    <polyline points="12 12 20 7.5"></polyline>
    <polyline points="12 12 12 21"></polyline>
    <polyline points="12 12 4 7.5"></polyline>
  </svg>
);

const CheckmarkIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="20 6 9 17 4 12"></polyline>
  </svg>
);

const ChartIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="12" y1="2" x2="12" y2="22"></line>
    <path d="M17 5h-5v7h5V5z"></path>
    <path d="M7 12h5v10H7z"></path>
  </svg>
);

const TextInputIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="18" height="18" rx="2"></rect>
    <line x1="7" y1="10" x2="17" y2="10"></line>
    <line x1="7" y1="14" x2="17" y2="14"></line>
    <line x1="7" y1="18" x2="13" y2="18"></line>
  </svg>
);

const BrainIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M9 11a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"></path>
    <path d="M9 12h0"></path>
    <path d="M15 12h0"></path>
    <path d="M6 20c-1.1 0 -2 -.9 -2 -2v-1c0 -1.1 1 -2 2 -2h1v-3c0 -2.21 1.79 -4 4 -4h2c2.21 0 4 1.79 4 4v3h1c1.1 0 2 .9 2 2v1c0 1.1 -.9 2 -2 2h-12z"></path>
  </svg>
);

const ListIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="9" y1="6" x2="20" y2="6"></line>
    <line x1="9" y1="12" x2="20" y2="12"></line>
    <line x1="9" y1="18" x2="20" y2="18"></line>
    <line x1="5" y1="6" x2="5" y2="6.01"></line>
    <line x1="5" y1="12" x2="5" y2="12.01"></line>
    <line x1="5" y1="18" x2="5" y2="18.01"></line>
  </svg>
);

const WelcomeLanding: React.FC<WelcomeLandingProps> = ({
  onSubmitQuery,
  dailyChallengeSlot,
}) => {
  const examplePrompts = [
    'Rozwiąż x² - 5x + 6 = 0',
    'Pochodna sin(x)',
    'log₂(8)',
    'Średnia ważona z 12 i 18 z wagami 2 i 3',
    'Całka ∫x² dx',
    'Kombinacje C(10,3)',
  ];

  const steps = [
    {
      num: '1',
      title: 'Wpisz lub wklej zadanie',
      icon: TextInputIcon,
      description: 'Podaj treść zadania w dowolnej postaci',
    },
    {
      num: '2',
      title: 'AI analizuje i oblicza',
      icon: BrainIcon,
      description: 'System przetwarza dane i znajduje rozwiązanie',
    },
    {
      num: '3',
      title: 'Otrzymujesz rozwiązanie krok po kroku',
      icon: ListIcon,
      description: 'Szczegółowe wyjaśnienie każdego kroku',
    },
  ];

  const topics = [
    'Równania i nierówności',
    'Funkcje',
    'Trygonometria',
    'Logarytmy',
    'Pochodne',
    'Całki',
    'Ciągi',
    'Kombinatoryka',
  ];

  return (
    <div className="welcome-landing">
      {/* Hero Section */}
      <section className="hero-section">
        <div className="hero-content">
          <h1 className="hero-headline">
            Rozwiąż zadanie maturalne z matematyki krok po kroku
          </h1>
          <p className="hero-subheadline">
            Wpisz lub wklej dowolne zadanie. AI pokaże rozwiązanie po polsku, z każdym krokiem i wzorem. Bez logowania, bez opłat.
          </p>

          {/* Feature Pills */}
          <div className="feature-pills">
            <div className="feature-pill">
              <div className="pill-icon">
                <StepsIcon />
              </div>
              <span>Matura podstawowa i rozszerzona</span>
            </div>
            <div className="feature-pill">
              <div className="pill-icon">
                <CheckmarkIcon />
              </div>
              <span>Bez logowania</span>
            </div>
            <div className="feature-pill">
              <div className="pill-icon">
                <ChartIcon />
              </div>
              <span>Krok po kroku</span>
            </div>
          </div>
        </div>
      </section>

      {/* Example Prompts Section: pierwsza interakcja above the fold,
          żeby użytkownik klikał od razu i nie odbijał się ze strony. */}
      <section className="examples-section">
        <h2 className="section-title">Kliknij przykład żeby zacząć</h2>
        <div className="examples-grid">
          {examplePrompts.map((prompt) => (
            <button
              key={prompt}
              className="example-chip"
              onClick={() => onSubmitQuery(prompt)}
            >
              {prompt}
            </button>
          ))}
        </div>
      </section>

      {/* Daily Challenge Section */}
      <section className="daily-challenge-section">
        {dailyChallengeSlot}
      </section>

      {/* How It Works Section */}
      <section className="how-it-works-section">
        <h2 className="section-title">Jak to działa?</h2>
        <div className="steps-container">
          <div className="steps-grid">
            {steps.map((step, idx) => {
              const Icon = step.icon;
              return (
                <div key={step.num} className="step-card">
                  <div className="step-number-badge">{step.num}</div>
                  <div className="step-icon">
                    <Icon />
                  </div>
                  <h3 className="step-title">{step.title}</h3>
                  <p className="step-description">{step.description}</p>
                  {idx < steps.length - 1 && (
                    <div className="step-connector"></div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Stats Section */}
      <section className="stats-section">
        <h3 className="stats-title">Obsługiwane tematy:</h3>
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-value">800+</div>
            <div className="stat-label">Koncepcji matematycznych</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">128</div>
            <div className="stat-label">Wzorów CKE</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">100</div>
            <div className="stat-label">Arkuszy maturalnych (2015-2024)</div>
          </div>
        </div>
      </section>

      {/* Topics Section */}
      <section className="topics-section">
        <h2 className="section-title">Popularne tematy</h2>
        <div className="topics-grid">
          {topics.map((topic) => (
            <button
              key={topic}
              className="topic-link"
              onClick={() => onSubmitQuery(topic)}
            >
              {topic}
            </button>
          ))}
        </div>
      </section>

    </div>
  );
};

export default WelcomeLanding;
