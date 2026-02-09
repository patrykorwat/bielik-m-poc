import { useState, useRef, useEffect } from 'react';
import { MCPAgentOrchestrator, Message, LLMProvider, MLXConfig } from './services/mcpAgentService';
import { ChatHistoryService, ChatSession } from './services/chatHistoryService';
import { ChatHistorySidebar } from './components/ChatHistorySidebar';
import { MessageContent } from './components/MessageContent';
import './App.css';

const MCP_PROXY_URL = 'http://localhost:3001';

function App() {
  const [provider, setProvider] = useState<LLMProvider>('claude');
  const [apiKey, setApiKey] = useState('');
  const [mlxBaseUrl, setMlxBaseUrl] = useState('http://localhost:8011');
  const [mlxModel, setMlxModel] = useState('LibraxisAI/Bielik-11B-v3.0-mlx-q4');
  const [isConfigured, setIsConfigured] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [mcpConnected, setMcpConnected] = useState(false);

  const orchestratorRef = useRef<MCPAgentOrchestrator | null>(null);
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

      orchestratorRef.current = new MCPAgentOrchestrator(
        provider,
        provider === 'claude' ? apiKey : undefined,
        mlxConfig
      );

      // Connect to MCP server
      console.log('Connecting to MCP proxy...');
      await orchestratorRef.current.connectMCP(MCP_PROXY_URL);
      setMcpConnected(true);
      console.log('MCP connected successfully');

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
          <h1>🤖 Agent Matematyczny z SymPy</h1>
          <p className="subtitle">
            Jeden inteligentny agent z dostępem do narzędzi SymPy
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
                  placeholder="LibraxisAI/Bielik-11B-v3.0-mlx-q4"
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
              <li><strong>Model Context Protocol (MCP)</strong> - połączenie z serwerem SymPy</li>
              <li><strong>9 narzędzi matematycznych</strong> - całki, pochodne, równania, macierze, itp.</li>
              <li>Agent automatycznie wybiera i używa odpowiednich narzędzi</li>
              <li>Precyzyjne obliczenia symboliczne dzięki SymPy</li>
            </ul>
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
                    <code>mlx_lm.server --model LibraxisAI/Bielik-11B-v3.0-mlx-q4 --port 8011</code>
                    <button
                      onClick={() => copyToClipboard('mlx_lm.server --model LibraxisAI/Bielik-11B-v3.0-mlx-q4 --port 8011')}
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
        <h1>🤖 Agent Matematyczny z SymPy</h1>
        <div className="header-controls">
          <button onClick={() => setShowHistory(true)} className="history-button">
            📚 Historia
          </button>
          {mcpConnected && (
            <span className="mcp-status">
              🔌 MCP Connected
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
              <p>👋 Witaj! Zadaj pytanie matematyczne, a agent użyje narzędzi SymPy do rozwiązania.</p>
              <div className="examples">
                <p><strong>Przykłady:</strong></p>
                <ul>
                  <li>Oblicz pochodną funkcji f(x) = x³ + 2x² - 5x + 1</li>
                  <li>Całkuj x² od 0 do 2</li>
                  <li>Rozwiąż równanie x² - 5x + 6 = 0</li>
                  <li>Uprość wyrażenie sin(x)² + cos(x)²</li>
                  <li>Oblicz granicę sin(x)/x gdy x dąży do 0</li>
                  <li>Znajdź wyznacznik macierzy [[1, 2], [3, 4]]</li>
                  <li>Rozwiń (x + 1)³</li>
                  <li>Zfaktoryzuj x² - 4</li>
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
                      🤖 Agent Matematyczny
                    </div>
                  )}
                  <div className="message-content">
                    <MessageContent content={msg.content} />
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div className="tool-calls">
                      {msg.toolCalls.map(tc => (
                        <div key={tc.id} className="tool-call">
                          🔧 Używam narzędzia: <code>{tc.name}</code>
                          <details style={{ marginTop: '0.5em', fontSize: '0.85em' }}>
                            <summary>Parametry</summary>
                            <pre>{JSON.stringify(tc.arguments, null, 2)}</pre>
                          </details>
                        </div>
                      ))}
                    </div>
                  )}
                  {msg.toolResults && msg.toolResults.length > 0 && (
                    <div className="tool-results">
                      {msg.toolResults.map((tr, idx) => (
                        <div key={idx} className={`tool-result ${tr.isError ? 'error' : ''}`}>
                          ✅ Wynik <code>{tr.toolName}</code>: <strong>{tr.result}</strong>
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
              <span>Agent pracuje nad odpowiedzią...</span>
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
