import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { writeFileSync, chmodSync, existsSync, readFileSync, readdirSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  getDb,
  closeDb,
  enqueue,
  getQueueLength,
  listQueueItems,
  listClaimedItems,
  claimNextQueueItem,
  deleteQueueItem,
} from "./db.js";
import { run } from "./queue-runner.js";
import { render } from "./display.js";

const TMP = join(tmpdir(), "brain-runner-test");

// Worker scripts
const WORKER_OK = join(TMP, "worker-ok.sh");
const WORKER_ECHO = join(TMP, "worker-echo.sh");
const WORKER_ENV = join(TMP, "worker-env.sh");

function writeScript(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

afterAll(() => {
  closeDb();
});

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });

  // Clean debug dirs from previous runs
  for (const dir of ["debug-stdin", "debug-env", "debug-test"]) {
    const p = join(TMP, dir);
    if (existsSync(p)) rmSync(p, { recursive: true });
  }

  const db = getDb();
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DELETE FROM queue_items;
    DELETE FROM queues;
    PRAGMA foreign_keys = ON;
  `);

  writeScript(WORKER_OK, "#!/bin/bash\ncat > /dev/null\nexit 0\n");

  writeScript(WORKER_ECHO, "#!/bin/bash\nvalue=$(cat)\necho \"processed: $value\"\nexit 0\n");

  writeScript(WORKER_ENV, "#!/bin/bash\ncat > /dev/null\necho \"id=$BRAIN_ITEM_ID\"\nexit 0\n");
});

describe("queue runner", () => {
  // ─── Basic success ───────────────────────────────────────

  it("processes all items successfully", async () => {
    enqueue("test-q", ["a", "b", "c"]);

    const result = await run({
      queueName: "test-q",
      concurrency: 2,
      command: ["bash", WORKER_OK],
      mode: "extra-silent",
    });

    expect(result.completed).toBe(3);
    expect(result.failed).toBe(0);
    expect(getQueueLength("test-q")).toBe(0);
  });

  it("returns completed=0 for empty queue", async () => {
    const result = await run({
      queueName: "nonexistent-q",
      concurrency: 1,
      command: ["bash", WORKER_OK],
      mode: "extra-silent",
    });

    expect(result.completed).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("leaves no claimed items after successful run", async () => {
    enqueue("clean-q", ["x", "y", "z"]);

    await run({
      queueName: "clean-q",
      concurrency: 2,
      command: ["bash", WORKER_OK],
      mode: "extra-silent",
    });

    expect(listClaimedItems("clean-q")).toEqual([]);
    expect(getQueueLength("clean-q")).toBe(0);
  });

  // ─── Stdin and env var ───────────────────────────────────

  it("passes item value via stdin", async () => {
    const debugDir = join(TMP, "debug-stdin");
    enqueue("stdin-q", ["hello-world"]);

    await run({
      queueName: "stdin-q",
      concurrency: 1,
      command: ["bash", WORKER_ECHO],
      mode: "extra-silent",
      debugDir,
    });

    const dirs = readdirSync(debugDir).filter((f) => f !== "runner.log");
    expect(dirs.length).toBe(1);
    const stdout = readFileSync(join(debugDir, dirs[0], "stdout"), "utf-8");
    expect(stdout.trim()).toBe("processed: hello-world");
  });

  it("exposes BRAIN_ITEM_ID env var to worker", async () => {
    const debugDir = join(TMP, "debug-env");
    enqueue("env-q", ["test-value"]);

    await run({
      queueName: "env-q",
      concurrency: 1,
      command: ["bash", WORKER_ENV],
      mode: "extra-silent",
      debugDir,
    });

    const dirs = readdirSync(debugDir).filter((f) => f !== "runner.log");
    expect(dirs.length).toBe(1);
    const itemDir = dirs[0];
    const stdout = readFileSync(join(debugDir, itemDir, "stdout"), "utf-8");
    expect(stdout.trim()).toBe(`id=${itemDir}`);
  });

  // ─── Failure: re-enqueue to tail ─────────────────────────

  it("re-enqueues failed items to the tail of the queue", () => {
    // Test the DB-level behavior that the runner performs on failure:
    // delete the claimed item, then re-enqueue its value (goes to tail)
    enqueue("fail-q", ["good", "bad", "also-good"]);

    const item = claimNextQueueItem("fail-q");
    expect(item!.value).toBe("good");

    const badItem = claimNextQueueItem("fail-q");
    expect(badItem!.value).toBe("bad");

    // Simulate failure: delete + re-enqueue (runner's failure path)
    deleteQueueItem(badItem!.id);
    enqueue("fail-q", [badItem!.value]);

    // Complete the good item
    deleteQueueItem(item!.id);

    // Unclaimed queue should now be: also-good (original), bad (re-enqueued at tail)
    const items = listQueueItems("fail-q");
    expect(items.length).toBe(2);
    expect(items[0].value).toBe("also-good");
    expect(items[1].value).toBe("bad");
  });

  // ─── Concurrency ─────────────────────────────────────────

  it("processes items with concurrency > 1", async () => {
    enqueue("conc-q", ["a", "b", "c", "d", "e"]);

    const result = await run({
      queueName: "conc-q",
      concurrency: 3,
      command: ["bash", WORKER_OK],
      mode: "extra-silent",
    });

    expect(result.completed).toBe(5);
    expect(result.failed).toBe(0);
  });

  it("works with concurrency 1", async () => {
    enqueue("seq-q", ["a", "b"]);

    const result = await run({
      queueName: "seq-q",
      concurrency: 1,
      command: ["bash", WORKER_OK],
      mode: "extra-silent",
    });

    expect(result.completed).toBe(2);
    expect(result.failed).toBe(0);
  });

  // ─── Debug output ────────────────────────────────────────

  it("writes per-item debug output when debugDir is set", async () => {
    const debugDir = join(TMP, "debug-test");
    enqueue("debug-q", ["item-one", "item-two"]);

    await run({
      queueName: "debug-q",
      concurrency: 1,
      command: ["bash", WORKER_ECHO],
      mode: "extra-silent",
      debugDir,
    });

    expect(existsSync(debugDir)).toBe(true);

    const dirs = readdirSync(debugDir).filter((f) => f !== "runner.log");
    expect(dirs.length).toBe(2);

    for (const dir of dirs) {
      const itemPath = join(debugDir, dir);
      expect(existsSync(join(itemPath, "stdout"))).toBe(true);
      expect(existsSync(join(itemPath, "stderr"))).toBe(true);
      expect(existsSync(join(itemPath, "meta.json"))).toBe(true);

      const meta = JSON.parse(readFileSync(join(itemPath, "meta.json"), "utf-8"));
      expect(meta.exitCode).toBe(0);
      expect(meta.result).toBe("completed");
      expect(typeof meta.elapsed).toBe("number");
      expect(typeof meta.value).toBe("string");
    }
  });

  it("does not create debug dir when debugDir is not set", async () => {
    enqueue("nodebug-q", ["item"]);

    await run({
      queueName: "nodebug-q",
      concurrency: 1,
      command: ["bash", WORKER_OK],
      mode: "extra-silent",
    });

    expect(existsSync(".brain-run")).toBe(false);
  });
});

// ─── Display rendering ─────────────────────────────────────

describe("display", () => {
  it("renders TUI state with slots and summary", () => {
    const output = render({
      queueName: "my-queue",
      slots: [
        { phase: "run", label: "src/controllers/UserCtrl.ts", startedAt: Date.now() - 12000 },
        { phase: "idle", label: "", startedAt: Date.now() },
        { phase: "run", label: "src/controllers/CartCtrl.ts", startedAt: Date.now() - 31000 },
      ],
      maxWorkers: 3,
      completed: 12,
      failed: 2,
      remaining: 34,
      draining: false,
      elapsed: 222000,
    });

    expect(output).toContain("brain queue run");
    expect(output).toContain("my-queue");
    expect(output).toContain("3 workers");
    expect(output).toContain("completed: 12");
    expect(output).toContain("failed: 2");
    expect(output).toContain("remaining: 34");
    expect(output).toContain("idle");
    expect(output).toContain("run");
  });

  it("shows DRAINING when draining", () => {
    const output = render({
      queueName: "q",
      slots: [],
      maxWorkers: 1,
      completed: 0,
      failed: 0,
      remaining: 0,
      draining: true,
      elapsed: 0,
    });

    expect(output).toContain("DRAINING");
  });

  it("truncates labels longer than 80 chars", () => {
    const longLabel = "a".repeat(90);
    const output = render({
      queueName: "q",
      slots: [{ phase: "run", label: longLabel, startedAt: Date.now() }],
      maxWorkers: 1,
      completed: 0,
      failed: 0,
      remaining: 1,
      draining: false,
      elapsed: 0,
    });

    expect(output).not.toContain(longLabel);
  });

  it("shows winding_down for excess slots", () => {
    const output = render({
      queueName: "q",
      slots: [
        { phase: "run", label: "item", startedAt: Date.now() },
        { phase: "run", label: "item2", startedAt: Date.now() },
      ],
      maxWorkers: 1,  // slot #2 is excess
      completed: 0,
      failed: 0,
      remaining: 2,
      draining: false,
      elapsed: 0,
    });

    expect(output).toContain("wind");
  });
});
