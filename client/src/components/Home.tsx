import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { realtime } from '../realtime';
import { getToken } from '../api';
import type { ConversationSummary, Message, PublicUser } from '../types';
import { convTitle, initials, messagePreview, formatTime, otherMember } from './util';
import { ChatView } from './ChatView';
import { NewChat } from './NewChat';
import { Settings } from './Settings';
import { Admin } from './Admin';

type Overlay = 'new' | 'settings' | 'admin' | null;

export function Home({
  user,
  onLogout,
  onUserChange,
}: {
  user: PublicUser;
  onLogout: () => void;
  onUserChange: (u: PublicUser) => void;
}) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [contacts, setContacts] = useState<PublicUser[]>([]);
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [speaking, setSpeaking] = useState<Record<number, { convId: string; name: string }>>({});
  const [bitrate, setBitrate] = useState(24000);
  const [connected, setConnected] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(null);

  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  const loadConversations = () => api.conversations().then((r) => setConversations(r.conversations)).catch(() => {});
  const loadContacts = () => api.contacts().then((r) => setContacts(r.contacts)).catch(() => {});

  // Initial load + realtime connection
  useEffect(() => {
    loadConversations();
    loadContacts();
    api.getSettings().then((s) => setBitrate(s.audioBitrate)).catch(() => {});

    realtime.setHandlers({
      onStatus: setConnected,
      onPresenceSnapshot: (ids) => setOnline(new Set(ids)),
      onPresence: (userId, status) =>
        setOnline((prev) => {
          const next = new Set(prev);
          if (status === 'online') next.add(userId);
          else next.delete(userId);
          return next;
        }),
      onMessage: (m) => {
        if (m.conversation_id === selectedIdRef.current) {
          setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
          api.markRead(m.conversation_id).catch(() => {});
        }
        loadConversations();
      },
      onStreamStart: (info) =>
        setSpeaking((prev) => ({
          ...prev,
          [info.streamId]: { convId: info.convId, name: info.from?.display_name ?? 'Jemand' },
        })),
      onStreamStop: (streamId) =>
        setSpeaking((prev) => {
          const next = { ...prev };
          delete next[streamId];
          return next;
        }),
      onConversationNew: () => loadConversations(),
    });
    realtime.connect(getToken()!);
    return () => realtime.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load messages when a conversation is selected
  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      return;
    }
    api
      .messages(selectedId)
      .then((r) => setMessages(r.messages))
      .catch(() => setMessages([]));
    api.markRead(selectedId).then(loadConversations).catch(() => {});
  }, [selectedId]);

  const selected = useMemo(
    () => conversations.find((c) => c.id === selectedId) ?? null,
    [conversations, selectedId],
  );

  const speakingHere = useMemo(
    () => (selectedId ? Object.values(speaking).filter((s) => s.convId === selectedId) : []),
    [speaking, selectedId],
  );

  const openDirect = async (u: PublicUser) => {
    const r = await api.openDirect(u.id);
    await loadConversations();
    setSelectedId(r.conversation.id);
    setOverlay(null);
  };

  const conversationsWithContacts = useMemo(() => {
    // Contacts without an existing conversation, shown so user can start one.
    const convUserIds = new Set(
      conversations.filter((c) => c.type === 'direct').flatMap((c) => c.members.map((m) => m.id)),
    );
    return contacts.filter((c) => !convUserIds.has(c.id));
  }, [contacts, conversations]);

  return (
    <div className={`app ${selectedId ? 'has-selection' : ''}`}>
      <aside className="sidebar">
        <div className="topbar">
          <div className="avatar" style={{ width: 34, height: 34, fontSize: 13 }}>{initials(user.display_name)}</div>
          <div className="title">{user.display_name}</div>
          <span className="status-chip">
            <span className={`dot ${connected ? 'online' : ''}`} /> {connected ? 'Verbunden' : 'Getrennt'}
          </span>
          {user.is_admin && (
            <button className="iconbtn small" title="Admin" onClick={() => setOverlay('admin')}>🛡️</button>
          )}
          <button className="iconbtn small" title="Einstellungen" onClick={() => setOverlay('settings')}>⚙️</button>
        </div>

        <div className="topbar" style={{ borderTop: 'none' }}>
          <button className="btn" onClick={() => setOverlay('new')}>+ Neue Unterhaltung</button>
        </div>

        <div className="list">
          {conversations.map((c) => {
            const other = otherMember(c, user.id);
            const isOnline = c.type === 'direct' && other ? online.has(other.id) : false;
            const speakingNow = Object.values(speaking).some((s) => s.convId === c.id);
            return (
              <button
                key={c.id}
                className={`list-item ${c.id === selectedId ? 'active' : ''}`}
                onClick={() => setSelectedId(c.id)}
              >
                <div className={`avatar ${c.type === 'group' ? 'group' : ''}`}>
                  {c.type === 'group' ? '👥' : initials(convTitle(c, user.id))}
                  {c.type === 'direct' && <span className={`dot ${isOnline ? 'online' : ''}`} />}
                </div>
                <div className="li-body">
                  <div className="li-title">
                    <span>{convTitle(c, user.id)}</span>
                    <span className="time">{c.lastMessage ? formatTime(c.lastMessage.created_at) : ''}</span>
                  </div>
                  <div className="li-sub">
                    {speakingNow ? '🔊 spricht gerade …' : messagePreview(c.lastMessage)}
                  </div>
                </div>
                {c.unread > 0 && <span className="badge">{c.unread}</span>}
              </button>
            );
          })}

          {conversationsWithContacts.length > 0 && (
            <>
              <div className="section-label">Kontakte</div>
              {conversationsWithContacts.map((u) => (
                <button key={u.id} className="list-item" onClick={() => openDirect(u)}>
                  <div className="avatar">
                    {initials(u.display_name)}
                    <span className={`dot ${online.has(u.id) ? 'online' : ''}`} />
                  </div>
                  <div className="li-body">
                    <div className="li-title">{u.display_name}</div>
                    <div className="li-sub">@{u.username}</div>
                  </div>
                </button>
              ))}
            </>
          )}

          {conversations.length === 0 && conversationsWithContacts.length === 0 && (
            <div className="empty" style={{ padding: 32 }}>
              Noch keine Unterhaltungen.<br />Tippe auf „Neue Unterhaltung".
            </div>
          )}
        </div>
      </aside>

      <main className="main">
        {selected ? (
          <ChatView
            key={selected.id}
            me={user}
            conversation={selected}
            messages={messages}
            online={online}
            bitrate={bitrate}
            speaking={speakingHere}
            onBack={() => setSelectedId(null)}
            onAddedMember={loadConversations}
          />
        ) : (
          <div className="empty">
            <div>
              <img src="/favicon.svg" width={72} height={72} alt="" style={{ opacity: 0.5 }} />
              <p>Wähle eine Unterhaltung, um zu funken.</p>
            </div>
          </div>
        )}
      </main>

      {overlay === 'new' && (
        <NewChat
          contacts={contacts}
          onClose={() => setOverlay(null)}
          onContactsChange={loadContacts}
          onOpenDirect={openDirect}
          onCreated={async (convId) => {
            await loadConversations();
            setSelectedId(convId);
            setOverlay(null);
          }}
        />
      )}
      {overlay === 'settings' && (
        <Settings
          bitrate={bitrate}
          onBitrate={setBitrate}
          onClose={() => setOverlay(null)}
          onLogout={onLogout}
        />
      )}
      {overlay === 'admin' && user.is_admin && (
        <Admin me={user} onClose={() => setOverlay(null)} onUserChange={onUserChange} />
      )}
    </div>
  );
}
