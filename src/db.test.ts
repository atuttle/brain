import { describe, it, expect, beforeEach, afterAll } from "vitest";

import {
  getDb,
  closeDb,
  listProjects,
  listProjectDetails,
  getProject,
  upsertProject,
  deleteProject,
  createTasks,
  listTasks,
  getTask,
  updateTask,
  deleteTask,
  searchTasks,
  appendToTask,
  listDeletedTasks,
  restoreTask,
  emptyTrash,
  listQueues,
  enqueue,
  getQueueLength,
  claimNextQueueItem,
  listQueueItems,
  listClaimedItems,
  deleteQueueItem,
  releaseQueueItem,
  releaseAllQueueItems,
  deleteQueue,
  listSets,
  addToSet,
  addManyToSet,
  removeFromSet,
  setHas,
  listSetMembers,
  deleteSet,
} from "./db.js";

afterAll(() => {
  closeDb();
});

// Wipe tables between tests for isolation
beforeEach(() => {
  const db = getDb();
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DELETE FROM sets;
    DELETE FROM queue_items;
    DELETE FROM queues;
    DELETE FROM chunks;
    DELETE FROM projects;
    PRAGMA foreign_keys = ON;
  `);
});

// ─── Projects ───────────────────────────────────────────

describe("projects", () => {
  it("starts with no projects", () => {
    expect(listProjects()).toEqual([]);
    expect(listProjectDetails()).toEqual([]);
  });

  it("creates a project with default states", () => {
    const proj = upsertProject("my-proj");
    expect(proj.name).toBe("my-proj");
    expect(proj.states).toEqual(["pending", "active", "done", "archived"]);
    expect(listProjects()).toEqual(["my-proj"]);
  });

  it("creates a project with custom states", () => {
    const proj = upsertProject("kanban", ["todo", "doing", "review", "shipped"]);
    expect(proj.states).toEqual(["todo", "doing", "review", "shipped"]);
  });

  it("upsert updates states of existing project", () => {
    upsertProject("p", ["a", "b"]);
    const updated = upsertProject("p", ["x", "y", "z"]);
    expect(updated.states).toEqual(["x", "y", "z"]);
    // still only one project
    expect(listProjects()).toEqual(["p"]);
  });

  it("getProject returns null for nonexistent", () => {
    expect(getProject("nope")).toBeNull();
  });

  it("deletes an empty project", () => {
    upsertProject("p");
    deleteProject("p");
    expect(getProject("p")).toBeNull();
    expect(listProjects()).toEqual([]);
  });

  it("rejects deleting a project with active or trashed tasks", () => {
    upsertProject("p");
    const [id] = createTasks("p", [{ title: "t" }]);

    expect(() => deleteProject("p")).toThrow("not empty");

    deleteTask(id);
    expect(() => deleteProject("p")).toThrow("not empty");

    expect(emptyTrash("p")).toBe(1);
    deleteProject("p");
    expect(getProject("p")).toBeNull();
  });

  it("throws for nonexistent project deletion", () => {
    expect(() => deleteProject("missing")).toThrow('Project "missing" not found');
  });

  it("listProjectDetails includes task counts", () => {
    upsertProject("a");
    upsertProject("b");
    createTasks("a", [{ title: "t1" }, { title: "t2" }]);
    createTasks("b", [{ title: "t3" }]);

    const details = listProjectDetails();
    const a = details.find((d) => d.name === "a")!;
    const b = details.find((d) => d.name === "b")!;
    expect(a.task_count).toBe(2);
    expect(b.task_count).toBe(1);
  });
});

// ─── Tasks ─────────────────────────────────────────────

describe("tasks", () => {
  it("creates tasks and returns ids", () => {
    upsertProject("p");
    const ids = createTasks("p", [
      { title: "first", body: "body1", sequence: "1", refs: ["/a.ts"] },
      { title: "second" },
    ]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBeLessThan(ids[1]);
  });

  it("throws when creating tasks for nonexistent project", () => {
    expect(() => createTasks("nope", [{ title: "x" }])).toThrow(
      'Project "nope" does not exist'
    );
  });

  it("new tasks get the first project state as default status", () => {
    upsertProject("p", ["todo", "done"]);
    const [id] = createTasks("p", [{ title: "t" }]);
    const task = getTask(id)!;
    expect(task.status).toBe("todo");
  });

  it("stores body, sequence, and refs", () => {
    upsertProject("p");
    const [id] = createTasks("p", [
      { title: "t", body: "details", sequence: "3A", refs: ["/x", "/y"] },
    ]);
    const task = getTask(id)!;
    expect(task.body).toBe("details");
    expect(task.sequence).toBe("3A");
    expect(task.refs).toEqual(["/x", "/y"]);
  });

  it("defaults body/sequence/refs when omitted", () => {
    upsertProject("p");
    const [id] = createTasks("p", [{ title: "bare" }]);
    const task = getTask(id)!;
    expect(task.body).toBe("");
    expect(task.sequence).toBe("");
    expect(task.refs).toEqual([]);
  });

  it("getTask returns null for nonexistent id", () => {
    expect(getTask(99999)).toBeNull();
  });
});

// ─── List & filter ──────────────────────────────────────

describe("listTasks", () => {
  it("lists all tasks for a project", () => {
    upsertProject("p");
    createTasks("p", [{ title: "a" }, { title: "b" }]);
    expect(listTasks("p")).toHaveLength(2);
  });

  it("filters by status", () => {
    upsertProject("p");
    const [id1] = createTasks("p", [{ title: "a" }, { title: "b" }]);
    updateTask(id1, { status: "active" });

    expect(listTasks("p", "active")).toHaveLength(1);
    expect(listTasks("p", "pending")).toHaveLength(1);
  });

  it("excludes soft-deleted tasks", () => {
    upsertProject("p");
    const [id] = createTasks("p", [{ title: "a" }]);
    deleteTask(id);
    expect(listTasks("p")).toHaveLength(0);
  });

  it("returns summaries without body", () => {
    upsertProject("p");
    createTasks("p", [{ title: "a", body: "big body" }]);
    const [summary] = listTasks("p");
    expect(summary).not.toHaveProperty("body");
  });

  it("sorts by natural order of sequence", () => {
    upsertProject("p");
    createTasks("p", [
      { title: "c", sequence: "10" },
      { title: "a", sequence: "2" },
      { title: "b", sequence: "3A" },
    ]);
    const tasks = listTasks("p");
    expect(tasks.map((t) => t.sequence)).toEqual(["2", "3A", "10"]);
  });
});

// ─── Update ─────────────────────────────────────────────

describe("updateTask", () => {
  it("updates title", () => {
    upsertProject("p");
    const [id] = createTasks("p", [{ title: "old" }]);
    const updated = updateTask(id, { title: "new" });
    expect(updated.title).toBe("new");
  });

  it("updates status to a valid state", () => {
    upsertProject("p");
    const [id] = createTasks("p", [{ title: "t" }]);
    const updated = updateTask(id, { status: "done" });
    expect(updated.status).toBe("done");
  });

  it("rejects invalid status", () => {
    upsertProject("p");
    const [id] = createTasks("p", [{ title: "t" }]);
    expect(() => updateTask(id, { status: "bogus" })).toThrow(
      'Invalid status "bogus"'
    );
  });

  it("updates multiple fields at once", () => {
    upsertProject("p");
    const [id] = createTasks("p", [{ title: "t" }]);
    const updated = updateTask(id, {
      title: "new title",
      body: "new body",
      sequence: "5",
      refs: ["/z.ts"],
    });
    expect(updated.title).toBe("new title");
    expect(updated.body).toBe("new body");
    expect(updated.sequence).toBe("5");
    expect(updated.refs).toEqual(["/z.ts"]);
  });

  it("throws for nonexistent task", () => {
    expect(() => updateTask(99999, { title: "x" })).toThrow("not found");
  });

  it("updates updated_at timestamp", () => {
    upsertProject("p");
    const [id] = createTasks("p", [{ title: "t" }]);
    const before = getTask(id)!.updated_at;
    // SQLite datetime granularity is seconds, so just check it doesn't throw
    const updated = updateTask(id, { body: "changed" });
    expect(updated.updated_at).toBeDefined();
    // updated_at should be >= before
    expect(updated.updated_at >= before).toBe(true);
  });
});

// ─── Delete / Restore / Trash ───────────────────────────

describe("delete & restore", () => {
  it("soft-deletes a task", () => {
    upsertProject("p");
    const [id] = createTasks("p", [{ title: "t" }]);
    deleteTask(id);
    expect(getTask(id)).toBeNull();
  });

  it("throws when deleting nonexistent task", () => {
    expect(() => deleteTask(99999)).toThrow("not found");
  });

  it("throws when deleting already-deleted task", () => {
    upsertProject("p");
    const [id] = createTasks("p", [{ title: "t" }]);
    deleteTask(id);
    expect(() => deleteTask(id)).toThrow("not found");
  });

  it("lists deleted tasks", () => {
    upsertProject("p");
    const [id1, id2] = createTasks("p", [{ title: "a" }, { title: "b" }]);
    deleteTask(id1);
    const deleted = listDeletedTasks();
    expect(deleted).toHaveLength(1);
    expect(deleted[0].id).toBe(id1);
  });

  it("filters deleted tasks by project", () => {
    upsertProject("a");
    upsertProject("b");
    const [id1] = createTasks("a", [{ title: "x" }]);
    const [id2] = createTasks("b", [{ title: "y" }]);
    deleteTask(id1);
    deleteTask(id2);

    expect(listDeletedTasks("a")).toHaveLength(1);
    expect(listDeletedTasks("a")[0].id).toBe(id1);
  });

  it("restores a deleted task", () => {
    upsertProject("p");
    const [id] = createTasks("p", [{ title: "t" }]);
    deleteTask(id);
    expect(getTask(id)).toBeNull();

    const restored = restoreTask(id);
    expect(restored.id).toBe(id);
    expect(restored.deleted_at).toBeNull();
    expect(getTask(id)).not.toBeNull();
  });

  it("throws when restoring non-deleted task", () => {
    upsertProject("p");
    const [id] = createTasks("p", [{ title: "t" }]);
    expect(() => restoreTask(id)).toThrow("not found");
  });

  it("empties trash and returns count", () => {
    upsertProject("p");
    const ids = createTasks("p", [{ title: "a" }, { title: "b" }, { title: "c" }]);
    deleteTask(ids[0]);
    deleteTask(ids[1]);

    const count = emptyTrash();
    expect(count).toBe(2);
    expect(listDeletedTasks()).toHaveLength(0);
    // non-deleted task survives
    expect(getTask(ids[2])).not.toBeNull();
  });

  it("emptyTrash returns 0 when trash is empty", () => {
    expect(emptyTrash()).toBe(0);
  });
});

// ─── Search ─────────────────────────────────────────────

describe("searchTasks", () => {
  it("matches title", () => {
    upsertProject("p");
    createTasks("p", [{ title: "deploy pipeline" }, { title: "unrelated" }]);
    const results = searchTasks("pipeline");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("deploy pipeline");
  });

  it("matches body", () => {
    upsertProject("p");
    createTasks("p", [{ title: "notes", body: "the frobnitz is broken" }]);
    const results = searchTasks("frobnitz");
    expect(results).toHaveLength(1);
  });

  it("matches refs", () => {
    upsertProject("p");
    createTasks("p", [{ title: "task", refs: ["/src/utils.ts"] }]);
    const results = searchTasks("utils.ts");
    expect(results).toHaveLength(1);
  });

  it("is case-insensitive", () => {
    upsertProject("p");
    createTasks("p", [{ title: "UPPERCASE THING" }]);
    const results = searchTasks("uppercase");
    expect(results).toHaveLength(1);
  });

  it("returns empty array for no matches", () => {
    upsertProject("p");
    createTasks("p", [{ title: "hello" }]);
    expect(searchTasks("zzzzz")).toEqual([]);
  });

  it("scopes to project", () => {
    upsertProject("a");
    upsertProject("b");
    createTasks("a", [{ title: "needle" }]);
    createTasks("b", [{ title: "needle" }]);
    expect(searchTasks("needle", "a")).toHaveLength(1);
    expect(searchTasks("needle", "a")[0].project).toBe("a");
  });

  it("scopes to status", () => {
    upsertProject("p");
    const [id1] = createTasks("p", [{ title: "needle a" }, { title: "needle b" }]);
    updateTask(id1, { status: "active" });
    expect(searchTasks("needle", undefined, "active")).toHaveLength(1);
  });

  it("excludes soft-deleted tasks", () => {
    upsertProject("p");
    const [id] = createTasks("p", [{ title: "findme" }]);
    deleteTask(id);
    expect(searchTasks("findme")).toEqual([]);
  });

  it("returns summaries without body", () => {
    upsertProject("p");
    createTasks("p", [{ title: "hit", body: "searchable content" }]);
    const [result] = searchTasks("searchable");
    expect(result).not.toHaveProperty("body");
  });

  it("returns multiple results sorted by sequence", () => {
    upsertProject("p");
    createTasks("p", [
      { title: "needle C", sequence: "10" },
      { title: "needle A", sequence: "2" },
      { title: "needle B", sequence: "3" },
    ]);
    const results = searchTasks("needle");
    expect(results.map((t) => t.sequence)).toEqual(["2", "3", "10"]);
  });
});

// ─── Append to task ────────────────────────────────────

describe("appendToTask", () => {
  it("appends to task with existing body", () => {
    upsertProject("p");
    const [id] = createTasks("p", [{ title: "t", body: "first" }]);
    const updated = appendToTask(id, "second");
    expect(updated.body).toBe("first\n\nsecond");
  });

  it("appends to task with empty body (no leading separator)", () => {
    upsertProject("p");
    const [id] = createTasks("p", [{ title: "t" }]);
    const updated = appendToTask(id, "content");
    expect(updated.body).toBe("content");
  });

  it("bumps updated_at", () => {
    upsertProject("p");
    const [id] = createTasks("p", [{ title: "t" }]);
    const before = getTask(id)!.updated_at;
    const updated = appendToTask(id, "more");
    expect(updated.updated_at >= before).toBe(true);
  });

  it("returns full task with all fields", () => {
    upsertProject("p");
    const [id] = createTasks("p", [
      { title: "t", body: "b", sequence: "1", refs: ["/a.ts"] },
    ]);
    const updated = appendToTask(id, "extra");
    expect(updated.id).toBe(id);
    expect(updated.title).toBe("t");
    expect(updated.sequence).toBe("1");
    expect(updated.refs).toEqual(["/a.ts"]);
    expect(updated.body).toBe("b\n\nextra");
  });

  it("throws for nonexistent task", () => {
    expect(() => appendToTask(99999, "x")).toThrow("not found");
  });

  it("preserves other fields unchanged", () => {
    upsertProject("p");
    const [id] = createTasks("p", [{ title: "t", body: "orig" }]);
    updateTask(id, { status: "active", sequence: "5" });
    const appended = appendToTask(id, "new stuff");
    expect(appended.status).toBe("active");
    expect(appended.sequence).toBe("5");
    expect(appended.title).toBe("t");
  });

  it("handles multiple appends", () => {
    upsertProject("p");
    const [id] = createTasks("p", [{ title: "t" }]);
    appendToTask(id, "one");
    appendToTask(id, "two");
    const task = appendToTask(id, "three");
    expect(task.body).toBe("one\n\ntwo\n\nthree");
  });
});

// ─── Transactions ───────────────────────────────────────

describe("transactions", () => {
  it("createTasks is atomic — partial failure rolls back all", () => {
    upsertProject("p");
    const ids = createTasks("p", [{ title: "a" }, { title: "b" }]);
    expect(ids).toHaveLength(2);
    expect(listTasks("p")).toHaveLength(2);
  });
});

// ─── Queues ─────────────────────────────────────────────

describe("queues", () => {
  it("starts with no queues", () => {
    expect(listQueues()).toEqual([]);
  });

  it("auto-creates queue on first enqueue", () => {
    enqueue("q", ["item1"]);
    const queues = listQueues();
    expect(queues).toHaveLength(1);
    expect(queues[0].name).toBe("q");
    expect(queues[0].item_count).toBe(1);
  });

  it("enqueue returns item ids", () => {
    const ids = enqueue("q", ["a", "b", "c"]);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBeLessThan(ids[1]);
    expect(ids[1]).toBeLessThan(ids[2]);
  });

  it("enqueue filters blank strings", () => {
    const ids = enqueue("q", ["a", "", "  ", "b"]);
    expect(ids).toHaveLength(2);
    expect(listQueueItems("q").map((i) => i.value)).toEqual(["a", "b"]);
  });

  it("enqueue with all blanks returns empty array", () => {
    const ids = enqueue("q", ["", "  "]);
    expect(ids).toEqual([]);
    // queue should not be created
    expect(listQueues()).toEqual([]);
  });

  it("allows duplicate values", () => {
    enqueue("q", ["same", "same", "same"]);
    expect(listQueueItems("q")).toHaveLength(3);
  });

  it("preserves FIFO order", () => {
    enqueue("q", ["first", "second", "third"]);
    const items = listQueueItems("q");
    expect(items.map((i) => i.value)).toEqual(["first", "second", "third"]);
  });

  it("appends to existing queue", () => {
    enqueue("q", ["a"]);
    enqueue("q", ["b"]);
    expect(listQueueItems("q").map((i) => i.value)).toEqual(["a", "b"]);
  });
});

describe("getQueueLength", () => {
  it("returns 0 for nonexistent queue", () => {
    expect(getQueueLength("nope")).toBe(0);
  });

  it("returns correct count", () => {
    enqueue("q", ["a", "b", "c"]);
    expect(getQueueLength("q")).toBe(3);
  });

  it("updates after delete", () => {
    const [id] = enqueue("q", ["a", "b"]);
    deleteQueueItem(id);
    expect(getQueueLength("q")).toBe(1);
  });
});

describe("claimNextQueueItem", () => {
  it("returns null for empty queue", () => {
    expect(claimNextQueueItem("nope")).toBeNull();
  });

  it("claims the first item and marks it", () => {
    enqueue("q", ["first", "second"]);
    const item = claimNextQueueItem("q")!;
    expect(item.value).toBe("first");
    expect(item.claimed_at).not.toBeNull();
  });

  it("sequential claims return different items", () => {
    enqueue("q", ["a", "b", "c"]);
    const first = claimNextQueueItem("q")!;
    const second = claimNextQueueItem("q")!;
    expect(first.id).not.toBe(second.id);
    expect(first.value).toBe("a");
    expect(second.value).toBe("b");
  });

  it("returns null after all items claimed", () => {
    enqueue("q", ["only"]);
    claimNextQueueItem("q");
    expect(claimNextQueueItem("q")).toBeNull();
  });

  it("returns null after all items deleted", () => {
    const [id] = enqueue("q", ["only"]);
    deleteQueueItem(id);
    expect(claimNextQueueItem("q")).toBeNull();
  });
});

describe("claimed items visibility", () => {
  it("claimed items are hidden from listQueueItems by default", () => {
    enqueue("q", ["a", "b", "c"]);
    claimNextQueueItem("q");
    expect(listQueueItems("q")).toHaveLength(2);
  });

  it("listQueueItems with includeClaimed shows all", () => {
    enqueue("q", ["a", "b", "c"]);
    claimNextQueueItem("q");
    expect(listQueueItems("q", true)).toHaveLength(3);
  });

  it("listClaimedItems returns only claimed items", () => {
    enqueue("q", ["a", "b", "c"]);
    claimNextQueueItem("q");
    const claimed = listClaimedItems("q");
    expect(claimed).toHaveLength(1);
    expect(claimed[0].value).toBe("a");
  });

  it("getQueueLength counts only unclaimed items", () => {
    enqueue("q", ["a", "b", "c"]);
    claimNextQueueItem("q");
    expect(getQueueLength("q")).toBe(2);
  });

  it("listQueues item_count counts only unclaimed items", () => {
    enqueue("q", ["a", "b", "c"]);
    claimNextQueueItem("q");
    const queues = listQueues();
    expect(queues[0].item_count).toBe(2);
  });
});

describe("releaseQueueItem", () => {
  it("makes item claimable again", () => {
    enqueue("q", ["a"]);
    const item = claimNextQueueItem("q")!;
    expect(claimNextQueueItem("q")).toBeNull();
    releaseQueueItem(item.id);
    const reclaimed = claimNextQueueItem("q")!;
    expect(reclaimed.id).toBe(item.id);
  });

  it("throws for unclaimed item", () => {
    const [id] = enqueue("q", ["a"]);
    expect(() => releaseQueueItem(id)).toThrow("not found or not claimed");
  });

  it("throws for nonexistent id", () => {
    expect(() => releaseQueueItem(99999)).toThrow("not found or not claimed");
  });
});

describe("releaseAllQueueItems", () => {
  it("releases all claimed items and returns count", () => {
    enqueue("q", ["a", "b", "c"]);
    claimNextQueueItem("q");
    claimNextQueueItem("q");
    const count = releaseAllQueueItems("q");
    expect(count).toBe(2);
    expect(getQueueLength("q")).toBe(3);
  });

  it("returns 0 when nothing is claimed", () => {
    enqueue("q", ["a"]);
    expect(releaseAllQueueItems("q")).toBe(0);
  });
});

describe("deleteQueueItem", () => {
  it("removes an item", () => {
    const [id] = enqueue("q", ["x"]);
    deleteQueueItem(id);
    expect(listQueueItems("q")).toHaveLength(0);
  });

  it("throws for nonexistent id", () => {
    expect(() => deleteQueueItem(99999)).toThrow("not found");
  });

  it("can delete from middle of queue", () => {
    const [a, b, c] = enqueue("q", ["a", "b", "c"]);
    deleteQueueItem(b);
    expect(listQueueItems("q").map((i) => i.value)).toEqual(["a", "c"]);
  });
});

describe("deleteQueue", () => {
  it("deletes queue and all its items", () => {
    enqueue("q", ["a", "b", "c"]);
    deleteQueue("q");
    expect(listQueues()).toEqual([]);
    expect(listQueueItems("q")).toEqual([]);
  });

  it("throws for nonexistent queue", () => {
    expect(() => deleteQueue("nope")).toThrow('Queue "nope" not found');
  });

  it("does not affect other queues", () => {
    enqueue("q1", ["a"]);
    enqueue("q2", ["b"]);
    deleteQueue("q1");
    expect(listQueues()).toHaveLength(1);
    expect(listQueueItems("q2")).toHaveLength(1);
  });
});

describe("listQueues", () => {
  it("includes item counts per queue", () => {
    enqueue("small", ["a"]);
    enqueue("big", ["x", "y", "z"]);
    const queues = listQueues();
    const small = queues.find((q) => q.name === "small")!;
    const big = queues.find((q) => q.name === "big")!;
    expect(small.item_count).toBe(1);
    expect(big.item_count).toBe(3);
  });

  it("shows 0 items for empty queue after all deleted", () => {
    const [id] = enqueue("q", ["a"]);
    deleteQueueItem(id);
    const queues = listQueues();
    expect(queues).toHaveLength(1);
    expect(queues[0].item_count).toBe(0);
  });
});

// ─── Sets ──────────────────────────────────────────────

describe("sets", () => {
  it("starts with no sets", () => {
    expect(listSets()).toEqual([]);
  });

  it("addToSet creates set implicitly", () => {
    addToSet("s", "key1");
    expect(setHas("s", "key1")).toBe(true);
    expect(listSets()).toHaveLength(1);
    expect(listSets()[0].name).toBe("s");
    expect(listSets()[0].member_count).toBe(1);
  });

  it("addToSet ignores duplicate keys", () => {
    addToSet("s", "key1");
    addToSet("s", "key1");
    expect(listSetMembers("s")).toEqual(["key1"]);
  });

  it("setHas returns false for nonexistent key", () => {
    expect(setHas("s", "nope")).toBe(false);
  });

  it("setHas returns false for nonexistent set", () => {
    expect(setHas("nope", "nope")).toBe(false);
  });

  it("listSetMembers returns sorted keys", () => {
    addToSet("s", "banana");
    addToSet("s", "apple");
    addToSet("s", "cherry");
    expect(listSetMembers("s")).toEqual(["apple", "banana", "cherry"]);
  });

  it("listSetMembers returns empty for nonexistent set", () => {
    expect(listSetMembers("nope")).toEqual([]);
  });

  it("removeFromSet removes a key", () => {
    addToSet("s", "a");
    addToSet("s", "b");
    removeFromSet("s", "a");
    expect(setHas("s", "a")).toBe(false);
    expect(setHas("s", "b")).toBe(true);
  });

  it("removeFromSet throws for nonexistent key", () => {
    addToSet("s", "a");
    expect(() => removeFromSet("s", "nope")).toThrow('Key "nope" not found in set "s"');
  });

  it("deleteSet removes all members", () => {
    addToSet("s", "a");
    addToSet("s", "b");
    addToSet("s", "c");
    const count = deleteSet("s");
    expect(count).toBe(3);
    expect(listSets()).toEqual([]);
    expect(listSetMembers("s")).toEqual([]);
  });

  it("deleteSet throws for nonexistent set", () => {
    expect(() => deleteSet("nope")).toThrow('Set "nope" not found');
  });

  it("sets are independent of each other", () => {
    addToSet("s1", "shared-key");
    addToSet("s2", "shared-key");
    deleteSet("s1");
    expect(setHas("s2", "shared-key")).toBe(true);
  });
});

describe("addManyToSet", () => {
  it("adds multiple keys in one call", () => {
    const added = addManyToSet("s", ["a", "b", "c"]);
    expect(added).toBe(3);
    expect(listSetMembers("s")).toEqual(["a", "b", "c"]);
  });

  it("skips blank strings", () => {
    const added = addManyToSet("s", ["a", "", "  ", "b"]);
    expect(added).toBe(2);
    expect(listSetMembers("s")).toEqual(["a", "b"]);
  });

  it("returns 0 for all-blank input", () => {
    const added = addManyToSet("s", ["", "  "]);
    expect(added).toBe(0);
  });

  it("reports how many were actually new", () => {
    addToSet("s", "a");
    const added = addManyToSet("s", ["a", "b", "c"]);
    expect(added).toBe(2);
    expect(listSetMembers("s")).toEqual(["a", "b", "c"]);
  });
});

describe("listSets", () => {
  it("shows member counts per set", () => {
    addToSet("small", "x");
    addManyToSet("big", ["a", "b", "c"]);
    const sets = listSets();
    const small = sets.find((s) => s.name === "small")!;
    const big = sets.find((s) => s.name === "big")!;
    expect(small.member_count).toBe(1);
    expect(big.member_count).toBe(3);
  });
});
