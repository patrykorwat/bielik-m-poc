import { useState, useRef, useEffect } from 'react';
import { ThreeAgentOrchestrator, Message, MLXConfig, ProverBackend, LLMProvider } from './services/threeAgentSystem';
import { ChatHistoryService, ChatSession } from './services/chatHistoryService';
import { ChatHistorySidebar } from './components/ChatHistorySidebar';
import { MessageContent } from './components/MessageContent';
import html2canvas from 'html2canvas';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import './App.css';

const MCP_PROXY_URL = import.meta.env.VITE_MCP_PROXY_URL || 'http://localhost:3001';
const LEAN_PROXY_URL = import.meta.env.VITE_LEAN_PROXY_URL || 'http://localhost:3002';
const DEFAULT_REMOTE_API_URL = import.meta.env.VITE_REMOTE_API_URL ;
const DEFAULT_REMOTE_MODEL = import.meta.env.VITE_REMOTE_MODEL || 'speakleash/Bielik-11B-v3.0-Instruct';

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
  useEffect(() => {
    fetch(`${MCP_PROXY_URL}/llm-proxy/config`)
      .then(res => res.json())
      .then(data => {
        if (data.hasApiKey) {
          setProxyHasApiKey(true);
          setLlmProvider('remote');
          setMlxBaseUrl(DEFAULT_REMOTE_API_URL);
          setMlxModel(DEFAULT_REMOTE_MODEL);
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
      const exportWrapper = document.createElement('div');
      exportWrapper.style.position = 'fixed';
      exportWrapper.style.top = '-100000px'; // Move far off screen
      exportWrapper.style.left = '0';
      exportWrapper.style.width = '800px';
      exportWrapper.style.backgroundColor = '#ffffff';
      exportWrapper.style.padding = '30px';
      exportWrapper.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif';
      exportWrapper.style.zIndex = '-1';
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
        msgClone.style.backgroundColor = msgClone.classList.contains('user') ? '#667eea' : '#f0f0f0';

        // Remove any inherited opacity/background issues and animations
        const allElements = msgClone.querySelectorAll('*');
        allElements.forEach((el) => {
          const htmlEl = el as HTMLElement;
          htmlEl.style.opacity = '1';
          htmlEl.style.animation = 'none';
        });
        exportWrapper.appendChild(msgClone);
      });

      document.body.appendChild(exportWrapper);

      // Wait for render
      await new Promise(resolve => setTimeout(resolve, 200));

      // Generate canvas
      const canvas = await html2canvas(exportWrapper, {
        backgroundColor: '#ffffff',
        scale: 2,
        logging: false,
        useCORS: true,
        allowTaint: true,
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
          <h1>🤖 System Matematyczny z SymPy i Lean Prover</h1>
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

            <h3>🎯 Lean Prover:</h3>
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
        <h1>🎓 Bielik Matura - Asystent Matematyczny</h1>
        <div className="header-controls">
          <button onClick={() => setShowHistory(true)} className="history-button">
            📚 Historia
          </button>
          <button onClick={handleExportToPNG} className="export-button" disabled={messages.length === 0}>
            📸 Eksport PNG
          </button>
          {mcpConnected && (
            <span className="mcp-status">
              🔌 SymPy
            </span>
          )}
          {leanConnected && (
            <span className="mcp-status" style={{ marginLeft: '8px' }}>
              🎯 Lean
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
              <p>👋 Witaj! Zadaj pytanie matematyczne - system agentów będzie współpracować nad rozwiązaniem.</p>
              <p style={{ marginTop: '10px', fontSize: '0.95em', color: '#666' }}>
                🧠 <strong>Agent Analityczny</strong> rozbije problem na kroki<br/>
                ⚡ <strong>Agent Wykonawczy</strong> wykona obliczenia lub przygotuje dowód<br/>
                🎯 <strong>Agent Weryfikujący</strong> sprawdzi poprawność dowodu (Lean Prover)<br/>
                🔬 <strong>Agent Formalizujący</strong> (opcjonalny) - pełna formalna weryfikacja z Mathlib
              </p>
              <p style={{ marginTop: '8px', fontSize: '0.85em', color: '#888', fontStyle: 'italic' }}>
                💡 Dla zadań z dowodami, Agent Formalizujący automatycznie przetłumaczy dowód na pełny formalny kod Lean 4 z biblioteką Mathlib, gotowy do kompilacji i weryfikacji.
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
                    <div className="message-badge">👤 Ty</div>
                  )}
                  {msg.role === 'assistant' && (
                    <div className="agent-badge">
                      {msg.agentName === 'Agent Analityczny' ? '🧠' :
                       msg.agentName === 'Agent Wykonawczy' ? '⚡' :
                       msg.agentName === 'Agent Weryfikujący' ? '🎯' :
                       msg.agentName === 'Agent Formalizujący' ? '🔬' : '🤖'} {msg.agentName || 'Agent'}
                    </div>
                  )}
                  <div className="message-content">
                    <MessageContent content={msg.content} />
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div className="tool-calls">
                      {msg.toolCalls.map(tc => (
                        <div key={tc.id} className="tool-call">
                          🔧 Używam narzędzia: <code>{tc.name}</code>
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
                                💡 <strong>Chcesz nauczyć się Pythona?</strong> Zobacz darmowy {' '}
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
                          {tr.isError ? '❌' : '✅'} {tr.isError ? 'Błąd' : 'Wynik'} <code>{tr.toolName}</code>:{' '}
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
