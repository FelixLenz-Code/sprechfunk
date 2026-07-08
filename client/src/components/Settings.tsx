import { useEffect, useState } from 'react';
import { api } from '../api';

const LABELS: Record<number, string> = {
  8000: 'Sehr sparsam',
  12000: 'Sparsam',
  16000: 'Niedrig',
  24000: 'Standard',
  32000: 'Gut',
  48000: 'Hoch',
  64000: 'Sehr hoch',
};

export function Settings({
  bitrate,
  onBitrate,
  onClose,
  onLogout,
}: {
  bitrate: number;
  onBitrate: (b: number) => void;
  onClose: () => void;
  onLogout: () => void;
}) {
  const [allowed, setAllowed] = useState<number[]>([8000, 12000, 16000, 24000, 32000, 48000, 64000]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getSettings().then((s) => setAllowed(s.allowedBitrates)).catch(() => {});
  }, []);

  const choose = async (b: number) => {
    setSaving(true);
    try {
      await api.setBitrate(b);
      onBitrate(b);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Einstellungen</h2>

        <div className="section-label" style={{ padding: '0 0 6px' }}>Audioqualität &amp; Bandbreite</div>
        <p className="li-sub" style={{ marginBottom: 12 }}>
          Höhere Qualität klingt besser, verbraucht aber mehr Datenvolumen. Für unterwegs oder schwaches Netz
          empfiehlt sich „Sparsam".
        </p>
        {allowed.map((b) => (
          <div className="row" key={b}>
            <div>
              <div>{LABELS[b] ?? `${b / 1000} kbit/s`}</div>
              <div className="li-sub">≈ {(b / 1000).toFixed(0)} kbit/s · {(b / 8000).toFixed(1)} KB/s</div>
            </div>
            <button
              className={`pill ${bitrate === b ? 'selected' : ''}`}
              disabled={saving}
              onClick={() => choose(b)}
            >
              {bitrate === b ? '✓ Aktiv' : 'Wählen'}
            </button>
          </div>
        ))}

        <button className="btn" style={{ marginTop: 18 }} onClick={onClose}>Fertig</button>
        <button className="btn secondary" style={{ marginTop: 10 }} onClick={onLogout}>Abmelden</button>
      </div>
    </div>
  );
}
