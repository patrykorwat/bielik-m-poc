import { useState, useEffect } from 'react';

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
}

interface Category {
  id: string;
  name: string;
  name_en: string;
  methods: Method[];
}

interface FormulaReferenceProps {
  onSubmitQuery: (query: string) => void;
  onNavigateToChat: () => void;
}

export function FormulaReference({ onSubmitQuery, onNavigateToChat }: FormulaReferenceProps) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [expandedMethod, setExpandedMethod] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    fetch('/api/formulas')
      .then(res => res.json())
      .then(data => {
        setCategories(data.categories || []);
        setLoading(false);
      })
      .catch(err => {
        setError('Nie udało się załadować formuł');
        setLoading(false);
        console.error(err);
      });
  }, []);

  const filtered = searchQuery.trim()
    ? categories
        .map(cat => ({
          ...cat,
          methods: cat.methods.filter(m =>
            m.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            m.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
            m.sympy_functions.some(f => f.toLowerCase().includes(searchQuery.toLowerCase()))
          ),
        }))
        .filter(cat => cat.methods.length > 0)
    : categories;

  const totalMethods = categories.reduce((sum, c) => sum + c.methods.length, 0);

  return (
    <div className="formula-reference-inline">
      <div className="formula-header">
        <h2>Baza wzorów i metod</h2>
        <span className="formula-count">{totalMethods} metod w {categories.length} kategoriach</span>
      </div>

        <div className="formula-search">
          <input
            type="text"
            placeholder="Szukaj metody, wzoru lub funkcji SymPy..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            autoFocus
          />
        </div>

        <div className="formula-body">
          {loading && <p className="formula-status">Ładowanie...</p>}
          {error && <p className="formula-status formula-error">{error}</p>}
          {!loading && !error && filtered.length === 0 && (
            <p className="formula-status">Brak wyników dla &ldquo;{searchQuery}&rdquo;</p>
          )}
          {filtered.map(cat => (
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
                  {cat.methods.map(method => (
                    <div key={method.id} className="formula-method">
                      <button
                        className={`formula-method-header ${expandedMethod === method.id ? 'expanded' : ''}`}
                        onClick={() => setExpandedMethod(expandedMethod === method.id ? null : method.id)}
                      >
                        <span className="formula-method-name">{method.name}</span>
                      </button>
                      {expandedMethod === method.id && (
                        <div className="formula-method-detail">
                          <p className="formula-description">{method.description}</p>
                          <div className="formula-meta-row">
                            <strong>Kiedy stosować:</strong> {method.when_to_use}
                          </div>
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
                              <strong>Przykład:</strong> {method.worked_example.problem}
                              {method.worked_example.common_pitfalls.length > 0 && (
                                <div className="formula-pitfalls">
                                  <strong>Pułapki:</strong>
                                  {method.worked_example.common_pitfalls.map((p, i) => (
                                    <span key={i} className="formula-pitfall">{p}</span>
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
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
    </div>
  );
}
