import { useState, useEffect } from 'react';

declare global {
  interface Window {
    formuloGrantConsent?: (level: string) => void;
    __tcfapi?: (...args: unknown[]) => void;
  }
}

function hasGoogleCMP(): boolean {
  return typeof window.__tcfapi === 'function';
}

function hasExistingConsent(): boolean {
  // Google Funding Choices stores consent in FCCDCF cookie
  if (document.cookie.split(';').some(c => c.trim().startsWith('FCCDCF='))) return true;
  // Our own fallback consent
  if (localStorage.getItem('formulo-cookie-consent')) return true;
  return false;
}

export function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (hasExistingConsent()) return;

    // First check: Google CMP might already be loaded
    if (hasGoogleCMP()) return;

    // Wait 1.5s for Google Funding Choices to potentially load
    const timer = setTimeout(() => {
      if (hasGoogleCMP() || hasExistingConsent()) return;
      // Google CMP did not load, show our fallback banner
      setVisible(true);
    }, 1500);

    return () => clearTimeout(timer);
  }, []);

  const accept = (level: string) => {
    if (window.formuloGrantConsent) {
      window.formuloGrantConsent(level);
    }
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      background: 'var(--glass-bg, #1a1a2e)',
      borderTop: '1px solid var(--glass-border, #333)',
      padding: '16px 24px',
      zIndex: 9999,
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '12px',
      fontSize: '13px',
      color: 'var(--text-secondary, #ccc)',
      backdropFilter: 'blur(12px)',
    }}>
      <span>
        Używamy cookies do analityki i reklam.{' '}
        <a href="/cookies" style={{ color: 'var(--primary, #667eea)', textDecoration: 'underline' }}>Więcej informacji</a>
      </span>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          onClick={() => accept('necessary')}
          style={{
            padding: '6px 14px',
            borderRadius: '6px',
            border: '1px solid var(--glass-border, #444)',
            background: 'transparent',
            color: 'var(--text-secondary, #ccc)',
            cursor: 'pointer',
            fontSize: '13px',
          }}
        >
          Tylko niezbędne
        </button>
        <button
          onClick={() => accept('all')}
          style={{
            padding: '6px 14px',
            borderRadius: '6px',
            border: 'none',
            background: 'var(--primary, #667eea)',
            color: 'white',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: 600,
          }}
        >
          Akceptuję wszystkie
        </button>
      </div>
    </div>
  );
}
