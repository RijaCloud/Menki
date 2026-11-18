import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowUp,
  Plus,
  PanelLeft,
  Folder,
  MessageSquare,
  Check,
  ChevronRight,
  X,
  Mic,
  Volume2,
  VolumeX,
  Square,
  ClipboardList,
  Brain,
  Files,
  Settings,
  MoreHorizontal,
  ArrowUpRight,
  Download,
  RotateCcw,
  LoaderCircle,
  Shield,
  Code2,
  FlaskConical,
  Compass,
  Terminal,
  Radio,
} from 'lucide-react';
import { api, recordWave, connected } from './api.js';
import { VoiceSettings } from './voice-settings.js';
import { VoiceSession, pause, voicePhaseLabels, type VoicePhase } from './voice-session.js';
import { captureUtterance } from './voice-capture.js';
import { playSpeech } from './voice-playback.js';
import {
  labels,
  roleLabels,
  type Snapshot,
  type Project,
  type Message,
  type Role,
  type VoiceOutputSettings,
} from '../shared.js';
import './style.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';

type Panel = 'tasks' | 'memory' | 'files' | 'settings' | null;
const icons = {
  manager: MessageSquare,
  developer: Code2,
  reviewer: FlaskConical,
  researcher: Compass,
  devops: Terminal,
};
function App() {
  const [data, setData] = useState<Snapshot>();
  const [selected, setSelected] = useState(
    new URLSearchParams(location.search).get('conversation') ??
      localStorage.getItem('menki.conversation') ??
      '',
  );
  const [panel, setPanel] = useState<Panel>(null);
  const [rail, setRail] = useState(innerWidth > 850);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [projectForm, setProjectForm] = useState(false);
  const [taskForm, setTaskForm] = useState(false);
  const [recording, setRecording] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>('off');
  const [eventState, setEventState] = useState('connecting');
  const [activity, setActivity] = useState('');
  const stopRecording = useRef<(() => Promise<string>) | null>(null);
  const speechAbort = useRef<AbortController | null>(null);
  const voiceSession = useRef<VoiceSession | null>(null);
  const voiceContext = useRef('');
  const latestData = useRef(data);
  latestData.current = data;
  const voiceConversation = useRef<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const pendingSend = useRef<{ id: string; text: string; conversationId: string } | null>(null);
  const spoken = useRef(new Set<string>());
  const currentConversation = useRef('');
  const reload = useCallback(async () => {
    try {
      setData(await api<Snapshot>('/snapshot'));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  const conversation =
    data?.conversations.find((c) => c.id === selected) ??
    data?.conversations.find((c) => !c.projectId);
  const project = data?.projects.find((p) => p.id === conversation?.projectId);
  const currentTask = data?.tasks.find((t) => t.id === conversation?.taskId);
  currentConversation.current = conversation?.id ?? '';
  const messages = data?.messages.filter((m) => m.conversationId === conversation?.id) ?? [];
  const runs =
    data?.runs.filter(
      (r) => r.conversationId === conversation?.id && ['running', 'queued'].includes(r.state),
    ) ?? [];
  const active = runs.find((r) => r.state === 'running');
  const tasks = data?.tasks.filter((t) => !project || t.projectId === project.id) ?? [];
  const approvals =
    data?.approvals.filter((a) => a.conversationId === conversation?.id && a.state === 'pending') ??
    [];
  const previousApprovals =
    data?.approvals.filter((a) => a.conversationId === conversation?.id && a.state !== 'pending') ??
    [];
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    let canceled = false;
    let close = () => {};
    void connected
      .then(() => {
        if (canceled) return;
        const events = new EventSource('/api/events');
        events.onopen = () => setEventState('ready');
        events.onerror = () => setEventState('reconnecting');
        events.onmessage = (event) => {
          const item = JSON.parse(event.data);
          if (item.type === 'activity' && item.data.conversationId === currentConversation.current)
            setActivity(
              item.data.type === 'webSearch' ? 'Recherche sur le Web…' : 'L’équipe travaille…',
            );
          if (item.type === 'tool' && item.data.conversationId === currentConversation.current)
            setActivity(
              (
                {
                  write_file: 'Écriture des fichiers…',
                  read_file: 'Lecture du projet…',
                  run_checks: 'Vérifications en cours…',
                  create_task: 'Création du ticket…',
                  document: 'Préparation du document…',
                  start_task: 'Délégation à un agent…',
                } as Record<string, string>
              )[item.data.name] ?? 'Analyse en cours…',
            );
          if (
            item.type === 'notification' &&
            'Notification' in window &&
            Notification.permission === 'granted' &&
            document.visibilityState !== 'visible'
          ) {
            const notice = new Notification(item.data.title, { body: item.data.body });
            notice.onclick = () => {
              window.focus();
              if (item.data.conversationId) setSelected(item.data.conversationId);
            };
          }
          if (!scheduled)
            scheduled = setTimeout(() => {
              scheduled = undefined;
              void reload();
            }, 100);
        };
        close = () => {
          events.close();
          clearTimeout(scheduled);
        };
      })
      .catch((e) => setError((e as Error).message));
    return () => {
      canceled = true;
      close();
    };
  }, [reload]);
  useEffect(() => {
    if (conversation) localStorage.setItem('menki.conversation', conversation.id);
  }, [conversation?.id]);
  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' });
  }, [messages.at(-1)?.body, messages.length]);
  async function action(fn: () => Promise<unknown>) {
    setError('');
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function openConversation(key: string) {
    stopVoice();
    mute();
    setSelected(key);
    setInput('');
    setActivity('');
    if (innerWidth < 850) setRail(false);
  }
  function openProject(p: Project) {
    const c = data?.conversations.find((c) => c.projectId === p.id && !c.taskId);
    if (c) openConversation(c.id);
  }
  async function send(text = input) {
    if (!text.trim() || !conversation || sending) return;
    stopVoice();
    setSending(true);
    setError('');
    try {
      if (currentTask) await api('/tasks/' + currentTask.id + '/start', { feedback: text });
      else {
        const previous = pendingSend.current;
        const request =
          previous?.text === text && previous.conversationId === conversation.id
            ? previous
            : { id: crypto.randomUUID(), text, conversationId: conversation.id };
        pendingSend.current = request;
        await api('/messages', { conversationId: conversation.id, text, requestId: request.id });
        pendingSend.current = null;
      }
      setInput('');
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  function mute() {
    speechAbort.current?.abort();
    speechAbort.current = null;
    setSpeaking(false);
  }
  async function speak(text: string) {
    mute();
    const controller = new AbortController();
    speechAbort.current = controller;
    setSpeaking(true);
    try {
      await playSpeech(text, String(data?.settings.culture ?? 'fr-FR'), controller.signal);
    } catch (e) {
      if (speechAbort.current === controller) {
        if ((e as Error).name !== 'AbortError') setError((e as Error).message);
      }
    } finally {
      if (speechAbort.current === controller) {
        speechAbort.current = null;
        setSpeaking(false);
      }
    }
  }
  useEffect(() => {
    // Loading history is not a request to regenerate (and bill) its last audio.
    if (!data || !conversation) return;
    if (voiceConversation.current !== conversation.id) {
      voiceConversation.current = conversation.id;
      for (const message of messages) {
        if (message.state !== 'streaming') spoken.current.add(message.id);
      }
      return;
    }
    const latest = messages
      .filter((m) => m.role === 'assistant' && m.state === 'complete' && m.body)
      .at(-1);
    if (!latest || spoken.current.has(latest.id)) return;
    spoken.current.add(latest.id);
    if (!voiceSession.current?.active && data?.settings.voice) void speak(latest.body);
  }, [conversation?.id, messages.at(-1)?.id, messages.at(-1)?.state]);
  function stopVoice() {
    voiceSession.current?.stop();
    voiceSession.current = null;
  }
  function toggleVoice() {
    if (voiceSession.current?.active) {
      stopVoice();
      return;
    }
    setError('');
    if (!conversation || data?.connection.state !== 'ready' || eventState !== 'ready') {
      setError('Attends que Menki et Codex soient connectés avant de parler.');
      return;
    }
    if (input.trim()) {
      setError('Envoie ou efface ton brouillon avant de démarrer la conversation vocale.');
      return;
    }
    const settings = data.settings.voiceOutput as VoiceOutputSettings;
    if (
      settings.provider !== 'elevenlabs' ||
      !settings.keyConfigured ||
      !settings.voiceId ||
      !settings.cloudEnabled
    ) {
      setError('Configure et active une voix ElevenLabs dans les préférences avant de démarrer.');
      return;
    }
    mute();
    const target = conversation.id;
    const taskId = currentTask?.id;
    const culture = String(data.settings.culture ?? 'fr-FR');
    voiceContext.current = target;
    const session = new VoiceSession({
      capture: captureUtterance,
      transcribe: async (audio, signal) =>
        (await api<{ text: string }>('/voice/recognize', { audio, culture }, 'POST', signal)).text,
      transcript: setInput,
      submit: async (text, requestId, signal) => {
        if (currentConversation.current !== target)
          throw new Error('La conversation a changé. Relance l’oral dans ce fil.');
        const result = await api<{ runId: string }>(
          taskId ? '/tasks/' + taskId + '/start' : '/messages',
          taskId
            ? { feedback: text, requestId, voice: true }
            : { conversationId: target, text, requestId, voice: true },
          'POST',
          signal,
        );
        if (!result.runId)
          throw new Error('Le message n’a pas pu être suivi. Vérifie le fil avant de réessayer.');
        if (!signal.aborted) setInput('');
        await reload();
        return result.runId;
      },
      reply: async (runId, signal) => {
        const until = Date.now() + 10 * 60 * 1000;
        while (!signal.aborted && Date.now() < until) {
          const snapshot = latestData.current;
          const run = snapshot?.runs.find((r) => r.id === runId);
          const message = snapshot?.messages.find(
            (m) => m.runId === runId && m.role === 'assistant',
          );
          if (run?.state === 'failed' || run?.state === 'interrupted')
            throw new Error(run.error ?? 'Le travail a été interrompu.');
          if (run?.state === 'completed' && message?.state === 'complete') {
            spoken.current.add(message.id);
            return message.body;
          }
          await pause(200, signal);
        }
        if (signal.aborted) throw new DOMException('Conversation arrêtée.', 'AbortError');
        throw new Error('Le travail continue dans le ticket. La conversation vocale est en pause.');
      },
      play: (text, signal) => playSpeech(text, culture, signal),
      phase: setVoicePhase,
      error: (message) =>
        setError(
          message.includes('Permission') || message.includes('denied')
            ? 'Autorise le microphone dans ton navigateur, puis clique sur Parler avec Menki.'
            : message,
        ),
    });
    voiceSession.current = session;
    void session.start();
  }
  useEffect(() => {
    if (voiceSession.current?.active && conversation?.id !== voiceContext.current) stopVoice();
  }, [conversation?.id]);
  useEffect(() => {
    const stop = () => {
      voiceSession.current?.stop();
      speechAbort.current?.abort();
    };
    const hidden = () => {
      if (document.hidden) stop();
    };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', stop);
    window.addEventListener('offline', stop);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', stop);
      window.removeEventListener('offline', stop);
    };
  }, []);
  useEffect(() => {
    if (eventState !== 'ready' && voiceSession.current?.active) {
      stopVoice();
      setError(
        'Connexion au service interrompue. Le fil est conservé ; relance l’oral une fois reconnecté.',
      );
    }
  }, [eventState]);
  async function microphone() {
    stopVoice();
    setError('');
    if (recording && stopRecording.current) {
      setRecording(false);
      setVoiceBusy(true);
      try {
        const audio = await stopRecording.current();
        stopRecording.current = null;
        const result = await api<{ text: string }>('/voice/recognize', {
          audio,
          culture: data?.settings.culture ?? 'fr-FR',
        });
        if (!result.text.trim())
          throw new Error('Aucun mot reconnu. Réessaie en parlant près du microphone.');
        setInput((s) => s + (s ? ' ' : '') + result.text);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setVoiceBusy(false);
      }
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stopRecording.current = await recordWave(stream);
      setRecording(true);
      setTimeout(() => {
        if (stopRecording.current) document.querySelector<HTMLButtonElement>('[data-mic]')?.click();
      }, 25000);
    } catch {
      setError('Autorise le microphone dans ton navigateur pour dicter un message.');
    }
  }
  const liveCount = data?.runs.filter((r) => r.state === 'running').length ?? 0;
  const title = conversation?.title ?? 'Ton assistant';
  return (
    <div className={'app ' + (!rail ? 'rail-closed' : '')}>
      {rail && (
        <aside className="rail">
          <button
            className="brand"
            onClick={() => {
              const c = data?.conversations.find((c) => !c.projectId);
              if (c) openConversation(c.id);
            }}
          >
            <span className="monogram">
              m<span />
            </span>
            <span>menki</span>
            <span className="local-label">LOCAL</span>
          </button>
          <button
            className={'nav-item ' + (!project ? 'selected' : '')}
            onClick={() => {
              const c = data?.conversations.find((c) => !c.projectId);
              if (c) openConversation(c.id);
            }}
          >
            <MessageSquare size={17} /> Ton assistant
          </button>
          <div className="section-title">
            <span>PROJETS</span>
            <button className="icon" title="Ajouter un projet" onClick={() => setProjectForm(true)}>
              <Plus size={16} />
            </button>
          </div>
          <nav className="projects">
            {data?.projects.map((p) => (
              <button
                key={p.id}
                className={'nav-item ' + (project?.id === p.id ? 'selected' : '')}
                onClick={() => openProject(p)}
              >
                <span className={'project-icon ' + p.kind}>
                  {p.kind === 'code' ? <Code2 size={15} /> : <Compass size={15} />}
                </span>
                <span>{p.name}</span>
                {data.tasks.some((t) => t.projectId === p.id && t.state === 'running') && (
                  <span className="tiny-pulse" />
                )}
              </button>
            ))}
          </nav>
          {project && (
            <>
              <div className="section-title">
                <span>CONVERSATIONS</span>
                <button
                  className="icon"
                  title="Nouvelle conversation"
                  onClick={() =>
                    void action(async () => {
                      const c = await api<{ id: string }>('/conversations', {
                        projectId: project.id,
                        title: 'Nouvelle conversation',
                      });
                      openConversation(c.id);
                    })
                  }
                >
                  <Plus size={15} />
                </button>
              </div>
              <nav className="conversations">
                {data?.conversations
                  .filter((c) => c.projectId === project.id && !c.taskId)
                  .slice(-8)
                  .map((c) => (
                    <button
                      key={c.id}
                      onClick={() => openConversation(c.id)}
                      className={conversation?.id === c.id ? 'chosen' : ''}
                    >
                      <MessageSquare size={13} />
                      <span>{c.title}</span>
                    </button>
                  ))}
              </nav>
            </>
          )}
          <div className="rail-bottom">
            <div className="machine">
              <span
                className={'connection-dot ' + (data?.connection.state === 'ready' ? 'online' : '')}
              />
              <span>Sur cet ordinateur</span>
              <span className="keycap">PC</span>
            </div>
            <button
              className="nav-item"
              onClick={() => setPanel(panel === 'settings' ? null : 'settings')}
            >
              <Settings size={16} /> Préférences
            </button>
            <div className="owner">
              <span className="owner-avatar">R</span>
              <span>
                Ton espace personnel
                <small>
                  {liveCount
                    ? liveCount + ' agent' + (liveCount > 1 ? 's' : '') + ' au travail'
                    : 'Prêt à t’aider'}
                </small>
              </span>
            </div>
          </div>
        </aside>
      )}
      <main className="main">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon"
              title="Afficher ou masquer les projets"
              onClick={() => setRail((s) => !s)}
            >
              <PanelLeft size={18} />
            </button>
            <span className="divider" />
            {project ? (
              <>
                <Folder size={15} />
                <button onClick={() => openProject(project)}>{project.name}</button>
                <ChevronRight size={13} />
                <span>{currentTask ? 'Ticket' : title}</span>
              </>
            ) : (
              <span>Ton assistant</span>
            )}
          </div>
          <div className="top-actions">
            <span
              className={'connection-text ' + (data?.connection.state === 'ready' ? '' : 'muted')}
            >
              <span
                className={'connection-dot ' + (data?.connection.state === 'ready' ? 'online' : '')}
              />
              {eventState === 'reconnecting'
                ? 'Reconnexion…'
                : data?.connection.state === 'ready'
                  ? 'Codex connecté'
                  : 'Connexion à Codex…'}
            </span>
            <button
              className={'top-tool ' + (panel === 'tasks' ? 'on' : '')}
              title="Ouvrir les tickets"
              onClick={() => setPanel(panel === 'tasks' ? null : 'tasks')}
            >
              <ClipboardList size={16} />
              <span>Tickets</span>
              {tasks.filter((t) => t.state !== 'done').length > 0 && (
                <b>{tasks.filter((t) => t.state !== 'done').length}</b>
              )}
            </button>
            <button
              className="icon"
              title="Ouvrir les détails"
              onClick={() => setPanel(panel === 'memory' ? null : 'memory')}
            >
              <MoreHorizontal size={21} />
            </button>
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button className="icon" onClick={() => setError('')}>
              <X size={15} />
            </button>
          </div>
        )}
        {data?.connection.state === 'error' && (
          <div className="connection-error">
            <p>{data.connection.error}</p>
            <button onClick={() => void action(() => api('/connection/retry', {}))}>
              <RotateCcw size={14} /> Revérifier Codex
            </button>
          </div>
        )}
        <div className="conversation" ref={scroll}>
          {!messages.length && (
            <div className="welcome">
              <div className="assistant-symbol">
                <span />
                <span />
                <span />
              </div>
              <h1>{project ? 'On avance sur ' + project.name + ' ?' : 'Bonjour Rija.'}</h1>
              <p>
                {project
                  ? 'Dis-moi ce que tu veux faire. Je m’occupe de l’organiser.'
                  : 'Qu’est-ce qu’on fait aujourd’hui ?'}
              </p>
              <div className="suggestions">
                {(project?.kind === 'code'
                  ? [
                      'Crée et lance un ticket pour une petite application de notes en HTML/CSS/JS avec des tests Node.',
                      'Explore le projet et propose les prochaines étapes.',
                    ]
                  : project?.kind === 'personal'
                    ? [
                        'Cherche trois outils gratuits de prise de notes sur leurs sites officiels et prépare un PDF comparatif.',
                        'Aide-moi à organiser mes priorités de la semaine.',
                      ]
                    : ['Où en sommes-nous sur mes projets ?', 'Quels tickets ont besoin de moi ?']
                ).map((s, i) => (
                  <button key={s} onClick={() => setInput(s)}>
                    <span>{i === 0 ? <Compass size={15} /> : <ClipboardList size={15} />}</span>
                    {s}
                    <ArrowUpRight size={14} />
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="thread">
            {messages.map((m) => (
              <MessageView
                key={m.id}
                message={m}
                role={
                  data?.runs.find((r) => r.id === m.runId)?.role ?? conversation?.role ?? 'manager'
                }
                onSpeak={() => {
                  stopVoice();
                  void speak(m.body);
                }}
                onRetry={() => m.runId && void action(() => api('/runs/' + m.runId + '/retry', {}))}
              />
            ))}
            {previousApprovals.map((a) => (
              <div className="task-context" key={a.id}>
                <Shield size={14} />
                <span>{a.description}</span>
                <span className="status">
                  {a.state === 'approved'
                    ? 'Accord enregistré'
                    : a.state === 'denied'
                      ? 'Refusée'
                      : 'Expirée au redémarrage'}
                </span>
              </div>
            ))}
            {approvals.map((a) => (
              <div className="approval" key={a.id}>
                <Shield size={19} />
                <div>
                  <strong>Ton accord est nécessaire</strong>
                  <p>{a.description}</p>
                  <details>
                    <summary>Détails</summary>
                    <pre>{a.details}</pre>
                  </details>
                  <div className="row">
                    <button
                      onClick={() =>
                        void action(() => api('/approvals/' + a.id + '/answer', { approve: false }))
                      }
                    >
                      Refuser
                    </button>
                    <button
                      className="primary"
                      onClick={() =>
                        void action(() => api('/approvals/' + a.id + '/answer', { approve: true }))
                      }
                    >
                      Enregistrer mon accord
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {(active || runs.some((r) => r.state === 'queued')) && (
              <div className="working">
                <span className="working-dot" />
                <span>{active ? activity || 'Menki réfléchit…' : 'Dans la file de travail…'}</span>
              </div>
            )}
            {currentTask && (
              <div className="task-context">
                <span className={'status ' + currentTask.state}>{labels[currentTask.state]}</span>
                <span>{currentTask.title}</span>
                {currentTask.preview && (
                  <a href={currentTask.preview} target="_blank" rel="noreferrer">
                    <ArrowUpRight size={14} /> Voir le résultat
                  </a>
                )}
                {currentTask.state === 'qa' && (
                  <button
                    className="primary"
                    onClick={() =>
                      void action(() => api('/tasks/' + currentTask.id, { state: 'done' }, 'PATCH'))
                    }
                  >
                    <Check size={14} /> Terminer le ticket
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="compose-wrap">
          <div className={'voice-conversation ' + (voicePhase !== 'off' ? 'is-active' : '')}>
            {voicePhase === 'off' ? (
              <button
                type="button"
                onClick={toggleVoice}
                disabled={recording || voiceBusy || sending || runs.length > 0}
              >
                <Radio size={16} /> Parler avec Menki
              </button>
            ) : (
              <>
                <span role="status" aria-live="polite">
                  <span className={'voice-indicator ' + voicePhase} />
                  {voicePhaseLabels[voicePhase]}
                </span>
                <button type="button" onClick={stopVoice}>
                  <Square size={12} /> Quitter l’oral
                </button>
              </>
            )}
          </div>
          <form
            className={'composer ' + (recording ? 'recording' : '')}
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              aria-label="Message à Menki"
              placeholder={
                recording
                  ? 'Je t’écoute…'
                  : currentTask
                    ? 'Ton retour, une correction, une question…'
                    : 'Demande quelque chose à Menki…'
              }
              value={input}
              disabled={voicePhase !== 'off'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={2}
            />
            <div className="composer-footer">
              <div className="composer-left">
                <span className="mini-logo">m</span>
                <span>
                  {currentTask ? roleLabels[conversation?.role ?? 'manager'] : 'Menki'}
                  <small> · {data?.connection.model ?? 'Codex'}</small>
                </span>
              </div>
              <div className="row">
                <button
                  className={'icon ' + (speaking ? 'on' : '')}
                  type="button"
                  title={
                    voicePhase !== 'off'
                      ? 'Quitter la conversation vocale'
                      : speaking
                        ? 'Couper la lecture'
                        : 'Activer ou couper la lecture automatique'
                  }
                  onClick={() => {
                    if (voiceSession.current?.active) {
                      stopVoice();
                      return;
                    }
                    if (speaking) mute();
                    void action(() => api('/settings', { voice: !data?.settings.voice }));
                  }}
                >
                  {data?.settings.voice || speaking || voicePhase === 'speaking' ? (
                    <Volume2 size={17} />
                  ) : (
                    <VolumeX size={17} />
                  )}
                </button>
                <button
                  className={'icon ' + (recording ? 'mic-active' : '')}
                  type="button"
                  data-mic
                  title={recording ? 'Arrêter la dictée' : 'Dicter un message'}
                  onClick={() => void microphone()}
                  disabled={voiceBusy || voicePhase !== 'off'}
                >
                  {voiceBusy ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : recording ? (
                    <Square size={15} />
                  ) : (
                    <Mic size={17} />
                  )}
                </button>
                {active ? (
                  <button
                    className="send stop"
                    type="button"
                    title="Arrêter le travail"
                    onClick={() => void action(() => api('/runs/' + active.id + '/stop', {}))}
                  >
                    <Square size={15} />
                  </button>
                ) : (
                  <button
                    className="send"
                    title="Envoyer"
                    type="submit"
                    disabled={!input.trim() || sending || voicePhase !== 'off'}
                  >
                    {sending ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={19} />}
                  </button>
                )}
              </div>
            </div>
          </form>
          <div className="compose-note">
            {voicePhase !== 'off'
              ? 'Envoi après une pause · micro fermé pendant la réponse · les tickets continuent si tu quittes l’oral.'
              : recording
                ? 'Clique sur le carré pour terminer. Le texte apparaîtra avant envoi.'
                : project
                  ? 'Autonome dans ce projet · les actions sensibles te sont proposées.'
                  : 'Tes projets et conversations restent sur ce PC.'}
          </div>
        </div>
      </main>
      {panel && (
        <aside className="inspector">
          <header>
            <div className="row">
              {panel === 'tasks' ? (
                <ClipboardList size={17} />
              ) : panel === 'memory' ? (
                <Brain size={17} />
              ) : panel === 'files' ? (
                <Files size={17} />
              ) : (
                <Settings size={17} />
              )}
              <strong>
                {
                  {
                    tasks: 'Tickets',
                    memory: 'Mémoire du projet',
                    files: 'Documents',
                    settings: 'Préférences',
                  }[panel]
                }
              </strong>
            </div>
            <button className="icon" onClick={() => setPanel(null)} title="Fermer le panneau">
              <X size={17} />
            </button>
          </header>
          <div className="inspector-tabs">
            <button
              onClick={() => setPanel('tasks')}
              className={panel === 'tasks' ? 'selected' : ''}
            >
              Tickets
            </button>
            <button
              onClick={() => setPanel('memory')}
              className={panel === 'memory' ? 'selected' : ''}
            >
              Mémoire
            </button>
            <button
              onClick={() => setPanel('files')}
              className={panel === 'files' ? 'selected' : ''}
            >
              Fichiers
            </button>
          </div>
          <div className="inspector-content">
            {panel === 'tasks' && (
              <>
                <div className="panel-heading">
                  <span>{project?.name ?? 'Tous les projets'}</span>
                  {project && (
                    <button
                      className="icon"
                      title="Créer un ticket"
                      onClick={() => setTaskForm(true)}
                    >
                      <Plus size={17} />
                    </button>
                  )}
                </div>
                {!tasks.length && (
                  <div className="empty">
                    <ClipboardList size={27} />
                    <p>
                      Les prochaines étapes
                      <br />
                      prendront place ici.
                    </p>
                    <small>Demande à Menki de créer une tâche.</small>
                  </div>
                )}
                {(['running', 'needs_input', 'blocked', 'qa', 'queued', 'done'] as const).map(
                  (state) => {
                    const list = tasks.filter((t) => t.state === state);
                    return (
                      list.length > 0 && (
                        <section key={state} className="task-group">
                          <h3>
                            <span className={'state-dot ' + state} />
                            {labels[state]}
                            <small>{list.length}</small>
                          </h3>
                          {list.map((t) => (
                            <article key={t.id} className="task-card">
                              <div className="task-meta">
                                {!project && (
                                  <span>
                                    {data?.projects.find((p) => p.id === t.projectId)?.name}
                                  </span>
                                )}
                                <select
                                  aria-label={'Priorité de ' + t.title}
                                  value={t.priority}
                                  onChange={(e) =>
                                    void action(() =>
                                      api(
                                        '/tasks/' + t.id,
                                        { priority: Number(e.target.value) },
                                        'PATCH',
                                      ),
                                    )
                                  }
                                >
                                  <option value={0}>Haute</option>
                                  <option value={1}>Normale</option>
                                  <option value={2}>Basse</option>
                                </select>
                              </div>
                              <button
                                className="task-title"
                                onClick={() => openConversation(t.conversationId)}
                              >
                                {t.title}
                                <ChevronRight size={15} />
                              </button>
                              {t.summary && <p>{t.summary.replace(/[#*`]/g, '').slice(0, 160)}</p>}
                              <div className="task-buttons">
                                <button onClick={() => openConversation(t.conversationId)}>
                                  <MessageSquare size={13} /> Ouvrir
                                </button>
                                {['queued', 'blocked', 'needs_input'].includes(t.state) && (
                                  <button
                                    className="primary"
                                    onClick={() =>
                                      void action(() => api('/tasks/' + t.id + '/start', {}))
                                    }
                                  >
                                    {t.state === 'queued' ? 'Lancer' : 'Reprendre'}
                                    <ArrowUpRight size={13} />
                                  </button>
                                )}
                                {t.state === 'qa' && (
                                  <button
                                    className="primary"
                                    onClick={() =>
                                      void action(() =>
                                        api('/tasks/' + t.id, { state: 'done' }, 'PATCH'),
                                      )
                                    }
                                  >
                                    <Check size={13} /> Terminer
                                  </button>
                                )}
                              </div>
                              {t.preview && (
                                <a
                                  className="preview-link"
                                  href={t.preview}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  <ArrowUpRight size={13} /> Voir le résultat
                                </a>
                              )}
                              <details>
                                <summary>Détails</summary>
                                <p>{t.description}</p>
                                {t.branch && <code>{t.branch}</code>}
                                {t.checks && <pre>{t.checks}</pre>}
                              </details>
                            </article>
                          ))}
                        </section>
                      )
                    );
                  },
                )}
              </>
            )}
            {panel === 'memory' && (
              <>
                <p className="panel-intro">
                  Les décisions qui suivent ton projet, même quand tu changes de ticket.
                </p>
                {!project ? (
                  <p className="muted">Ouvre un projet pour consulter sa mémoire.</p>
                ) : (
                  <>
                    <button
                      className="secondary full"
                      onClick={() => {
                        const text = prompt('Quelle décision veux-tu garder ?');
                        if (text)
                          void action(() => api('/memories', { projectId: project.id, text }));
                      }}
                    >
                      <Plus size={15} /> Ajouter une décision
                    </button>
                    {data?.memories
                      .filter((m) => m.projectId === project.id)
                      .map((m) => (
                        <div className="memory" key={m.id}>
                          <p>{m.text}</p>
                          <small>
                            {m.source === 'owner' ? 'Ajoutée par toi' : 'Issue d’une conversation'}
                          </small>
                          <div className="row">
                            <button
                              onClick={() => {
                                const text = prompt('Modifier la décision', m.text);
                                if (text)
                                  void action(() => api('/memories/' + m.id, { text }, 'PATCH'));
                              }}
                            >
                              Modifier
                            </button>
                            <button
                              onClick={() =>
                                void action(() => api('/memories/' + m.id, undefined, 'DELETE'))
                              }
                            >
                              Supprimer
                            </button>
                          </div>
                        </div>
                      ))}
                    <div className="folder-info">
                      <h3>Dossiers autorisés</h3>
                      {project.roots.map((r) => (
                        <code key={r}>{r}</code>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
            {panel === 'files' && (
              <>
                {!data?.artifacts.filter((a) => !project || a.projectId === project.id).length && (
                  <div className="empty">
                    <Files size={27} />
                    <p>Tes documents apparaîtront ici.</p>
                    <small>Tu peux demander un PDF à Menki.</small>
                  </div>
                )}
                {data?.artifacts
                  .filter((a) => !project || a.projectId === project.id)
                  .map((a) => (
                    <a className="artifact" key={a.id} href={'/api/artifacts/' + a.id}>
                      <span className="file-type">{a.kind.toUpperCase()}</span>
                      <span>
                        {a.name}
                        <small>{data.projects.find((p) => p.id === a.projectId)?.name}</small>
                      </span>
                      <Download size={16} />
                    </a>
                  ))}
              </>
            )}
            {panel === 'settings' && <SettingsPanel data={data} action={action} />}
          </div>
        </aside>
      )}
      {projectForm && (
        <ProjectForm
          onClose={() => setProjectForm(false)}
          onSave={async (value) => {
            const p = await api<Project>('/projects', value);
            const snapshot = await api<Snapshot>('/snapshot');
            setData(snapshot);
            setProjectForm(false);
            const c = snapshot.conversations.find((c) => c.projectId === p.id && !c.taskId);
            if (c) openConversation(c.id);
          }}
        />
      )}
      {taskForm && project && (
        <TaskForm
          project={project}
          onClose={() => setTaskForm(false)}
          onSave={async (value) => {
            await api('/tasks', value);
            await reload();
            setTaskForm(false);
            setPanel('tasks');
          }}
        />
      )}
    </div>
  );
}
function MessageView({
  message,
  role,
  onSpeak,
  onRetry,
}: {
  message: Message;
  role: Role;
  onSpeak: () => void;
  onRetry: () => void;
}) {
  if (message.state === 'queued' && !message.body) return null;
  const Icon = icons[role];
  return (
    <article
      className={'message ' + message.role + ' ' + (message.state === 'error' ? 'failed' : '')}
    >
      <div className={'avatar ' + role}>
        {message.role === 'user' ? (
          'R'
        ) : message.role === 'system' ? (
          <Shield size={15} />
        ) : (
          <Icon size={16} />
        )}
      </div>
      <div className="message-content">
        <div className="message-heading">
          <strong>
            {message.role === 'user'
              ? 'Toi'
              : message.role === 'system'
                ? 'Menki · information'
                : roleLabels[role]}
          </strong>
          <time>
            {new Date(message.createdAt).toLocaleTimeString('fr-FR', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
          {message.state === 'streaming' && <span className="tiny-pulse" />}
        </div>
        <div className="markdown">
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              ),
            }}
          >
            {message.body.replace(/^\s*REVIEW_(?:APPROVED|CHANGES)\s*$/gm, '').trim()}
          </Markdown>
        </div>
        {message.role === 'assistant' && message.state !== 'streaming' && (
          <div className="message-controls">
            <button title="Écouter ce message" onClick={onSpeak}>
              <Volume2 size={13} />
            </button>
            {message.state === 'error' && (
              <button onClick={onRetry}>
                <RotateCcw size={13} /> Reprendre
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
function SettingsPanel({
  data,
  action,
}: {
  data?: Snapshot;
  action: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [models, setModels] = useState<{ id: string; name: string }[]>([]),
    [backup, setBackup] = useState('');
  useEffect(() => {
    void api<typeof models>('/models').then(setModels);
  }, []);
  return (
    <div className="settings">
      <label>
        Modèle Codex
        <select
          value={data?.connection.model ?? ''}
          onChange={(e) => void action(() => api('/settings', { model: e.target.value }))}
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Langue de la voix
        <select
          value={String(data?.settings.culture ?? 'fr-FR')}
          onChange={(e) => void action(() => api('/settings', { culture: e.target.value }))}
        >
          <option value="fr-FR">Français</option>
          <option value="en-US">English</option>
        </select>
      </label>
      <label className="toggle-label">
        <input
          type="checkbox"
          checked={!!data?.settings.voice}
          onChange={(e) => void action(() => api('/settings', { voice: e.target.checked }))}
        />{' '}
        Lire les réponses à voix haute
      </label>
      <VoiceSettings
        value={data?.settings.voiceOutput as VoiceOutputSettings | undefined}
        action={action}
      />
      <button onClick={() => void Notification.requestPermission()}>
        Activer les notifications
      </button>
      <button
        onClick={() =>
          void action(async () => {
            const b = await api<{ folder: string; files: number }>('/backup', {});
            setBackup('Sauvegarde vérifiée · ' + b.files + ' fichiers\n' + b.folder);
          })
        }
      >
        Sauvegarder et vérifier
      </button>
      {backup && <p className="backup-result">{backup}</p>}
      <div className="folder-info">
        <h3>Sur ton PC</h3>
        <p>
          Les conversations sont enregistrées dans ton profil Windows. Deux agents maximum
          travaillent à la fois.
        </p>
        <small>Codex {data?.connection.version}</small>
      </div>
    </div>
  );
}
function ProjectForm({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (value: unknown) => Promise<void>;
}) {
  const [name, setName] = useState(''),
    [description, setDescription] = useState(''),
    [kind, setKind] = useState('code'),
    [roots, setRoots] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Ajouter un projet"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2>Un nouvel espace</h2>
          <button className="icon" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <p>Un projet, ses dossiers et une équipe qui garde le fil.</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await onSave({
                name,
                description,
                kind,
                roots: roots
                  .split('\n')
                  .map((s) => s.trim())
                  .filter(Boolean),
                permissions: { write: true, checks: kind === 'code', web: true },
              });
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Nom
            <input
              autoFocus
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Mon projet"
            />
          </label>
          <label>
            Type
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="code">Développement</option>
              <option value="personal">Recherche et assistance personnelle</option>
            </select>
          </label>
          <label>
            Ce qu’on y fait
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Une phrase pour donner le contexte"
            />
          </label>
          <label>
            Dossiers sur le PC
            <textarea
              required
              value={roots}
              onChange={(e) => setRoots(e.target.value)}
              placeholder={'C:\\mes-projets\\mon-app\nUn dossier par ligne'}
              rows={3}
            />
          </label>
          <p className="fine-print">
            Tu autorises la lecture et les modifications dans ces dossiers, ainsi que les recherches
            Web.
          </p>
          {error && <p className="form-error">{error}</p>}
          <button className="primary full" disabled={busy}>
            {busy ? 'Création…' : 'Créer le projet'}
          </button>
        </form>
      </section>
    </div>
  );
}
function TaskForm({
  project,
  onClose,
  onSave,
}: {
  project: Project;
  onClose: () => void;
  onSave: (value: unknown) => Promise<void>;
}) {
  const [title, setTitle] = useState(''),
    [description, setDescription] = useState(''),
    [error, setError] = useState('');
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Créer un ticket"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2>Une nouvelle tâche</h2>
          <button className="icon" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <p>{project.name}</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await onSave({
                projectId: project.id,
                title,
                description,
                role: project.kind === 'code' ? 'developer' : 'researcher',
                priority: 1,
              });
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <label>
            Titre
            <input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            Résultat attendu
            <textarea
              required
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary full">Ajouter à la liste</button>
        </form>
      </section>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
