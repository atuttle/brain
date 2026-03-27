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
  chunk_count: number;
}

export function listProjectDetails(): ProjectSummary[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT p.name, p.states, p.created_at,
              COUNT(c.id) AS chunk_count
       FROM projects p
       LEFT JOIN chunks c ON c.project = p.name AND c.deleted_at IS NULL
       GROUP BY p.name
       ORDER BY p.name`
    )
    .all() as {
    name: string;
    states: string;
    created_at: string;
    chunk_count: number;
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

// --- Chunk operations ---

export interface Chunk {
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

export type ChunkSummary = Omit<Chunk, "body">;

interface ChunkRow {
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

function rowToChunk(row: ChunkRow): Chunk {
  return { ...row, refs: JSON.parse(row.refs) };
}

function rowToSummary(row: ChunkRow): ChunkSummary {
  const { body: _, ...rest } = row;
  return { ...rest, refs: JSON.parse(rest.refs) };
}

export interface CreateChunkInput {
  title: string;
  body?: string;
  sequence?: string;
  refs?: string[];
}

export function createChunks(
  project: string,
  chunks: CreateChunkInput[]
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
    for (const chunk of chunks) {
      const result = stmt.run(
        project,
        chunk.title,
        chunk.body ?? "",
        defaultStatus,
        chunk.sequence ?? "",
        JSON.stringify(chunk.refs ?? [])
      );
      ids.push(Number(result.lastInsertRowid));
    }
  });

  insertAll();
  return ids;
}

export function listChunks(
  project: string,
  status?: string
): ChunkSummary[] {
  const db = getDb();
  let sql = `SELECT id, project, title, status, sequence, refs, created_at, updated_at, deleted_at
             FROM chunks WHERE project = ? AND deleted_at IS NULL`;
  const params: unknown[] = [project];

  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }

  const rows = db.prepare(sql).all(...params) as ChunkRow[];
  const summaries = rows.map(rowToSummary);
  return orderBy(summaries, [(c) => c.sequence], ["asc"]);
}

export function getChunk(id: number): Chunk | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM chunks WHERE id = ? AND deleted_at IS NULL")
    .get(id) as ChunkRow | undefined;
  return row ? rowToChunk(row) : null;
}

export interface UpdateChunkInput {
  title?: string;
  body?: string;
  status?: string;
  sequence?: string;
  refs?: string[];
}

export function updateChunk(id: number, updates: UpdateChunkInput): Chunk {
  const db = getDb();
  const existing = getChunk(id);
  if (!existing) throw new Error(`Chunk ${id} not found`);

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

  return getChunk(id)!;
}

export function deleteChunk(id: number): void {
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM chunks WHERE id = ? AND deleted_at IS NULL")
    .get(id);
  if (!existing) throw new Error(`Chunk ${id} not found`);

  db.prepare("UPDATE chunks SET deleted_at = datetime('now') WHERE id = ?").run(
    id
  );
}

// --- For CLI: deleted chunks ---

export function listDeletedChunks(project?: string): ChunkSummary[] {
  const db = getDb();
  let sql = `SELECT id, project, title, status, sequence, refs, created_at, updated_at, deleted_at
             FROM chunks WHERE deleted_at IS NOT NULL`;
  const params: unknown[] = [];

  if (project) {
    sql += " AND project = ?";
    params.push(project);
  }

  sql += " ORDER BY deleted_at DESC";
  const rows = db.prepare(sql).all(...params) as ChunkRow[];
  return rows.map(rowToSummary);
}

export function restoreChunk(id: number): Chunk {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM chunks WHERE id = ? AND deleted_at IS NOT NULL")
    .get(id) as ChunkRow | undefined;
  if (!row) throw new Error(`Deleted chunk ${id} not found`);

  db.prepare(
    "UPDATE chunks SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(id);

  return getChunk(id)!;
}

export function emptyTrash(): number {
  const db = getDb();
  const result = db.prepare("DELETE FROM chunks WHERE deleted_at IS NOT NULL").run();
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
