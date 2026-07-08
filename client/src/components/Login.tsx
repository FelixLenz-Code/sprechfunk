import { useEffect, useState } from 'react';
import { api } from '../api';
import type { PublicUser } from '../types';

export function Login({ onAuth }: { onAuth: (token: string, user: PublicUser) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  const [firstUser, setFirstUser] = useState(false);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .authConfig()
      .then((c) => {
        setRegistrationEnabled(c.registrationEnabled);
        setFirstUser(!c.hasUsers);
        if (!c.hasUsers) setMode('register');
      })
      .catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res =
        mode === 'register'
          ? await api.register(username.trim(), displayName.trim() || username.trim(), password)
          : await api.login(username.trim(), password);
      onAuth(res.token, res.user);
    } catch (err: any) {
      setError(err.message ?? 'Fehler');
    } finally {
      setBusy(false);
    }
  };

  const canRegister = registrationEnabled || firstUser;

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">
          <img src="/favicon.svg" alt="" />
          <h1>Sprechfunk</h1>
        </div>

        {firstUser && (
          <p className="hint" style={{ textAlign: 'left', marginTop: 0 }}>
            Willkommen! Das erste Konto wird zum <strong>Administrator</strong>.
          </p>
        )}

        {mode === 'register' && (
          <div className="field">
            <label>Anzeigename</label>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="z. B. Max" />
          </div>
        )}

        <div className="field">
          <label>Benutzername</label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            required
          />
        </div>

        <div className="field">
          <label>Passwort</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>

        {error && <div className="error">{error}</div>}

        <button className="btn" disabled={busy}>
          {mode === 'register' ? 'Registrieren' : 'Anmelden'}
        </button>

        {mode === 'login' && canRegister && (
          <p className="hint">
            Noch kein Konto?{' '}
            <button type="button" className="link" onClick={() => setMode('register')}>
              Registrieren
            </button>
          </p>
        )}
        {mode === 'register' && !firstUser && (
          <p className="hint">
            Bereits registriert?{' '}
            <button type="button" className="link" onClick={() => setMode('login')}>
              Anmelden
            </button>
          </p>
        )}
        {mode === 'login' && !canRegister && (
          <p className="hint">Registrierung ist derzeit deaktiviert.</p>
        )}
      </form>
    </div>
  );
}
