import { useState, useRef, useEffect } from 'react';
import { ThreeAgentOrchestrator, Message, MLXConfig, LLMProvider } from './services/threeAgentSystem';
import { ChatHistoryService, ChatSession } from './services/chatHistoryService';
import { ChatHistorySidebar } from './components/ChatHistorySidebar';
import { MessageContent } from './components/MessageContent';
import { toPng } from 'html-to-image';
import html2canvas from 'html2canvas';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import './App.css';

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
  const [, setMcpConnected] = useState(false);
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

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

  const orchestratorRef = useRef<ThreeAgentOrchestrator | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

      // 1. Check if proxy has API key (remote provider like Cyfronet)
      try {
        const configRes = await fetch(`${MCP_PROXY_URL}/llm-proxy/config`);
        const data = await configRes.json();
        if (data.hasApiKey && data.llmUrl) {
          const remoteUrl = data.llmUrl;
          setLlmProvider('remote');

          const mlxConfig: MLXConfig = {
            provider: 'remote',
            baseUrl: remoteUrl,
            model: DEFAULT_REMOTE_MODEL,
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
      } catch { /* proxy not ready, continue to MLX check */ }

      // 2. Check if MLX is running locally (port 8011)
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
    if (!inputMessage.trim() || !orchestratorRef.current || isProcessing) {
      return;
    }

    setIsProcessing(true);
    const userInput = inputMessage;
    setInputMessage('');

    try {
      await orchestratorRef.current.processMessage(
        userInput,
        (message) => {
          setMessages(prev => {
            // Check if message with this ID already exists
            const existingIndex = prev.findIndex(m => m.id === message.id);
            if (existingIndex !== -1) {
              // Update existing message
              const updated = [...prev];
              updated[existingIndex] = message;
              return updated;
            }
            // Add new message
            return [...prev, message];
          });
        },
        { classifierMode }
      );
    } catch (error) {
      console.error('Błąd podczas przetwarzania:', error);
      alert('Wystąpił błąd podczas komunikacji z agentem. Sprawdź klucz API i połączenie.');
    } finally {
      setIsProcessing(false);
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
          <button onClick={() => setShowHistory(true)} className="history-button">
            <Icon type="books" /> Historia
          </button>
          <button onClick={handleExportToPNG} className="export-button" disabled={messages.length === 0}>
            <Icon type="camera" /> Eksport
          </button>
<button onClick={handleClearHistory} className="clear-button">
            Wyczyść historię
          </button>
        </div>
      </header>

      <div className="chat-container">
        <div className="messages-container">
          {messages.length === 0 ? (
            <div className="empty-state">
              <p><Icon type="wave" /> Witaj! Zadaj pytanie matematyczne - system agentów będzie współpracować nad rozwiązaniem.</p>
              <p style={{ marginTop: '10px', fontSize: '0.95em', color: 'var(--text-secondary)' }}>
                <Icon type="brain" /> <strong>Agent Analityczny</strong> rozbije problem na kroki<br/>
                <Icon type="bolt" /> <strong>Agent Wykonawczy</strong> wykona obliczenia lub przygotuje dowód<br/>
                <Icon type="target" /> <strong>Agent Weryfikujący</strong> sprawdzi poprawność dowodu (Lean Prover)<br/>
                <Icon type="microscope" /> <strong>Agent Formalizujący</strong> (opcjonalny) - pełna formalna weryfikacja z Mathlib
              </p>
              <p style={{ marginTop: '8px', fontSize: '0.85em', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                <Icon type="bulb" /> Dla zadań z dowodami, Agent Formalizujący automatycznie przetłumaczy dowód na pełny formalny kod Lean 4 z biblioteką Mathlib, gotowy do kompilacji i weryfikacji.
              </p>
              <div className="examples">
                <p><strong>Zadania maturalne (poziom podstawowy):</strong></p>
                <ul>
                  <li>Rozwiąż nierówność 2x + 3 &gt; 5x - 9</li>
                  <li>Oblicz pole trójkąta o bokach 5, 12 i 13</li>
                  <li>Wyznacz dziedzinę funkcji f(x) = sqrt(4 - x²)</li>
                  <li>Ciąg arytmetyczny ma a₁ = 3 i r = 4. Oblicz sumę 20 pierwszych wyrazów</li>
                  <li>Jaka jest objętość stożka o promieniu 5 i wysokości 12?</li>
                </ul>
                <p style={{ marginTop: '12px' }}><strong>Zadania maturalne (poziom rozszerzony):</strong></p>
                <ul>
                  <li>Dla jakich wartości parametru m równanie x² + mx + 4 = 0 ma dwa różne pierwiastki rzeczywiste?</li>
                  <li>Zbadaj przebieg zmienności funkcji f(x) = (x² - 1) / (x + 2)</li>
                  <li>Wyznacz równanie stycznej do paraboli y = x² w punkcie (2, 4)</li>
                  <li>Rozwiąż układ równań: x² + y² = 25 i x + y = 7</li>
                  <li>Udowodnij, że suma kwadratów dwóch kolejnych liczb nieparzystych daje resztę 2 z dzielenia przez 4</li>
                </ul>
              </div>
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
                    </div>
                  )}
                  <div className="message-content">
                    <MessageContent content={msg.content} />
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div className="tool-calls">
                      {msg.toolCalls.map(tc => (
                        <div key={tc.id} className="tool-call">
                          <Icon type="wrench" /> Używam narzędzia: <code>{tc.name}</code>
                          <details style={{ marginTop: '0.5em', fontSize: '0.85em' }} open>
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
          <div ref={messagesEndRef} />
        </div>

        <div className="input-container">
          <textarea
            ref={textareaRef}
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Wpisz zadanie matematyczne... (Enter aby wysłać, Shift+Enter dla nowej linii)"
            className="message-input"
            disabled={isProcessing}
            rows={1}
          />
          <button
            onClick={handleSendMessage}
            disabled={isProcessing || !inputMessage.trim()}
            className="send-button"
          >
            {isProcessing ? 'Przetwarzanie...' : 'Wyślij'}
          </button>
        </div>
      </div>

      <footer className="app-footer">
        <span>
          Projekt open-source na licencji{' '}
          <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener noreferrer">AGPL-3.0</a>
        </span>
        <a href="https://github.com/formulopl/formulopl" target="_blank" rel="noopener noreferrer" className="github-link" title="GitHub">
          <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
          GitHub
        </a>
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
