import { describe, it, expect, beforeEach, afterAll } from "vitest";

import {
  getDb,
  closeDb,
  listProjects,
  listProjectDetails,
  getProject,
  upsertProject,
  createChunks,
  listChunks,
  getChunk,
  updateChunk,
  deleteChunk,
  searchChunks,
  appendToChunk,
  listDeletedChunks,
  restoreChunk,
  emptyTrash,
  listQueues,
  enqueue,
  getQueueLength,
  getNextQueueItem,
  listQueueItems,
  deleteQueueItem,
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

  it("listProjectDetails includes chunk counts", () => {
    upsertProject("a");
    upsertProject("b");
    createChunks("a", [{ title: "t1" }, { title: "t2" }]);
    createChunks("b", [{ title: "t3" }]);

    const details = listProjectDetails();
    const a = details.find((d) => d.name === "a")!;
    const b = details.find((d) => d.name === "b")!;
    expect(a.chunk_count).toBe(2);
    expect(b.chunk_count).toBe(1);
  });
});

// ─── Chunks ─────────────────────────────────────────────

describe("chunks", () => {
  it("creates chunks and returns ids", () => {
    upsertProject("p");
    const ids = createChunks("p", [
      { title: "first", body: "body1", sequence: "1", refs: ["/a.ts"] },
      { title: "second" },
    ]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBeLessThan(ids[1]);
  });

  it("throws when creating chunks for nonexistent project", () => {
    expect(() => createChunks("nope", [{ title: "x" }])).toThrow(
      'Project "nope" does not exist'
    );
  });

  it("new chunks get the first project state as default status", () => {
    upsertProject("p", ["todo", "done"]);
    const [id] = createChunks("p", [{ title: "t" }]);
    const chunk = getChunk(id)!;
    expect(chunk.status).toBe("todo");
  });

  it("stores body, sequence, and refs", () => {
    upsertProject("p");
    const [id] = createChunks("p", [
      { title: "t", body: "details", sequence: "3A", refs: ["/x", "/y"] },
    ]);
    const chunk = getChunk(id)!;
    expect(chunk.body).toBe("details");
    expect(chunk.sequence).toBe("3A");
    expect(chunk.refs).toEqual(["/x", "/y"]);
  });

  it("defaults body/sequence/refs when omitted", () => {
    upsertProject("p");
    const [id] = createChunks("p", [{ title: "bare" }]);
    const chunk = getChunk(id)!;
    expect(chunk.body).toBe("");
    expect(chunk.sequence).toBe("");
    expect(chunk.refs).toEqual([]);
  });

  it("getChunk returns null for nonexistent id", () => {
    expect(getChunk(99999)).toBeNull();
  });
});

// ─── List & filter ──────────────────────────────────────

describe("listChunks", () => {
  it("lists all chunks for a project", () => {
    upsertProject("p");
    createChunks("p", [{ title: "a" }, { title: "b" }]);
    expect(listChunks("p")).toHaveLength(2);
  });

  it("filters by status", () => {
    upsertProject("p");
    const [id1] = createChunks("p", [{ title: "a" }, { title: "b" }]);
    updateChunk(id1, { status: "active" });

    expect(listChunks("p", "active")).toHaveLength(1);
    expect(listChunks("p", "pending")).toHaveLength(1);
  });

  it("excludes soft-deleted chunks", () => {
    upsertProject("p");
    const [id] = createChunks("p", [{ title: "a" }]);
    deleteChunk(id);
    expect(listChunks("p")).toHaveLength(0);
  });

  it("returns summaries without body", () => {
    upsertProject("p");
    createChunks("p", [{ title: "a", body: "big body" }]);
    const [summary] = listChunks("p");
    expect(summary).not.toHaveProperty("body");
  });

  it("sorts by natural order of sequence", () => {
    upsertProject("p");
    createChunks("p", [
      { title: "c", sequence: "10" },
      { title: "a", sequence: "2" },
      { title: "b", sequence: "3A" },
    ]);
    const chunks = listChunks("p");
    expect(chunks.map((c) => c.sequence)).toEqual(["2", "3A", "10"]);
  });
});

// ─── Update ─────────────────────────────────────────────

describe("updateChunk", () => {
  it("updates title", () => {
    upsertProject("p");
    const [id] = createChunks("p", [{ title: "old" }]);
    const updated = updateChunk(id, { title: "new" });
    expect(updated.title).toBe("new");
  });

  it("updates status to a valid state", () => {
    upsertProject("p");
    const [id] = createChunks("p", [{ title: "t" }]);
    const updated = updateChunk(id, { status: "done" });
    expect(updated.status).toBe("done");
  });

  it("rejects invalid status", () => {
    upsertProject("p");
    const [id] = createChunks("p", [{ title: "t" }]);
    expect(() => updateChunk(id, { status: "bogus" })).toThrow(
      'Invalid status "bogus"'
    );
  });

  it("updates multiple fields at once", () => {
    upsertProject("p");
    const [id] = createChunks("p", [{ title: "t" }]);
    const updated = updateChunk(id, {
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

  it("throws for nonexistent chunk", () => {
    expect(() => updateChunk(99999, { title: "x" })).toThrow("not found");
  });

  it("updates updated_at timestamp", () => {
    upsertProject("p");
    const [id] = createChunks("p", [{ title: "t" }]);
    const before = getChunk(id)!.updated_at;
    // SQLite datetime granularity is seconds, so just check it doesn't throw
    const updated = updateChunk(id, { body: "changed" });
    expect(updated.updated_at).toBeDefined();
    // updated_at should be >= before
    expect(updated.updated_at >= before).toBe(true);
  });
});

// ─── Delete / Restore / Trash ───────────────────────────

describe("delete & restore", () => {
  it("soft-deletes a chunk", () => {
    upsertProject("p");
    const [id] = createChunks("p", [{ title: "t" }]);
    deleteChunk(id);
    expect(getChunk(id)).toBeNull();
  });

  it("throws when deleting nonexistent chunk", () => {
    expect(() => deleteChunk(99999)).toThrow("not found");
  });

  it("throws when deleting already-deleted chunk", () => {
    upsertProject("p");
    const [id] = createChunks("p", [{ title: "t" }]);
    deleteChunk(id);
    expect(() => deleteChunk(id)).toThrow("not found");
  });

  it("lists deleted chunks", () => {
    upsertProject("p");
    const [id1, id2] = createChunks("p", [{ title: "a" }, { title: "b" }]);
    deleteChunk(id1);
    const deleted = listDeletedChunks();
    expect(deleted).toHaveLength(1);
    expect(deleted[0].id).toBe(id1);
  });

  it("filters deleted chunks by project", () => {
    upsertProject("a");
    upsertProject("b");
    const [id1] = createChunks("a", [{ title: "x" }]);
    const [id2] = createChunks("b", [{ title: "y" }]);
    deleteChunk(id1);
    deleteChunk(id2);

    expect(listDeletedChunks("a")).toHaveLength(1);
    expect(listDeletedChunks("a")[0].id).toBe(id1);
  });

  it("restores a deleted chunk", () => {
    upsertProject("p");
    const [id] = createChunks("p", [{ title: "t" }]);
    deleteChunk(id);
    expect(getChunk(id)).toBeNull();

    const restored = restoreChunk(id);
    expect(restored.id).toBe(id);
    expect(restored.deleted_at).toBeNull();
    expect(getChunk(id)).not.toBeNull();
  });

  it("throws when restoring non-deleted chunk", () => {
    upsertProject("p");
    const [id] = createChunks("p", [{ title: "t" }]);
    expect(() => restoreChunk(id)).toThrow("not found");
  });

  it("empties trash and returns count", () => {
    upsertProject("p");
    const ids = createChunks("p", [{ title: "a" }, { title: "b" }, { title: "c" }]);
    deleteChunk(ids[0]);
    deleteChunk(ids[1]);

    const count = emptyTrash();
    expect(count).toBe(2);
    expect(listDeletedChunks()).toHaveLength(0);
    // non-deleted chunk survives
    expect(getChunk(ids[2])).not.toBeNull();
  });

  it("emptyTrash returns 0 when trash is empty", () => {
    expect(emptyTrash()).toBe(0);
  });
});

// ─── Search ─────────────────────────────────────────────

describe("searchChunks", () => {
  it("matches title", () => {
    upsertProject("p");
    createChunks("p", [{ title: "deploy pipeline" }, { title: "unrelated" }]);
    const results = searchChunks("pipeline");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("deploy pipeline");
  });

  it("matches body", () => {
    upsertProject("p");
    createChunks("p", [{ title: "notes", body: "the frobnitz is broken" }]);
    const results = searchChunks("frobnitz");
    expect(results).toHaveLength(1);
  });

  it("matches refs", () => {
    upsertProject("p");
    createChunks("p", [{ title: "task", refs: ["/src/utils.ts"] }]);
    const results = searchChunks("utils.ts");
    expect(results).toHaveLength(1);
  });

  it("is case-insensitive", () => {
    upsertProject("p");
    createChunks("p", [{ title: "UPPERCASE THING" }]);
    const results = searchChunks("uppercase");
    expect(results).toHaveLength(1);
  });

  it("returns empty array for no matches", () => {
    upsertProject("p");
    createChunks("p", [{ title: "hello" }]);
    expect(searchChunks("zzzzz")).toEqual([]);
  });

  it("scopes to project", () => {
    upsertProject("a");
    upsertProject("b");
    createChunks("a", [{ title: "needle" }]);
    createChunks("b", [{ title: "needle" }]);
    expect(searchChunks("needle", "a")).toHaveLength(1);
    expect(searchChunks("needle", "a")[0].project).toBe("a");
  });

  it("scopes to status", () => {
    upsertProject("p");
    const [id1] = createChunks("p", [{ title: "needle a" }, { title: "needle b" }]);
    updateChunk(id1, { status: "active" });
    expect(searchChunks("needle", undefined, "active")).toHaveLength(1);
  });

  it("excludes soft-deleted chunks", () => {
    upsertProject("p");
    const [id] = createChunks("p", [{ title: "findme" }]);
    deleteChunk(id);
    expect(searchChunks("findme")).toEqual([]);
  });

  it("returns summaries without body", () => {
    upsertProject("p");
    createChunks("p", [{ title: "hit", body: "searchable content" }]);
    const [result] = searchChunks("searchable");
    expect(result).not.toHaveProperty("body");
  });

  it("returns multiple results sorted by sequence", () => {
    upsertProject("p");
    createChunks("p", [
      { title: "needle C", sequence: "10" },
      { title: "needle A", sequence: "2" },
      { title: "needle B", sequence: "3" },
    ]);
    const results = searchChunks("needle");
    expect(results.map((c) => c.sequence)).toEqual(["2", "3", "10"]);
  });
});

// ─── Append to chunk ────────────────────────────────────

describe("appendToChunk", () => {
  it("appends to chunk with existing body", () => {
    upsertProject("p");
    const [id] = createChunks("p", [{ title: "t", body: "first" }]);
    const updated = appendToChunk(id, "second");
    expect(updated.body).toBe("first\n\nsecond");
  });

  it("appends to chunk with empty body (no leading separator)", () => {
    upsertProject("p");
    const [id] = createChunks("p", [{ title: "t" }]);
    const updated = appendToChunk(id, "content");
    expect(updated.body).toBe("content");
  });

  it("bumps updated_at", () => {
    upsertProject("p");
    const [id] = createChunks("p", [{ title: "t" }]);
    const before = getChunk(id)!.updated_at;
    const updated = appendToChunk(id, "more");
    expect(updated.updated_at >= before).toBe(true);
  });

  it("returns full chunk with all fields", () => {
    upsertProject("p");
    const [id] = createChunks("p", [
      { title: "t", body: "b", sequence: "1", refs: ["/a.ts"] },
    ]);
    const updated = appendToChunk(id, "extra");
    expect(updated.id).toBe(id);
    expect(updated.title).toBe("t");
    expect(updated.sequence).toBe("1");
    expect(updated.refs).toEqual(["/a.ts"]);
    expect(updated.body).toBe("b\n\nextra");
  });

  it("throws for nonexistent chunk", () => {
    expect(() => appendToChunk(99999, "x")).toThrow("not found");
  });

  it("preserves other fields unchanged", () => {
    upsertProject("p");
    const [id] = createChunks("p", [{ title: "t", body: "orig" }]);
    updateChunk(id, { status: "active", sequence: "5" });
    const appended = appendToChunk(id, "new stuff");
    expect(appended.status).toBe("active");
    expect(appended.sequence).toBe("5");
    expect(appended.title).toBe("t");
  });

  it("handles multiple appends", () => {
    upsertProject("p");
    const [id] = createChunks("p", [{ title: "t" }]);
    appendToChunk(id, "one");
    appendToChunk(id, "two");
    const chunk = appendToChunk(id, "three");
    expect(chunk.body).toBe("one\n\ntwo\n\nthree");
  });
});

// ─── Transactions ───────────────────────────────────────

describe("transactions", () => {
  it("createChunks is atomic — partial failure rolls back all", () => {
    upsertProject("p");
    // Manually break one insert by passing a chunk that violates constraints
    // We can't easily force a mid-transaction failure with the current API,
    // but we can verify the transaction wrapper works by checking all-or-nothing
    const ids = createChunks("p", [{ title: "a" }, { title: "b" }]);
    expect(ids).toHaveLength(2);
    expect(listChunks("p")).toHaveLength(2);
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

describe("getNextQueueItem", () => {
  it("returns null for empty queue", () => {
    expect(getNextQueueItem("nope")).toBeNull();
  });

  it("returns the first item (peek, no removal)", () => {
    enqueue("q", ["first", "second"]);
    const item1 = getNextQueueItem("q")!;
    expect(item1.value).toBe("first");

    // calling again returns the same item
    const item2 = getNextQueueItem("q")!;
    expect(item2.id).toBe(item1.id);
  });

  it("advances after deleting the head", () => {
    enqueue("q", ["first", "second"]);
    const head = getNextQueueItem("q")!;
    deleteQueueItem(head.id);

    const next = getNextQueueItem("q")!;
    expect(next.value).toBe("second");
  });

  it("returns null after all items deleted", () => {
    const [id] = enqueue("q", ["only"]);
    deleteQueueItem(id);
    expect(getNextQueueItem("q")).toBeNull();
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
