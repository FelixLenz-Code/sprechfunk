import { useEffect, useState } from 'react';
import { api } from '../api';
import type { PublicUser } from '../types';
import { initials } from './util';

export function Admin({
  me,
  onClose,
  onUserChange,
}: {
  me: PublicUser;
  onClose: () => void;
  onUserChange: (u: PublicUser) => void;
}) {
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  const [users, setUsers] = useState<(PublicUser & { created_at: number })[]>([]);
  const [error, setError] = useState('');

  const load = () => {
    api.adminSettings().then((s) => setRegistrationEnabled(s.registrationEnabled)).catch(() => {});
    api.adminUsers().then((r) => setUsers(r.users)).catch(() => {});
  };
  useEffect(load, []);

  const toggleRegistration = async () => {
    const next = !registrationEnabled;
    setRegistrationEnabled(next);
    try {
      await api.setRegistration(next);
    } catch {
      setRegistrationEnabled(!next);
    }
  };

  const toggleAdmin = async (u: PublicUser) => {
    setError('');
    try {
      await api.setUserAdmin(u.id, !u.is_admin);
      if (u.id === me.id) onUserChange({ ...me, is_admin: !u.is_admin });
      load();
    } catch (e: any) {
      setError(e.message ?? 'Fehler');
    }
  };

  const remove = async (u: PublicUser) => {
    setError('');
    if (!confirm(`Nutzer „${u.display_name}" wirklich löschen?`)) return;
    try {
      await api.deleteUser(u.id);
      load();
    } catch (e: any) {
      setError(e.message ?? 'Fehler');
    }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>🛡️ Administration</h2>

        <div className="row">
          <div>
            <div>Registrierung erlaubt</div>
            <div className="li-sub">Neue Nutzer können sich selbst anmelden</div>
          </div>
          <button
            className={`toggle ${registrationEnabled ? 'on' : ''}`}
            onClick={toggleRegistration}
            aria-label="Registrierung umschalten"
          >
            <span />
          </button>
        </div>

        <div className="section-label" style={{ padding: '14px 0 6px' }}>Nutzer ({users.length})</div>
        {error && <div className="error">{error}</div>}
        {users.map((u) => (
          <div className="row" key={u.id}>
            <div className="check">
              <div className="avatar" style={{ width: 34, height: 34, fontSize: 13 }}>{initials(u.display_name)}</div>
              <div>
                <div>{u.display_name} {u.is_admin && <span className="pill" style={{ padding: '1px 8px', fontSize: 11 }}>Admin</span>}</div>
                <div className="li-sub">@{u.username}</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="pill" onClick={() => toggleAdmin(u)}>
                {u.is_admin ? 'Admin entz.' : 'Zum Admin'}
              </button>
              {u.id !== me.id && (
                <button className="iconbtn small" style={{ background: 'var(--danger)' }} onClick={() => remove(u)}>🗑️</button>
              )}
            </div>
          </div>
        ))}

        <button className="btn" style={{ marginTop: 18 }} onClick={onClose}>Fertig</button>
      </div>
    </div>
  );
}
