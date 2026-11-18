import { useState } from 'react';
import type { VoiceOutputSettings } from '../shared.js';
import { api } from './api.js';

export function VoiceSettings({
  value,
  action,
}: {
  value?: VoiceOutputSettings;
  action: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [provider, setProvider] = useState(value?.provider ?? 'windows');
  const [voiceId, setVoiceId] = useState(value?.voiceId ?? '');
  const [cloudEnabled, setCloudEnabled] = useState(value?.cloudEnabled ?? false);
  const [key, setKey] = useState('');
  const [voices, setVoices] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  async function save(removeKey = false) {
    setBusy(true);
    setNotice('');
    try {
      await action(async () => {
        await api('/voice/settings', {
          provider,
          voiceId,
          cloudEnabled: removeKey ? false : cloudEnabled,
          ...(key.trim() && !removeKey ? { apiKey: key.trim() } : {}),
          ...(removeKey ? { removeKey: true } : {}),
        });
        setKey('');
        if (removeKey) setCloudEnabled(false);
        setNotice(
          removeKey
            ? 'Clé supprimée. Lecture ElevenLabs désactivée.'
            : 'Réglages enregistrés. Aucun audio généré.',
        );
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="voice-settings" aria-label="Voix de Menki">
      <h3>Voix de Menki</h3>
      <label>
        Voix de lecture
        <select
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value as typeof provider);
            setNotice('');
          }}
        >
          <option value="windows">Windows · locale</option>
          <option value="elevenlabs">ElevenLabs · naturelle</option>
        </select>
      </label>
      {provider === 'elevenlabs' && (
        <>
          <p>
            Le texte lu est envoyé à ElevenLabs et consomme ton quota. La voix est générée par IA.
            La dictée reste sur ton PC.
          </p>
          <label>
            Clé API ElevenLabs
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              placeholder={
                value?.keyConfigured
                  ? 'Clé enregistrée · laisser vide pour la garder'
                  : 'Coller la clé ici'
              }
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <small>
            Chiffrée pour ton compte Windows, hors des projets et des sauvegardes. Elle n’est jamais
            réaffichée.
          </small>
          <button
            disabled={busy || !value?.keyConfigured}
            onClick={() =>
              void action(async () => {
                setVoices(await api<typeof voices>('/voice/voices'));
                setNotice('Voix chargées. Choisis une voix puis enregistre.');
              })
            }
          >
            Charger mes voix
          </button>
          {voices.length > 0 && (
            <label>
              Mes voix
              <select value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
                <option value="">Choisir une voix</option>
                {!voices.some((v) => v.id === voiceId) && voiceId && (
                  <option value={voiceId}>{voiceId}</option>
                )}
                {voices.map((v) => (
                  <option value={v.id} key={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Identifiant de voix
            <input
              value={voiceId}
              autoComplete="off"
              spellCheck={false}
              placeholder="Voice ID ElevenLabs"
              onChange={(e) => setVoiceId(e.target.value)}
            />
          </label>
          <label className="toggle-label">
            <input
              type="checkbox"
              checked={cloudEnabled}
              onChange={(e) => setCloudEnabled(e.target.checked)}
            />
            Autoriser l’envoi du texte à ElevenLabs pour la lecture
          </label>
          <small>
            Commence par enregistrer la clé, puis charge tes voix. L’écoute utilise le modèle
            Multilingual v2 et lit au maximum 3 000 caractères nettoyés. Un même texte est réutilisé
            en mémoire pendant cette session du service.
          </small>
        </>
      )}
      <button disabled={busy} onClick={() => void save()}>
        {busy ? 'Enregistrement…' : 'Enregistrer la voix'}
      </button>
      {provider === 'elevenlabs' && value?.keyConfigured && (
        <button disabled={busy} onClick={() => void save(true)}>
          Supprimer la clé
        </button>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
