import React, { useState, useRef, useEffect } from 'react';
import './MathKeyboard.css';

interface MathKeyboardProps {
  onInsert: (text: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}

interface SymbolGroup {
  label: string;
  symbols: { display: string; insert: string; title: string }[];
}

const SYMBOL_GROUPS: SymbolGroup[] = [
  {
    label: 'Podstawowe',
    symbols: [
      { display: '²', insert: '²', title: 'Kwadrat' },
      { display: '³', insert: '³', title: 'Sześcian' },
      { display: 'ⁿ', insert: '^', title: 'Potęga' },
      { display: '√', insert: '√', title: 'Pierwiastek' },
      { display: '∛', insert: '∛', title: 'Pierwiastek trzeciego stopnia' },
      { display: 'π', insert: 'π', title: 'Pi' },
      { display: 'e', insert: 'e', title: 'Liczba Eulera' },
      { display: '∞', insert: '∞', title: 'Nieskończoność' },
      { display: '±', insert: '±', title: 'Plus minus' },
      { display: '|x|', insert: '|', title: 'Wartość bezwzględna' },
      { display: '(', insert: '(', title: 'Nawias otwierający' },
      { display: ')', insert: ')', title: 'Nawias zamykający' },
    ],
  },
  {
    label: 'Relacje',
    symbols: [
      { display: '≤', insert: '≤', title: 'Mniejsze lub równe' },
      { display: '≥', insert: '≥', title: 'Większe lub równe' },
      { display: '≠', insert: '≠', title: 'Różne od' },
      { display: '≈', insert: '≈', title: 'W przybliżeniu równe' },
      { display: '∈', insert: '∈', title: 'Należy do' },
      { display: '∉', insert: '∉', title: 'Nie należy do' },
      { display: '⊂', insert: '⊂', title: 'Podzbiór' },
      { display: '∪', insert: '∪', title: 'Suma zbiorów' },
      { display: '∩', insert: '∩', title: 'Iloczyn zbiorów' },
      { display: '∅', insert: '∅', title: 'Zbiór pusty' },
      { display: '⇒', insert: '⇒', title: 'Implikacja' },
      { display: '⇔', insert: '⇔', title: 'Równoważność' },
    ],
  },
  {
    label: 'Analiza',
    symbols: [
      { display: '∫', insert: '∫', title: 'Całka' },
      { display: 'Σ', insert: 'Σ', title: 'Suma' },
      { display: 'Π', insert: 'Π', title: 'Iloczyn' },
      { display: 'lim', insert: 'lim ', title: 'Granica' },
      { display: 'Δ', insert: 'Δ', title: 'Delta' },
      { display: '∂', insert: '∂', title: 'Pochodna cząstkowa' },
      { display: 'dx', insert: ' dx', title: 'Różniczka' },
      { display: '→', insert: '→', title: 'Dąży do' },
    ],
  },
  {
    label: 'Trygonometria',
    symbols: [
      { display: 'sin', insert: 'sin(', title: 'Sinus' },
      { display: 'cos', insert: 'cos(', title: 'Cosinus' },
      { display: 'tg', insert: 'tg(', title: 'Tangens' },
      { display: 'ctg', insert: 'ctg(', title: 'Cotangens' },
      { display: 'α', insert: 'α', title: 'Alfa' },
      { display: 'β', insert: 'β', title: 'Beta' },
      { display: 'γ', insert: 'γ', title: 'Gamma' },
      { display: '°', insert: '°', title: 'Stopień' },
    ],
  },
  {
    label: 'Logarytmy',
    symbols: [
      { display: 'log', insert: 'log(', title: 'Logarytm' },
      { display: 'ln', insert: 'ln(', title: 'Logarytm naturalny' },
      { display: 'log₂', insert: 'log₂(', title: 'Logarytm o podstawie 2' },
      { display: 'log₁₀', insert: 'log₁₀(', title: 'Logarytm dziesiętny' },
    ],
  },
  {
    label: 'Indeksy',
    symbols: [
      { display: '₀', insert: '₀', title: 'Indeks dolny 0' },
      { display: '₁', insert: '₁', title: 'Indeks dolny 1' },
      { display: '₂', insert: '₂', title: 'Indeks dolny 2' },
      { display: 'ₙ', insert: 'ₙ', title: 'Indeks dolny n' },
      { display: '⁰', insert: '⁰', title: 'Wykładnik 0' },
      { display: '¹', insert: '¹', title: 'Wykładnik 1' },
      { display: '⁴', insert: '⁴', title: 'Wykładnik 4' },
      { display: '⁵', insert: '⁵', title: 'Wykładnik 5' },
    ],
  },
];

const MathKeyboard: React.FC<MathKeyboardProps> = ({ onInsert, textareaRef }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [activeGroup, setActiveGroup] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);

  // Zamknij panel po kliknięciu poza nim
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleSymbolClick = (insert: string) => {
    onInsert(insert);
    // Nie zamykaj panelu po wstawieniu symbolu, żeby można było wstawić kilka z rzędu
    textareaRef.current?.focus();
  };

  const toggleOpen = () => {
    setIsOpen((prev) => !prev);
  };

  return (
    <div className="math-keyboard-wrapper" ref={panelRef}>
      <button
        type="button"
        className={`math-keyboard-toggle ${isOpen ? 'active' : ''}`}
        onClick={toggleOpen}
        title="Klawiatura matematyczna"
        aria-label="Otwórz klawiaturę matematyczną"
        aria-expanded={isOpen}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="3" width="16" height="18" rx="2" />
          <line x1="7" y1="7" x2="17" y2="7" />
          <line x1="8" y1="12" x2="8.01" y2="12" />
          <line x1="12" y1="12" x2="12.01" y2="12" />
          <line x1="16" y1="12" x2="16.01" y2="12" />
          <line x1="8" y1="16" x2="8.01" y2="16" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
          <line x1="16" y1="16" x2="16.01" y2="16" />
        </svg>
      </button>

      {isOpen && (
        <div className="math-keyboard-panel">
          <div className="math-keyboard-tabs">
            {SYMBOL_GROUPS.map((group, idx) => (
              <button
                key={group.label}
                type="button"
                className={`math-keyboard-tab ${activeGroup === idx ? 'active' : ''}`}
                onClick={() => setActiveGroup(idx)}
              >
                {group.label}
              </button>
            ))}
          </div>
          <div className="math-keyboard-symbols">
            {SYMBOL_GROUPS[activeGroup].symbols.map((sym) => (
              <button
                key={sym.title}
                type="button"
                className="math-symbol-btn"
                onClick={() => handleSymbolClick(sym.insert)}
                title={sym.title}
                aria-label={sym.title}
              >
                {sym.display}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default MathKeyboard;
