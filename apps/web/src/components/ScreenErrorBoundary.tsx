import { Component, useEffect, useState, type ReactNode } from 'react';

function ScreenRecovery() {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  return <main className="main-content" id="main-content" data-screen-error>
    <section className="card stack" role="alert" aria-labelledby="screen-error-title">
      <h1 id="screen-error-title">This screen could not load</h1>
      <p className="muted">{online ? 'Reload the screen to try again.' : 'Reconnect, then reload this screen to try again.'}</p>
      <div>
        <button type="button" className="button button-primary" autoFocus onClick={() => window.location.reload()}>
          <span className="button-label">Reload screen</span>
        </button>
      </div>
    </section>
  </main>;
}

/** Keep rejected lazy imports and rendering failures actionable without exposing error details. */
export class ScreenErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <ScreenRecovery /> : this.props.children;
  }
}
