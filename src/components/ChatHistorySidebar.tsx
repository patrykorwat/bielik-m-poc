import { ChatSession, ChatHistoryService } from '../services/chatHistoryService';
import './ChatHistorySidebar.css';

interface Props {
  sessions: ChatSession[];
  currentChatId: string | null;
  onLoadChat: (chatId: string) => void;
  onDeleteChat: (chatId: string) => void;
  onNewChat: () => void;
  onClose: () => void;
}

export function ChatHistorySidebar({
  sessions,
  currentChatId,
  onLoadChat,
  onDeleteChat,
  onNewChat,
  onClose,
}: Props) {
  return (
    <div className="sidebar-overlay" onClick={onClose}>
      <div className="sidebar" onClick={(e) => e.stopPropagation()}>
        <div className="sidebar-header">
          <h2>📚 Historia Konwersacji</h2>
          <button onClick={onClose} className="close-button" title="Zamknij">
            ✕
          </button>
        </div>

        <button onClick={onNewChat} className="new-chat-button">
          ➕ Nowa Konwersacja
        </button>

        <div className="sessions-list">
          {sessions.length === 0 ? (
            <div className="empty-sessions">
              <p>Brak zapisanych konwersacji</p>
            </div>
          ) : (
            sessions.map((session) => {
              const title = ChatHistoryService.getSessionTitle(session);
              const isActive = session.id === currentChatId;
              const date = new Date(session.updatedAt).toLocaleDateString('pl-PL', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              });

              return (
                <div
                  key={session.id}
                  className={`session-item ${isActive ? 'active' : ''}`}
                >
                  <div
                    className="session-content"
                    onClick={() => onLoadChat(session.id)}
                  >
                    <div className="session-provider">
                      {session.provider === 'claude' ? '🤖 Claude' : '⚡ MLX'}
                    </div>
                    <div className="session-title">{title}</div>
                    <div className="session-meta">
                      <span className="session-date">{date}</span>
                      <span className="session-count">
                        {session.messages.length} wiadomości
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteChat(session.id);
                    }}
                    className="delete-session-button"
                    title="Usuń konwersację"
                  >
                    🗑️
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="sidebar-footer">
          <div className="storage-info">
            {(() => {
              const info = ChatHistoryService.getStorageInfo();
              const usedMB = (info.used / (1024 * 1024)).toFixed(2);
              const totalMB = (info.total / (1024 * 1024)).toFixed(0);
              return (
                <>
                  <div className="storage-bar">
                    <div
                      className="storage-fill"
                      style={{ width: `${Math.min(info.percentage, 100)}%` }}
                    />
                  </div>
                  <div className="storage-text">
                    Pamięć: {usedMB} / {totalMB} MB
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}
