import { spawn, type ChildProcess } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  getDb,
  claimNextQueueItem,
  deleteQueueItem,
  enqueue,
  getQueueLength,
  releaseAllQueueItems,
} from "./db.js";
import * as display from "./display.js";
import type { SlotState, RunDisplayState } from "./display.js";

// ── Types ───────────────────────────────────────────────────────────────

export type OutputMode = "tui" | "stream" | "silent" | "extra-silent";

export interface RunOptions {
  queueName: string;
  concurrency: number;
  command: string[];
  mode: OutputMode;
  debugDir?: string;
  limit?: number;
}

export interface RunResult {
  completed: number;
  failed: number;
}

// ── State ───────────────────────────────────────────────────────────────

let draining = false;
let maxWorkers: number;
let queueName: string;
let command: string[];
let mode: OutputMode;
let debugDir: string | undefined;
let limit: number | undefined;
let claimed = 0;

let completed = 0;
let failed = 0;
let remaining = 0;
const startTime = { value: Date.now() };
const runtimes: number[] = [];

function recordRuntime(ms: number): void {
  runtimes.push(ms);
}

function runtimeStats(): { avgMs: number; medianMs: number } | null {
  if (runtimes.length === 0) return null;
  const sum = runtimes.reduce((a, b) => a + b, 0);
  const avgMs = sum / runtimes.length;
  const sorted = [...runtimes].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return { avgMs, medianMs };
}

let slotStates: SlotState[] = [];
let slots: (Promise<void> | null)[] = [];

type SlotHandle = { index: number };
let handles: (SlotHandle | null)[] = [];

// Active child processes for force-quit termination
const activeProcesses = new Set<ChildProcess>();

// ── Wake signal for pool resizing ───────────────────────────────────────

let wakeResolve: (() => void) | null = null;

function wakeMainLoop(): void {
  if (wakeResolve) {
    wakeResolve();
    wakeResolve = null;
  }
}

function newWakePromise(): Promise<void> {
  return new Promise((resolve) => {
    wakeResolve = resolve;
  });
}

// ── Display helpers ─────────────────────────────────────────────────────

function getDisplayState(): RunDisplayState {
  const stats = runtimeStats();
  return {
    queueName,
    slots: slotStates,
    maxWorkers,
    completed,
    failed,
    remaining,
    draining,
    elapsed: Date.now() - startTime.value,
    avgRuntimeMs: stats?.avgMs ?? null,
    medianRuntimeMs: stats?.medianMs ?? null,
  };
}

function refreshDisplay(): void {
  if (mode === "tui") {
    display.update(getDisplayState());
  }
}

function truncateLabel(value: string): string {
  const firstLine = value.split("\n")[0];
  return firstLine.length > 80 ? firstLine.slice(0, 79) + "\u2026" : firstLine;
}

// ── Stream/silent output ────────────────────────────────────────────────

function logProgress(
  success: boolean,
  value: string,
  workerStdout?: string,
  workerStderr?: string
): void {
  if (mode === "tui" || mode === "extra-silent") return;

  const total = completed + failed + remaining;
  const done = completed + failed;
  const mark = success ? "\u2713" : "\u2717";
  const label = truncateLabel(value);

  if (mode === "silent") {
    console.log(`[${done}/${total}] ${mark} ${label}`);
    return;
  }

  // stream mode — show progress + worker output
  console.log(`[${done}/${total}] ${mark} ${label}`);
  if (workerStdout?.trim()) {
    for (const line of workerStdout.trim().split("\n")) {
      console.log(`  ${line}`);
    }
  }
  if (workerStderr?.trim()) {
    for (const line of workerStderr.trim().split("\n")) {
      console.error(`  ${line}`);
    }
  }
}

// ── Debug logging ───────────────────────────────────────────────────────

function writeDebug(
  itemId: number,
  value: string,
  exitCode: number | null,
  stdout: string,
  stderr: string,
  elapsedMs: number,
  result: "completed" | "failed"
): void {
  if (!debugDir) return;
  const itemDir = join(debugDir, String(itemId));
  mkdirSync(itemDir, { recursive: true });
  writeFileSync(join(itemDir, "stdout"), stdout);
  writeFileSync(join(itemDir, "stderr"), stderr);
  writeFileSync(
    join(itemDir, "meta.json"),
    JSON.stringify({ value, exitCode, elapsed: elapsedMs, result }, null, 2)
  );
}

// ── Worker execution ────────────────────────────────────────────────────

function runWorker(
  value: string,
  itemId: number
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = command;
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, BRAIN_ITEM_ID: String(itemId) },
    });

    activeProcesses.add(child);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    // Write item value to worker's stdin
    child.stdin.write(value);
    child.stdin.end();

    child.on("error", (err) => {
      activeProcesses.delete(child);
      reject(err);
    });

    child.on("close", (code) => {
      activeProcesses.delete(child);
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
      });
    });
  });
}

// ── Thread (slot) execution ─────────────────────────────────────────────

async function runSlot(handle: SlotHandle): Promise<void> {
  slotStates[handle.index] = {
    phase: "idle",
    label: "",
    startedAt: Date.now(),
  };

  // Limit reached — stop claiming
  if (limit !== undefined && claimed >= limit) {
    draining = true;
    refreshDisplay();
    return;
  }

  // Claim next item
  const item = claimNextQueueItem(queueName);
  if (!item) {
    // Queue empty — signal drain
    draining = true;
    refreshDisplay();
    return;
  }
  claimed++;
  if (limit !== undefined && claimed >= limit) {
    // Soft-drain: don't start any new work after this one
    draining = true;
  }

  const label = truncateLabel(item.value);
  slotStates[handle.index] = {
    phase: "run",
    label,
    startedAt: Date.now(),
  };
  remaining = getQueueLength(queueName);
  refreshDisplay();

  const slotStart = Date.now();
  try {
    const result = await runWorker(item.value, item.id);
    const elapsedMs = Date.now() - slotStart;
    recordRuntime(elapsedMs);

    if (result.code === 0) {
      // Success — delete the item (complete)
      deleteQueueItem(item.id);
      completed++;
      writeDebug(
        item.id,
        item.value,
        result.code,
        result.stdout,
        result.stderr,
        elapsedMs,
        "completed"
      );
      logProgress(true, item.value, result.stdout, result.stderr);
    } else {
      // Failure — delete and re-enqueue to tail
      const itemValue = item.value;
      deleteQueueItem(item.id);
      enqueue(queueName, [itemValue]);
      failed++;
      writeDebug(
        item.id,
        item.value,
        result.code,
        result.stdout,
        result.stderr,
        elapsedMs,
        "failed"
      );
      logProgress(false, item.value, result.stdout, result.stderr);
    }
  } catch (err) {
    // Spawn error — delete and re-enqueue to tail
    const itemValue = item.value;
    const elapsedMs = Date.now() - slotStart;
    recordRuntime(elapsedMs);
    try {
      deleteQueueItem(item.id);
      enqueue(queueName, [itemValue]);
    } catch {
      // If we can't even re-enqueue, the item is lost
    }
    failed++;
    const errMsg = err instanceof Error ? err.message : String(err);
    writeDebug(item.id, item.value, null, "", errMsg, elapsedMs, "failed");
    logProgress(false, item.value);
  }

  remaining = getQueueLength(queueName);
  slotStates[handle.index] = { phase: "idle", label: "", startedAt: Date.now() };
  refreshDisplay();
}

// ── Pool resizing ───────────────────────────────────────────────────────

function spliceSlot(i: number): void {
  slotStates.splice(i, 1);
  slots.splice(i, 1);
  handles.splice(i, 1);
  for (let j = i; j < handles.length; j++) {
    if (handles[j]) handles[j]!.index = j;
  }
}

function trimIdleSlots(): void {
  // Remove idle slots from the end until we're at maxWorkers size
  for (let i = slots.length - 1; i >= 0 && slots.length > maxWorkers; i--) {
    if (slots[i] === null) {
      spliceSlot(i);
    }
  }
}

export function resizePool(newSize: number): void {
  if (newSize < 1) return;
  const oldSize = maxWorkers;
  maxWorkers = newSize;

  if (newSize > oldSize) {
    for (let i = oldSize; i < newSize; i++) {
      slotStates.push({ phase: "idle", label: "", startedAt: Date.now() });
      slots.push(null);
      handles.push(null);
    }
    wakeMainLoop();
  } else if (newSize < oldSize) {
    let toRemove = oldSize - newSize;
    for (let i = slots.length - 1; i >= 0 && toRemove > 0; i--) {
      if (slots[i] === null) {
        spliceSlot(i);
        toRemove--;
      }
    }
  }

  remaining = getQueueLength(queueName);
  refreshDisplay();
}

// ── Keyboard input ──────────────────────────────────────────────────────

let sigintCount = 0;

function setupKeyboardInput(): void {
  if (!process.stdin.isTTY) return;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", (key: string) => {
    // Ctrl+C
    if (key === "\x03") {
      sigintCount++;
      if (sigintCount === 1) {
        draining = true;
        refreshDisplay();
      } else {
        forceQuit();
      }
      return;
    }

    // Increase pool: + or =
    if (key === "+" || key === "=") {
      resizePool(maxWorkers + 1);
      return;
    }

    // Decrease pool: -
    if (key === "-") {
      resizePool(maxWorkers - 1);
      return;
    }
  });
}

function teardownKeyboardInput(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

function forceQuit(): void {
  teardownKeyboardInput();

  // Kill all active child processes
  for (const child of activeProcesses) {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }

  if (mode === "tui") {
    display.destroy(getDisplayState());
  }

  if (mode !== "extra-silent") {
    console.log("\nForce quit \u2014 releasing all claimed items...");
  }

  try {
    releaseAllQueueItems(queueName);
    if (mode !== "extra-silent") {
      console.log("Released. Items are back in the queue.");
    }
  } catch (err) {
    if (mode !== "extra-silent") {
      console.error("Failed to release items:", err);
    }
  }

  process.exit(1);
}

// ── Main loop ───────────────────────────────────────────────────────────

export async function run(options: RunOptions): Promise<RunResult> {
  // Reset module state for clean runs
  draining = false;
  sigintCount = 0;
  completed = 0;
  failed = 0;
  claimed = 0;
  runtimes.length = 0;
  startTime.value = Date.now();
  display.reset();

  queueName = options.queueName;
  maxWorkers = options.concurrency;
  command = options.command;
  mode = options.mode;
  debugDir = options.debugDir;
  limit = options.limit;

  getDb();

  remaining = getQueueLength(queueName);

  if (remaining === 0) {
    if (mode !== "extra-silent") {
      console.log(`Queue "${queueName}" is empty, nothing to run.`);
    }
    return { completed: 0, failed: 0 };
  }

  slotStates = Array.from({ length: maxWorkers }, () => ({
    phase: "idle" as const,
    label: "",
    startedAt: Date.now(),
  }));
  slots = new Array(maxWorkers).fill(null);
  handles = new Array(maxWorkers).fill(null);

  let sigintHandler: (() => void) | null = null;

  if (mode === "tui") {
    setupKeyboardInput();
  } else {
    // Non-TUI: still handle Ctrl+C for graceful shutdown
    sigintHandler = () => {
      sigintCount++;
      if (sigintCount === 1) {
        draining = true;
        if (mode !== "extra-silent") {
          console.log("\nDraining... finishing active workers.");
        }
      } else {
        forceQuit();
      }
    };
    process.on("SIGINT", sigintHandler);
  }

  refreshDisplay();

  const tick = mode === "tui" ? setInterval(refreshDisplay, 1000) : null;

  while (true) {
    trimIdleSlots();

    let activeCount = slots.filter((s) => s !== null).length;
    for (let i = 0; i < slots.length && activeCount < maxWorkers; i++) {
      if (slots[i] === null && !draining) {
        const handle: SlotHandle = { index: i };
        handles[i] = handle;
        activeCount++;
        slots[i] = runSlot(handle).finally(() => {
          slots[handle.index] = null;
          handles[handle.index] = null;
        });
      }
    }

    const active = slots.filter((s): s is Promise<void> => s !== null);
    if (active.length === 0) break;

    await Promise.race([...active, newWakePromise()]);
  }

  if (tick) clearInterval(tick);

  if (mode === "tui") {
    teardownKeyboardInput();
    display.destroy(getDisplayState());
  } else if (sigintHandler) {
    process.removeListener("SIGINT", sigintHandler);
  }

  if (debugDir && mode !== "extra-silent") {
    console.log(`Debug logs: ${debugDir}`);
  }

  return { completed, failed };
}
