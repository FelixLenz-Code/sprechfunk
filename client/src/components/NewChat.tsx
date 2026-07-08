import { useEffect, useState } from 'react';
import { api } from '../api';
import type { PublicUser } from '../types';
import { initials } from './util';

export function NewChat({
  contacts,
  onClose,
  onContactsChange,
  onOpenDirect,
  onCreated,
}: {
  contacts: PublicUser[];
  onClose: () => void;
  onContactsChange: () => void;
  onOpenDirect: (u: PublicUser) => void;
  onCreated: (convId: string) => void;
}) {
  const [tab, setTab] = useState<'direct' | 'group'>('direct');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PublicUser[]>([]);
  const [groupName, setGroupName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');

  const contactIds = new Set(contacts.map((c) => c.id));

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      api.searchUsers(q).then((r) => setResults(r.users)).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const addContact = async (u: PublicUser) => {
    await api.addContact(u.id);
    onContactsChange();
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const createGroup = async () => {
    setError('');
    if (!groupName.trim()) return setError('Bitte einen Gruppennamen eingeben.');
    if (selected.size === 0) return setError('Bitte mindestens ein Mitglied auswählen.');
    try {
      const r = await api.createGroup(groupName.trim(), [...selected]);
      onCreated(r.conversation.id);
    } catch (e: any) {
      setError(e.message ?? 'Fehler');
    }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Neue Unterhaltung</h2>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <button className={`pill ${tab === 'direct' ? 'selected' : ''}`} onClick={() => setTab('direct')}>Direkt</button>
          <button className={`pill ${tab === 'group' ? 'selected' : ''}`} onClick={() => setTab('group')}>Gruppe</button>
        </div>

        {tab === 'direct' ? (
          <>
            <div className="field">
              <input
                placeholder="Nutzer suchen (Name oder @benutzername) …"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
            </div>
            {results.map((u) => (
              <div className="row" key={u.id}>
                <div className="check">
                  <div className="avatar" style={{ width: 34, height: 34, fontSize: 13 }}>{initials(u.display_name)}</div>
                  <div>
                    <div>{u.display_name}</div>
                    <div className="li-sub">@{u.username}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {!contactIds.has(u.id) && <button className="pill" onClick={() => addContact(u)}>+ Kontakt</button>}
                  <button className="pill selected" onClick={() => onOpenDirect(u)}>Chat</button>
                </div>
              </div>
            ))}
            {query.trim() && results.length === 0 && <p className="hint">Keine Treffer.</p>}

            {contacts.length > 0 && (
              <>
                <div className="section-label" style={{ padding: '14px 0 6px' }}>Deine Kontakte</div>
                {contacts.map((u) => (
                  <div className="row" key={u.id}>
                    <div className="check">
                      <div className="avatar" style={{ width: 34, height: 34, fontSize: 13 }}>{initials(u.display_name)}</div>
                      <span>{u.display_name}</span>
                    </div>
                    <button className="pill selected" onClick={() => onOpenDirect(u)}>Chat</button>
                  </div>
                ))}
              </>
            )}
          </>
        ) : (
          <>
            <div className="field">
              <label>Gruppenname</label>
              <input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="z. B. Team Alpha" />
            </div>
            <div className="section-label" style={{ padding: '0 0 6px' }}>Mitglieder wählen</div>
            {contacts.length === 0 && <p className="hint">Füge zuerst Kontakte hinzu (Tab „Direkt").</p>}
            {contacts.map((u) => (
              <div className="row" key={u.id}>
                <div className="check">
                  <div className="avatar" style={{ width: 34, height: 34, fontSize: 13 }}>{initials(u.display_name)}</div>
                  <span>{u.display_name}</span>
                </div>
                <button
                  className={`pill ${selected.has(u.id) ? 'selected' : ''}`}
                  onClick={() => toggle(u.id)}
                >
                  {selected.has(u.id) ? '✓ Gewählt' : 'Wählen'}
                </button>
              </div>
            ))}
            {error && <div className="error">{error}</div>}
            <button className="btn" style={{ marginTop: 14 }} onClick={createGroup}>Gruppe erstellen</button>
          </>
        )}

        <button className="btn secondary" style={{ marginTop: 12 }} onClick={onClose}>Schließen</button>
      </div>
    </div>
  );
}
