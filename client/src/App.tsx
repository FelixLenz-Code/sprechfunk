import { useEffect, useState } from 'react';
import { api, clearToken, getToken, setToken } from './api';
import type { PublicUser } from './types';
import { Login } from './components/Login';
import { Home } from './components/Home';
import { unlockAudio } from './audio';

export function App() {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Unlock/keep-alive audio playback on user interaction (autoplay policy).
    // Not `once`: the shared context can be suspended again by the browser, so
    // we re-resume it on every gesture to keep incoming streams audible.
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    if (!getToken()) {
      setLoading(false);
      return;
    }
    api
      .me()
      .then((r) => setUser(r.user))
      .catch(() => clearToken())
      .finally(() => setLoading(false));

    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  const handleAuth = (token: string, u: PublicUser) => {
    setToken(token);
    setUser(u);
  };

  const handleLogout = () => {
    clearToken();
    setUser(null);
  };

  if (loading) {
    return (
      <div className="auth-wrap">
        <div className="hint">Lade …</div>
      </div>
    );
  }

  if (!user) return <Login onAuth={handleAuth} />;
  return <Home user={user} onLogout={handleLogout} onUserChange={setUser} />;
}
