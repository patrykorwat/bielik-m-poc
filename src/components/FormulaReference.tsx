import { useState, useEffect } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

// ── Types ────────────────────────────────────────────────────────────

interface WorkedExample {
  problem: string;
  common_pitfalls: string[];
}

interface Method {
  id: string;
  name: string;
  description: string;
  sympy_functions: string[];
  when_to_use: string;
  worked_example: WorkedExample | null;
  latex?: string;
}

interface Category {
  id: string;
  name: string;
  name_en: string;
  type?: 'methods' | 'formulas';
  methods: Method[];
}

interface Level {
  level: string;
  label: string;
  categories: Category[];
}

interface FormulaReferenceProps {
  onSubmitQuery: (query: string) => void;
  onNavigateToChat: () => void;
}

// ── LaTeX helper ─────────────────────────────────────────────────────
// Detects math-like fragments in plain text and wraps them in KaTeX.
// Patterns: x^2, log_5(4), sqrt(...), a*b, fractions like (2a+1)/(a*(1+b)),
// single-letter variables near operators, etc.

function renderMathText(text: string): string {
  // Already has explicit LaTeX delimiters? Render them.
  // Pattern: $...$ for inline, $$...$$ for display
  let result = text.replace(/\$\$(.+?)\$\$/g, (_m, tex) => {
    try { return katex.renderToString(tex, { displayMode: true, throwOnError: false, strict: false }); } catch { return tex; }
  });
  result = result.replace(/\$(.+?)\$/g, (_m, tex) => {
    try { return katex.renderToString(tex, { displayMode: false, throwOnError: false, strict: false }); } catch { return tex; }
  });

  // Auto-detect common math patterns and render inline
  // Match expressions like: x^2, log_{...}(...), sqrt(...), sin(x), a^n, (2a+1)/(a*(1+b))
  result = result.replace(
    /(?:log_\{?[^}\s]+\}?\([^)]+\)|log_\S+\([^)]+\)|\b(?:sqrt|sin|cos|tan|ln|exp|lim)\([^)]*\)|(?:\([^)]+\)\s*\/\s*\([^)]+\))|(?:[a-zA-Z0-9]+\^[\{(]?[a-zA-Z0-9/]+[\})]?)|(?:[a-zA-Z]_[a-zA-Z0-9]+))/g,
    (match) => {
      // Convert informal notation to LaTeX
      let tex = match;
      // log_{base}(arg) -> \log_{base}(arg)
      tex = tex.replace(/^log_/g, '\\log_');
      // sqrt( -> \sqrt{
      tex = tex.replace(/^sqrt\(/, '\\sqrt{').replace(/\)$/, '}');
      // sin, cos, etc.
      tex = tex.replace(/^(sin|cos|tan|ln|exp|lim)\(/, '\\$1(');
      try {
        return katex.renderToString(tex, { displayMode: false, throwOnError: false, strict: false });
      } catch {
        return match;
      }
    }
  );

  return result;
}

// ── Component ────────────────────────────────────────────────────────

const LEVEL_ICONS: Record<string, string> = {
  podstawowa: '📐',
  matura_podstawowa: '🎓',
  matura_rozszerzona: '📊',
  studia: '🔬',
};

export function FormulaReference({ onSubmitQuery, onNavigateToChat }: FormulaReferenceProps) {
  const [levels, setLevels] = useState<Level[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeLevel, setActiveLevel] = useState<string>('matura_podstawowa');
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [expandedMethod, setExpandedMethod] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    fetch('/api/formulas')
      .then(res => res.json())
      .then(data => {
        setLevels(data.levels || []);
        setLoading(false);
      })
      .catch(err => {
        setError('Nie udało się załadować formuł');
        setLoading(false);
        console.error(err);
      });
  }, []);

  // Filter by search across all levels, or show active level
  const currentLevel = levels.find(l => l.level === activeLevel);
  const categoriesToShow = searchQuery.trim()
    ? levels
        .flatMap(l => l.categories)
        .map(cat => ({
          ...cat,
          methods: cat.methods.filter(m =>
            m.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            m.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
            (m.latex || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
            m.sympy_functions.some(f => f.toLowerCase().includes(searchQuery.toLowerCase()))
          ),
        }))
        .filter(cat => cat.methods.length > 0)
    : currentLevel?.categories || [];

  const totalMethods = levels.reduce((sum, l) => sum + l.categories.reduce((s, c) => s + c.methods.length, 0), 0);

  return (
    <div className="formula-reference-inline">
      <div className="formula-header">
        <h2>Baza wzorów i metod</h2>
        <span className="formula-count">{totalMethods} pozycji</span>
      </div>

      {/* Level tabs */}
      {!loading && levels.length > 0 && (
        <div className="formula-level-tabs">
          {levels.map(l => (
            <button
              key={l.level}
              className={`formula-level-tab ${activeLevel === l.level ? 'active' : ''}`}
              onClick={() => { setActiveLevel(l.level); setSearchQuery(''); setExpandedCategory(null); setExpandedMethod(null); }}
            >
              <span className="formula-level-icon">{LEVEL_ICONS[l.level] || ''}</span>
              {l.label}
              <span className="formula-level-count">
                {l.categories.reduce((s, c) => s + c.methods.length, 0)}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="formula-search">
        <input
          type="text"
          placeholder="Szukaj metody, wzoru lub funkcji SymPy..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
      </div>

      <div className="formula-body">
        {loading && <p className="formula-status">Ładowanie...</p>}
        {error && <p className="formula-status formula-error">{error}</p>}
        {!loading && !error && categoriesToShow.length === 0 && (
          <p className="formula-status">
            {searchQuery.trim() ? `Brak wyników dla \u201e${searchQuery}\u201d` : 'Brak kategorii'}
          </p>
        )}
        {categoriesToShow.map(cat => (
          <div key={cat.id} className="formula-category">
            <button
              className={`formula-category-header ${expandedCategory === cat.id ? 'expanded' : ''}`}
              onClick={() => setExpandedCategory(expandedCategory === cat.id ? null : cat.id)}
            >
              <span className="formula-category-name">{cat.name}</span>
              <span className="formula-category-count">{cat.methods.length}</span>
              <span className="formula-chevron">{expandedCategory === cat.id ? '▾' : '▸'}</span>
            </button>
            {expandedCategory === cat.id && (
              <div className="formula-methods">
                {(cat.type === 'formulas' || cat.methods.some(m => m.latex)) ? (
                  /* CKE formula cards: show LaTeX directly, no expand needed */
                  cat.methods.map(formula => (
                    <div key={formula.id} className="formula-card">
                      <div className="formula-card-top">
                        <div className="formula-card-name">{formula.name}</div>
                        <button
                          className="formula-card-link"
                          onClick={() => {
                            onSubmitQuery(`Zadanie z: ${formula.name}`);
                            onNavigateToChat();
                          }}
                          title="Rozwiąż zadanie wymagające tego wzoru"
                        >
                          Rozwiąż zadanie →
                        </button>
                      </div>
                      {formula.latex && (
                        <div
                          className="formula-card-latex"
                          dangerouslySetInnerHTML={{
                            __html: (() => {
                              try {
                                return katex.renderToString(formula.latex, { displayMode: true, throwOnError: false, strict: false });
                              } catch {
                                return formula.latex;
                              }
                            })()
                          }}
                        />
                      )}
                    </div>
                  ))
                ) : (
                  /* Method cards: expandable with SymPy details */
                  cat.methods.map(method => (
                    <div key={method.id} className="formula-method">
                      <button
                        className={`formula-method-header ${expandedMethod === method.id ? 'expanded' : ''}`}
                        onClick={() => setExpandedMethod(expandedMethod === method.id ? null : method.id)}
                      >
                        <span className="formula-method-name">{method.name}</span>
                      </button>
                      {expandedMethod === method.id && (
                        <div className="formula-method-detail">
                          <p
                            className="formula-description"
                            dangerouslySetInnerHTML={{ __html: renderMathText(method.description) }}
                          />
                          {method.when_to_use && (
                            <div className="formula-meta-row">
                              <strong>Kiedy stosować:</strong>{' '}
                              <span dangerouslySetInnerHTML={{ __html: renderMathText(method.when_to_use) }} />
                            </div>
                          )}
                          {method.sympy_functions.length > 0 && (
                            <div className="formula-meta-row">
                              <strong>Funkcje SymPy:</strong>
                              <span className="formula-tags">
                                {method.sympy_functions.map(fn => (
                                  <code key={fn} className="formula-tag">{fn}</code>
                                ))}
                              </span>
                            </div>
                          )}
                          {method.worked_example && (
                            <div className="formula-example">
                              <strong>Przykład:</strong>{' '}
                              <span dangerouslySetInnerHTML={{ __html: renderMathText(method.worked_example.problem) }} />
                              {method.worked_example.common_pitfalls.length > 0 && (
                                <div className="formula-pitfalls">
                                  <strong>Pułapki:</strong>
                                  {method.worked_example.common_pitfalls.map((p, i) => (
                                    <span
                                      key={i}
                                      className="formula-pitfall"
                                      dangerouslySetInnerHTML={{ __html: renderMathText(p) }}
                                    />
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                          <button
                            className="formula-try-btn"
                            onClick={() => {
                              onSubmitQuery(method.worked_example?.problem || `Rozwiąż zadanie z: ${method.name}`);
                              onNavigateToChat();
                            }}
                          >
                            Wypróbuj to zadanie
                          </button>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
