import { Message } from './agentService';

export interface ChatSession {
  id: string;
  provider: 'claude' | 'mlx';
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  title?: string; // First user message or custom title
}

const STORAGE_KEY = 'bielik-m-chat-history';

/**
 * Chat History Service - manages conversation persistence
 * Uses localStorage for browser-based storage
 */
export class ChatHistoryService {
  /**
   * Generate unique chat ID
   */
  static generateChatId(): string {
    return `chat-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Get all chat sessions
   */
  static getAllSessions(): ChatSession[] {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (!data) return [];
      const sessions = JSON.parse(data) as ChatSession[];
      // Sort by updatedAt descending (most recent first)
      return sessions.sort((a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
    } catch (error) {
      console.error('[ChatHistory] Failed to load sessions:', error);
      return [];
    }
  }

  /**
   * Get session by ID
   */
  static getSession(chatId: string): ChatSession | null {
    const sessions = this.getAllSessions();
    return sessions.find(s => s.id === chatId) || null;
  }

  /**
   * Save or update chat session
   */
  static saveSession(session: ChatSession): void {
    try {
      const sessions = this.getAllSessions();
      const existingIndex = sessions.findIndex(s => s.id === session.id);

      if (existingIndex >= 0) {
        // Update existing session
        sessions[existingIndex] = {
          ...session,
          updatedAt: new Date().toISOString(),
        };
      } else {
        // Add new session
        sessions.push({
          ...session,
          createdAt: session.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }

      localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
      console.log(`[ChatHistory] Saved session ${session.id}`);
    } catch (error) {
      console.error('[ChatHistory] Failed to save session:', error);
    }
  }

  /**
   * Delete session by ID
   */
  static deleteSession(chatId: string): void {
    try {
      const sessions = this.getAllSessions();
      const filtered = sessions.filter(s => s.id !== chatId);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
      console.log(`[ChatHistory] Deleted session ${chatId}`);
    } catch (error) {
      console.error('[ChatHistory] Failed to delete session:', error);
    }
  }

  /**
   * Delete all sessions
   */
  static clearAllSessions(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
      console.log('[ChatHistory] Cleared all sessions');
    } catch (error) {
      console.error('[ChatHistory] Failed to clear sessions:', error);
    }
  }

  /**
   * Create new session
   */
  static createSession(provider: 'claude' | 'mlx'): ChatSession {
    return {
      id: this.generateChatId(),
      provider,
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Get session title (first user message or auto-generated)
   */
  static getSessionTitle(session: ChatSession): string {
    if (session.title) return session.title;

    const firstUserMessage = session.messages.find(m => m.role === 'user');
    if (firstUserMessage) {
      const content = firstUserMessage.content.trim();
      return content.length > 50 ? content.substring(0, 50) + '...' : content;
    }

    return `Konwersacja ${new Date(session.createdAt).toLocaleDateString('pl-PL')}`;
  }

  /**
   * Export session as JSON file
   */
  static exportSession(chatId: string): void {
    const session = this.getSession(chatId);
    if (!session) {
      console.error('[ChatHistory] Session not found:', chatId);
      return;
    }

    const dataStr = JSON.stringify(session, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `bielik-m-${chatId}.json`;
    link.click();
    URL.revokeObjectURL(url);
    console.log(`[ChatHistory] Exported session ${chatId}`);
  }

  /**
   * Import session from JSON file
   */
  static async importSession(file: File): Promise<ChatSession | null> {
    try {
      const text = await file.text();
      const session = JSON.parse(text) as ChatSession;

      // Validate session structure
      if (!session.id || !session.provider || !Array.isArray(session.messages)) {
        throw new Error('Invalid session format');
      }

      // Generate new ID to avoid conflicts
      session.id = this.generateChatId();
      session.createdAt = new Date().toISOString();
      session.updatedAt = new Date().toISOString();

      this.saveSession(session);
      console.log(`[ChatHistory] Imported session as ${session.id}`);
      return session;
    } catch (error) {
      console.error('[ChatHistory] Failed to import session:', error);
      return null;
    }
  }

  /**
   * Get storage usage info
   */
  static getStorageInfo(): { used: number; total: number; percentage: number } {
    try {
      const data = localStorage.getItem(STORAGE_KEY) || '[]';
      const used = new Blob([data]).size;
      const total = 5 * 1024 * 1024; // ~5MB typical localStorage limit
      return {
        used,
        total,
        percentage: (used / total) * 100,
      };
    } catch (error) {
      return { used: 0, total: 0, percentage: 0 };
    }
  }
}
