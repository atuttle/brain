#!/usr/bin/env node

import { intro, outro, select, confirm, text, isCancel, cancel, log } from "@clack/prompts";
import {
  getDb,
  getDbPath,
  listProjectDetails,
  getProject,
  listChunks,
  getChunk,
  searchChunks,
  listDeletedChunks,
  restoreChunk,
  emptyTrash,
  listQueues,
  enqueue,
  getNextQueueItem,
  listQueueItems,
  deleteQueueItem,
  deleteQueue,
  addToSet,
  addManyToSet,
  removeFromSet,
  setHas,
  listSetMembers,
  listSets,
  deleteSet,
  type ChunkSummary,
} from "./db.js";
import { execSync } from "child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { dirname, join } from "path";

const BACKUP_DIR = join(dirname(getDbPath()), "backups");

function formatChunk(c: ChunkSummary): string {
  return `[${c.sequence || "-"}] #${c.id} (${c.status}) ${c.title}`;
}

function bail(value: unknown): value is symbol {
  if (isCancel(value)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  return false;
}

async function mainMenu(): Promise<void> {
  intro("mcp-brain");

  while (true) {
    const action = await select({
      message: "What do you want to do?",
      options: [
        { label: "Projects", value: "projects" },
        { label: "Queues", value: "queues" },
        { label: "Sets", value: "sets" },
        { label: "Empty all trash", value: "empty-trash" },
        { label: "Backup database", value: "backup" },
        { label: "Install backup cron", value: "install-cron" },
        { label: "Exit", value: "exit" },
      ],
    });
    if (bail(action)) return;

    switch (action) {
      case "projects":
        await projectsMenu();
        break;
      case "queues":
        await queuesMenu();
        break;
      case "sets":
        await setsMenu();
        break;
      case "empty-trash":
        await globalEmptyTrashMenu();
        break;
      case "backup":
        runBackup();
        break;
      case "install-cron":
        await installCron();
        break;
      case "exit":
        outro("Bye.");
        return;
    }
  }
}

async function projectsMenu(): Promise<void> {
  const details = listProjectDetails();
  if (details.length === 0) {
    log.info("No projects found.");
    return;
  }

  const choice = await select({
    message: "Select project",
    options: [
      ...details.map((p) => ({
        label: `${p.name}  (${p.chunk_count} records)`,
        value: p.name,
      })),
      { label: "← Back", value: "" },
    ],
  });
  if (bail(choice)) return;
  if (!choice) return;

  await projectMenu(choice);
}

async function projectMenu(project: string): Promise<void> {
  const proj = getProject(project);
  if (!proj) return;

  while (true) {
    const action = await select({
      message: `${project}`,
      options: [
        { label: "Browse records", value: "browse" },
        { label: "Search records", value: "search" },
        { label: "View deleted records", value: "trash" },
        { label: "Restore a record", value: "restore" },
        { label: "Empty trash", value: "empty-trash" },
        { label: "← Back", value: "back" },
      ],
    });
    if (bail(action)) return;

    switch (action) {
      case "browse":
        await browseChunks(project, proj);
        break;
      case "search":
        await searchMenu(project);
        break;
      case "trash":
        await viewTrash(project);
        break;
      case "restore":
        await restoreMenu(project);
        break;
      case "empty-trash":
        await emptyTrashMenu(project);
        break;
      case "back":
        return;
    }
  }
}

async function browseChunks(project: string, proj: import("./db.js").Project): Promise<void> {
  const statusFilter = await select({
    message: "Filter by status",
    options: [
      { label: "All", value: "" },
      ...proj.states.map((s) => ({ label: s, value: s })),
    ],
  });
  if (bail(statusFilter)) return;

  const chunks = listChunks(project, statusFilter || undefined);
  if (chunks.length === 0) {
    log.info("No records found.");
    return;
  }

  log.info(`${chunks.length} record(s):`);

  const chunkChoice = await select({
    message: "Select record to view",
    options: [
      ...chunks.map((c) => ({
        label: formatChunk(c),
        value: c.id,
      })),
      { label: "← Back", value: -1 as number },
    ],
  });
  if (bail(chunkChoice)) return;

  if (chunkChoice === -1) return;

  const full = getChunk(chunkChoice);
  if (!full) {
    log.error("Record not found.");
    return;
  }

  log.info(`${"─".repeat(60)}`);
  log.message(`#${full.id} (${full.status}) — ${full.title}`);
  log.message(`Sequence: ${full.sequence || "(none)"}  Created: ${full.created_at}  Updated: ${full.updated_at}`);
  log.info(`${"─".repeat(60)}`);
  log.message(full.body || "(empty body)");
  log.info(`${"─".repeat(60)}`);
}

async function searchMenu(project: string): Promise<void> {
  const query = await text({ message: "Search query" });
  if (bail(query)) return;
  if (!query.trim()) return;

  const results = searchChunks(query.trim(), project);
  if (results.length === 0) {
    log.info("No matching records.");
    return;
  }

  log.info(`${results.length} result(s):`);
  log.message(results.map((c) => `  #${c.id} (${c.status}) ${c.title}`).join("\n"));
}

function handleSearch(): void {
  const args = process.argv.slice(2);
  const searchIdx = args.indexOf("--search");
  if (searchIdx === -1) return;

  const query = args.slice(searchIdx + 1).join(" ");
  if (!query) {
    console.error("Usage: mcp-brain --search <query>");
    process.exit(1);
  }

  getDb();
  const results = searchChunks(query);
  if (results.length === 0) {
    console.log("No matching records.");
    process.exit(0);
  }

  for (const c of results) {
    console.log(`${c.id}\t${c.project}\t${c.status}\t${c.title}`);
  }
  process.exit(0);
}

async function viewTrash(project: string): Promise<void> {
  const deleted = listDeletedChunks(project);
  if (deleted.length === 0) {
    log.info("Trash is empty.");
    return;
  }

  log.info(`${deleted.length} deleted record(s):`);
  log.message(deleted.map((c) => `  #${c.id} ${c.title} — deleted ${c.deleted_at}`).join("\n"));
}

async function restoreMenu(project: string): Promise<void> {
  const deleted = listDeletedChunks(project);
  if (deleted.length === 0) {
    log.info("Trash is empty.");
    return;
  }

  const chunkId = await select({
    message: "Select record to restore",
    options: [
      ...deleted.map((c) => ({
        label: `#${c.id} ${c.title} — deleted ${c.deleted_at}`,
        value: c.id,
      })),
      { label: "← Back", value: -1 as number },
    ],
  });
  if (bail(chunkId)) return;

  if (chunkId === -1) return;

  const restored = restoreChunk(chunkId);
  log.success(`Restored record #${restored.id}: ${restored.title}`);
}

async function emptyTrashMenu(project: string): Promise<void> {
  const deleted = listDeletedChunks(project);
  if (deleted.length === 0) {
    log.info("Trash is empty.");
    return;
  }

  log.info(`${deleted.length} record(s) in trash:`);
  log.message(deleted.map((c) => `  #${c.id} ${c.title} — deleted ${c.deleted_at}`).join("\n"));

  const ok = await confirm({
    message: `Permanently delete ${deleted.length} record(s)? This cannot be undone.`,
  });
  if (bail(ok)) return;
  if (!ok) return;

  const count = emptyTrash(project);
  log.success(`Permanently deleted ${count} record(s).`);
}

async function globalEmptyTrashMenu(): Promise<void> {
  const deleted = listDeletedChunks();
  if (deleted.length === 0) {
    log.info("Trash is empty.");
    return;
  }

  log.info(`${deleted.length} record(s) in trash:`);
  log.message(deleted.map((c) => `  #${c.id} [${c.project}] ${c.title} — deleted ${c.deleted_at}`).join("\n"));

  const ok = await confirm({
    message: `Permanently delete ${deleted.length} record(s) across all projects? This cannot be undone.`,
  });
  if (bail(ok)) return;
  if (!ok) return;

  const count = emptyTrash();
  log.success(`Permanently deleted ${count} record(s).`);
}

// --- Queue menus ---

async function queuesMenu(): Promise<void> {
  const action = await select({
    message: "Queues",
    options: [
      { label: "List queues", value: "list" },
      { label: "View queue contents", value: "view" },
      { label: "Add items to queue", value: "enqueue" },
      { label: "Delete item from queue", value: "delete-item" },
      { label: "Delete entire queue", value: "delete-queue" },
      { label: "← Back", value: "back" },
    ],
  });
  if (bail(action)) return;

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
    log.info("No queues found.");
    return;
  }

  log.info(`${queues.length} queue(s):`);
  log.message(queues.map((q) => `  ${q.name}  (${q.item_count} items)  created: ${q.created_at}`).join("\n"));
}

async function pickQueue(): Promise<string | null> {
  const queues = listQueues();
  if (queues.length === 0) {
    log.info("No queues found.");
    return null;
  }

  const value = await select({
    message: "Select queue",
    options: queues.map((q) => ({ label: `${q.name} (${q.item_count} items)`, value: q.name })),
  });
  if (bail(value)) return null;
  return value;
}

async function viewQueueMenu(): Promise<void> {
  const queue = await pickQueue();
  if (!queue) return;

  const items = listQueueItems(queue);
  if (items.length === 0) {
    log.info("Queue is empty.");
    return;
  }

  log.info(`${items.length} item(s) in "${queue}":`);
  log.message(items.map((item) => `  #${item.id}  ${item.value}`).join("\n"));
}

async function enqueueMenu(): Promise<void> {
  const queueName = await text({ message: "Queue name (auto-created if new)" });
  if (bail(queueName)) return;
  if (!queueName.trim()) return;

  const mode = await select({
    message: "Input mode",
    options: [
      { label: "Single item", value: "single" },
      { label: "Multi-line (paste, then enter empty line to finish)", value: "multi" },
    ],
  });
  if (bail(mode)) return;

  if (mode === "single") {
    const value = await text({ message: "Item value" });
    if (bail(value)) return;
    if (!value.trim()) return;
    const ids = enqueue(queueName.trim(), [value.trim()]);
    log.success(`Enqueued 1 item (id: ${ids[0]})`);
  } else {
    log.info("Enter items one per line. Empty line to finish:");
    const lines: string[] = [];
    while (true) {
      const line = await text({ message: ">" });
      if (bail(line)) return;
      if (line.trim() === "") break;
      lines.push(line.trim());
    }
    if (lines.length === 0) {
      log.info("No items entered.");
      return;
    }
    const ids = enqueue(queueName.trim(), lines);
    log.success(`Enqueued ${ids.length} item(s).`);
  }
}

async function deleteQueueItemMenu(): Promise<void> {
  const queue = await pickQueue();
  if (!queue) return;

  const items = listQueueItems(queue);
  if (items.length === 0) {
    log.info("Queue is empty.");
    return;
  }

  const itemId = await select({
    message: "Select item to delete",
    options: [
      ...items.map((item) => ({
        label: `#${item.id}  ${item.value}`,
        value: item.id,
      })),
      { label: "← Back", value: -1 as number },
    ],
  });
  if (bail(itemId)) return;

  if (itemId === -1) return;
  deleteQueueItem(itemId);
  log.success(`Deleted item #${itemId}.`);
}

async function deleteQueueMenu(): Promise<void> {
  const queue = await pickQueue();
  if (!queue) return;

  const items = listQueueItems(queue);
  const ok = await confirm({
    message: `Delete queue "${queue}" and its ${items.length} item(s)? This cannot be undone.`,
  });
  if (bail(ok)) return;
  if (!ok) return;

  deleteQueue(queue);
  log.success(`Deleted queue "${queue}".`);
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
    log.success(`Backup created: ${backupPath}`);
    cleanOldBackups();
  } catch {
    log.error("Backup failed. Is sqlite3 installed?");
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
    log.info(`Cleaned ${removed} old backup(s).`);
  }
}

async function installCron(): Promise<void> {
  const ok = await confirm({
    message: "Install hourly backup cron job?",
  });
  if (bail(ok)) return;
  if (!ok) return;

  const nodePath = process.execPath;
  const cliPath = process.argv[1];
  const cronLine = `0 * * * * "${nodePath}" "${cliPath}" --backup`;

  try {
    const existing = execSync("crontab -l 2>/dev/null", {
      encoding: "utf-8",
    }).trim();

    if (existing.includes("mcp-brain")) {
      log.info("Cron job already installed.");
      return;
    }

    const newCrontab = existing ? `${existing}\n${cronLine}\n` : `${cronLine}\n`;
    execSync(`echo "${newCrontab.replace(/"/g, '\\"')}" | crontab -`, {
      stdio: "pipe",
    });
    log.success("Cron job installed: hourly backup.");
  } catch {
    log.error("Failed to install cron. You may need to add it manually:");
    log.message(`  ${cronLine}`);
  }
}

// --- Set menus ---

async function setsMenu(): Promise<void> {
  while (true) {
    const action = await select({
      message: "Sets",
      options: [
        { label: "List sets", value: "list" },
        { label: "View set members", value: "view" },
        { label: "Add to set", value: "add" },
        { label: "Check membership", value: "check" },
        { label: "Remove from set", value: "remove" },
        { label: "Delete entire set", value: "delete" },
        { label: "← Back", value: "back" },
      ],
    });
    if (bail(action)) return;

    switch (action) {
      case "list":
        listSetsInteractive();
        break;
      case "view":
        await viewSetMenu();
        break;
      case "add":
        await addToSetMenu();
        break;
      case "check":
        await checkSetMenu();
        break;
      case "remove":
        await removeFromSetMenu();
        break;
      case "delete":
        await deleteSetMenu();
        break;
      case "back":
        return;
    }
  }
}

function listSetsInteractive(): void {
  const sets = listSets();
  if (sets.length === 0) {
    log.info("No sets found.");
    return;
  }

  log.info(`${sets.length} set(s):`);
  log.message(sets.map((s) => `  ${s.name}  (${s.member_count} members)`).join("\n"));
}

async function pickSet(): Promise<string | null> {
  const sets = listSets();
  if (sets.length === 0) {
    log.info("No sets found.");
    return null;
  }

  const value = await select({
    message: "Select set",
    options: sets.map((s) => ({ label: `${s.name} (${s.member_count} members)`, value: s.name })),
  });
  if (bail(value)) return null;
  return value;
}

async function viewSetMenu(): Promise<void> {
  const set = await pickSet();
  if (!set) return;

  const members = listSetMembers(set);
  if (members.length === 0) {
    log.info("Set is empty.");
    return;
  }

  log.info(`${members.length} member(s) in "${set}":`);
  log.message(members.map((m) => `  ${m}`).join("\n"));
}

async function addToSetMenu(): Promise<void> {
  const setName = await text({ message: "Set name (auto-created if new)" });
  if (bail(setName)) return;
  if (!setName.trim()) return;

  const mode = await select({
    message: "Input mode",
    options: [
      { label: "Single key", value: "single" },
      { label: "Multi-line (enter empty line to finish)", value: "multi" },
    ],
  });
  if (bail(mode)) return;

  if (mode === "single") {
    const key = await text({ message: "Key" });
    if (bail(key)) return;
    if (!key.trim()) return;
    addToSet(setName.trim(), key.trim());
    log.success(`Added "${key.trim()}" to set "${setName.trim()}".`);
  } else {
    const keys: string[] = [];
    while (true) {
      const line = await text({ message: ">" });
      if (bail(line)) return;
      if (line.trim() === "") break;
      keys.push(line.trim());
    }
    if (keys.length === 0) {
      log.info("No keys entered.");
      return;
    }
    const added = addManyToSet(setName.trim(), keys);
    log.success(`Added ${added} key(s) to set "${setName.trim()}" (${keys.length - added} already existed).`);
  }
}

async function checkSetMenu(): Promise<void> {
  const set = await pickSet();
  if (!set) return;

  const key = await text({ message: "Key to check" });
  if (bail(key)) return;
  if (!key.trim()) return;

  if (setHas(set, key.trim())) {
    log.success(`"${key.trim()}" IS in set "${set}".`);
  } else {
    log.info(`"${key.trim()}" is NOT in set "${set}".`);
  }
}

async function removeFromSetMenu(): Promise<void> {
  const set = await pickSet();
  if (!set) return;

  const members = listSetMembers(set);
  if (members.length === 0) {
    log.info("Set is empty.");
    return;
  }

  const key = await select({
    message: "Select member to remove",
    options: [
      ...members.map((m) => ({ label: m, value: m })),
      { label: "← Back", value: "" },
    ],
  });
  if (bail(key)) return;
  if (!key) return;

  removeFromSet(set, key);
  log.success(`Removed "${key}" from set "${set}".`);
}

async function deleteSetMenu(): Promise<void> {
  const set = await pickSet();
  if (!set) return;

  const members = listSetMembers(set);
  const ok = await confirm({
    message: `Delete set "${set}" and its ${members.length} member(s)? This cannot be undone.`,
  });
  if (bail(ok)) return;
  if (!ok) return;

  const count = deleteSet(set);
  log.success(`Deleted set "${set}" (${count} member(s)).`);
}

// --- Queue CLI handlers ---

function handleDeleteQueueItem(): void {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--delete-queue-item");
  if (idx === -1) return;

  const rawId = args[idx + 1];
  const id = Number(rawId);
  if (!rawId || !Number.isInteger(id)) {
    console.error("Usage: brain --delete-queue-item <item-id>");
    process.exit(1);
  }

  getDb();
  try {
    deleteQueueItem(id);
    console.log(`Deleted queue item #${id}.`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  process.exit(0);
}

function handleNextQueueItem(): void {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--next-queue-item");
  if (idx === -1) return;

  const queueName = args[idx + 1];
  if (!queueName) {
    console.error("Usage: brain --next-queue-item <queue-name>");
    process.exit(1);
  }

  getDb();
  const item = getNextQueueItem(queueName);
  if (!item) {
    process.exit(1);
  }

  console.log(`${item.id}\t${item.value}`);
  process.exit(0);
}

// --- Project/Chunk CLI handlers ---

function handleListProjects(): void {
  getDb();
  const projects = listProjectDetails();
  if (projects.length === 0) {
    console.log("No projects found.");
    process.exit(0);
  }
  for (const p of projects) {
    console.log(`${p.name}\t${p.chunk_count}`);
  }
  process.exit(0);
}

function handleListChunks(): void {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--list-chunks");
  if (idx === -1) return;

  const project = args[idx + 1];
  if (!project) {
    console.error("Usage: brain --list-chunks <project> [--status <status>]");
    process.exit(1);
  }

  const statusIdx = args.indexOf("--status");
  const status = statusIdx !== -1 ? args[statusIdx + 1] : undefined;

  getDb();
  const chunks = listChunks(project, status);
  if (chunks.length === 0) {
    console.log("No records found.");
    process.exit(0);
  }
  for (const c of chunks) {
    console.log(`${c.id}\t${c.status}\t${c.sequence || ""}\t${c.title}`);
  }
  process.exit(0);
}

function handleGetChunk(): void {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--get-chunk");
  if (idx === -1) return;

  const rawId = args[idx + 1];
  const id = Number(rawId);
  if (!rawId || !Number.isInteger(id)) {
    console.error("Usage: brain --get-chunk <id>");
    process.exit(1);
  }

  getDb();
  const chunk = getChunk(id);
  if (!chunk) {
    console.error("Record not found.");
    process.exit(1);
  }

  console.log(JSON.stringify(chunk));
  process.exit(0);
}

function handleListDeleted(): void {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--list-deleted");
  if (idx === -1) return;

  const project = args[idx + 1]; // optional

  getDb();
  const deleted = listDeletedChunks(project || undefined);
  if (deleted.length === 0) {
    console.log("Trash is empty.");
    process.exit(0);
  }
  for (const c of deleted) {
    console.log(`${c.id}\t${c.project}\t${c.title}\t${c.deleted_at}`);
  }
  process.exit(0);
}

function handleRestoreChunk(): void {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--restore-chunk");
  if (idx === -1) return;

  const rawId = args[idx + 1];
  const id = Number(rawId);
  if (!rawId || !Number.isInteger(id)) {
    console.error("Usage: brain --restore-chunk <id>");
    process.exit(1);
  }

  getDb();
  try {
    const restored = restoreChunk(id);
    console.log(`Restored record #${restored.id}: ${restored.title}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  process.exit(0);
}

function handleEmptyTrash(): void {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--empty-trash");
  if (idx === -1) return;

  const project = args[idx + 1]; // optional

  getDb();
  const count = emptyTrash(project || undefined);
  console.log(`Permanently deleted ${count} record(s).`);
  process.exit(0);
}

// --- Queue CLI handlers ---

function handleListQueues(): void {
  getDb();
  const queues = listQueues();
  if (queues.length === 0) {
    console.log("No queues found.");
    process.exit(0);
  }
  for (const q of queues) {
    console.log(`${q.name}\t${q.item_count}`);
  }
  process.exit(0);
}

function handleListQueueItems(): void {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--list-queue-items");
  if (idx === -1) return;

  const queueName = args[idx + 1];
  if (!queueName) {
    console.error("Usage: brain --list-queue-items <queue-name>");
    process.exit(1);
  }

  getDb();
  const items = listQueueItems(queueName);
  if (items.length === 0) {
    console.log("Queue is empty.");
    process.exit(0);
  }
  for (const item of items) {
    console.log(`${item.id}\t${item.value}`);
  }
  process.exit(0);
}

function handleDeleteQueue(): void {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--delete-queue");
  if (idx === -1) return;

  const queueName = args[idx + 1];
  if (!queueName) {
    console.error("Usage: brain --delete-queue <queue-name>");
    process.exit(1);
  }

  getDb();
  const count = deleteQueue(queueName);
  console.log(`Deleted queue "${queueName}" (${count} item(s)).`);
  process.exit(0);
}

function handleSetHas(): void {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--set-has");
  if (idx === -1) return;

  const setName = args[idx + 1];
  const keyIdx = args.indexOf("--key");
  const key = keyIdx !== -1 ? args[keyIdx + 1] : undefined;

  if (!setName || !key) {
    console.error("Usage: brain --set-has <set-name> --key <key>");
    process.exit(1);
  }

  getDb();
  if (setHas(setName, key)) {
    console.log("true");
    process.exit(0);
  } else {
    console.log("false");
    process.exit(1);
  }
}

function handleBackup(): void {
  getDb();
  mkdirSync(BACKUP_DIR, { recursive: true });
  const dbPath = getDbPath();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupPath = join(BACKUP_DIR, `brain-${timestamp}.db`);

  try {
    execSync(`sqlite3 "${dbPath}" ".backup '${backupPath}'"`, { stdio: "pipe" });
    console.log(backupPath);
    cleanOldBackups();
  } catch {
    console.error("Backup failed. Is sqlite3 installed?");
    process.exit(1);
  }
  process.exit(0);
}

function handleInstallCron(): void {
  const nodePath = process.execPath;
  const cliPath = process.argv[1];
  const cronLine = `0 * * * * "${nodePath}" "${cliPath}" --backup`;

  try {
    const existing = execSync("crontab -l 2>/dev/null", {
      encoding: "utf-8",
    }).trim();

    if (existing.includes("mcp-brain")) {
      console.log("Cron job already installed.");
      process.exit(0);
    }

    const newCrontab = existing ? `${existing}\n${cronLine}\n` : `${cronLine}\n`;
    execSync(`echo "${newCrontab.replace(/"/g, '\\"')}" | crontab -`, {
      stdio: "pipe",
    });
    console.log("Cron job installed: hourly backup.");
  } catch {
    console.error("Failed to install cron. Add manually:");
    console.error(`  ${cronLine}`);
    process.exit(1);
  }
  process.exit(0);
}

// --- Set CLI handlers ---

function handleAddToSet(): void {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--add-to-set");
  if (idx === -1) return;

  const setName = args[idx + 1];
  if (!setName) {
    console.error("Usage: brain --add-to-set <set-name> [--key <key>]");
    process.exit(1);
  }

  getDb();
  const keyIdx = args.indexOf("--key");
  if (keyIdx !== -1) {
    const key = args[keyIdx + 1];
    if (!key) {
      console.error("Usage: brain --add-to-set <set-name> --key <key>");
      process.exit(1);
    }
    addToSet(setName, key);
    console.log(`Added "${key}" to set "${setName}".`);
  } else {
    const stdinData = readFileSync(0, "utf-8");
    const keys = stdinData.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
    if (keys.length === 0) {
      console.log("No keys to add (stdin was empty).");
      process.exit(0);
    }
    const added = addManyToSet(setName, keys);
    console.log(`Added ${added} key(s) to set "${setName}" (${keys.length - added} already existed).`);
  }
  process.exit(0);
}

function handleRemoveFromSet(): void {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--remove-from-set");
  if (idx === -1) return;

  const setName = args[idx + 1];
  const keyIdx = args.indexOf("--key");
  const key = keyIdx !== -1 ? args[keyIdx + 1] : undefined;

  if (!setName || !key) {
    console.error("Usage: brain --remove-from-set <set-name> --key <key>");
    process.exit(1);
  }

  getDb();
  try {
    removeFromSet(setName, key);
    console.log(`Removed "${key}" from set "${setName}".`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  process.exit(0);
}

function handleInSet(): void {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--in-set");
  if (idx === -1) return;

  const setName = args[idx + 1];
  if (!setName) {
    console.error("Usage: ... | brain --in-set <set-name>");
    process.exit(1);
  }

  getDb();
  const stdinData = readFileSync(0, "utf-8");
  const lines = stdinData.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);

  for (const line of lines) {
    if (setHas(setName, line)) {
      process.stdout.write(line + "\n");
    }
  }
  process.exit(0);
}

function handleNotInSet(): void {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--not-in-set");
  if (idx === -1) return;

  const setName = args[idx + 1];
  if (!setName) {
    console.error("Usage: ... | brain --not-in-set <set-name>");
    process.exit(1);
  }

  getDb();
  const stdinData = readFileSync(0, "utf-8");
  const lines = stdinData.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);

  for (const line of lines) {
    if (!setHas(setName, line)) {
      process.stdout.write(line + "\n");
    }
  }
  process.exit(0);
}

function handleDeleteSet(): void {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--delete-set");
  if (idx === -1) return;

  const setName = args[idx + 1];
  if (!setName) {
    console.error("Usage: brain --delete-set <set-name>");
    process.exit(1);
  }

  getDb();
  try {
    const count = deleteSet(setName);
    console.log(`Deleted set "${setName}" (${count} member(s)).`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  process.exit(0);
}

function handleListSets(): void {
  if (!process.argv.includes("--list-sets")) return;

  getDb();
  const sets = listSets();
  if (sets.length === 0) {
    console.log("No sets found.");
  } else {
    for (const s of sets) {
      console.log(`${s.name}\t${s.member_count}`);
    }
  }
  process.exit(0);
}

function handleListSetMembers(): void {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--list-set-members");
  if (idx === -1) return;

  const setName = args[idx + 1];
  if (!setName) {
    console.error("Usage: brain --list-set-members <set-name>");
    process.exit(1);
  }

  getDb();
  const members = listSetMembers(setName);
  for (const m of members) {
    process.stdout.write(m + "\n");
  }
  process.exit(0);
}

// Support non-interactive flags
if (process.argv.includes("--search")) {
  handleSearch();
} else if (process.argv.includes("--list-projects")) {
  handleListProjects();
} else if (process.argv.includes("--list-chunks")) {
  handleListChunks();
} else if (process.argv.includes("--get-chunk")) {
  handleGetChunk();
} else if (process.argv.includes("--list-deleted")) {
  handleListDeleted();
} else if (process.argv.includes("--restore-chunk")) {
  handleRestoreChunk();
} else if (process.argv.includes("--empty-trash")) {
  handleEmptyTrash();
} else if (process.argv.includes("--list-queues")) {
  handleListQueues();
} else if (process.argv.includes("--list-queue-items")) {
  handleListQueueItems();
} else if (process.argv.includes("--next-queue-item")) {
  handleNextQueueItem();
} else if (process.argv.includes("--delete-queue-item")) {
  handleDeleteQueueItem();
} else if (process.argv.includes("--enqueue")) {
  handleStdinEnqueue();
} else if (process.argv.includes("--delete-queue")) {
  handleDeleteQueue();
} else if (process.argv.includes("--backup")) {
  handleBackup();
} else if (process.argv.includes("--install-cron")) {
  handleInstallCron();
} else if (process.argv.includes("--add-to-set")) {
  handleAddToSet();
} else if (process.argv.includes("--remove-from-set")) {
  handleRemoveFromSet();
} else if (process.argv.includes("--set-has")) {
  handleSetHas();
} else if (process.argv.includes("--in-set")) {
  handleInSet();
} else if (process.argv.includes("--not-in-set")) {
  handleNotInSet();
} else if (process.argv.includes("--delete-set")) {
  handleDeleteSet();
} else if (process.argv.includes("--list-sets")) {
  handleListSets();
} else if (process.argv.includes("--list-set-members")) {
  handleListSetMembers();
} else {
  mainMenu().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
