import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Project,
  Conversation,
  Message,
  Task,
  Memory,
  Artifact,
  Approval,
  Run,
} from '../shared.js';

export interface Entities {
  project: Project;
  conversation: Conversation;
  message: Message;
  task: Task;
  memory: Memory;
  artifact: Artifact;
  approval: Approval;
  run: Run;
}
export type Kind = keyof Entities;
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export class Store {
  readonly db: DatabaseSync;
  private listeners = new Set<(event: { id: number; type: string; data: unknown }) => void>();
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'menki.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, conversation TEXT NOT NULL, body TEXT NOT NULL, response TEXT NOT NULL); `);
  }
  all<K extends Kind>(kind: K): Entities[K][] {
    return this.db
      .prepare('SELECT data FROM entities WHERE kind=? ORDER BY rowid')
      .all(kind)
      .map((row) => JSON.parse(row.data as string));
  }
  get<K extends Kind>(kind: K, key: string): Entities[K] {
    const row = this.db.prepare('SELECT data FROM entities WHERE kind=? AND id=?').get(kind, key);
    if (!row) throw Object.assign(new Error('Élément introuvable.'), { statusCode: 404 });
    return JSON.parse(row.data as string);
  }
  put<K extends Kind>(kind: K, value: Entities[K]): Entities[K] {
    this.db
      .prepare(
        'INSERT INTO entities(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data',
      )
      .run(kind, value.id, JSON.stringify(value));
    this.event(kind, value);
    return value;
  }
  patch<K extends Kind>(kind: K, key: string, changes: Partial<Entities[K]>): Entities[K] {
    return this.put(kind, { ...this.get(kind, key), ...changes });
  }
  remove(kind: Kind, key: string) {
    this.db.prepare('DELETE FROM entities WHERE kind=? AND id=?').run(kind, key);
    this.event('deleted', { kind, id: key });
  }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  event(type: string, data: unknown) {
    const result = this.db
      .prepare('INSERT INTO events(type,data,at) VALUES(?,?,?)')
      .run(type, JSON.stringify(data), now());
    const event = { id: Number(result.lastInsertRowid), type, data };
    // Notify after synchronous transaction commits.
    queueMicrotask(() => {
      for (const listener of this.listeners) listener(event);
    });
  }
  eventsAfter(after: number) {
    return this.db
      .prepare('SELECT id,type,data FROM events WHERE id>? ORDER BY id LIMIT 1000')
      .all(after)
      .map((row) => ({
        id: Number(row.id),
        type: row.type as string,
        data: JSON.parse(row.data as string),
      }));
  }
  subscribe(fn: (event: { id: number; type: string; data: unknown }) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  setting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(row.value as string) : fallback;
  }
  setSetting(key: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
    this.event('settings', { key, value });
  }
  async backup(destination: string) {
    await backup(this.db, destination);
  }
  close() {
    this.db.close();
  }
}
