import { useState, useRef, useEffect } from 'react';
import { ThreeAgentOrchestrator, Message, MLXConfig, ProverBackend, LLMProvider } from './services/threeAgentSystem';
import { ChatHistoryService, ChatSession } from './services/chatHistoryService';
import { ChatHistorySidebar } from './components/ChatHistorySidebar';
import { MessageContent } from './components/MessageContent';
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

const MCP_PROXY_URL = import.meta.env.VITE_MCP_PROXY_URL || 'http://localhost:3001';
const LEAN_PROXY_URL = import.meta.env.VITE_LEAN_PROXY_URL || 'http://localhost:3002';
const DEFAULT_REMOTE_MODEL = import.meta.env.VITE_REMOTE_MODEL || 'speakleash/Bielik-11B-v3.0-Instruct';
const DEFAULT_REMOTE_API_URL = import.meta.env.VITE_REMOTE_API_URL || '';

function App() {
  const [proverBackend, setProverBackend] = useState<ProverBackend>('both');
  const [classifierMode, setClassifierMode] = useState(false);
  const [llmProvider, setLlmProvider] = useState<LLMProvider>('ollama');
  const [mlxBaseUrl, setMlxBaseUrl] = useState('http://localhost:11434');
  const [mlxModel, setMlxModel] = useState('SpeakLeash/bielik-11b-v3.0-instruct:Q4_K_M');
  const [apiKey, setApiKey] = useState('');
  const [proxyHasApiKey, setProxyHasApiKey] = useState(false);

  const handleProviderChange = (provider: LLMProvider) => {
    setLlmProvider(provider);
    if (provider === 'ollama') {
      setMlxBaseUrl('http://localhost:11434');
      setMlxModel('SpeakLeash/bielik-11b-v3.0-instruct:Q4_K_M');
      setApiKey('');
    } else if (provider === 'mlx') {
      setMlxBaseUrl('http://localhost:8011');
      setMlxModel('speakleash/Bielik-11B-v3.0-Instruct-MLX-4bit');
      setApiKey('');
    } else if (provider === 'remote') {
      setMlxBaseUrl(DEFAULT_REMOTE_API_URL);
      setMlxModel(DEFAULT_REMOTE_MODEL);
    }
  };
  const [isConfigured, setIsConfigured] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [mcpConnected, setMcpConnected] = useState(false);
  const [leanConnected, setLeanConnected] = useState(false);

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

  // Check if proxy has API key configured (key stays server-side)
  // If yes, auto-configure as remote and skip config screen → go straight to chat
  useEffect(() => {
    fetch(`${MCP_PROXY_URL}/llm-proxy/config`)
      .then(res => res.json())
      .then(async (data) => {
        if (data.hasApiKey && data.llmUrl) {
          const remoteUrl = data.llmUrl;
          setProxyHasApiKey(true);
          setLlmProvider('remote');
          setMlxBaseUrl(remoteUrl);
          setMlxModel(DEFAULT_REMOTE_MODEL);

          // Auto-start: skip config screen, connect MCP, go to chat
          try {
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
            setIsConfigured(true);
          } catch (err) {
            console.warn('Auto-configure failed, showing config screen:', err);
          }
        }
      })
      .catch(() => { /* proxy not ready yet, ignore */ });
  }, []);

  // Load chat sessions on mount
  useEffect(() => {
    const sessions = ChatHistoryService.getAllSessions();
    setChatSessions(sessions);
  }, []);

  // Save messages to history whenever they change
  useEffect(() => {
    if (messages.length > 0 && currentChatId && isConfigured) {
      const session: ChatSession = {
        id: currentChatId,
        provider: llmProvider,
        messages,
        createdAt: messages[0]?.timestamp.toISOString() || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      ChatHistoryService.saveSession(session);
      // Refresh sessions list
      setChatSessions(ChatHistoryService.getAllSessions());
    }
  }, [messages, currentChatId, isConfigured]);

  const handleConfigure = async () => {
    if (!mlxBaseUrl.trim()) {
      alert('Proszę wprowadzić URL serwera LLM');
      return;
    }

    try {
      const mlxConfig: MLXConfig = {
        provider: llmProvider,
        baseUrl: mlxBaseUrl,
        model: mlxModel,
        temperature: 0.7,
        maxTokens: 4096,
        ...(apiKey ? { apiKey } : {}),
      };

      orchestratorRef.current = new ThreeAgentOrchestrator(
        proverBackend,
        mlxConfig,
        classifierMode
      );

      // Connect to MCP server (SymPy)
      if (proverBackend === 'sympy' || proverBackend === 'both') {
        console.log('Connecting to MCP proxy...');
        try {
          await orchestratorRef.current.connectMCP(MCP_PROXY_URL);
          setMcpConnected(true);
          console.log('MCP connected successfully');
        } catch (error) {
          console.warn('MCP connection failed:', error);
          if (proverBackend === 'sympy') {
            throw error;
          }
        }
      }

      // Connect to Lean Prover
      if (proverBackend === 'lean' || proverBackend === 'both') {
        console.log('Connecting to Lean proxy...');
        try {
          await orchestratorRef.current.connectLean(LEAN_PROXY_URL);
          const backendInfo = orchestratorRef.current.getBackendInfo();
          setLeanConnected(backendInfo.leanConnected);
          console.log('Lean connected successfully');
        } catch (error) {
          console.warn('Lean connection failed:', error);
          if (proverBackend === 'lean') {
            throw error;
          }
        }
      }

      // Create new chat session
      const newChatId = ChatHistoryService.generateChatId();
      setCurrentChatId(newChatId);
      setIsConfigured(true);
    } catch (error) {
      console.error('Configuration error:', error);
      alert(`Błąd konfiguracji: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

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
        }
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

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      alert('Skopiowano do schowka!');
    }).catch(err => {
      console.error('Błąd kopiowania:', err);
    });
  };

  const handleExportToPNG = async () => {
    const messagesContainer = document.querySelector('.messages-container');
    if (!messagesContainer || messages.length === 0) {
      alert('Brak konwersacji do wyeksportowania');
      return;
    }

    try {
      // Create a clean wrapper for export
      // Position it on-screen (left: -9999px scrolled area) to ensure proper text layout.
      // html2canvas has bugs with off-screen text rendering (missing spaces, overlapping fonts).
      const exportWrapper = document.createElement('div');
      exportWrapper.style.position = 'absolute';
      exportWrapper.style.top = '0';
      exportWrapper.style.left = '-9999px';
      exportWrapper.style.width = '800px';
      exportWrapper.style.backgroundColor = '#ffffff';
      exportWrapper.style.padding = '30px';
      exportWrapper.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif';
      exportWrapper.style.zIndex = '1';
      exportWrapper.style.pointerEvents = 'none';

      // Add title
      const title = document.createElement('h2');
      title.textContent = '🎓 Konwersacja - Bielik Matura';
      title.style.marginBottom = '20px';
      title.style.color = '#333';
      exportWrapper.appendChild(title);

      // Clone each message individually and clean them
      const messageElements = messagesContainer.querySelectorAll('.message');
      messageElements.forEach((msgElement) => {
        const msgClone = msgElement.cloneNode(true) as HTMLElement;
        msgClone.style.marginBottom = '15px';
        msgClone.style.opacity = '1';
        msgClone.style.animation = 'none';
        msgClone.style.maxWidth = '100%';
        msgClone.style.width = 'auto';
        msgClone.style.boxSizing = 'border-box';
        msgClone.style.backgroundColor = msgClone.classList.contains('user') ? '#667eea' : '#f0f0f0';

        // Fix text rendering in all child elements
        const allElements = msgClone.querySelectorAll('*');
        allElements.forEach((el) => {
          const htmlEl = el as HTMLElement;
          htmlEl.style.opacity = '1';
          htmlEl.style.animation = 'none';
          // Fix html2canvas text rendering issues
          htmlEl.style.wordSpacing = 'normal';
          htmlEl.style.letterSpacing = 'normal';
          htmlEl.style.textRendering = 'auto';
        });

        // Fix message-content elements specifically
        const contentEls = msgClone.querySelectorAll('.message-content');
        contentEls.forEach((el) => {
          const htmlEl = el as HTMLElement;
          htmlEl.style.whiteSpace = 'pre-wrap';
          htmlEl.style.wordWrap = 'break-word';
          htmlEl.style.overflowWrap = 'break-word';
          htmlEl.style.wordSpacing = 'normal';
          htmlEl.style.lineHeight = '1.6';
          htmlEl.style.maxWidth = '100%';
        });

        // Fix code blocks
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

      // Wait for render — html2canvas needs layout to be stable
      await new Promise(resolve => setTimeout(resolve, 500));

      // Generate canvas
      const canvas = await html2canvas(exportWrapper, {
        backgroundColor: '#ffffff',
        scale: 2,
        logging: false,
        useCORS: true,
        allowTaint: true,
        windowWidth: 800,
        width: 800,
        ignoreElements: (element) => {
          // Skip elements with animations that might affect opacity
          return element.classList.contains('processing-indicator') ||
                 element.classList.contains('spinner');
        },
      });

      // Remove temporary container
      document.body.removeChild(exportWrapper);

      // Convert to blob and download
      canvas.toBlob((blob) => {
        if (blob) {
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          link.download = `konwersacja-${timestamp}.png`;
          link.href = url;
          link.click();
          URL.revokeObjectURL(url);
        }
      }, 'image/png');
    } catch (error) {
      console.error('Błąd eksportu do PNG:', error);
      alert('Wystąpił błąd podczas eksportu do PNG');
    }
  };

  if (!isConfigured) {
    return (
      <div className="config-container">
        <div className="config-card">
          <h1><Icon type="robot" /> System Matematyczny z SymPy i Lean Prover</h1>
          <p className="subtitle">
            SymPy dla obliczeń + Lean Prover dla formalnych dowodów = Kompletne rozwiązania matematyczne
          </p>

          <div className="config-form">
            <label htmlFor="llmProvider">Provider LLM:</label>
            <select
              id="llmProvider"
              value={llmProvider}
              onChange={(e) => handleProviderChange(e.target.value as LLMProvider)}
              className="provider-select"
            >
              <option value="ollama">Ollama (wieloplatformowy) - Rekomendowane</option>
              <option value="mlx">MLX (Apple Silicon - macOS)</option>
              <option value="remote">Zdalne API (np. Cyfronet LLM Lab)</option>
            </select>

            <label htmlFor="proverBackend">Wybierz Backend Dowodzenia:</label>
            <select
              id="proverBackend"
              value={proverBackend}
              onChange={(e) => setProverBackend(e.target.value as ProverBackend)}
              className="provider-select"
            >
              <option value="both">Oba (SymPy + Lean Prover) - Rekomendowane</option>
              <option value="sympy">Tylko SymPy (obliczenia numeryczne/symboliczne)</option>
              <option value="lean">Tylko Lean Prover (formalne dowody)</option>
            </select>

            <div style={{ marginTop: '10px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={classifierMode}
                  onChange={(e) => setClassifierMode(e.target.checked)}
                />
                <span>🔍 Tryb Klasyfikatora (deterministyczny solver)</span>
              </label>
              {classifierMode && (
                <div className="info-box" style={{ marginTop: '5px', padding: '8px', backgroundColor: '#d4edda', border: '1px solid #28a745', borderRadius: '4px', fontSize: '0.85em' }}>
                  Model klasyfikuje typ zadania → deterministyczny kod SymPy → MCP. Mniej tokenów, stabilniejsze wyniki.
                </div>
              )}
            </div>

            {proverBackend === 'lean' && (
              <div className="info-box" style={{ marginTop: '10px', padding: '10px', backgroundColor: '#fff3cd', border: '1px solid #ffc107', borderRadius: '4px' }}>
                <strong>⚠️ Wymagane:</strong> Upewnij się, że serwer Lean Proxy działa:<br/>
                <code style={{ backgroundColor: '#f8f9fa', padding: '2px 6px', borderRadius: '3px', fontSize: '0.9em' }}>npm run lean-proxy</code>
              </div>
            )}

            {(proverBackend === 'lean' || proverBackend === 'both') && (
              <div className="info-box" style={{ marginTop: '10px', padding: '10px', backgroundColor: '#d1ecf1', border: '1px solid #0c5460', borderRadius: '4px', fontSize: '0.9em' }}>
                <strong>ℹ️ Lean Prover:</strong> Działa bez instalacji Lean (tylko weryfikacja agenta). Dla pełnej weryfikacji zainstaluj Lean:<br/>
                <code style={{ backgroundColor: '#f8f9fa', padding: '2px 6px', borderRadius: '3px' }}>brew install elan-init && elan default leanprover/lean4:stable</code>
              </div>
            )}

            <label htmlFor="mlxBaseUrl">URL serwera {llmProvider === 'ollama' ? 'Ollama' : llmProvider === 'remote' ? 'API' : 'MLX'}:</label>
            <input
              id="mlxBaseUrl"
              type="text"
              value={mlxBaseUrl}
              onChange={(e) => setMlxBaseUrl(e.target.value)}
              placeholder={llmProvider === 'ollama' ? 'http://localhost:11434' : llmProvider === 'remote' ? DEFAULT_REMOTE_API_URL : 'http://localhost:8011'}
              className="api-input"
            />

            {llmProvider === 'remote' && !proxyHasApiKey && (
              <>
                <label htmlFor="apiKey">Klucz API (Bearer token):</label>
                <input
                  id="apiKey"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="np. plg-xxx..."
                  className="api-input"
                />
              </>
            )}
            {llmProvider === 'remote' && proxyHasApiKey && (
              <p style={{ color: '#4caf50', fontSize: '0.9em', margin: '4px 0' }}>
                Klucz API skonfigurowany na serwerze proxy (--api-key)
              </p>
            )}

            <label htmlFor="mlxModel">Model {llmProvider === 'ollama' ? 'Ollama' : llmProvider === 'remote' ? 'API' : 'MLX'}:</label>
            <input
              id="mlxModel"
              type="text"
              value={mlxModel}
              onChange={(e) => setMlxModel(e.target.value)}
              placeholder={llmProvider === 'ollama' ? 'SpeakLeash/bielik-11b-v3.0-instruct:Q4_K_M' : llmProvider === 'remote' ? 'speakleash/Bielik-11B-v3.0-Instruct' : 'speakleash/Bielik-11B-v3.0-Instruct-MLX-4bit'}
              className="api-input"
            />

            <button onClick={handleConfigure} className="config-button">
              Rozpocznij
            </button>
          </div>

          <div className="info-box">
            <h3>Jak to działa?</h3>
            <ul>
              <li><strong>SymPy Backend</strong> - wykonuje obliczenia symboliczne i numeryczne</li>
              <li><strong>Lean Prover Backend</strong> - tworzy i weryfikuje formalne dowody matematyczne</li>
              <li><strong>Automatyczny wybór</strong> - system wykrywa czy zadanie wymaga dowodu czy obliczeń</li>
              <li><strong>LLM Agent</strong> - analizuje problem i generuje kod/dowód</li>
              <li>Precyzyjne obliczenia + formalna weryfikacja dowodów w jednym systemie</li>
            </ul>

            <h3><Icon type="target" /> Lean Prover:</h3>
            <ul style={{ fontSize: '0.9em', lineHeight: '1.4' }}>
              <li>Profesjonalny system dowodzenia twierdzeń matematycznych</li>
              <li>Weryfikuje poprawność dowodów formalnych</li>
              <li>Używany w badaniach matematycznych i weryfikacji oprogramowania</li>
              <li>Wspiera zadania typu: "udowodnij", "wykaż", twierdzenia, lematy</li>
              <li>
                <strong>Instalacja macOS:</strong> <code>brew install elan-init && elan default leanprover/lean4:stable</code>
              </li>
              <li>
                <strong>Instalacja Linux:</strong> <code>curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf | sh</code>
              </li>
              <li>
                <strong>Uruchom serwer:</strong> <code>npm run lean-proxy</code>
              </li>
            </ul>

            {proverBackend !== 'lean' && (
              <>
                <h3>Dostępne narzędzia SymPy:</h3>
                <ul style={{ fontSize: '0.9em', lineHeight: '1.4' }}>
                  <li><code>sympy_differentiate</code> - obliczanie pochodnych</li>
                  <li><code>sympy_integrate</code> - całkowanie (oznaczone i nieoznaczone)</li>
                  <li><code>sympy_solve</code> - rozwiązywanie równań</li>
                  <li><code>sympy_simplify</code> - upraszczanie wyrażeń</li>
                  <li><code>sympy_expand</code> - rozwijanie wyrażeń</li>
                  <li><code>sympy_factor</code> - faktoryzacja</li>
                  <li><code>sympy_limit</code> - granice funkcji</li>
                  <li><code>sympy_matrix</code> - operacje na macierzach</li>
                  <li><code>sympy_calculate</code> - dowolne obliczenia SymPy</li>
                </ul>
              </>
            )}
            {llmProvider === 'remote' ? (
              <div className="mlx-info">
                <h3>ℹ️ Zdalne API (OpenAI-compatible):</h3>
                <ul>
                  <li>Obsługuje dowolne API zgodne z formatem OpenAI (np. Cyfronet LLM Lab, vLLM, TGI)</li>
                  <li>Wymaga klucza API (Bearer token) do uwierzytelnienia</li>
                  <li>URL powinien wskazywać na bazę API (przed <code>/v1/...</code>)</li>
                  <li><strong>Wymaga uruchomienia MCP proxy</strong> (obsługa CORS): <code>npm run mcp-proxy</code></li>
                </ul>
                <div className="mlx-command">
                  <h4>Cyfronet LLM Lab:</h4>
                  <div className="command-box">
                    <code>URL: {DEFAULT_REMOTE_API_URL}</code>
                    <button
                      onClick={() => copyToClipboard(DEFAULT_REMOTE_API_URL)}
                      className="copy-button"
                      title="Skopiuj do schowka"
                    >
                      📋 Kopiuj
                    </button>
                  </div>
                </div>
              </div>
            ) : llmProvider === 'ollama' ? (
              <div className="mlx-info">
                <h3>ℹ️ Wymagania Ollama:</h3>
                <ul>
                  <li>Działa na macOS, Linux i Windows</li>
                  <li>Darmowy, lokalny inference</li>
                  <li>Model GGUF 4-bit: <a href="https://huggingface.co/speakleash/Bielik-11B-v3.0-Instruct-GGUF" target="_blank" rel="noopener noreferrer" style={{ color: '#1976d2' }}>speakleash/Bielik-11B-v3.0-Instruct-GGUF</a></li>
                </ul>
                <div className="mlx-command">
                  <h4>1. Pobierz model Bielik:</h4>
                  <div className="command-box">
                    <code>ollama pull SpeakLeash/bielik-11b-v3.0-instruct:Q4_K_M</code>
                    <button
                      onClick={() => copyToClipboard('ollama pull SpeakLeash/bielik-11b-v3.0-instruct:Q4_K_M')}
                      className="copy-button"
                      title="Skopiuj do schowka"
                    >
                      📋 Kopiuj
                    </button>
                  </div>
                  <h4>2. Uruchom serwer Ollama:</h4>
                  <div className="command-box">
                    <code>ollama serve</code>
                    <button
                      onClick={() => copyToClipboard('ollama serve')}
                      className="copy-button"
                      title="Skopiuj do schowka"
                    >
                      📋 Kopiuj
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mlx-info">
                <h3>ℹ️ Wymagania MLX:</h3>
                <ul>
                  <li>Mac z Apple Silicon (M1/M2/M3/M4)</li>
                  <li>Darmowy, lokalny inference z akceleracją sprzętową</li>
                </ul>
                <div className="mlx-command">
                  <h4>Uruchom serwer MLX w nowym terminalu:</h4>
                  <div className="command-box">
                    <code>mlx_lm.server --model speakleash/Bielik-11B-v3.0-Instruct-MLX-4bit --port 8011</code>
                    <button
                      onClick={() => copyToClipboard('mlx_lm.server --model speakleash/Bielik-11B-v3.0-Instruct-MLX-4bit --port 8011')}
                      className="copy-button"
                      title="Skopiuj do schowka"
                    >
                      📋 Kopiuj
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <header className="app-header">
        <h1><Icon type="graduation" /> Bielik Matura - Asystent Matematyczny</h1>
        <div className="header-controls">
          <button onClick={() => setShowHistory(true)} className="history-button">
            <Icon type="books" /> Historia
          </button>
          <button onClick={handleExportToPNG} className="export-button" disabled={messages.length === 0}>
            <Icon type="camera" /> Eksport PNG
          </button>
          {mcpConnected && (
            <span className="mcp-status">
              <Icon type="plug" /> SymPy
            </span>
          )}
          {leanConnected && (
            <span className="mcp-status" style={{ marginLeft: '8px' }}>
              <Icon type="target" /> Lean
            </span>
          )}
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
              <p style={{ marginTop: '10px', fontSize: '0.95em', color: '#666' }}>
                <Icon type="brain" /> <strong>Agent Analityczny</strong> rozbije problem na kroki<br/>
                <Icon type="bolt" /> <strong>Agent Wykonawczy</strong> wykona obliczenia lub przygotuje dowód<br/>
                <Icon type="target" /> <strong>Agent Weryfikujący</strong> sprawdzi poprawność dowodu (Lean Prover)<br/>
                <Icon type="microscope" /> <strong>Agent Formalizujący</strong> (opcjonalny) - pełna formalna weryfikacja z Mathlib
              </p>
              <p style={{ marginTop: '8px', fontSize: '0.85em', color: '#888', fontStyle: 'italic' }}>
                <Icon type="bulb" /> Dla zadań z dowodami, Agent Formalizujący automatycznie przetłumaczy dowód na pełny formalny kod Lean 4 z biblioteką Mathlib, gotowy do kompilacji i weryfikacji.
              </p>
              <div className="examples">
                <p><strong>Przykłady obliczeń (SymPy):</strong></p>
                <ul>
                  <li>Oblicz pochodną funkcji f(x) = x³ + 2x² - 5x + 1</li>
                  <li>Całkuj x² od 0 do 2</li>
                  <li>Rozwiąż równanie x² - 5x + 6 = 0</li>
                  <li>Uprość wyrażenie sin(x)² + cos(x)²</li>
                  <li>Oblicz granicę sin(x)/x gdy x dąży do 0</li>
                  <li>Znajdź wyznacznik macierzy [[1, 2], [3, 4]]</li>
                </ul>
                <p style={{ marginTop: '12px' }}><strong>Przykłady dowodów (Lean):</strong></p>
                <ul>
                  <li>Udowodnij, że suma kątów w trójkącie wynosi 180 stopni</li>
                  <li>Wykaż, że dla każdego n, n + 0 = n</li>
                  <li>Dowód przez indukcję: suma pierwszych n liczb = n(n+1)/2</li>
                  <li>Udowodnij własność przemienności dodawania</li>
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
                                backgroundColor: '#e3f2fd',
                                padding: '8px 12px',
                                borderRadius: '4px',
                                marginTop: '8px',
                                fontSize: '0.9em',
                                borderLeft: '3px solid #2196f3'
                              }}>
                                <Icon type="bulb" /> <strong>Chcesz nauczyć się Pythona?</strong> Zobacz darmowy {' '}
                                <a
                                  href="https://discovery.navoica.pl/course-v1:Uniwersytet_Gdanski+UG_2_Py_1+2024_01/about"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={{ color: '#1976d2', textDecoration: 'underline' }}
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
