import React from 'react';

interface Props {
  children: React.ReactNode;
  /** Optional name shown in the fallback UI so the user knows which section failed */
  sectionName?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Generic Error Boundary that catches render errors in its children
 * and displays a compact fallback instead of crashing the whole app.
 */
class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(
      `[ErrorBoundary${this.props.sectionName ? `: ${this.props.sectionName}` : ''}]`,
      error,
      info.componentStack,
    );
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            padding: '24px',
            margin: '12px 0',
            borderRadius: '12px',
            backgroundColor: 'var(--bg-secondary, #f5f5f5)',
            color: 'var(--text-primary, #333)',
            textAlign: 'center',
          }}
        >
          <p style={{ margin: '0 0 8px', fontWeight: 600 }}>
            {this.props.sectionName
              ? `Nie udało się załadować: ${this.props.sectionName}`
              : 'Coś poszło nie tak'}
          </p>
          <p style={{ margin: '0 0 12px', fontSize: '0.9em', opacity: 0.7 }}>
            {this.state.error?.message}
          </p>
          <button
            onClick={this.handleRetry}
            style={{
              padding: '8px 20px',
              borderRadius: '8px',
              border: 'none',
              backgroundColor: 'var(--primary, #667eea)',
              color: '#fff',
              cursor: 'pointer',
              fontSize: '0.9em',
            }}
          >
            Spróbuj ponownie
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
