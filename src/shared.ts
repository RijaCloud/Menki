export type Role = 'manager' | 'developer' | 'reviewer' | 'devops' | 'researcher';
export type TaskState = 'queued' | 'running' | 'needs_input' | 'blocked' | 'qa' | 'done';
export const labels: Record<TaskState, string> = {
  queued: 'En attente',
  running: 'En cours',
  needs_input: 'Besoin de toi',
  blocked: 'Bloqué',
  qa: 'À vérifier',
  done: 'Terminé',
};
export const roleLabels: Record<Role, string> = {
  manager: 'Menki',
  developer: 'Développement',
  reviewer: 'Vérification',
  devops: 'DevOps',
  researcher: 'Recherche & rédaction',
};
export interface Project {
  id: string;
  name: string;
  description: string;
  kind: 'code' | 'personal';
  roots: string[];
  permissions: { write: boolean; checks: boolean; web: boolean };
  createdAt: string;
}
export interface Conversation {
  id: string;
  projectId: string | null;
  taskId: string | null;
  title: string;
  threadId: string | null;
  role: Role;
  createdAt: string;
}
export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  body: string;
  state: 'queued' | 'streaming' | 'complete' | 'error';
  runId: string | null;
  createdAt: string;
}
export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  state: TaskState;
  priority: number;
  role: Role;
  conversationId: string;
  originConversationId?: string;
  branch: string | null;
  worktrees: { source: string; path: string }[];
  summary: string;
  checks: string;
  preview: string | null;
  reviewRound: number;
  reviewThreadId?: string;
  createdAt: string;
  updatedAt: string;
}
export interface Memory {
  id: string;
  projectId: string;
  text: string;
  source: string;
  createdAt: string;
}
export interface Artifact {
  id: string;
  projectId: string;
  taskId: string | null;
  name: string;
  path: string;
  kind: string;
  createdAt: string;
}
export interface Approval {
  id: string;
  runId: string;
  conversationId: string;
  kind: string;
  description: string;
  details: string;
  state: 'pending' | 'approved' | 'denied' | 'expired';
  createdAt: string;
}
export interface Run {
  id: string;
  conversationId: string;
  taskId: string | null;
  messageId: string;
  role: Role;
  voice?: boolean;
  state: 'queued' | 'running' | 'completed' | 'interrupted' | 'failed';
  threadId: string | null;
  turnId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface VoiceOutputSettings {
  provider: 'windows' | 'elevenlabs';
  voiceId: string;
  cloudEnabled: boolean;
  keyConfigured: boolean;
}
export interface Snapshot {
  projects: Project[];
  conversations: Conversation[];
  messages: Message[];
  tasks: Task[];
  memories: Memory[];
  artifacts: Artifact[];
  approvals: Approval[];
  runs: Run[];
  settings: Record<string, unknown>;
  connection: { state: string; model: string | null; version: string; error?: string };
}
