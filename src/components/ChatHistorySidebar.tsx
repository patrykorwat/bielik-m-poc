import { ChatSession, ChatHistoryService } from '../services/chatHistoryService';
import './ChatHistorySidebar.css';

const SidebarIcon = ({ type }: { type: string }) => {
  const icons: Record<string, { svg: string; color: string }> = {
    books: { svg: '<path d="M21 5c-1.11-.35-2.33-.5-3.5-.5-1.95 0-4.05.4-5.5 1.5-1.45-1.1-3.55-1.5-5.5-1.5S2.45 4.9 1 6v14.65c0 .25.25.5.5.5.1 0 .15-.05.25-.05C3.1 20.45 5.05 20 6.5 20c1.95 0 4.05.4 5.5 1.5 1.35-.85 3.8-1.5 5.5-1.5 1.65 0 3.35.3 4.75 1.05.1.05.15.05.25.05.25 0 .5-.25.5-.5V6c-.6-.45-1.25-.75-2-1zm0 13.5c-1.1-.35-2.3-.5-3.5-.5-1.7 0-4.15.65-5.5 1.5V8c1.35-.85 3.8-1.5 5.5-1.5 1.2 0 2.4.15 3.5.5v11.5z"/>', color: '#2563eb' },
    plus: { svg: '<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>', color: '#16a34a' },
    robot: { svg: '<path d="M12 2a2 2 0 012 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 017 7h1a1 1 0 011 1v3a1 1 0 01-1 1h-1v1a2 2 0 01-2 2H5a2 2 0 01-2-2v-1H2a1 1 0 01-1-1v-3a1 1 0 011-1h1a7 7 0 017-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 012-2zM7.5 13A1.5 1.5 0 006 14.5 1.5 1.5 0 007.5 16 1.5 1.5 0 009 14.5 1.5 1.5 0 007.5 13zm9 0a1.5 1.5 0 00-1.5 1.5 1.5 1.5 0 001.5 1.5 1.5 1.5 0 001.5-1.5 1.5 1.5 0 00-1.5-1.5z"/>', color: '#6366f1' },
    bolt: { svg: '<path d="M7 2v11h3v9l7-12h-4l4-8z"/>', color: '#f59e0b' },
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
      style={{ verticalAlign: 'middle', display: 'inline-block', flexShrink: 0, marginRight: '2px' }}
      dangerouslySetInnerHTML={{ __html: icon.svg }}
    />
  );
};

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
          <h2><SidebarIcon type="books" /> Historia Konwersacji</h2>
          <button onClick={onClose} className="close-button" title="Zamknij">
            ✕
          </button>
        </div>

        <button onClick={onNewChat} className="new-chat-button">
          <SidebarIcon type="plus" /> Nowa Konwersacja
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
                      {session.provider === 'claude' ? <><SidebarIcon type="robot" /> Claude</> : <><SidebarIcon type="bolt" /> MLX</>}
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
                    <SidebarIcon type="trash" />
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
