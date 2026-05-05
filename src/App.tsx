import { useState, useRef, useEffect, useCallback } from 'react';
import { ThreeAgentOrchestrator, Message, MLXConfig, LLMProvider } from './services/threeAgentSystem';
import { ChatHistoryService, ChatSession } from './services/chatHistoryService';
import { ChatHistorySidebar } from './components/ChatHistorySidebar';
import { MessageContent } from './components/MessageContent';
import { FormulaReference } from './components/FormulaReference';
import DailyChallenge from './components/DailyChallenge';
import { QuizMode } from './components/QuizMode';
import ImageUpload from './components/ImageUpload';
import WelcomeLanding from './components/WelcomeLanding';
import { GamificationWidget } from './components/GamificationWidget';
import StudyPlan from './components/StudyPlan';
import MathKeyboard from './components/MathKeyboard';
import PracticeSuggestions from './components/PracticeSuggestions';
import MathNotebook from './components/MathNotebook';
import StatsPanel from './components/StatsPanel';
import { addEntry, isBookmarked, countEntries } from './services/notebookService';
import { loadGamificationState, recordSolve, recordQuiz, GamificationState } from './services/gamificationService';
import './components/FormulaReference.css';
import './components/DailyChallenge.css';
import './components/QuizMode.css';
import './components/ImageUpload.css';
import './components/WelcomeLanding.css';
import './components/GamificationWidget.css';
import './components/StudyPlan.css';
import './components/MathKeyboard.css';
import './components/PracticeSuggestions.css';
import './components/MathNotebook.css';
import './components/StatsPanel.css';
import { toPng } from 'html-to-image';
import html2canvas from 'html2canvas';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import ErrorBoundary from './components/ErrorBoundary';
import './App.css';

// Google Analytics / Ads conversion tracking
declare global {
  interface Window { gtag?: (...args: unknown[]) => void; }
}
function trackEvent(name: string, params?: Record<string, unknown>) {
  if (window.gtag) window.gtag('event', name, params);
}

// Icon component - uses inline SVG for cross-browser compatibility (no emoji dependency)
const Icon = ({ type, label }: { type: string; label?: string }) => {
  const icons: Record<string, { svg: string; color: string }> = {
    graduation: { svg: '<path d="M12 3L1 9l4 2.18v4L12 19l7-3.82v-4l2-1.09V17h2V9L12 3zm6.82 6L12 12.72 5.18 9 12 5.28 18.82 9zM17 15.99l-5 2.73-5-2.73v-3.72L12 15l5-2.73v3.72z"/>', color: '#6b46c1' },
    books: { svg: '<path d="M21 5c-1.11-.35-2.33-.5-3.5-.5-1.95 0-4.05.4-5.5 1.5-1.45-1.1-3.55-1.5-5.5-1.5S2.45 4.9 1 6v14.65c0 .25.25.5.5.5.1 0 .15-.05.25-.05C3.1 20.45 5.05 20 6.5 20c1.95 0 4.05.4 5.5 1.5 1.35-.85 3.8-1.5 5.5-1.5 1.65 0 3.35.3 4.75 1.05.1.05.15.05.25.05.25 0 .5-.25.5-.5V6c-.6-.45-1.25-.75-2-1zm0 13.5c-1.1-.35-2.3-.5-3.5-.5-1.7 0-4.15.65-5.5 1.5V8c1.35-.85 3.8-1.5 5.5-1.5 1.2 0 2.4.15 3.5.5v11.5z"/>', color: '#2563eb' },
    camera: { svg: '<circle cx="12" cy="12" r="3.2"/><path d="M9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z"/>', color: '#059669' },
    plug: { svg: '<path d="M16 9V4.5C16 3.12 17.12 2 18.5 2S21 3.12 21 4.5V9h-5zm-8 0V4.5C8 3.12 6.88 2 5.5 2S3 3.12 3 4.5V9h5zm11.5 2h-15C3.67 11 3 11.67 3 12.5V13c0 3.47 2.61 6.34 6 6.92V22h6v-2.08c3.39-.58 6-3.45 6-6.92v-.5c0-.83-.67-1.5-1.5-1.5z"/>', color: '#10b981' },
    target: { svg: '<path d="M12 2C6.49 2 2 6.49 2 12s4.49 10 10 10 10-4.49 10-10S17.51 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm3-8c0 1.66-1.34 3-3 3s-3-1.34-3-3 1.34-3 3-3 3 1.34 3 3z"/>', color: '#dc2626' },
    wave: { svg: '<path d="M7 11.5c0-.83.67-1.5 1.5-1.5S10 10.67 10 11.5V12h4v-.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5V15c0 2.21-1.79 4-4 4h-2c-2.21 0-4-1.79-4-4v-3.5zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/>', color: '#f59e0b' },
    brain: { svg: '<path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/>', color: '#8b5cf6' },
    bolt: { svg: '<path d="M7 2v11h3v9l7-12h-4l4-8z"/>', color: '#f59e0b' },
    microscope: { svg: '<path d="M13 11.33L18 18H6l5-6.67V6.83c-.85-.3-1.53-1-1.83-1.83h3.66c-.3.83-.98 1.53-1.83 1.83v4.5zM15.32 3a2.98 2.98 0 01-1.56 2.2 2.98 2.98 0 01-3.52 0A2.98 2.98 0 018.68 3H6v2h1.09A5 5 0 007 7.17V11l-4 5.33V20h18v-3.67L17 11V7.17A5 5 0 0016.91 5H18V3h-2.68z"/>', color: '#6366f1' },
    bulb: { svg: '<path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z"/>', color: '#eab308' },
    user: { svg: '<path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>', color: '#6b7280' },
    robot: { svg: '<path d="M12 2a2 2 0 012 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 017 7h1a1 1 0 011 1v3a1 1 0 01-1 1h-1v1a2 2 0 01-2 2H5a2 2 0 01-2-2v-1H2a1 1 0 01-1-1v-3a1 1 0 011-1h1a7 7 0 017-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 012-2zM7.5 13A1.5 1.5 0 006 14.5 1.5 1.5 0 007.5 16 1.5 1.5 0 009 14.5 1.5 1.5 0 007.5 13zm9 0a1.5 1.5 0 00-1.5 1.5 1.5 1.5 0 001.5 1.5 1.5 1.5 0 001.5-1.5 1.5 1.5 0 00-1.5-1.5z"/>', color: '#6366f1' },
    wrench: { svg: '<path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/>', color: '#3b82f6' },
    error: { svg: '<path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/>', color: '#dc2626' },
    success: { svg: '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>', color: '#16a34a' },
    trash: { svg: '<path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>', color: '#ef4444' },
  };
  const icon = icons[type] || { svg: '<circle cx="12" cy="12" r="4"/>', color: '#666' };
  return (
    <svg
      className="icon-svg"
      viewBox="0 0 24 24"
      fill={icon.color}
      width="1em"
      height="1em"
      role="img"
      aria-label={label || type}
      style={{ verticalAlign: 'middle', display: 'inline-block', flexShrink: 0 }}
      dangerouslySetInnerHTML={{ __html: icon.svg }}
    />
  );
};

// Theme management
type Theme = 'light' | 'dark';

function getInitialTheme(): Theme {
  const stored = localStorage.getItem('formulo-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
  return 'dark';
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('formulo-theme', theme);
}

const MCP_PROXY_URL = import.meta.env.VITE_MCP_PROXY_URL || 'http://localhost:3001';
const DEFAULT_REMOTE_MODEL = import.meta.env.VITE_REMOTE_MODEL || 'speakleash/Bielik-11B-v3.0-Instruct';
const DEFAULT_REMOTE_API_URL = import.meta.env.VITE_REMOTE_API_URL || 'https://llmlab.plgrid.pl/api';
const PRECONFIGURED_PROVIDER = import.meta.env.VITE_LLM_PROVIDER as string | undefined;

function App() {
  const [classifierMode] = useState(true);
  const [llmProvider, setLlmProvider] = useState<LLMProvider>(PRECONFIGURED_PROVIDER === 'remote' ? 'remote' : 'ollama');
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [orchestratorReady, setOrchestratorReady] = useState(false);
  const [, setMcpConnected] = useState(false);
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [activePage, setActivePage] = useState<'chat' | 'formulas' | 'quiz' | 'plan' | 'notebook' | 'stats'>(() => {
    const params = new URLSearchParams(window.location.search);
    const p = params.get('p');
    if (p === 'formulas') return 'formulas';
    if (p === 'quiz') return 'quiz';
    if (p === 'plan') return 'plan';
    if (p === 'notebook') return 'notebook';
    if (p === 'stats') return 'stats';
    return 'chat';
  });
  // Stan licznika notatnika (do odświeżania badge)
  const [notebookCount, setNotebookCount] = useState<number>(() => countEntries());
  // Śledzenie zaznaczonej przez użytkownika wiadomości (do bookmarku)
  const [bookmarkedIds, setBookmarkedIds] = useState<Set<string>>(new Set());
  const [gamificationState, setGamificationState] = useState<GamificationState>(loadGamificationState);
  const [shareStatus, setShareStatus] = useState<'idle' | 'saving' | 'done' | 'error'>('idle');
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  // Warm-up status (Bedrock + Lean) — pollujemy /api/status zeby pokazac
  // banner uzytkownikowi gdy ciezkie zaleznosci sie rozkrecaja.
  // Bedrock status liczony z faktow: warming gdy retry trwa, warm gdy ostatni
  // success <4 min temu, cold inaczej.
  type LeanComponent = { status: 'cold' | 'warming' | 'warm' | 'disabled'; durationSec: number | null; elapsedSec: number | null };
  type BedrockComponent = {
    status: 'cold' | 'warming' | 'warm' | 'disabled';
    warmingForSec: number | null;
    sinceLastSuccessSec: number | null;
    totalInvokes?: number;
    totalRetries?: number;
  };
  const [warmStatus, setWarmStatus] = useState<{ lean: LeanComponent; bedrock: BedrockComponent } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/status');
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setWarmStatus(data);
      } catch {
        // ignore network errors
      }
    };
    poll();
    // 5s polling zeby banner pokazal sie szybko gdy user wysle zapytanie i
    // model jest cold (cold start trwa do 5 min, chcemy info od razu)
    const interval = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const showWarmupBanner = warmStatus && (
    warmStatus.bedrock.status === 'warming' ||
    warmStatus.lean.status === 'warming'
  );

  // Apply theme on mount and when it changes
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Listen for system preference changes
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      if (!localStorage.getItem('formulo-theme')) {
        setTheme(e.matches ? 'dark' : 'light');
      }
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const toggleTheme = () => setTheme(prev => prev === 'dark' ? 'light' : 'dark');

  const navigateTo = (page: 'chat' | 'formulas' | 'quiz' | 'plan' | 'notebook' | 'stats') => {
    setActivePage(page);
    const url = (page === 'chat') ? window.location.pathname : `?p=${page}`;
    window.history.replaceState({}, '', url);
  };

  // Refresh gamification state after actions
  const refreshGamification = useCallback(() => {
    setGamificationState(loadGamificationState());
  }, []);

  // Zapisz wiadomość AI do notatnika
  const handleBookmark = useCallback((msg: Message) => {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    // Znajdź poprzednią wiadomość użytkownika jako pytanie (przez ref do aktualnych wiadomości)
    const currentMessages = messagesRef.current;
    const idx = currentMessages.findIndex(m => m.id === msg.id);
    const userMsg = idx > 0 ? currentMessages[idx - 1] : null;
    const questionText = userMsg && typeof userMsg.content === 'string' ? userMsg.content : undefined;
    addEntry(content, { questionText });
    setNotebookCount(countEntries());
    setBookmarkedIds(ids => new Set([...ids, msg.id]));
  }, []);

  const orchestratorRef = useRef<ThreeAgentOrchestrator | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const urlQueryHandled = useRef(false);
  // Ref do bieżących wiadomości (używany przez handleBookmark bez dodawania messages do dep)
  const messagesRef = useRef<Message[]>(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Auto-resize textarea as user types
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      const newHeight = Math.min(textarea.scrollHeight, 300); // max 300px
      textarea.style.height = `${newHeight}px`;
    }
  }, [inputMessage]);

  // Auto-detect available LLM backend and skip config screen
  // Priority: 0) VITE_LLM_PROVIDER preset → 1) Proxy with API key (remote) → 2) MLX on port 8011 → 3) Ollama on 11434 → show config
  useEffect(() => {
    const autoDetect = async () => {
      // 0. Pre-configured remote provider (e.g. Heroku deployment)
      if (PRECONFIGURED_PROVIDER === 'remote') {
        const mlxConfig: MLXConfig = {
          provider: 'remote',
          baseUrl: DEFAULT_REMOTE_API_URL,
          model: DEFAULT_REMOTE_MODEL,
          temperature: 0.7,
          maxTokens: 4096,
        };
        orchestratorRef.current = new ThreeAgentOrchestrator('sympy', mlxConfig, false);
        try {
          await orchestratorRef.current.connectMCP(MCP_PROXY_URL);
          setMcpConnected(true);
        } catch { /* MCP connection will be retried on first message */ }
        const newChatId = ChatHistoryService.generateChatId();
        setCurrentChatId(newChatId);
        return;
      }

      // 1. Check if MLX is running locally (port 8011)
      try {
        const mlxRes = await fetch('http://localhost:8011/v1/models', { signal: AbortSignal.timeout(2000) });
        const mlxData = await mlxRes.json();
        if (mlxData?.data?.length > 0) {
          const detectedModel = mlxData.data[0].id || 'local-model';
          console.log('Auto-detected MLX model:', detectedModel);
          setLlmProvider('mlx');

          const mlxConfig: MLXConfig = {
            provider: 'mlx',
            baseUrl: 'http://localhost:8011',
            model: detectedModel,
            temperature: 0.7,
            maxTokens: 4096,
          };
          orchestratorRef.current = new ThreeAgentOrchestrator('sympy', mlxConfig, false);
          await orchestratorRef.current.connectMCP(MCP_PROXY_URL);
          setMcpConnected(true);
          const newChatId = ChatHistoryService.generateChatId();
          setCurrentChatId(newChatId);
          return;
        }
      } catch { /* MLX not running, continue to Ollama check */ }

      // 3. Check if Ollama is running locally (port 11434)
      try {
        const ollamaRes = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) });
        const ollamaData = await ollamaRes.json();
        if (ollamaData?.models?.length > 0) {
          const bielikModel = ollamaData.models.find((m: { name: string }) => /bielik/i.test(m.name));
          const selectedModel = bielikModel?.name || ollamaData.models[0].name;
          console.log('Auto-detected Ollama model:', selectedModel);
          setLlmProvider('ollama');

          const mlxConfig: MLXConfig = {
            provider: 'ollama',
            baseUrl: 'http://localhost:11434',
            model: selectedModel,
            temperature: 0.7,
            maxTokens: 4096,
          };
          orchestratorRef.current = new ThreeAgentOrchestrator('sympy', mlxConfig, false);
          await orchestratorRef.current.connectMCP(MCP_PROXY_URL);
          setMcpConnected(true);
          const newChatId = ChatHistoryService.generateChatId();
          setCurrentChatId(newChatId);
          return;
        }
      } catch { /* Ollama not running */ }

      // 4. Fallback: initialize with remote defaults
      console.log('No LLM backend auto-detected, falling back to remote');
      setLlmProvider('remote');
      const fallbackConfig: MLXConfig = {
        provider: 'remote',
        baseUrl: DEFAULT_REMOTE_API_URL,
        model: DEFAULT_REMOTE_MODEL,
        temperature: 0.7,
        maxTokens: 4096,
      };
      orchestratorRef.current = new ThreeAgentOrchestrator('sympy', fallbackConfig, false);
      try {
        await orchestratorRef.current.connectMCP(MCP_PROXY_URL);
        setMcpConnected(true);
      } catch { /* MCP connection will be retried */ }
      const newChatId = ChatHistoryService.generateChatId();
      setCurrentChatId(newChatId);
      setOrchestratorReady(true);
    };
    autoDetect();
  }, []);

  // Load chat sessions on mount
  useEffect(() => {
    const sessions = ChatHistoryService.getAllSessions();
    setChatSessions(sessions);
  }, []);

  // Save messages to history whenever they change
  useEffect(() => {
    if (messages.length > 0 && currentChatId) {
      const session: ChatSession = {
        id: currentChatId,
        provider: llmProvider,
        messages,
        createdAt: messages[0]?.timestamp.toISOString() || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      ChatHistoryService.saveSession(session);
      setChatSessions(ChatHistoryService.getAllSessions());
    }
  }, [messages, currentChatId]);

  // Sync classifierMode toggle to orchestrator at runtime
  useEffect(() => {
    if (orchestratorRef.current) {
      orchestratorRef.current.setClassifierMode(classifierMode);
    }
  }, [classifierMode]);

  const handleSendMessage = async () => {
    if (!inputMessage.trim() || !orchestratorRef.current) {
      return;
    }

    // If already processing, abort the previous request
    if (isProcessing && abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    setIsProcessing(true);
    const userInput = inputMessage;
    setInputMessage('');
    trackEvent('solve_started', { query_length: userInput.length });

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      await orchestratorRef.current.processMessage(
        userInput,
        (message) => {
          if (controller.signal.aborted) return;
          setMessages(prev => {
            const existingIndex = prev.findIndex(m => m.id === message.id);
            if (existingIndex !== -1) {
              const updated = [...prev];
              updated[existingIndex] = message;
              return updated;
            }
            return [...prev, message];
          });
        },
        { classifierMode, abortSignal: controller.signal }
      );
      trackEvent('solve_completed');
      recordSolve();
      refreshGamification();
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      console.error('Blad podczas przetwarzania:', error);
      trackEvent('solve_error');
      alert('Wystapil blad podczas komunikacji z agentem. Sprawdz klucz API i polaczenie.');
    } finally {
      if (abortControllerRef.current === controller) {
        setIsProcessing(false);
        abortControllerRef.current = null;
      }
    }
  };

  const submitQuery = (query: string) => {
    if (!orchestratorRef.current) return;
    if (isProcessing && abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setInputMessage('');
    setIsProcessing(true);
    trackEvent('solve_started', { query_length: query.length, source: 'formula_card' });
    const controller = new AbortController();
    abortControllerRef.current = controller;
    orchestratorRef.current.processMessage(
      query,
      (message) => {
        if (controller.signal.aborted) return;
        setMessages(prev => {
          const idx = prev.findIndex(m => m.id === message.id);
          if (idx !== -1) { const u = [...prev]; u[idx] = message; return u; }
          return [...prev, message];
        });
      },
      { classifierMode, abortSignal: controller.signal }
    ).then(() => {
      trackEvent('solve_completed', { source: 'formula_card' });
      recordSolve();
      refreshGamification();
    }).catch((error) => {
      if (!controller.signal.aborted) {
        console.error('Blad podczas przetwarzania:', error);
        trackEvent('solve_error');
      }
    }).finally(() => {
      if (abortControllerRef.current === controller) {
        setIsProcessing(false);
        abortControllerRef.current = null;
      }
    });
  };

  // Load shared solution from /s/:id or auto-submit from ?q=
  useEffect(() => {
    if (urlQueryHandled.current) return;
    const path = window.location.pathname;
    const shareMatch = path.match(/^\/s\/([a-z0-9]+)$/i);
    if (shareMatch) {
      urlQueryHandled.current = true;
      fetch(`/api/share/${shareMatch[1]}`)
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (data && data.messages) {
            const loaded = data.messages.map((m: any, i: number) => ({
              id: `shared-${i}`,
              role: m.role,
              content: m.content,
              agentName: m.agentName || undefined,
              timestamp: new Date(),
            }));
            setMessages(loaded);
          }
        })
        .catch(() => {});
      return;
    }
    if (!orchestratorReady) return;
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q');
    if (q && q.trim()) {
      urlQueryHandled.current = true;
      window.history.replaceState({}, '', window.location.pathname);
      submitQuery(q.trim());
    }
  }, [orchestratorReady]);

  const handleShare = async () => {
    if (messages.length === 0 || shareStatus === 'saving') return;
    setShareStatus('saving');
    try {
      // Share the full conversation
      const shareMessages = messages.map(m => ({
        role: m.role,
        content: m.content,
        agentName: (m as any).agentName || undefined,
      }));
      const res = await fetch('/api/share/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: shareMessages }),
      });
      if (!res.ok) throw new Error('share failed');
      const { url } = await res.json();
      const fullUrl = `${window.location.origin}${url}`;
      await navigator.clipboard.writeText(fullUrl);
      setShareUrl(fullUrl);
      setShareStatus('done');
      trackEvent('conversation_shared', { message_count: messages.length });
      setTimeout(() => { setShareStatus('idle'); setShareUrl(null); }, 8000);
    } catch {
      setShareStatus('error');
      setTimeout(() => setShareStatus('idle'), 3000);
    }
  };

  const handleClearHistory = () => {
    if (orchestratorRef.current) {
      orchestratorRef.current.clearHistory();
      setMessages([]);
      // Create new chat session
      const newChatId = ChatHistoryService.generateChatId();
      setCurrentChatId(newChatId);
    }
  };

  const handleLoadChat = (chatId: string) => {
    const session = ChatHistoryService.getSession(chatId);
    if (session && orchestratorRef.current) {
      // Parse messages back from session (timestamps are strings in storage)
      const loadedMessages = session.messages.map(m => ({
        ...m,
        timestamp: new Date(m.timestamp),
      }));
      setMessages(loadedMessages);
      setCurrentChatId(chatId);
      setShowHistory(false);

      // Clear orchestrator history
      orchestratorRef.current.clearHistory();
    }
  };

  const handleDeleteChat = (chatId: string) => {
    if (confirm('Czy na pewno chcesz usunąć tę konwersację?')) {
      ChatHistoryService.deleteSession(chatId);
      setChatSessions(ChatHistoryService.getAllSessions());
      if (currentChatId === chatId) {
        handleClearHistory();
      }
    }
  };

  const handleNewChat = () => {
    handleClearHistory();
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // Wstawia tekst z klawiatury matematycznej w pozycji kursora
  const handleMathInsert = useCallback((text: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      setInputMessage(prev => prev + text);
      return;
    }
    const start = textarea.selectionStart ?? inputMessage.length;
    const end = textarea.selectionEnd ?? inputMessage.length;
    const before = inputMessage.slice(0, start);
    const after = inputMessage.slice(end);
    const newValue = before + text + after;
    setInputMessage(newValue);

    // Ustaw kursor za wstawionym tekstem
    requestAnimationFrame(() => {
      const newPos = start + text.length;
      textarea.setSelectionRange(newPos, newPos);
      textarea.focus();
    });
  }, [inputMessage]);

  const handleExportToPNG = async () => {
    const messagesContainer = document.querySelector('.messages-container');
    if (!messagesContainer || messages.length === 0) {
      alert('Brak konwersacji do wyeksportowania');
      return;
    }

    try {
      // Create a clean wrapper for export
      const exportWrapper = document.createElement('div');
      exportWrapper.style.position = 'absolute';
      exportWrapper.style.top = '0';
      exportWrapper.style.left = '0';
      exportWrapper.style.width = '800px';
      exportWrapper.style.backgroundColor = '#ffffff';
      exportWrapper.style.padding = '30px';
      exportWrapper.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif';
      exportWrapper.style.zIndex = '99999';
      exportWrapper.style.boxSizing = 'border-box';

      // Add title
      const title = document.createElement('h2');
      title.textContent = '\u{1F393} Konwersacja - Formulo';
      title.style.marginBottom = '20px';
      title.style.color = '#333';
      exportWrapper.appendChild(title);

      // Clone each message individually
      const messageElements = messagesContainer.querySelectorAll('.message');
      messageElements.forEach((msgElement) => {
        const msgClone = msgElement.cloneNode(true) as HTMLElement;
        msgClone.style.marginBottom = '15px';
        msgClone.style.opacity = '1';
        msgClone.style.animation = 'none';
        msgClone.style.maxWidth = '100%';
        msgClone.style.boxSizing = 'border-box';
        msgClone.style.borderRadius = '12px';
        msgClone.style.padding = '15px 20px';
        msgClone.style.backgroundColor = msgClone.classList.contains('user') ? '#667eea' : '#f0f0f0';
        if (msgClone.classList.contains('user')) {
          msgClone.style.color = 'white';
        }

        // Remove animations and fix font issues for html-to-image
        const allElements = msgClone.querySelectorAll('*');
        allElements.forEach((el) => {
          const htmlEl = el as HTMLElement;
          htmlEl.style.opacity = '1';
          htmlEl.style.animation = 'none';
        });
        // KaTeX elements use custom fonts that crash html-to-image.
        // Replace KaTeX rendered math with its source text (annotation).
        msgClone.querySelectorAll('.katex').forEach(katexEl => {
          const annotation = katexEl.querySelector('annotation');
          const texSource = annotation?.textContent || katexEl.textContent || '';
          const replacement = document.createElement('code');
          replacement.textContent = texSource;
          replacement.style.fontFamily = 'monospace';
          replacement.style.fontSize = '0.9em';
          replacement.style.backgroundColor = 'rgba(0,0,0,0.05)';
          replacement.style.padding = '1px 4px';
          replacement.style.borderRadius = '3px';
          katexEl.replaceWith(replacement);
        });

        // Ensure code blocks don't overflow
        const codeBlocks = msgClone.querySelectorAll('pre, code');
        codeBlocks.forEach((el) => {
          const htmlEl = el as HTMLElement;
          htmlEl.style.whiteSpace = 'pre-wrap';
          htmlEl.style.wordBreak = 'break-word';
          htmlEl.style.overflow = 'hidden';
          htmlEl.style.maxWidth = '100%';
        });

        exportWrapper.appendChild(msgClone);
      });

      document.body.appendChild(exportWrapper);

      // Wait for layout
      await new Promise(resolve => setTimeout(resolve, 300));

      // Try html-to-image first (SVG foreignObject — proper text rendering),
      // fallback to html2canvas if it fails (e.g. KaTeX font issues)
      let dataUrl: string | null = null;
      try {
        dataUrl = await toPng(exportWrapper, {
          pixelRatio: 2,
          backgroundColor: '#ffffff',
          style: { transform: 'none' },
          filter: (node: HTMLElement) => {
            if (!node.classList) return true;
            return !node.classList.contains('processing-indicator') &&
                   !node.classList.contains('spinner');
          },
        });
      } catch (e) {
        console.warn('html-to-image failed, falling back to html2canvas:', e);
        // Fallback: html2canvas (may have spacing issues but at least works)
        const canvas = await html2canvas(exportWrapper, {
          backgroundColor: '#ffffff',
          scale: 2,
          logging: false,
          useCORS: true,
          allowTaint: true,
        });
        dataUrl = canvas.toDataURL('image/png');
      }

      // Remove temporary container
      document.body.removeChild(exportWrapper);

      // Download
      if (dataUrl) {
        const link = document.createElement('a');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        link.download = `konwersacja-${timestamp}.png`;
        link.href = dataUrl;
        link.click();
      }
    } catch (error) {
      console.error('Błąd eksportu do PNG:', error);
      alert('Wystąpił błąd podczas eksportu do PNG');
    }
  };

  return (
    <div className="app-container">
      {showWarmupBanner && (
        <div style={{
          background: 'linear-gradient(90deg, #fef3c7 0%, #fde68a 100%)',
          color: '#78350f',
          padding: '10px 16px',
          fontSize: '14px',
          textAlign: 'center',
          borderBottom: '1px solid #f59e0b',
          lineHeight: 1.4,
        }}>
          <strong>⏳ Model się rozkręca</strong>
          {warmStatus?.bedrock.status === 'warming' && warmStatus.bedrock.warmingForSec != null && (
            <> ({warmStatus.bedrock.warmingForSec}s)</>
          )}
          . Pierwsze zapytanie po dłuższej przerwie może potrwać 5-10 minut.
          Kolejne będą szybkie. Bedrock CMI ładuje 11B parametrów Bielika do GPU.
        </div>
      )}
      <header className="app-header">
        <h1>
          <svg viewBox="0 0 32 32" width="28" height="28" style={{ flexShrink: 0 }}>
            <defs>
              <linearGradient id="logoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" style={{ stopColor: '#667eea' }} />
                <stop offset="100%" style={{ stopColor: '#764ba2' }} />
              </linearGradient>
            </defs>
            <rect width="32" height="32" rx="7" fill="url(#logoGrad)" />
            <text x="5" y="27" fontFamily="Georgia, serif" fontSize="28" fontWeight="bold" fill="white" opacity="0.95">∫</text>
            <text x="17" y="22" fontFamily="Georgia, serif" fontSize="14" fontStyle="italic" fontWeight="bold" fill="rgba(255,255,255,0.7)">f</text>
          </svg>
          Formulo
        </h1>
        <div className="header-controls">
          <button onClick={toggleTheme} className="theme-toggle" title={theme === 'dark' ? 'Tryb jasny' : 'Tryb ciemny'}>
            {theme === 'dark' ? (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5"/>
                <line x1="12" y1="1" x2="12" y2="3"/>
                <line x1="12" y1="21" x2="12" y2="23"/>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                <line x1="1" y1="12" x2="3" y2="12"/>
                <line x1="21" y1="12" x2="23" y2="12"/>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
              </svg>
            )}
          </button>
          <div className="page-tabs">
            <button className={`page-tab ${activePage === 'chat' ? 'active' : ''}`} onClick={() => navigateTo('chat')} title="Czat">
              <span className="tab-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
              </span>
              <span className="tab-label">Czat</span>
            </button>
            <button className={`page-tab ${activePage === 'plan' ? 'active' : ''}`} onClick={() => navigateTo('plan')} title="Plan nauki">
              <span className="tab-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2"/>
                  <path d="M16 2v4M8 2v4M3 10h18"/>
                  <path d="m9 16 2 2 4-4"/>
                </svg>
              </span>
              <span className="tab-label">Plan</span>
            </button>
            <button className={`page-tab ${activePage === 'quiz' ? 'active' : ''}`} onClick={() => navigateTo('quiz')} title="Sprawdź się">
              <span className="tab-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <circle cx="12" cy="12" r="6"/>
                  <circle cx="12" cy="12" r="2"/>
                </svg>
              </span>
              <span className="tab-label">Sprawdź</span>
            </button>
            <button className={`page-tab ${activePage === 'formulas' ? 'active' : ''}`} onClick={() => navigateTo('formulas')} title="Wzory">
              <span className="tab-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 7V5a2 2 0 0 1 2-2h2"/>
                  <path d="M16 3h2a2 2 0 0 1 2 2v2"/>
                  <path d="M20 17v2a2 2 0 0 1-2 2h-2"/>
                  <path d="M8 21H6a2 2 0 0 1-2-2v-2"/>
                  <path d="M9 9h6"/>
                  <path d="M9 13h6"/>
                  <path d="M9 17h4"/>
                </svg>
              </span>
              <span className="tab-label">Wzory</span>
            </button>
            <button className={`page-tab ${activePage === 'notebook' ? 'active' : ''}`} onClick={() => navigateTo('notebook')} title="Notatnik Matematyczny">
              <span className="tab-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
                </svg>
              </span>
              <span className="tab-label">Notatnik</span>
              {notebookCount > 0 && (
                <span className="notebook-tab-badge">{notebookCount}</span>
              )}
            </button>
            <button className={`page-tab ${activePage === 'stats' ? 'active' : ''}`} onClick={() => navigateTo('stats')} title="Moje Statystyki">
              <span className="tab-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3v18h18"/>
                  <rect x="7" y="12" width="3" height="6" rx="0.5"/>
                  <rect x="12" y="8" width="3" height="10" rx="0.5"/>
                  <rect x="17" y="5" width="3" height="13" rx="0.5"/>
                </svg>
              </span>
              <span className="tab-label">Statystyki</span>
            </button>
          </div>
          <GamificationWidget state={gamificationState} compact={true} />
          <button onClick={() => setShowHistory(true)} className="history-button">
            <Icon type="books" /> Historia
          </button>
          <button onClick={handleExportToPNG} className="export-button" disabled={messages.length === 0}>
            <Icon type="camera" /> Eksport
          </button>
<button onClick={handleClearHistory} className="clear-button">
            Nowy czat
          </button>
        </div>
      </header>

      {activePage === 'formulas' ? (
        <div className="chat-container">
          <ErrorBoundary sectionName="Wzory">
          <FormulaReference
            onSubmitQuery={(q) => { submitQuery(q); navigateTo('chat'); }}
            onNavigateToChat={() => navigateTo('chat')}
          />
          </ErrorBoundary>
        </div>
      ) : activePage === 'quiz' ? (
        <div className="chat-container">
          <div className="page-scroll-container">
          <ErrorBoundary sectionName="Quiz">
          <QuizMode
            onSubmitQuery={(q) => {
              submitQuery(q);
              navigateTo('chat');
            }}
            onNavigateToChat={() => navigateTo('chat')}
            onQuizComplete={(score, total) => {
              recordQuiz(score, total);
              refreshGamification();
            }}
          />
          </ErrorBoundary>
          </div>
        </div>
      ) : activePage === 'plan' ? (
        <div className="chat-container">
          <div className="page-scroll-container">
          <ErrorBoundary sectionName="Plan nauki">
          <StudyPlan
            onSubmitQuery={(q) => { submitQuery(q); navigateTo('chat'); }}
            onNavigateToChat={() => navigateTo('chat')}
          />
          </ErrorBoundary>
          </div>
        </div>
      ) : activePage === 'notebook' ? (
        <div className="chat-container">
          <div className="page-scroll-container">
          <ErrorBoundary sectionName="Notatnik">
          <MathNotebook
            onSolveInChat={(q) => { submitQuery(q); navigateTo('chat'); }}
            onNavigateToChat={() => navigateTo('chat')}
            onEntryDeleted={() => setNotebookCount(countEntries())}
          />
          </ErrorBoundary>
          </div>
        </div>
      ) : activePage === 'stats' ? (
        <div className="chat-container">
          <div className="page-scroll-container">
          <ErrorBoundary sectionName="Statystyki">
          <StatsPanel
            state={gamificationState}
            onNavigateToChat={() => navigateTo('chat')}
          />
          </ErrorBoundary>
          </div>
        </div>
      ) : (
      <div className="chat-container">
        <div className="messages-container">
          {messages.length === 0 ? (
            <div className="empty-state">
              <ErrorBoundary sectionName="Strona główna">
              <WelcomeLanding
                onSubmitQuery={submitQuery}
                dailyChallengeSlot={
                  <ErrorBoundary sectionName="Zadanie dnia">
                    <DailyChallenge onSolveInChat={(q: string) => submitQuery(q)} />
                  </ErrorBoundary>
                }
              />
              </ErrorBoundary>
            </div>
          ) : (
            messages
              .filter((msg) => {
                // Hide user messages that only contain tool results (internal messages)
                if (msg.role === 'user' && Array.isArray(msg.content)) {
                  return false;
                }
                return true;
              })
              .map((msg) => (
                <div
                  key={msg.id}
                  className={`message ${msg.role}`}
                >
                  {msg.role === 'user' && (
                    <div className="message-badge"><Icon type="user" /> Ty</div>
                  )}
                  {msg.role === 'assistant' && (
                    <div className="agent-badge">
                      <Icon type={
                        msg.agentName === 'Agent Analityczny' ? 'brain' :
                        msg.agentName === 'Agent Wykonawczy' ? 'bolt' :
                        msg.agentName === 'Agent Weryfikujący' ? 'target' :
                        msg.agentName === 'Agent Formalizujący' ? 'microscope' : 'robot'
                      } /> {msg.agentName || 'Agent'}
                      {/* Przycisk zapisz do notatnika */}
                      {typeof msg.content === 'string' && msg.content.length > 20 && (
                        <button
                          className={`bookmark-btn ${bookmarkedIds.has(msg.id) || (typeof msg.content === 'string' && isBookmarked(msg.content)) ? 'bookmarked' : ''}`}
                          onClick={(e) => { e.stopPropagation(); handleBookmark(msg); }}
                          title="Zapisz do Notatnika Matematycznego"
                          disabled={bookmarkedIds.has(msg.id) || (typeof msg.content === 'string' && isBookmarked(msg.content))}
                        >
                          {bookmarkedIds.has(msg.id) || (typeof msg.content === 'string' && isBookmarked(msg.content))
                            ? '🔖 Zapisano'
                            : '🔖 Zapisz'}
                        </button>
                      )}
                    </div>
                  )}
                  <div className="message-content">
                    <MessageContent content={msg.content} />
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div className="tool-calls">
                      {msg.toolCalls.map(tc => (
                        <div key={tc.id} className="tool-call">
                          <Icon type="wrench" /> Używam narzędzia: <code>{tc.name}</code>
                          <details style={{ marginTop: '0.5em', fontSize: '0.85em' }}>
                            <summary>
                              {tc.name === 'sympy_calculate' ? 'Kod Python' :
                               tc.name === 'lean_prover_verify' ? 'Argumenty narzędzia' :
                               'Argumenty'}
                            </summary>
                            {tc.name === 'sympy_calculate' && (
                              <div style={{
                                backgroundColor: 'rgba(102,126,234,0.1)',
                                padding: '8px 12px',
                                borderRadius: '4px',
                                marginTop: '8px',
                                fontSize: '0.9em',
                                borderLeft: '3px solid rgba(102,126,234,0.5)',
                                color: 'var(--tool-badge-color)'
                              }}>
                                <Icon type="bulb" /> <strong>Chcesz nauczyć się Pythona?</strong> Zobacz darmowy {' '}
                                <a
                                  href="https://discovery.navoica.pl/course-v1:Uniwersytet_Gdanski+UG_2_Py_1+2024_01/about"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={{ color: 'var(--primary)', textDecoration: 'underline' }}
                                >
                                  Kurs Pythona - Uniwersytet Gdański
                                </a>
                              </div>
                            )}
                            {tc.name === 'sympy_calculate' && tc.arguments.expression ? (
                              <SyntaxHighlighter
                                language="python"
                                style={vscDarkPlus}
                                customStyle={{
                                  borderRadius: '4px',
                                  fontSize: '13px',
                                  marginTop: '8px',
                                  padding: '12px',
                                  margin: 0,
                                  border: 'none',
                                  textDecoration: 'none'
                                }}
                                codeTagProps={{
                                  style: {
                                    textDecoration: 'none',
                                    textShadow: 'none'
                                  }
                                }}
                              >
                                {tc.arguments.expression}
                              </SyntaxHighlighter>
                            ) : (
                              <SyntaxHighlighter
                                language="json"
                                style={vscDarkPlus}
                                customStyle={{
                                  borderRadius: '4px',
                                  fontSize: '13px',
                                  marginTop: '8px',
                                  padding: '12px',
                                  margin: 0,
                                  border: 'none',
                                  textDecoration: 'none'
                                }}
                                codeTagProps={{
                                  style: {
                                    textDecoration: 'none',
                                    textShadow: 'none'
                                  }
                                }}
                              >
                                {JSON.stringify(tc.arguments, null, 2)}
                              </SyntaxHighlighter>
                            )}
                          </details>
                        </div>
                      ))}
                    </div>
                  )}
                  {msg.toolResults && msg.toolResults.length > 0 && (
                    <div className="tool-results">
                      {msg.toolResults.map((tr, idx) => (
                        <div key={idx} className={`tool-result ${tr.isError ? 'error' : ''}`}>
                          <Icon type={tr.isError ? 'error' : 'success'} /> {tr.isError ? 'Błąd' : 'Wynik'} <code>{tr.toolName}</code>:{' '}
                          {tr.isError && (tr.result.includes('Traceback') || tr.result.includes('Error:')) ? (
                            <pre style={{
                              backgroundColor: '#fff3cd',
                              border: '1px solid #ffc107',
                              padding: '12px',
                              borderRadius: '4px',
                              overflow: 'auto',
                              fontSize: '12px',
                              marginTop: '8px',
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word'
                            }}>
                              {tr.result}
                            </pre>
                          ) : (
                            <strong>{tr.result}</strong>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="message-time">
                  {msg.timestamp.toLocaleTimeString('pl-PL')}
                </div>
              </div>
            ))
          )}
          {isProcessing && (
            <div className="processing-indicator">
              <div className="spinner"></div>
              <span>Agenci pracują nad odpowiedzią...</span>
            </div>
          )}
          {messages.length > 0 && !isProcessing && (
            <div className="share-bar">
              <button
                className="share-btn"
                onClick={handleShare}
                disabled={shareStatus === 'saving'}
              >
                {shareStatus === 'saving' ? 'Zapisuję...' :
                 shareStatus === 'done' ? 'Link skopiowany!' :
                 shareStatus === 'error' ? 'Nie udało się' :
                 'Udostępnij konwersację'}
              </button>
              {shareStatus === 'done' && shareUrl && (
                <span className="share-expiry">Link ważny przez 60 dni</span>
              )}
            </div>
          )}
          {messages.length > 0 && !isProcessing && messages.some(m => m.role === 'assistant') && (
            <PracticeSuggestions
              conversationText={
                messages
                  .filter(m => typeof m.content === 'string')
                  .map(m => m.content as string)
                  .join(' ')
              }
              onSolve={(query) => submitQuery(query)}
            />
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="input-container">
          <ImageUpload
            onTextExtracted={(text) => setInputMessage(prev => prev ? prev + '\n' + text : text)}
            disabled={isProcessing}
          />
          <MathKeyboard onInsert={handleMathInsert} textareaRef={textareaRef} />
          <textarea
            ref={textareaRef}
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Wpisz zadanie matematyczne... (Enter aby wysłać, Shift+Enter dla nowej linii)"
            className="message-input"
            rows={1}
          />
          <button
            onClick={handleSendMessage}
            disabled={!inputMessage.trim()}
            className="send-button"
            aria-label="Wyślij"
          >
            <span className="send-button-label">Wyślij</span>
            <svg className="send-button-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="12" y1="19" x2="12" y2="5"/>
              <polyline points="5 12 12 5 19 12"/>
            </svg>
          </button>
        </div>
      </div>
      )}

      <footer className="app-footer">
        <span>
          Projekt open-source na licencji{' '}
          <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener noreferrer">AGPL-3.0</a>
        </span>
        <a href="https://github.com/formulopl/formulopl" target="_blank" rel="noopener noreferrer" className="github-link" title="GitHub">
          <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
          GitHub
        </a>
        <span>
          Powered by{' '}
          <a href="https://huggingface.co/speakleash/Bielik-11B-v3.0-Instruct" target="_blank" rel="noopener noreferrer">Bielik v3 11B</a>
        </span>
        <span className="footer-legal">
          <a href="/regulamin">Regulamin</a>{' · '}
          <a href="/polityka-prywatnosci">Prywatność</a>{' · '}
          <a href="/cookies">Cookies</a>{' · '}
          <a href="#" onClick={(e) => { e.preventDefault(); localStorage.removeItem('formulo-cookie-consent'); window.location.reload(); }}>Ustawienia cookies</a>
        </span>
      </footer>

      {showHistory && (
        <ChatHistorySidebar
          sessions={chatSessions}
          currentChatId={currentChatId}
          onLoadChat={handleLoadChat}
          onDeleteChat={handleDeleteChat}
          onNewChat={handleNewChat}
          onClose={() => setShowHistory(false)}
        />
      )}
    </div>
  );
}

export default App;
