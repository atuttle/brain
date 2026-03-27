#!/usr/bin/env node

import { select, confirm, input } from "@inquirer/prompts";
import {
  getDb,
  getDbPath,
  listProjects,
  listProjectDetails,
  getProject,
  listChunks,
  getChunk,
  listDeletedChunks,
  restoreChunk,
  emptyTrash,
  listQueues,
  enqueue,
  listQueueItems,
  deleteQueueItem,
  deleteQueue,
  type ChunkSummary,
} from "./db.js";
import { execSync } from "child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { dirname, join } from "path";

const BACKUP_DIR = join(dirname(getDbPath()), "backups");

function formatChunk(c: ChunkSummary): string {
  const refs = c.refs.length > 0 ? ` [${c.refs.join(", ")}]` : "";
  return `[${c.sequence || "-"}] #${c.id} ${c.title} (${c.status})${refs}`;
}

async function mainMenu(): Promise<void> {
  while (true) {
    const action = await select({
      message: "mcp-brain",
      choices: [
        { name: "List projects", value: "list-projects" },
        { name: "Browse records", value: "browse" },
        { name: "View deleted records", value: "trash" },
        { name: "Restore a record", value: "restore" },
        { name: "Empty trash", value: "empty-trash" },
        { name: "Queues", value: "queues" },
        { name: "Backup database", value: "backup" },
        { name: "Install backup cron", value: "install-cron" },
        { name: "Exit", value: "exit" },
      ],
    });

    switch (action) {
      case "list-projects":
        listProjectsMenu();
        break;
      case "browse":
        await browseChunks();
        break;
      case "trash":
        await viewTrash();
        break;
      case "restore":
        await restoreMenu();
        break;
      case "empty-trash":
        await emptyTrashMenu();
        break;
      case "queues":
        await queuesMenu();
        break;
      case "backup":
        runBackup();
        break;
      case "install-cron":
        await installCron();
        break;
      case "exit":
        return;
    }
  }
}

function listProjectsMenu(): void {
  const projects = listProjectDetails();
  if (projects.length === 0) {
    console.log("No projects found.");
    return;
  }

  console.log(`\n${projects.length} project(s):\n`);
  for (const p of projects) {
    const states = p.states.join(", ");
    console.log(`  ${p.name}  (${p.chunk_count} records)  states: [${states}]  created: ${p.created_at}`);
  }
  console.log();
}

async function pickProject(): Promise<string | null> {
  const projects = listProjects();
  if (projects.length === 0) {
    console.log("No projects found.");
    return null;
  }

  return select({
    message: "Select project",
    choices: projects.map((p) => ({ name: p, value: p })),
  });
}

async function browseChunks(): Promise<void> {
  const project = await pickProject();
  if (!project) return;

  const proj = getProject(project);
  if (!proj) return;

  const statusFilter = await select<string>({
    message: "Filter by status",
    choices: [
      { name: "All", value: "" },
      ...proj.states.map((s) => ({ name: s, value: s })),
    ],
  });

  const chunks = listChunks(project, statusFilter ? statusFilter : undefined);
  if (chunks.length === 0) {
    console.log("No records found.");
    return;
  }

  console.log(`\n${chunks.length} record(s):\n`);

  const chunkChoice = await select<number>({
    message: "Select record to view (or back)",
    choices: [
      ...chunks.map((c) => ({
        name: formatChunk(c),
        value: c.id,
      })),
      { name: "← Back", value: -1 },
    ],
  });

  if (chunkChoice === -1) return;

  const full = getChunk(chunkChoice);
  if (!full) {
    console.log("Record not found.");
    return;
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`#${full.id} — ${full.title}`);
  console.log(`Status: ${full.status}  Sequence: ${full.sequence || "(none)"}`);
  if (full.refs.length > 0) console.log(`Refs: ${full.refs.join(", ")}`);
  console.log(`Created: ${full.created_at}  Updated: ${full.updated_at}`);
  console.log(`${"─".repeat(60)}`);
  console.log(full.body || "(empty body)");
  console.log(`${"─".repeat(60)}\n`);
}

async function viewTrash(): Promise<void> {
  const deleted = listDeletedChunks();
  if (deleted.length === 0) {
    console.log("Trash is empty.");
    return;
  }

  console.log(`\n${deleted.length} deleted record(s):\n`);
  for (const c of deleted) {
    console.log(`  #${c.id} [${c.project}] ${c.title} — deleted ${c.deleted_at}`);
  }
  console.log();
}

async function restoreMenu(): Promise<void> {
  const deleted = listDeletedChunks();
  if (deleted.length === 0) {
    console.log("Trash is empty.");
    return;
  }

  const chunkId = await select<number>({
    message: "Select record to restore",
    choices: [
      ...deleted.map((c) => ({
        name: `#${c.id} [${c.project}] ${c.title} — deleted ${c.deleted_at}`,
        value: c.id,
      })),
      { name: "← Back", value: -1 },
    ],
  });

  if (chunkId === -1) return;

  const restored = restoreChunk(chunkId);
  console.log(`Restored record #${restored.id}: ${restored.title}`);
}

async function emptyTrashMenu(): Promise<void> {
  const deleted = listDeletedChunks();
  if (deleted.length === 0) {
    console.log("Trash is empty.");
    return;
  }

  console.log(`\n${deleted.length} record(s) in trash:\n`);
  for (const c of deleted) {
    console.log(`  #${c.id} [${c.project}] ${c.title} — deleted ${c.deleted_at}`);
  }
  console.log();

  const ok = await confirm({
    message: `Permanently delete ${deleted.length} record(s)? This cannot be undone.`,
  });
  if (!ok) return;

  const count = emptyTrash();
  console.log(`Permanently deleted ${count} record(s).`);
}

// --- Queue menus ---

async function queuesMenu(): Promise<void> {
  const action = await select({
    message: "Queues",
    choices: [
      { name: "List queues", value: "list" },
      { name: "View queue contents", value: "view" },
      { name: "Add items to queue", value: "enqueue" },
      { name: "Delete item from queue", value: "delete-item" },
      { name: "Delete entire queue", value: "delete-queue" },
      { name: "← Back", value: "back" },
    ],
  });

  switch (action) {
    case "list":
      listQueuesMenu();
      break;
    case "view":
      await viewQueueMenu();
      break;
    case "enqueue":
      await enqueueMenu();
      break;
    case "delete-item":
      await deleteQueueItemMenu();
      break;
    case "delete-queue":
      await deleteQueueMenu();
      break;
  }
}

function listQueuesMenu(): void {
  const queues = listQueues();
  if (queues.length === 0) {
    console.log("No queues found.");
    return;
  }

  console.log(`\n${queues.length} queue(s):\n`);
  for (const q of queues) {
    console.log(`  ${q.name}  (${q.item_count} items)  created: ${q.created_at}`);
  }
  console.log();
}

async function pickQueue(): Promise<string | null> {
  const queues = listQueues();
  if (queues.length === 0) {
    console.log("No queues found.");
    return null;
  }

  return select({
    message: "Select queue",
    choices: queues.map((q) => ({ name: `${q.name} (${q.item_count} items)`, value: q.name })),
  });
}

async function viewQueueMenu(): Promise<void> {
  const queue = await pickQueue();
  if (!queue) return;

  const items = listQueueItems(queue);
  if (items.length === 0) {
    console.log("Queue is empty.");
    return;
  }

  console.log(`\n${items.length} item(s) in "${queue}":\n`);
  for (const item of items) {
    console.log(`  #${item.id}  ${item.value}`);
  }
  console.log();
}

async function enqueueMenu(): Promise<void> {
  const queueName = await input({ message: "Queue name (auto-created if new)" });
  if (!queueName.trim()) return;

  const mode = await select({
    message: "Input mode",
    choices: [
      { name: "Single item", value: "single" },
      { name: "Multi-line (paste, then enter empty line to finish)", value: "multi" },
    ],
  });

  if (mode === "single") {
    const value = await input({ message: "Item value" });
    if (!value.trim()) return;
    const ids = enqueue(queueName.trim(), [value.trim()]);
    console.log(`Enqueued 1 item (id: ${ids[0]})`);
  } else {
    console.log("Enter items one per line. Empty line to finish:");
    const lines: string[] = [];
    while (true) {
      const line = await input({ message: ">" });
      if (line.trim() === "") break;
      lines.push(line.trim());
    }
    if (lines.length === 0) {
      console.log("No items entered.");
      return;
    }
    const ids = enqueue(queueName.trim(), lines);
    console.log(`Enqueued ${ids.length} item(s).`);
  }
}

async function deleteQueueItemMenu(): Promise<void> {
  const queue = await pickQueue();
  if (!queue) return;

  const items = listQueueItems(queue);
  if (items.length === 0) {
    console.log("Queue is empty.");
    return;
  }

  const itemId = await select<number>({
    message: "Select item to delete",
    choices: [
      ...items.map((item) => ({
        name: `#${item.id}  ${item.value}`,
        value: item.id,
      })),
      { name: "← Back", value: -1 },
    ],
  });

  if (itemId === -1) return;
  deleteQueueItem(itemId);
  console.log(`Deleted item #${itemId}.`);
}

async function deleteQueueMenu(): Promise<void> {
  const queue = await pickQueue();
  if (!queue) return;

  const items = listQueueItems(queue);
  const ok = await confirm({
    message: `Delete queue "${queue}" and its ${items.length} item(s)? This cannot be undone.`,
  });
  if (!ok) return;

  deleteQueue(queue);
  console.log(`Deleted queue "${queue}".`);
}

// --- Stdin pipe support for enqueue ---

function handleStdinEnqueue(): void {
  const args = process.argv.slice(2);
  const queueIdx = args.indexOf("--enqueue");
  if (queueIdx === -1) return;

  const queueName = args[queueIdx + 1];
  if (!queueName) {
    console.error("Usage: mcp-brain --enqueue <queue-name> < items.txt");
    process.exit(1);
  }

  getDb();
  const stdinData = readFileSync(0, "utf-8");
  const lines = stdinData.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);

  if (lines.length === 0) {
    console.log("No items to enqueue (stdin was empty).");
    process.exit(0);
  }

  const ids = enqueue(queueName, lines);
  console.log(`Enqueued ${ids.length} item(s) in "${queueName}".`);
  process.exit(0);
}

function runBackup(): void {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const dbPath = getDbPath();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupPath = join(BACKUP_DIR, `brain-${timestamp}.db`);

  try {
    // Use sqlite3 .backup for safe hot backup
    execSync(`sqlite3 "${dbPath}" ".backup '${backupPath}'"`, {
      stdio: "pipe",
    });
    console.log(`Backup created: ${backupPath}`);
    cleanOldBackups();
  } catch {
    console.error("Backup failed. Is sqlite3 installed?");
  }
}

function cleanOldBackups(): void {
  const files = readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith("brain-") && f.endsWith(".db"))
    .map((f) => ({
      name: f,
      path: join(BACKUP_DIR, f),
      mtime: statSync(join(BACKUP_DIR, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  const now = Date.now();
  const hourMs = 3600_000;
  const dayMs = 86400_000;

  // Keep 48 hourly (files < 48h old) + 30 daily (one per day for older files)
  const keep = new Set<string>();
  const seenDays = new Set<string>();

  for (const f of files) {
    const ageMs = now - f.mtime;

    if (ageMs < 48 * hourMs) {
      keep.add(f.name);
    } else if (ageMs < 30 * dayMs) {
      const day = new Date(f.mtime).toISOString().slice(0, 10);
      if (!seenDays.has(day)) {
        seenDays.add(day);
        keep.add(f.name);
      }
    }
  }

  let removed = 0;
  for (const f of files) {
    if (!keep.has(f.name)) {
      unlinkSync(f.path);
      removed++;
    }
  }

  if (removed > 0) {
    console.log(`Cleaned ${removed} old backup(s).`);
  }
}

async function installCron(): Promise<void> {
  const ok = await confirm({
    message: "Install hourly backup cron job?",
  });
  if (!ok) return;

  const cliPath = process.argv[1];
  const cronLine = `0 * * * * node "${cliPath}" --backup`;

  try {
    const existing = execSync("crontab -l 2>/dev/null", {
      encoding: "utf-8",
    }).trim();

    if (existing.includes("mcp-brain")) {
      console.log("Cron job already installed.");
      return;
    }

    const newCrontab = existing ? `${existing}\n${cronLine}\n` : `${cronLine}\n`;
    execSync(`echo "${newCrontab.replace(/"/g, '\\"')}" | crontab -`, {
      stdio: "pipe",
    });
    console.log("Cron job installed: hourly backup.");
  } catch {
    console.error("Failed to install cron. You may need to add it manually:");
    console.log(`  ${cronLine}`);
  }
}

// Support non-interactive flags
if (process.argv.includes("--enqueue")) {
  handleStdinEnqueue();
} else if (process.argv.includes("--backup")) {
  getDb(); // ensure DB exists
  runBackup();
} else {
  mainMenu().catch((err) => {
    if (err.name === "ExitPromptError") {
      // User pressed Ctrl+C
      process.exit(0);
    }
    console.error(err);
    process.exit(1);
  });
}
