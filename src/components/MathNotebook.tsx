/**
 * Formulo – Notatnik Matematyczny
 *
 * Strona wyświetlająca zapisane przez użytkownika rozwiązania AI.
 * Funkcje:
 *  - Lista notatek posortowana od najnowszej
 *  - Filtrowanie po temacie
 *  - Wyszukiwanie po treści i tytule
 *  - Edycja własnej notatki
 *  - Usuwanie wpisu
 *  - Przycisk "Powtórz w czacie"
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  NotebookEntry,
  getAllEntries,
  removeEntry,
  updateEntry,
  getTopics,
} from '../services/notebookService';
import { MessageContent } from './MessageContent';
import './MathNotebook.css';

interface MathNotebookProps {
  /** Wywoływane po kliknięciu "Powtórz w czacie" */
  onSolveInChat: (query: string) => void;
  /** Wywoływane żeby wrócić do czatu */
  onNavigateToChat: () => void;
  /** Wywoływane po usunięciu notatki (aktualizacja licznika w App) */
  onEntryDeleted?: () => void;
}

// ── Ikony SVG ────────────────────────────────────────────────────────────

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const TrashIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14H6L5 6" />
    <path d="M10 11v6M14 11v6" />
    <path d="M9 6V4h6v2" />
  </svg>
);

const EditIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

const ChatIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
  </svg>
);

const BookIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
  </svg>
);

const TagIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" />
    <line x1="7" y1="7" x2="7.01" y2="7" />
  </svg>
);

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const XIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

// ── Helper: formatowanie daty ──────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
}

// ── Karta pojedynczej notatki ──────────────────────────────────────────────

interface EntryCardProps {
  entry: NotebookEntry;
  onDelete: (id: string) => void;
  onUpdate: (id: string, patch: Partial<Pick<NotebookEntry, 'note' | 'tags' | 'title'>>) => void;
  onSolveInChat: (query: string) => void;
}

function EntryCard({ entry, onDelete, onUpdate, onSolveInChat }: EntryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [noteValue, setNoteValue] = useState(entry.note);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [showTagInput, setShowTagInput] = useState(false);

  const handleSaveNote = () => {
    onUpdate(entry.id, { note: noteValue });
    setEditingNote(false);
  };

  const handleCancelNote = () => {
    setNoteValue(entry.note);
    setEditingNote(false);
  };

  const handleAddTag = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && tagInput.trim()) {
      const newTag = tagInput.trim().toLowerCase();
      if (!entry.tags.includes(newTag)) {
        const newTags = [...entry.tags, newTag];
        onUpdate(entry.id, { tags: newTags });
      }
      setTagInput('');
      setShowTagInput(false);
    }
    if (e.key === 'Escape') {
      setTagInput('');
      setShowTagInput(false);
    }
  };

  const handleRemoveTag = (tag: string) => {
    const newTags = entry.tags.filter(t => t !== tag);
    onUpdate(entry.id, { tags: newTags });
  };

  const handleRepeatInChat = () => {
    // Jeśli mamy pytanie, użyj go; w przeciwnym razie użyj tytułu
    const query = entry.questionText || entry.title;
    onSolveInChat(query);
  };

  return (
    <div className={`notebook-card ${expanded ? 'expanded' : ''}`}>
      {/* Nagłówek karty */}
      <div className="notebook-card-header" onClick={() => setExpanded(!expanded)}>
        <div className="notebook-card-meta">
          <span className="notebook-topic-badge">{entry.topic}</span>
          <span className="notebook-date">{formatDate(entry.savedAt)} · {formatTime(entry.savedAt)}</span>
        </div>
        <div className="notebook-card-title">{entry.title}</div>
        <div className="notebook-expand-arrow">{expanded ? '▲' : '▼'}</div>
      </div>

      {/* Tagi */}
      {(entry.tags.length > 0 || showTagInput) && (
        <div className="notebook-tags">
          {entry.tags.map(tag => (
            <span key={tag} className="notebook-tag">
              <TagIcon /> {tag}
              <button
                className="notebook-tag-remove"
                onClick={(e) => { e.stopPropagation(); handleRemoveTag(tag); }}
                title="Usuń tag"
              >×</button>
            </span>
          ))}
          {showTagInput && (
            <input
              className="notebook-tag-input"
              value={tagInput}
              onChange={e => setTagInput(e.target.value)}
              onKeyDown={handleAddTag}
              placeholder="Dodaj tag, Enter..."
              autoFocus
            />
          )}
        </div>
      )}

      {/* Rozwinięta treść */}
      {expanded && (
        <div className="notebook-card-body">
          {/* Pytanie użytkownika (jeśli zapisane) */}
          {entry.questionText && (
            <div className="notebook-question">
              <span className="notebook-question-label">Twoje pytanie:</span>
              <span className="notebook-question-text">{entry.questionText}</span>
            </div>
          )}

          {/* Odpowiedź AI */}
          <div className="notebook-content">
            <MessageContent content={entry.content} />
          </div>

          {/* Własna notatka */}
          <div className="notebook-note-section">
            <div className="notebook-note-header">
              <span className="notebook-note-label">📝 Moja notatka</span>
              {!editingNote && (
                <button
                  className="notebook-action-btn"
                  onClick={() => setEditingNote(true)}
                  title="Edytuj notatkę"
                >
                  <EditIcon /> Edytuj
                </button>
              )}
            </div>
            {editingNote ? (
              <div className="notebook-note-editor">
                <textarea
                  className="notebook-note-textarea"
                  value={noteValue}
                  onChange={e => setNoteValue(e.target.value)}
                  placeholder="Wpisz własne notatki, spostrzeżenia, albo ważne wzory..."
                  rows={4}
                  autoFocus
                />
                <div className="notebook-note-actions">
                  <button className="notebook-save-btn" onClick={handleSaveNote}>
                    <CheckIcon /> Zapisz
                  </button>
                  <button className="notebook-cancel-btn" onClick={handleCancelNote}>
                    <XIcon /> Anuluj
                  </button>
                </div>
              </div>
            ) : (
              <div className="notebook-note-display">
                {entry.note
                  ? <p>{entry.note}</p>
                  : <p className="notebook-note-placeholder">Brak notatki. Kliknij "Edytuj" żeby dodać swoje spostrzeżenia.</p>
                }
              </div>
            )}
          </div>

          {/* Akcje */}
          <div className="notebook-card-actions">
            <button
              className="notebook-action-btn notebook-chat-btn"
              onClick={handleRepeatInChat}
              title="Wyślij to pytanie ponownie do czatu"
            >
              <ChatIcon /> Powtórz w czacie
            </button>
            <button
              className="notebook-action-btn notebook-tag-btn"
              onClick={() => setShowTagInput(!showTagInput)}
              title="Dodaj tag"
            >
              <TagIcon /> Dodaj tag
            </button>
            {!confirmDelete ? (
              <button
                className="notebook-action-btn notebook-delete-btn"
                onClick={() => setConfirmDelete(true)}
                title="Usuń notatkę"
              >
                <TrashIcon /> Usuń
              </button>
            ) : (
              <div className="notebook-delete-confirm">
                <span>Na pewno usunąć?</span>
                <button className="notebook-confirm-yes" onClick={() => onDelete(entry.id)}>Tak</button>
                <button className="notebook-confirm-no" onClick={() => setConfirmDelete(false)}>Nie</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Strona notatnika ──────────────────────────────────────────────────────

const MathNotebook: React.FC<MathNotebookProps> = ({ onSolveInChat, onNavigateToChat, onEntryDeleted }) => {
  const [entries, setEntries] = useState<NotebookEntry[]>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const [filterTopic, setFilterTopic] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const reload = useCallback(() => {
    setEntries(getAllEntries());
    setTopics(getTopics());
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleDelete = (id: string) => {
    removeEntry(id);
    reload();
    onEntryDeleted?.();
  };

  const handleUpdate = (id: string, patch: Partial<Pick<NotebookEntry, 'note' | 'tags' | 'title'>>) => {
    updateEntry(id, patch);
    reload();
  };

  // Filtrowanie
  const filtered = entries.filter(e => {
    const matchesTopic = !filterTopic || e.topic === filterTopic;
    const q = searchQuery.toLowerCase();
    const matchesSearch = !q ||
      e.title.toLowerCase().includes(q) ||
      e.content.toLowerCase().includes(q) ||
      e.note.toLowerCase().includes(q) ||
      e.tags.some(t => t.includes(q)) ||
      (e.questionText || '').toLowerCase().includes(q);
    return matchesTopic && matchesSearch;
  });

  // ── Empty state ──
  if (entries.length === 0) {
    return (
      <div className="notebook-container">
        <div className="notebook-header">
          <div className="notebook-header-title">
            <BookIcon />
            <h2>Notatnik Matematyczny</h2>
          </div>
          <p className="notebook-subtitle">Tutaj znajdziesz zapisane rozwiązania</p>
        </div>
        <div className="notebook-empty">
          <div className="notebook-empty-icon">📒</div>
          <h3>Notatnik jest pusty</h3>
          <p>
            Podczas rozmowy z Formulo kliknij przycisk <strong>🔖 Zapisz</strong> przy odpowiedzi
            agenta, żeby dodać rozwiązanie do notatnika. Idealne do powtórek przed maturą!
          </p>
          <button className="notebook-go-chat-btn" onClick={onNavigateToChat}>
            Przejdź do czatu
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="notebook-wrapper">
    <div className="notebook-container">
      {/* Nagłówek */}
      <div className="notebook-header">
        <div className="notebook-header-title">
          <BookIcon />
          <h2>Notatnik Matematyczny</h2>
          <span className="notebook-count">{entries.length}</span>
        </div>
        <p className="notebook-subtitle">Twoje zapisane rozwiązania – zawsze pod ręką</p>
      </div>

      {/* Pasek filtrów */}
      <div className="notebook-filters">
        <div className="notebook-search-wrapper">
          <SearchIcon />
          <input
            type="text"
            className="notebook-search"
            placeholder="Szukaj w notatkach..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="notebook-search-clear" onClick={() => setSearchQuery('')}>×</button>
          )}
        </div>

        <select
          className="notebook-topic-filter"
          value={filterTopic}
          onChange={e => setFilterTopic(e.target.value)}
        >
          <option value="">Wszystkie tematy</option>
          {topics.map(t => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>

      {/* Info o wynikach */}
      {(filterTopic || searchQuery) && (
        <div className="notebook-results-info">
          {filtered.length === 0
            ? 'Brak pasujących notatek'
            : `${filtered.length} z ${entries.length} notatek`}
          {(filterTopic || searchQuery) && (
            <button
              className="notebook-clear-filters"
              onClick={() => { setFilterTopic(''); setSearchQuery(''); }}
            >
              Wyczyść filtry
            </button>
          )}
        </div>
      )}

      {/* Lista notatek */}
      <div className="notebook-list">
        {filtered.map(entry => (
          <EntryCard
            key={entry.id}
            entry={entry}
            onDelete={handleDelete}
            onUpdate={handleUpdate}
            onSolveInChat={(q) => { onSolveInChat(q); onNavigateToChat(); }}
          />
        ))}
        {filtered.length === 0 && (filterTopic || searchQuery) && (
          <div className="notebook-no-results">
            <p>Nie znaleziono notatek pasujących do kryteriów.</p>
          </div>
        )}
      </div>

      {/* Stopka notatnika */}
      <div className="notebook-footer">
        <p>💡 Wskazówka: Kliknij na kartę żeby rozwinąć pełne rozwiązanie i dodać własne notatki.</p>
      </div>
    </div>
    </div>
  );
};

export default MathNotebook;
