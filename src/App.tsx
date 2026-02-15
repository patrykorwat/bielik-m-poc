import { useState, useRef, useEffect } from 'react';
import { ThreeAgentOrchestrator, Message, LLMProvider, MLXConfig, ProverBackend } from './services/threeAgentSystem';
import { ChatHistoryService, ChatSession } from './services/chatHistoryService';
import { ChatHistorySidebar } from './components/ChatHistorySidebar';
import { MessageContent } from './components/MessageContent';
import './App.css';

const MCP_PROXY_URL = 'http://localhost:3001';
const LEAN_PROXY_URL = 'http://localhost:3002';

function App() {
  const [provider, setProvider] = useState<LLMProvider>('claude');
  const [proverBackend, setProverBackend] = useState<ProverBackend>('both');
  const [apiKey, setApiKey] = useState('');
  const [mlxBaseUrl, setMlxBaseUrl] = useState('http://localhost:8011');
  const [mlxModel, setMlxModel] = useState('LibraxisAI/Bielik-11B-v3.0-mlx-q5');
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

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

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
        provider,
        messages,
        createdAt: messages[0]?.timestamp.toISOString() || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      ChatHistoryService.saveSession(session);
      // Refresh sessions list
      setChatSessions(ChatHistoryService.getAllSessions());
    }
  }, [messages, currentChatId, provider, isConfigured]);

  const handleConfigure = async () => {
    if (provider === 'claude' && !apiKey.trim()) {
      alert('Proszę wprowadzić klucz API dla Claude');
      return;
    }

    if (provider === 'mlx' && !mlxBaseUrl.trim()) {
      alert('Proszę wprowadzić URL serwera MLX');
      return;
    }

    try {
      let mlxConfig: MLXConfig | undefined;
      if (provider === 'mlx') {
        mlxConfig = {
          baseUrl: mlxBaseUrl,
          model: mlxModel,
          temperature: 0.7,
          maxTokens: 4096,
        };
      }

      orchestratorRef.current = new ThreeAgentOrchestrator(
        provider,
        proverBackend,
        provider === 'claude' ? apiKey : undefined,
        mlxConfig
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

  if (!isConfigured) {
    return (
      <div className="config-container">
        <div className="config-card">
          <h1>🤖 System Matematyczny z SymPy i Lean Prover</h1>
          <p className="subtitle">
            SymPy dla obliczeń + Lean Prover dla formalnych dowodów = Kompletne rozwiązania matematyczne
          </p>

          <div className="config-form">
            <label htmlFor="provider">Wybierz Provider LLM:</label>
            <select
              id="provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value as LLMProvider)}
              className="provider-select"
            >
              <option value="claude">Claude (Anthropic)</option>
              <option value="mlx">MLX (Apple Silicon - lokalny)</option>
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

            {provider === 'claude' ? (
              <>
                <label htmlFor="apiKey">Klucz API Anthropic:</label>
                <input
                  id="apiKey"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-ant-..."
                  className="api-input"
                />
              </>
            ) : (
              <>
                <label htmlFor="mlxBaseUrl">URL serwera MLX:</label>
                <input
                  id="mlxBaseUrl"
                  type="text"
                  value={mlxBaseUrl}
                  onChange={(e) => setMlxBaseUrl(e.target.value)}
                  placeholder="http://localhost:8011"
                  className="api-input"
                />

                <label htmlFor="mlxModel">Model MLX:</label>
                <input
                  id="mlxModel"
                  type="text"
                  value={mlxModel}
                  onChange={(e) => setMlxModel(e.target.value)}
                  placeholder="LibraxisAI/Bielik-11B-v3.0-mlx-q5"
                  className="api-input"
                />
              </>
            )}

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
            {provider === 'mlx' && (
              <div className="mlx-info">
                <h3>ℹ️ Wymagania MLX:</h3>
                <ul>
                  <li>Mac z Apple Silicon (M1/M2/M3/M4)</li>
                  <li>Darmowy, lokalny inference z akceleracją sprzętową</li>
                </ul>
                <div className="mlx-command">
                  <h4>Uruchom serwer MLX w nowym terminalu:</h4>
                  <div className="command-box">
                    <code>mlx_lm.server --model LibraxisAI/Bielik-11B-v3.0-mlx-q5 --port 8011</code>
                    <button
                      onClick={() => copyToClipboard('mlx_lm.server --model LibraxisAI/Bielik-11B-v3.0-mlx-q5 --port 8011')}
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
        <h1>🤖 System Trzech Agentów</h1>
        <div className="header-controls">
          <button onClick={() => setShowHistory(true)} className="history-button">
            📚 Historia
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
              <p>👋 Witaj! Zadaj pytanie matematyczne - system trzech agentów będzie współpracować nad rozwiązaniem.</p>
              <p style={{ marginTop: '10px', fontSize: '0.95em', color: '#666' }}>
                🧠 <strong>Agent Analityczny</strong> rozbije problem na kroki<br/>
                ⚡ <strong>Agent Wykonawczy</strong> wykona obliczenia lub przygotuje dowód<br/>
                🎯 <strong>Agent Weryfikujący</strong> sprawdzi poprawność dowodu (Lean Prover)
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
                       msg.agentName === 'Agent Weryfikujący' ? '🎯' : '🤖'} {msg.agentName || 'Agent'}
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
                            <summary>Kod Python</summary>
                            {tc.name === 'sympy_calculate' && tc.arguments.expression ? (
                              <pre style={{
                                backgroundColor: '#1e1e1e',
                                color: '#d4d4d4',
                                padding: '12px',
                                borderRadius: '4px',
                                overflow: 'auto',
                                fontSize: '13px',
                                marginTop: '8px'
                              }}>{tc.arguments.expression}</pre>
                            ) : (
                              <pre>{JSON.stringify(tc.arguments, null, 2)}</pre>
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
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Wpisz zadanie matematyczne... (Enter aby wysłać, Shift+Enter dla nowej linii)"
            className="message-input"
            disabled={isProcessing}
            rows={3}
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
