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
    // Unlock audio playback on first interaction (autoplay policy).
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock, { once: true });

    if (!getToken()) {
      setLoading(false);
      return;
    }
    api
      .me()
      .then((r) => setUser(r.user))
      .catch(() => clearToken())
      .finally(() => setLoading(false));

    return () => window.removeEventListener('pointerdown', unlock);
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
