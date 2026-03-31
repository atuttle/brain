#!/usr/bin/env node

import { Command } from "commander";
import { intro, outro, select, confirm, text, isCancel, cancel, log } from "@clack/prompts";
import {
  getDb,
  getDbPath,
  listProjectDetails,
  getProject,
  listTasks,
  getTask,
  searchTasks,
  listDeletedTasks,
  restoreTask,
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
  type TaskSummary,
} from "./db.js";
import { execSync } from "child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { dirname, join } from "path";

const BACKUP_DIR = join(dirname(getDbPath()), "backups");

// ─── Commander setup ────────────────────────────────────

const program = new Command("brain")
  .description("Persistent task memory and work queues for Claude Code")
  .version("1.0.0")
  .action(() => {
    // bare `brain` → interactive TUI
    mainMenu().catch((err) => {
      console.error(err);
      process.exit(1);
    });
  });

// ─── brain project ──────────────────────────────────────

const project = program
  .command("project")
  .description("Manage projects and tasks");

project
  .command("list")
  .description("List projects, or list tasks in a project")
  .argument("[project]", "project name — omit to list all projects")
  .option("--status <status>", "filter tasks by status")
  .action((proj: string | undefined, opts: { status?: string }) => {
    getDb();
    if (!proj) {
      const projects = listProjectDetails();
      if (projects.length === 0) {
        console.log("No projects found.");
        return;
      }
      for (const p of projects) {
        console.log(`${p.name}\t${p.task_count}`);
      }
    } else {
      const tasks = listTasks(proj, opts.status);
      if (tasks.length === 0) {
        console.log("No tasks found.");
        return;
      }
      for (const t of tasks) {
        console.log(`${t.id}\t${t.status}\t${t.sequence || ""}\t${t.title}`);
      }
    }
  });

project
  .command("get-task")
  .description("Get full task content as JSON")
  .argument("<id>", "task ID")
  .action((rawId: string) => {
    getDb();
    const id = Number(rawId);
    if (!Number.isInteger(id)) {
      console.error("Invalid task ID.");
      process.exit(1);
    }
    const task = getTask(id);
    if (!task) {
      console.error("Task not found.");
      process.exit(1);
    }
    console.log(JSON.stringify(task));
  });

project
  .command("search")
  .description("Full-text search across tasks")
  .argument("<query...>", "search terms")
  .option("--project <project>", "limit to a specific project")
  .option("--status <status>", "limit to a specific status")
  .action((queryParts: string[], opts: { project?: string; status?: string }) => {
    getDb();
    const query = queryParts.join(" ");
    const results = searchTasks(query, opts.project, opts.status);
    if (results.length === 0) {
      console.log("No matching tasks.");
      return;
    }
    for (const t of results) {
      console.log(`${t.id}\t${t.project}\t${t.status}\t${t.title}`);
    }
  });

project
  .command("list-deleted")
  .description("List soft-deleted tasks")
  .argument("[project]", "limit to a specific project")
  .action((proj: string | undefined) => {
    getDb();
    const deleted = listDeletedTasks(proj);
    if (deleted.length === 0) {
      console.log("Trash is empty.");
      return;
    }
    for (const t of deleted) {
      console.log(`${t.id}\t${t.project}\t${t.title}\t${t.deleted_at}`);
    }
  });

project
  .command("restore-task")
  .description("Restore a soft-deleted task")
  .argument("<id>", "task ID")
  .action((rawId: string) => {
    getDb();
    const id = Number(rawId);
    if (!Number.isInteger(id)) {
      console.error("Invalid task ID.");
      process.exit(1);
    }
    try {
      const restored = restoreTask(id);
      console.log(`Restored task #${restored.id}: ${restored.title}`);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

project
  .command("empty-trash")
  .description("Permanently delete all trashed tasks")
  .argument("[project]", "limit to a specific project")
  .action((proj: string | undefined) => {
    getDb();
    const count = emptyTrash(proj);
    console.log(`Permanently deleted ${count} task(s).`);
  });

// ─── brain queue ────────────────────────────────────────

const queue = program
  .command("queue")
  .description("Manage work queues");

queue
  .command("list")
  .description("List all queues with item counts")
  .action(() => {
    getDb();
    const queues = listQueues();
    if (queues.length === 0) {
      console.log("No queues found.");
      return;
    }
    for (const q of queues) {
      console.log(`${q.name}\t${q.item_count}`);
    }
  });

queue
  .command("items")
  .description("List all items in a queue")
  .argument("<queue>", "queue name")
  .action((queueName: string) => {
    getDb();
    const items = listQueueItems(queueName);
    if (items.length === 0) {
      console.log("Queue is empty.");
      return;
    }
    for (const item of items) {
      console.log(`${item.id}\t${item.value}`);
    }
  });

queue
  .command("add")
  .description("Enqueue items from stdin (one per line)")
  .argument("<queue>", "queue name (auto-created if new)")
  .action((queueName: string) => {
    getDb();
    const stdinData = readFileSync(0, "utf-8");
    const lines = stdinData.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
    if (lines.length === 0) {
      console.log("No items to enqueue (stdin was empty).");
      return;
    }
    const ids = enqueue(queueName, lines);
    console.log(`Enqueued ${ids.length} item(s) in "${queueName}".`);
  });

queue
  .command("next")
  .description("Peek at the next FIFO item without removing it")
  .argument("<queue>", "queue name")
  .action((queueName: string) => {
    getDb();
    const item = getNextQueueItem(queueName);
    if (!item) {
      process.exit(1);
    }
    console.log(`${item.id}\t${item.value}`);
  });

queue
  .command("delete-item")
  .description("Delete a queue item by ID (call after processing)")
  .argument("<id>", "queue item ID")
  .action((rawId: string) => {
    getDb();
    const id = Number(rawId);
    if (!Number.isInteger(id)) {
      console.error("Invalid item ID.");
      process.exit(1);
    }
    try {
      deleteQueueItem(id);
      console.log(`Deleted queue item #${id}.`);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

queue
  .command("delete")
  .description("Delete an entire queue and all its items")
  .argument("<queue>", "queue name")
  .action((queueName: string) => {
    getDb();
    try {
      deleteQueue(queueName);
      console.log(`Deleted queue "${queueName}".`);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

// ─── brain set ──────────────────────────────────────────

const set = program
  .command("set")
  .description("Manage sets");

set
  .command("list")
  .description("List all sets with member counts")
  .action(() => {
    getDb();
    const sets = listSets();
    if (sets.length === 0) {
      console.log("No sets found.");
      return;
    }
    for (const s of sets) {
      console.log(`${s.name}\t${s.member_count}`);
    }
  });

set
  .command("members")
  .description("List all keys in a set")
  .argument("<set>", "set name")
  .action((setName: string) => {
    getDb();
    const members = listSetMembers(setName);
    for (const m of members) {
      process.stdout.write(m + "\n");
    }
  });

set
  .command("add")
  .description("Add keys to a set from stdin or --key")
  .argument("<set>", "set name (auto-created if new)")
  .option("--key <key>", "single key to add (instead of stdin)")
  .action((setName: string, opts: { key?: string }) => {
    getDb();
    if (opts.key) {
      addToSet(setName, opts.key);
      console.log(`Added "${opts.key}" to set "${setName}".`);
    } else {
      const stdinData = readFileSync(0, "utf-8");
      const keys = stdinData.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
      if (keys.length === 0) {
        console.log("No keys to add (stdin was empty).");
        return;
      }
      const added = addManyToSet(setName, keys);
      console.log(`Added ${added} key(s) to set "${setName}" (${keys.length - added} already existed).`);
    }
  });

set
  .command("remove")
  .description("Remove a key from a set")
  .argument("<set>", "set name")
  .requiredOption("--key <key>", "key to remove")
  .action((setName: string, opts: { key: string }) => {
    getDb();
    try {
      removeFromSet(setName, opts.key);
      console.log(`Removed "${opts.key}" from set "${setName}".`);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

set
  .command("has")
  .description("Check if a key exists in a set (exit 0=yes, 1=no)")
  .argument("<set>", "set name")
  .requiredOption("--key <key>", "key to check")
  .action((setName: string, opts: { key: string }) => {
    getDb();
    if (setHas(setName, opts.key)) {
      console.log("true");
    } else {
      console.log("false");
      process.exit(1);
    }
  });

set
  .command("in")
  .description("Filter stdin to lines that are members of the set")
  .argument("<set>", "set name")
  .action((setName: string) => {
    getDb();
    const stdinData = readFileSync(0, "utf-8");
    const lines = stdinData.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
    for (const line of lines) {
      if (setHas(setName, line)) {
        process.stdout.write(line + "\n");
      }
    }
  });

set
  .command("not-in")
  .description("Filter stdin to lines that are NOT members of the set")
  .argument("<set>", "set name")
  .action((setName: string) => {
    getDb();
    const stdinData = readFileSync(0, "utf-8");
    const lines = stdinData.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
    for (const line of lines) {
      if (!setHas(setName, line)) {
        process.stdout.write(line + "\n");
      }
    }
  });

set
  .command("delete")
  .description("Delete an entire set and all its members")
  .argument("<set>", "set name")
  .action((setName: string) => {
    getDb();
    try {
      const count = deleteSet(setName);
      console.log(`Deleted set "${setName}" (${count} member(s)).`);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

// ─── brain backup ───────────────────────────────────────

const backup = program
  .command("backup")
  .description("Create a database backup")
  .action(() => {
    getDb();
    runBackup();
  });

backup
  .command("install-cron")
  .description("Install an hourly backup cron job")
  .action(() => {
    const nodePath = process.execPath;
    const cliPath = process.argv[1];
    const cronLine = `0 * * * * "${nodePath}" "${cliPath}" backup`;

    try {
      const existing = execSync("crontab -l 2>/dev/null", {
        encoding: "utf-8",
      }).trim();

      if (existing.includes("brain")) {
        console.log("Cron job already installed.");
        return;
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
  });

// ─── Parse ──────────────────────────────────────────────

program.parse();

// ─── Helpers ────────────────────────────────────────────

function runBackup(): void {
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
    console.error(`Cleaned ${removed} old backup(s).`);
  }
}

// ─── Interactive TUI ────────────────────────────────────

function formatTask(t: TaskSummary): string {
  return `[${t.sequence || "-"}] #${t.id} (${t.status}) ${t.title}`;
}

function bail(value: unknown): value is symbol {
  if (isCancel(value)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  return false;
}

async function mainMenu(): Promise<void> {
  intro("brain");

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
        await installCronInteractive();
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
        label: `${p.name}  (${p.task_count} tasks)`,
        value: p.name,
      })),
      { label: "← Back", value: "" },
    ],
  });
  if (bail(choice)) return;
  if (!choice) return;

  await projectMenuInteractive(choice);
}

async function projectMenuInteractive(projectName: string): Promise<void> {
  const proj = getProject(projectName);
  if (!proj) return;

  while (true) {
    const action = await select({
      message: `${projectName}`,
      options: [
        { label: "Browse tasks", value: "browse" },
        { label: "Search tasks", value: "search" },
        { label: "View deleted tasks", value: "trash" },
        { label: "Restore a task", value: "restore" },
        { label: "Empty trash", value: "empty-trash" },
        { label: "← Back", value: "back" },
      ],
    });
    if (bail(action)) return;

    switch (action) {
      case "browse":
        await browseTasks(projectName, proj);
        break;
      case "search":
        await searchMenuInteractive(projectName);
        break;
      case "trash":
        await viewTrash(projectName);
        break;
      case "restore":
        await restoreMenuInteractive(projectName);
        break;
      case "empty-trash":
        await emptyTrashMenuInteractive(projectName);
        break;
      case "back":
        return;
    }
  }
}

async function browseTasks(projectName: string, proj: import("./db.js").Project): Promise<void> {
  const statusFilter = await select({
    message: "Filter by status",
    options: [
      { label: "All", value: "" },
      ...proj.states.map((s) => ({ label: s, value: s })),
    ],
  });
  if (bail(statusFilter)) return;

  const tasks = listTasks(projectName, statusFilter || undefined);
  if (tasks.length === 0) {
    log.info("No tasks found.");
    return;
  }

  log.info(`${tasks.length} task(s):`);

  const taskChoice = await select({
    message: "Select task to view",
    options: [
      ...tasks.map((t) => ({
        label: formatTask(t),
        value: t.id,
      })),
      { label: "← Back", value: -1 as number },
    ],
  });
  if (bail(taskChoice)) return;

  if (taskChoice === -1) return;

  const full = getTask(taskChoice);
  if (!full) {
    log.error("Task not found.");
    return;
  }

  log.info(`${"─".repeat(60)}`);
  log.message(`#${full.id} (${full.status}) — ${full.title}`);
  log.message(`Sequence: ${full.sequence || "(none)"}  Created: ${full.created_at}  Updated: ${full.updated_at}`);
  log.info(`${"─".repeat(60)}`);
  log.message(full.body || "(empty body)");
  log.info(`${"─".repeat(60)}`);
}

async function searchMenuInteractive(projectName: string): Promise<void> {
  const query = await text({ message: "Search query" });
  if (bail(query)) return;
  if (!query.trim()) return;

  const results = searchTasks(query.trim(), projectName);
  if (results.length === 0) {
    log.info("No matching tasks.");
    return;
  }

  log.info(`${results.length} result(s):`);
  log.message(results.map((t) => `  #${t.id} (${t.status}) ${t.title}`).join("\n"));
}

async function viewTrash(projectName: string): Promise<void> {
  const deleted = listDeletedTasks(projectName);
  if (deleted.length === 0) {
    log.info("Trash is empty.");
    return;
  }

  log.info(`${deleted.length} deleted task(s):`);
  log.message(deleted.map((t) => `  #${t.id} ${t.title} — deleted ${t.deleted_at}`).join("\n"));
}

async function restoreMenuInteractive(projectName: string): Promise<void> {
  const deleted = listDeletedTasks(projectName);
  if (deleted.length === 0) {
    log.info("Trash is empty.");
    return;
  }

  const taskId = await select({
    message: "Select task to restore",
    options: [
      ...deleted.map((t) => ({
        label: `#${t.id} ${t.title} — deleted ${t.deleted_at}`,
        value: t.id,
      })),
      { label: "← Back", value: -1 as number },
    ],
  });
  if (bail(taskId)) return;

  if (taskId === -1) return;

  const restored = restoreTask(taskId);
  log.success(`Restored task #${restored.id}: ${restored.title}`);
}

async function emptyTrashMenuInteractive(projectName: string): Promise<void> {
  const deleted = listDeletedTasks(projectName);
  if (deleted.length === 0) {
    log.info("Trash is empty.");
    return;
  }

  log.info(`${deleted.length} task(s) in trash:`);
  log.message(deleted.map((t) => `  #${t.id} ${t.title} — deleted ${t.deleted_at}`).join("\n"));

  const ok = await confirm({
    message: `Permanently delete ${deleted.length} task(s)? This cannot be undone.`,
  });
  if (bail(ok)) return;
  if (!ok) return;

  const count = emptyTrash(projectName);
  log.success(`Permanently deleted ${count} task(s).`);
}

async function globalEmptyTrashMenu(): Promise<void> {
  const deleted = listDeletedTasks();
  if (deleted.length === 0) {
    log.info("Trash is empty.");
    return;
  }

  log.info(`${deleted.length} task(s) in trash:`);
  log.message(deleted.map((t) => `  #${t.id} [${t.project}] ${t.title} — deleted ${t.deleted_at}`).join("\n"));

  const ok = await confirm({
    message: `Permanently delete ${deleted.length} task(s) across all projects? This cannot be undone.`,
  });
  if (bail(ok)) return;
  if (!ok) return;

  const count = emptyTrash();
  log.success(`Permanently deleted ${count} task(s).`);
}

// --- Queue interactive menus ---

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
      listQueuesInteractive();
      break;
    case "view":
      await viewQueueMenu();
      break;
    case "enqueue":
      await enqueueMenuInteractive();
      break;
    case "delete-item":
      await deleteQueueItemMenuInteractive();
      break;
    case "delete-queue":
      await deleteQueueMenuInteractive();
      break;
  }
}

function listQueuesInteractive(): void {
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
  const queueName = await pickQueue();
  if (!queueName) return;

  const items = listQueueItems(queueName);
  if (items.length === 0) {
    log.info("Queue is empty.");
    return;
  }

  log.info(`${items.length} item(s) in "${queueName}":`);
  log.message(items.map((item) => `  #${item.id}  ${item.value}`).join("\n"));
}

async function enqueueMenuInteractive(): Promise<void> {
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

async function deleteQueueItemMenuInteractive(): Promise<void> {
  const queueName = await pickQueue();
  if (!queueName) return;

  const items = listQueueItems(queueName);
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

async function deleteQueueMenuInteractive(): Promise<void> {
  const queueName = await pickQueue();
  if (!queueName) return;

  const items = listQueueItems(queueName);
  const ok = await confirm({
    message: `Delete queue "${queueName}" and its ${items.length} item(s)? This cannot be undone.`,
  });
  if (bail(ok)) return;
  if (!ok) return;

  deleteQueue(queueName);
  log.success(`Deleted queue "${queueName}".`);
}

// --- Set interactive menus ---

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
        await addToSetMenuInteractive();
        break;
      case "check":
        await checkSetMenuInteractive();
        break;
      case "remove":
        await removeFromSetMenuInteractive();
        break;
      case "delete":
        await deleteSetMenuInteractive();
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
  const setName = await pickSet();
  if (!setName) return;

  const members = listSetMembers(setName);
  if (members.length === 0) {
    log.info("Set is empty.");
    return;
  }

  log.info(`${members.length} member(s) in "${setName}":`);
  log.message(members.map((m) => `  ${m}`).join("\n"));
}

async function addToSetMenuInteractive(): Promise<void> {
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

async function checkSetMenuInteractive(): Promise<void> {
  const setName = await pickSet();
  if (!setName) return;

  const key = await text({ message: "Key to check" });
  if (bail(key)) return;
  if (!key.trim()) return;

  if (setHas(setName, key.trim())) {
    log.success(`"${key.trim()}" IS in set "${setName}".`);
  } else {
    log.info(`"${key.trim()}" is NOT in set "${setName}".`);
  }
}

async function removeFromSetMenuInteractive(): Promise<void> {
  const setName = await pickSet();
  if (!setName) return;

  const members = listSetMembers(setName);
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

  removeFromSet(setName, key);
  log.success(`Removed "${key}" from set "${setName}".`);
}

async function deleteSetMenuInteractive(): Promise<void> {
  const setName = await pickSet();
  if (!setName) return;

  const members = listSetMembers(setName);
  const ok = await confirm({
    message: `Delete set "${setName}" and its ${members.length} member(s)? This cannot be undone.`,
  });
  if (bail(ok)) return;
  if (!ok) return;

  const count = deleteSet(setName);
  log.success(`Deleted set "${setName}" (${count} member(s)).`);
}

async function installCronInteractive(): Promise<void> {
  const ok = await confirm({
    message: "Install hourly backup cron job?",
  });
  if (bail(ok)) return;
  if (!ok) return;

  const nodePath = process.execPath;
  const cliPath = process.argv[1];
  const cronLine = `0 * * * * "${nodePath}" "${cliPath}" backup`;

  try {
    const existing = execSync("crontab -l 2>/dev/null", {
      encoding: "utf-8",
    }).trim();

    if (existing.includes("brain")) {
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
