import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { orderBy } from "natural-orderby";

const DB_PATH =
  process.env.MCP_BRAIN_DB ??
  `${process.env.HOME}/.mcp-brain/brain.db`;

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  migrate(_db);
  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      name       TEXT PRIMARY KEY,
      states     TEXT NOT NULL DEFAULT '["pending","active","done","archived"]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project    TEXT NOT NULL REFERENCES projects(name),
      title      TEXT NOT NULL,
      body       TEXT NOT NULL DEFAULT '',
      status     TEXT NOT NULL,
      sequence   TEXT NOT NULL DEFAULT '',
      refs       TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_project_status
      ON chunks(project, status) WHERE deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS queues (
      name       TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS queue_items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      queue      TEXT NOT NULL REFERENCES queues(name) ON DELETE CASCADE,
      value      TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_queue_items_queue
      ON queue_items(queue, id);

    CREATE TABLE IF NOT EXISTS sets (
      name       TEXT NOT NULL,
      key        TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (name, key)
    );
  `);
}

// --- Project operations ---

export interface Project {
  name: string;
  states: string[];
  created_at: string;
}

export function listProjects(): string[] {
  const db = getDb();
  const rows = db.prepare("SELECT name FROM projects ORDER BY name").all() as {
    name: string;
  }[];
  return rows.map((r) => r.name);
}

export interface ProjectSummary extends Project {
  task_count: number;
}

export function listProjectDetails(): ProjectSummary[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT p.name, p.states, p.created_at,
              COUNT(c.id) AS task_count
       FROM projects p
       LEFT JOIN chunks c ON c.project = p.name AND c.deleted_at IS NULL
       GROUP BY p.name
       ORDER BY p.name`
    )
    .all() as {
    name: string;
    states: string;
    created_at: string;
    task_count: number;
  }[];
  return rows.map((r) => ({
    ...r,
    states: JSON.parse(r.states),
  }));
}

export function getProject(name: string): Project | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM projects WHERE name = ?")
    .get(name) as { name: string; states: string; created_at: string } | undefined;
  if (!row) return null;
  return { ...row, states: JSON.parse(row.states) };
}

export function upsertProject(
  name: string,
  states?: string[]
): Project {
  const db = getDb();
  const defaultStates = '["pending","active","done","archived"]';
  const statesJson = states ? JSON.stringify(states) : defaultStates;

  db.prepare(
    `INSERT INTO projects (name, states) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET states = excluded.states`
  ).run(name, statesJson);

  return getProject(name)!;
}

// --- Task operations ---

export interface Task {
  id: number;
  project: string;
  title: string;
  body: string;
  status: string;
  sequence: string;
  refs: string[];
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export type TaskSummary = Omit<Task, "body">;

interface TaskRow {
  id: number;
  project: string;
  title: string;
  body: string;
  status: string;
  sequence: string;
  refs: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function rowToTask(row: TaskRow): Task {
  return { ...row, refs: JSON.parse(row.refs) };
}

function rowToSummary(row: TaskRow): TaskSummary {
  const { body: _, ...rest } = row;
  return { ...rest, refs: JSON.parse(rest.refs) };
}

export interface CreateTaskInput {
  title: string;
  body?: string;
  sequence?: string;
  refs?: string[];
}

export function createTasks(
  project: string,
  tasks: CreateTaskInput[]
): number[] {
  const db = getDb();
  const proj = getProject(project);
  if (!proj) throw new Error(`Project "${project}" does not exist`);

  const defaultStatus = proj.states[0];
  const stmt = db.prepare(
    `INSERT INTO chunks (project, title, body, status, sequence, refs)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const ids: number[] = [];
  const insertAll = db.transaction(() => {
    for (const task of tasks) {
      const result = stmt.run(
        project,
        task.title,
        task.body ?? "",
        defaultStatus,
        task.sequence ?? "",
        JSON.stringify(task.refs ?? [])
      );
      ids.push(Number(result.lastInsertRowid));
    }
  });

  insertAll();
  return ids;
}

export function listTasks(
  project: string,
  status?: string
): TaskSummary[] {
  const db = getDb();
  let sql = `SELECT id, project, title, status, sequence, refs, created_at, updated_at, deleted_at
             FROM chunks WHERE project = ? AND deleted_at IS NULL`;
  const params: unknown[] = [project];

  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }

  const rows = db.prepare(sql).all(...params) as TaskRow[];
  const summaries = rows.map(rowToSummary);
  return orderBy(summaries, [(t) => t.sequence], ["asc"]);
}

export function getTask(id: number): Task | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM chunks WHERE id = ? AND deleted_at IS NULL")
    .get(id) as TaskRow | undefined;
  return row ? rowToTask(row) : null;
}

export interface UpdateTaskInput {
  title?: string;
  body?: string;
  status?: string;
  sequence?: string;
  refs?: string[];
}

export function updateTask(id: number, updates: UpdateTaskInput): Task {
  const db = getDb();
  const existing = getTask(id);
  if (!existing) throw new Error(`Task ${id} not found`);

  if (updates.status) {
    const proj = getProject(existing.project);
    if (proj && !proj.states.includes(updates.status)) {
      throw new Error(
        `Invalid status "${updates.status}". Valid states: ${proj.states.join(", ")}`
      );
    }
  }

  const fields: string[] = ["updated_at = datetime('now')"];
  const params: unknown[] = [];

  if (updates.title !== undefined) {
    fields.push("title = ?");
    params.push(updates.title);
  }
  if (updates.body !== undefined) {
    fields.push("body = ?");
    params.push(updates.body);
  }
  if (updates.status !== undefined) {
    fields.push("status = ?");
    params.push(updates.status);
  }
  if (updates.sequence !== undefined) {
    fields.push("sequence = ?");
    params.push(updates.sequence);
  }
  if (updates.refs !== undefined) {
    fields.push("refs = ?");
    params.push(JSON.stringify(updates.refs));
  }

  params.push(id);
  db.prepare(`UPDATE chunks SET ${fields.join(", ")} WHERE id = ?`).run(
    ...params
  );

  return getTask(id)!;
}

export function deleteTask(id: number): void {
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM chunks WHERE id = ? AND deleted_at IS NULL")
    .get(id);
  if (!existing) throw new Error(`Task ${id} not found`);

  db.prepare("UPDATE chunks SET deleted_at = datetime('now') WHERE id = ?").run(
    id
  );
}

export function deleteTasksByStatus(project: string, status: string): number {
  const db = getDb();
  const result = db
    .prepare(
      "UPDATE chunks SET deleted_at = datetime('now') WHERE project = ? AND status = ? AND deleted_at IS NULL"
    )
    .run(project, status);
  return result.changes;
}

// --- Search tasks ---

export function searchTasks(
  query: string,
  project?: string,
  status?: string
): TaskSummary[] {
  const db = getDb();
  const pattern = `%${query}%`;
  let sql = `SELECT id, project, title, status, sequence, refs, created_at, updated_at, deleted_at
             FROM chunks WHERE deleted_at IS NULL
             AND (title LIKE ? COLLATE NOCASE OR body LIKE ? COLLATE NOCASE OR refs LIKE ? COLLATE NOCASE)`;
  const params: unknown[] = [pattern, pattern, pattern];

  if (project) {
    sql += " AND project = ?";
    params.push(project);
  }
  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }

  const rows = db.prepare(sql).all(...params) as TaskRow[];
  const summaries = rows.map(rowToSummary);
  return orderBy(summaries, [(t) => t.sequence], ["asc"]);
}

// --- Append to task ---

export function appendToTask(id: number, text: string): Task {
  const db = getDb();
  const existing = getTask(id);
  if (!existing) throw new Error(`Task ${id} not found`);

  const newBody = existing.body ? existing.body + "\n\n" + text : text;
  db.prepare(
    "UPDATE chunks SET body = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(newBody, id);

  return getTask(id)!;
}

// --- For CLI: deleted tasks ---

export function listDeletedTasks(project?: string): TaskSummary[] {
  const db = getDb();
  let sql = `SELECT id, project, title, status, sequence, refs, created_at, updated_at, deleted_at
             FROM chunks WHERE deleted_at IS NOT NULL`;
  const params: unknown[] = [];

  if (project) {
    sql += " AND project = ?";
    params.push(project);
  }

  sql += " ORDER BY deleted_at DESC";
  const rows = db.prepare(sql).all(...params) as TaskRow[];
  return rows.map(rowToSummary);
}

export function restoreTask(id: number): Task {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM chunks WHERE id = ? AND deleted_at IS NOT NULL")
    .get(id) as TaskRow | undefined;
  if (!row) throw new Error(`Deleted task ${id} not found`);

  db.prepare(
    "UPDATE chunks SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(id);

  return getTask(id)!;
}

export function emptyTrash(project?: string): number {
  const db = getDb();
  if (project) {
    const result = db.prepare("DELETE FROM chunks WHERE deleted_at IS NOT NULL AND project = ?").run(project);
    return result.changes;
  }
  const result = db.prepare("DELETE FROM chunks WHERE deleted_at IS NOT NULL").run();
  return result.changes;
}

// --- Queue operations ---

export interface Queue {
  name: string;
  created_at: string;
}

export interface QueueItem {
  id: number;
  queue: string;
  value: string;
  created_at: string;
}

export interface QueueSummary extends Queue {
  item_count: number;
}

export function listQueues(): QueueSummary[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT q.name, q.created_at, COUNT(qi.id) AS item_count
       FROM queues q
       LEFT JOIN queue_items qi ON qi.queue = q.name
       GROUP BY q.name
       ORDER BY q.name`
    )
    .all() as QueueSummary[];
}

export function getQueueLength(queue: string): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM queue_items WHERE queue = ?")
    .get(queue) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function enqueue(queue: string, items: string[]): number[] {
  const db = getDb();
  const filtered = items.map((s) => s.trim()).filter((s) => s.length > 0);
  if (filtered.length === 0) return [];

  // Auto-create queue
  db.prepare(
    "INSERT OR IGNORE INTO queues (name) VALUES (?)"
  ).run(queue);

  const stmt = db.prepare(
    "INSERT INTO queue_items (queue, value) VALUES (?, ?)"
  );

  const ids: number[] = [];
  const insertAll = db.transaction(() => {
    for (const value of filtered) {
      const result = stmt.run(queue, value);
      ids.push(Number(result.lastInsertRowid));
    }
  });

  insertAll();
  return ids;
}

export function getNextQueueItem(queue: string): QueueItem | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM queue_items WHERE queue = ? ORDER BY id ASC LIMIT 1"
    )
    .get(queue) as QueueItem | undefined;
  return row ?? null;
}

export function listQueueItems(queue: string): QueueItem[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM queue_items WHERE queue = ? ORDER BY id ASC")
    .all(queue) as QueueItem[];
}

export function deleteQueueItem(id: number): void {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM queue_items WHERE id = ?")
    .run(id);
  if (result.changes === 0) throw new Error(`Queue item ${id} not found`);
}

export function deleteQueue(queue: string): number {
  const db = getDb();
  const existing = db
    .prepare("SELECT name FROM queues WHERE name = ?")
    .get(queue);
  if (!existing) throw new Error(`Queue "${queue}" not found`);

  // CASCADE deletes items
  db.prepare("DELETE FROM queues WHERE name = ?").run(queue);
  return 1;
}

// --- Set operations ---

export interface SetSummary {
  name: string;
  member_count: number;
}

export function listSets(): SetSummary[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT name, COUNT(*) AS member_count
       FROM sets GROUP BY name ORDER BY name`
    )
    .all() as SetSummary[];
}

export function addToSet(set: string, key: string): void {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO sets (name, key) VALUES (?, ?)"
  ).run(set, key);
}

export function addManyToSet(set: string, keys: string[]): number {
  const db = getDb();
  const filtered = keys.map((s) => s.trim()).filter((s) => s.length > 0);
  if (filtered.length === 0) return 0;

  const stmt = db.prepare(
    "INSERT OR IGNORE INTO sets (name, key) VALUES (?, ?)"
  );

  let added = 0;
  const insertAll = db.transaction(() => {
    for (const key of filtered) {
      const result = stmt.run(set, key);
      added += result.changes;
    }
  });

  insertAll();
  return added;
}

export function removeFromSet(set: string, key: string): void {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM sets WHERE name = ? AND key = ?")
    .run(set, key);
  if (result.changes === 0) throw new Error(`Key "${key}" not found in set "${set}"`);
}

export function setHas(set: string, key: string): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT 1 FROM sets WHERE name = ? AND key = ?")
    .get(set, key);
  return row !== undefined;
}

export function listSetMembers(set: string): string[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT key FROM sets WHERE name = ? ORDER BY key")
    .all(set) as { key: string }[];
  return rows.map((r) => r.key);
}

export function deleteSet(set: string): number {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM sets WHERE name = ?")
    .run(set);
  if (result.changes === 0) throw new Error(`Set "${set}" not found`);
  return result.changes;
}

export function getDbPath(): string {
  return DB_PATH;
}

/** Close the database connection (for testing). */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
