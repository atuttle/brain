import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  listProjects,
  upsertProject,
  createChunks,
  listChunks,
  getChunk,
  updateChunk,
  deleteChunk,
  searchChunks,
  appendToChunk,
  listQueues,
  enqueue,
  getQueueLength,
  getNextQueueItem,
  deleteQueueItem,
} from "./db.js";

const server = new McpServer({
  name: "mcp-brain",
  version: "1.0.0",
});

// --- list_projects ---

server.registerTool("list_projects", {
  description:
    "List all projects. Call this first if you don't know which project to use, then ask the user which project they want to work with.",
}, async () => {
  const projects = listProjects();
  if (projects.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: "No projects exist yet. Use create_project to create one.",
        },
      ],
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(projects) }],
  };
});

// --- create_project ---

server.registerTool("create_project", {
  description:
    "Create a new project or update an existing project's states. States define the lifecycle of chunks (default: pending, active, done, archived).",
  inputSchema: {
    name: z.string().describe("Project name (descriptive, kebab-case preferred)"),
    states: z
      .array(z.string())
      .optional()
      .describe(
        'Custom lifecycle states for chunks in this project. Order matters — first state is the default for new chunks. Defaults to ["pending","active","done","archived"].'
      ),
  },
}, async ({ name, states }) => {
  const project = upsertProject(name, states);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(project) }],
  };
});

// --- create_chunks ---

server.registerTool("create_chunks", {
  description:
    "Create one or more chunks in a project. Chunks are units of work — plans, research, tasks. New chunks are always created in the first lifecycle state of the project. If you don't know the project, call list_projects first and ask the user.",
  inputSchema: {
    project: z.string().describe("Project name"),
    chunks: z
      .array(
        z.object({
          title: z.string().describe("Short description of the chunk"),
          body: z
            .string()
            .optional()
            .describe("Full content — plans, research notes, analysis"),
          sequence: z
            .string()
            .optional()
            .describe(
              "Ordering key. Supports alphanumeric (1, 2, 3A, 3B, 3C1). Natural sort is applied."
            ),
          refs: z
            .array(z.string())
            .optional()
            .describe("File paths relevant to this chunk"),
        })
      )
      .describe("Array of chunks to create"),
  },
}, async ({ project, chunks }) => {
  try {
    const ids = createChunks(project, chunks);
    return {
      content: [
        {
          type: "text" as const,
          text: `Created ${ids.length} chunk(s): ${JSON.stringify(ids)}`,
        },
      ],
    };
  } catch (e) {
    return {
      content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
      isError: true,
    };
  }
});

// --- list_chunks ---

server.registerTool("list_chunks", {
  description:
    "List chunks for a project, optionally filtered by status. Returns summaries (no body). Use get_chunk to read the full content of a specific chunk.",
  inputSchema: {
    project: z.string().describe("Project name"),
    status: z
      .string()
      .optional()
      .describe("Filter by status (e.g. pending, active, done)"),
  },
}, async ({ project, status }) => {
  const chunks = listChunks(project, status);
  if (chunks.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: status
            ? `No ${status} chunks in project "${project}".`
            : `No chunks in project "${project}".`,
        },
      ],
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(chunks, null, 2) }],
  };
});

// --- get_chunk ---

server.registerTool("get_chunk", {
  description: "Get the full content of a chunk by ID, including its body.",
  inputSchema: {
    id: z.coerce.number().describe("Chunk ID"),
  },
}, async ({ id }) => {
  const chunk = getChunk(id);
  if (!chunk) {
    return {
      content: [{ type: "text" as const, text: `Chunk ${id} not found.` }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(chunk, null, 2) }],
  };
});

// --- update_chunk ---

server.registerTool("update_chunk", {
  description:
    "Update a chunk's title, body, status, sequence, or references. Only include fields you want to change.",
  inputSchema: {
    id: z.coerce.number().describe("Chunk ID"),
    title: z.string().optional().describe("New title"),
    body: z.string().optional().describe("New body content"),
    status: z
      .string()
      .optional()
      .describe("New status (must be a valid state for the project)"),
    sequence: z.string().optional().describe("New sequence key"),
    refs: z
      .array(z.string())
      .optional()
      .describe("New file path references (replaces existing)"),
  },
}, async ({ id, ...updates }) => {
  try {
    const chunk = updateChunk(id, updates);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(chunk, null, 2) }],
    };
  } catch (e) {
    return {
      content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
      isError: true,
    };
  }
});

// --- delete_chunk ---

server.registerTool("delete_chunk", {
  description:
    "Soft-delete a chunk. The chunk can be restored later via the CLI. Use this when a chunk is no longer needed.",
  inputSchema: {
    id: z.coerce.number().describe("Chunk ID"),
  },
}, async ({ id }) => {
  try {
    deleteChunk(id);
    return {
      content: [{ type: "text" as const, text: `Chunk ${id} soft-deleted.` }],
    };
  } catch (e) {
    return {
      content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
      isError: true,
    };
  }
});

// --- search_chunks ---

server.registerTool("search_chunks", {
  description:
    "Search chunks by keyword across title, body, and refs. Case-insensitive. Optionally filter by project and/or status. Returns summaries (no body). Use get_chunk to read matching chunks.",
  inputSchema: {
    query: z.string().describe("Search term (case-insensitive substring match)"),
    project: z
      .string()
      .optional()
      .describe("Limit search to a specific project"),
    status: z
      .string()
      .optional()
      .describe("Limit search to a specific status"),
  },
}, async ({ query, project, status }) => {
  const chunks = searchChunks(query, project, status);
  if (chunks.length === 0) {
    return {
      content: [{ type: "text" as const, text: `No chunks matching "${query}".` }],
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(chunks, null, 2) }],
  };
});

// --- append_to_chunk ---

server.registerTool("append_to_chunk", {
  description:
    "Append text to a chunk's body. The text is added after two blank lines. Useful for incrementally building up notes, logs, or research.",
  inputSchema: {
    id: z.coerce.number().describe("Chunk ID"),
    text: z.string().describe("Text to append to the chunk body"),
  },
}, async ({ id, text }) => {
  try {
    const chunk = appendToChunk(id, text);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(chunk, null, 2) }],
    };
  } catch (e) {
    return {
      content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
      isError: true,
    };
  }
});

// --- list_queues ---

server.registerTool("list_queues", {
  description:
    "List all queues with their item counts.",
}, async () => {
  const queues = listQueues();
  if (queues.length === 0) {
    return {
      content: [{ type: "text" as const, text: "No queues exist yet. Use enqueue to create one." }],
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(queues, null, 2) }],
  };
});

// --- enqueue ---

server.registerTool("enqueue", {
  description:
    "Add items to a queue. The queue is auto-created if it doesn't exist. Items are newline-delimited — one item per line. Blank lines are ignored.",
  inputSchema: {
    queue: z.string().describe("Queue name"),
    items: z.string().describe("Newline-delimited items to add to the queue"),
  },
}, async ({ queue, items }) => {
  const parsed = items.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
  if (parsed.length === 0) {
    return {
      content: [{ type: "text" as const, text: "No items to enqueue (input was empty or all blank lines)." }],
      isError: true,
    };
  }
  const ids = enqueue(queue, parsed);
  return {
    content: [{ type: "text" as const, text: `Enqueued ${ids.length} item(s) in "${queue}": ${JSON.stringify(ids)}` }],
  };
});

// --- get_queue_length ---

server.registerTool("get_queue_length", {
  description: "Get the number of items in a queue.",
  inputSchema: {
    queue: z.string().describe("Queue name"),
  },
}, async ({ queue }) => {
  const count = getQueueLength(queue);
  return {
    content: [{ type: "text" as const, text: String(count) }],
  };
});

// --- get_next_queue_item ---

server.registerTool("get_next_queue_item", {
  description:
    "Peek at the next item in a queue (FIFO). Returns the item but does not remove it. Call delete_queue_item with the returned ID when done processing.",
  inputSchema: {
    queue: z.string().describe("Queue name"),
  },
}, async ({ queue }) => {
  const item = getNextQueueItem(queue);
  if (!item) {
    return {
      content: [{ type: "text" as const, text: `Queue "${queue}" is empty.` }],
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(item) }],
  };
});

// --- delete_queue_item ---

server.registerTool("delete_queue_item", {
  description:
    "Delete an item from a queue by ID. Use this after successfully processing an item returned by get_next_queue_item.",
  inputSchema: {
    id: z.coerce.number().describe("Queue item ID"),
  },
}, async ({ id }) => {
  try {
    deleteQueueItem(id);
    return {
      content: [{ type: "text" as const, text: `Queue item ${id} deleted.` }],
    };
  } catch (e) {
    return {
      content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
      isError: true,
    };
  }
});

// --- Start server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
