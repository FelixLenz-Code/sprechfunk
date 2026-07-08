import { useEffect, useRef, useState } from 'react';
import { api, fetchAudioUrl } from '../api';
import { realtime } from '../realtime';
import type { ConversationSummary, Message, PublicUser } from '../types';
import { convTitle, formatDuration, formatTime, initials, otherMember } from './util';

export function ChatView({
  me,
  conversation,
  messages,
  online,
  bitrate,
  speaking,
  onBack,
  onAddedMember,
}: {
  me: PublicUser;
  conversation: ConversationSummary;
  messages: Message[];
  online: Set<string>;
  bitrate: number;
  speaking: { convId: string; name: string }[];
  onBack: () => void;
  onAddedMember: () => void;
}) {
  const [text, setText] = useState('');
  const [ptt, setPtt] = useState(false);
  const [micError, setMicError] = useState('');
  const [showInfo, setShowInfo] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const holding = useRef(false);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, speaking.length]);

  const other = otherMember(conversation, me.id);
  const subtitle =
    conversation.type === 'group'
      ? `${conversation.members.length} Mitglieder`
      : other && online.has(other.id)
        ? 'Online'
        : 'Offline';

  const sendText = () => {
    const t = text.trim();
    if (!t) return;
    realtime.sendText(conversation.id, t);
    setText('');
  };

  const startPtt = async () => {
    if (holding.current) return;
    holding.current = true;
    setMicError('');
    setPtt(true);
    try {
      await realtime.startPtt(conversation.id, bitrate);
    } catch {
      setPtt(false);
      holding.current = false;
      setMicError('Mikrofonzugriff verweigert.');
    }
  };
  const stopPtt = async () => {
    if (!holding.current) return;
    holding.current = false;
    setPtt(false);
    await realtime.stopPtt();
  };

  // Spacebar as PTT (when not typing)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        void startPtt();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') void stopPtt();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id, bitrate]);

  return (
    <>
      <div className="topbar">
        <button className="iconbtn small back-btn" onClick={onBack}>←</button>
        <div className={`avatar ${conversation.type === 'group' ? 'group' : ''}`} style={{ width: 36, height: 36, fontSize: 14 }}>
          {conversation.type === 'group' ? '👥' : initials(convTitle(conversation, me.id))}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="title">{convTitle(conversation, me.id)}</div>
          <div className="li-sub">{subtitle}</div>
        </div>
        <button className="iconbtn small" title="Info" onClick={() => setShowInfo(true)}>ℹ️</button>
      </div>

      <div className="messages" ref={scrollRef}>
        {messages.map((m) => (
          <MessageBubble key={m.id} m={m} mine={m.sender_id === me.id} isGroup={conversation.type === 'group'} />
        ))}
        {messages.length === 0 && <div className="empty">Noch keine Nachrichten. Drücke die Sprechtaste!</div>}
      </div>

      {speaking.length > 0 && (
        <div className="speaking-bar">🔊 {speaking.map((s) => s.name).join(', ')} spricht …</div>
      )}
      {micError && <div className="speaking-bar" style={{ color: 'var(--danger)', background: 'rgba(239,68,68,.12)' }}>{micError}</div>}

      <div className="composer">
        <div className="text-row">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendText()}
            placeholder="Nachricht schreiben …"
          />
          <button className="iconbtn" onClick={sendText} title="Senden">➤</button>
        </div>
        <button
          className={`ptt ${ptt ? 'active' : ''}`}
          onPointerDown={(e) => {
            e.preventDefault();
            void startPtt();
          }}
          onPointerUp={() => void stopPtt()}
          onPointerLeave={() => void stopPtt()}
          onPointerCancel={() => void stopPtt()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {ptt ? <><span className="pulse" /> Sendet …</> : <>🎙️ Halten zum Sprechen</>}
        </button>
      </div>

      {showInfo && (
        <GroupInfo
          me={me}
          conversation={conversation}
          online={online}
          onClose={() => setShowInfo(false)}
          onAddedMember={onAddedMember}
        />
      )}
    </>
  );
}

function MessageBubble({ m, mine, isGroup }: { m: Message; mine: boolean; isGroup: boolean }) {
  if (m.type === 'system') return <div className="msg system">{m.body}</div>;
  return (
    <div className={`msg ${mine ? 'mine' : ''}`}>
      {isGroup && !mine && <div className="sender">{m.sender?.display_name ?? 'Unbekannt'}</div>}
      {m.type === 'voice' ? <VoiceMessage m={m} /> : <div>{m.body}</div>}
      <div className="meta">{formatTime(m.created_at)}</div>
    </div>
  );
}

function VoiceMessage({ m }: { m: Message }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const play = async () => {
    if (url) {
      audioRef.current?.play();
      return;
    }
    setLoading(true);
    try {
      const u = await fetchAudioUrl(m.id);
      setUrl(u);
      const audio = new Audio(u);
      audioRef.current = audio;
      await audio.play();
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="voice">
      <button onClick={play} title="Abspielen">{loading ? '…' : '▶'}</button>
      <span>Sprachnachricht {formatDuration(m.duration_ms)}</span>
    </div>
  );
}

function GroupInfo({
  me,
  conversation,
  online,
  onClose,
  onAddedMember,
}: {
  me: PublicUser;
  conversation: ConversationSummary;
  online: Set<string>;
  onClose: () => void;
  onAddedMember: () => void;
}) {
  const [contacts, setContacts] = useState<PublicUser[]>([]);
  const memberIds = new Set(conversation.members.map((m) => m.id));

  useEffect(() => {
    if (conversation.type === 'group') api.contacts().then((r) => setContacts(r.contacts)).catch(() => {});
  }, [conversation.type]);

  const add = async (u: PublicUser) => {
    await api.addMember(conversation.id, u.id);
    onAddedMember();
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{convTitle(conversation, me.id)}</h2>
        <div className="section-label" style={{ padding: '0 0 6px' }}>Mitglieder</div>
        {conversation.members.map((mem) => (
          <div className="row" key={mem.id}>
            <div className="check">
              <div className="avatar" style={{ width: 34, height: 34, fontSize: 13 }}>
                {initials(mem.display_name)}
                <span className={`dot ${online.has(mem.id) ? 'online' : ''}`} />
              </div>
              <div>
                <div>{mem.display_name}{mem.id === me.id ? ' (du)' : ''}</div>
                <div className="li-sub">@{mem.username}</div>
              </div>
            </div>
          </div>
        ))}

        {conversation.type === 'group' && contacts.some((c) => !memberIds.has(c.id)) && (
          <>
            <div className="section-label" style={{ padding: '14px 0 6px' }}>Kontakt hinzufügen</div>
            {contacts
              .filter((c) => !memberIds.has(c.id))
              .map((c) => (
                <div className="row" key={c.id}>
                  <span>{c.display_name}</span>
                  <button className="pill" onClick={() => add(c)}>+ Hinzufügen</button>
                </div>
              ))}
          </>
        )}
        <button className="btn secondary" style={{ marginTop: 16 }} onClick={onClose}>Schließen</button>
      </div>
    </div>
  );
}
