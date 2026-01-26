import { useState, useRef, useEffect } from 'react';
import { GroupChatOrchestrator, createMathAgents, Message } from './services/agentService';
import './App.css';

function App() {
  const [apiKey, setApiKey] = useState('');
  const [isConfigured, setIsConfigured] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [rounds, setRounds] = useState(2);

  const orchestratorRef = useRef<GroupChatOrchestrator | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleConfigure = () => {
    if (!apiKey.trim()) {
      alert('Proszę wprowadzić klucz API');
      return;
    }

    const agents = createMathAgents();
    orchestratorRef.current = new GroupChatOrchestrator(apiKey, agents);
    setIsConfigured(true);
  };

  const handleSendMessage = async () => {
    if (!inputMessage.trim() || !orchestratorRef.current || isProcessing) {
      return;
    }

    setIsProcessing(true);
    setInputMessage('');

    try {
      await orchestratorRef.current.orchestrateConversation(
        inputMessage,
        rounds,
        (message) => {
          setMessages(prev => [...prev, message]);
        }
      );
    } catch (error) {
      console.error('Błąd podczas przetwarzania:', error);
      alert('Wystąpił błąd podczas komunikacji z agentami. Sprawdź klucz API i połączenie.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleClearHistory = () => {
    if (orchestratorRef.current) {
      orchestratorRef.current.clearHistory();
      setMessages([]);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  if (!isConfigured) {
    return (
      <div className="config-container">
        <div className="config-card">
          <h1>🤖 System Agentów Matematycznych</h1>
          <p className="subtitle">
            Dwa agenty AI współpracują, aby rozwiązywać zadania matematyczne
          </p>

          <div className="config-form">
            <label htmlFor="apiKey">Klucz API Anthropic:</label>
            <input
              id="apiKey"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-ant-..."
              className="api-input"
            />

            <button onClick={handleConfigure} className="config-button">
              Rozpocznij
            </button>
          </div>

          <div className="info-box">
            <h3>Jak to działa?</h3>
            <ul>
              <li><strong>Analizator</strong> - analizuje problem i tworzy strategię</li>
              <li><strong>Kalkulator</strong> - wykonuje obliczenia krok po kroku</li>
              <li>Agenty wymieniają się informacjami w grupowym czacie</li>
              <li>Współpraca prowadzi do kompletnego rozwiązania</li>
            </ul>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>🤖 System Agentów Matematycznych</h1>
        <div className="header-controls">
          <label>
            Rundy konwersacji:
            <input
              type="number"
              min="1"
              max="5"
              value={rounds}
              onChange={(e) => setRounds(parseInt(e.target.value) || 1)}
              className="rounds-input"
            />
          </label>
          <button onClick={handleClearHistory} className="clear-button">
            Wyczyść historię
          </button>
        </div>
      </header>

      <div className="chat-container">
        <div className="messages-container">
          {messages.length === 0 ? (
            <div className="empty-state">
              <p>👋 Witaj! Zadaj pytanie matematyczne, a agenty wspólnie je rozwiążą.</p>
              <div className="examples">
                <p><strong>Przykłady:</strong></p>
                <ul>
                  <li>Rozwiąż równanie kwadratowe: 2x² + 5x - 3 = 0</li>
                  <li>Oblicz pochodną funkcji f(x) = x³ + 2x² - 5x + 1</li>
                  <li>Jakie jest pole koła o promieniu 7 cm?</li>
                  <li>Rozwiąż układ równań: 2x + y = 5 oraz x - y = 1</li>
                </ul>
              </div>
            </div>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`message ${msg.role} ${msg.agentName ? 'agent-message' : ''}`}
              >
                {msg.agentName && (
                  <div className="agent-badge">
                    {msg.agentName === 'Analizator' ? '🔍' : '🔢'} {msg.agentName}
                  </div>
                )}
                {msg.role === 'user' && (
                  <div className="message-badge">👤 Ty</div>
                )}
                <div className="message-content">{msg.content}</div>
                <div className="message-time">
                  {msg.timestamp.toLocaleTimeString('pl-PL')}
                </div>
              </div>
            ))
          )}
          {isProcessing && (
            <div className="processing-indicator">
              <div className="spinner"></div>
              <span>Agenty pracują nad odpowiedzią...</span>
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
    </div>
  );
}

export default App;
