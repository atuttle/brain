import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  listProjects,
  upsertProject,
  createTasks,
  listTasks,
  getTask,
  updateTask,
  deleteTask,
  searchTasks,
  appendToTask,
  listQueues,
  enqueue,
  getQueueLength,
  getNextQueueItem,
  deleteQueueItem,
  listSets,
  addToSet,
  removeFromSet,
  setHas,
  listSetMembers,
  deleteSet,
} from "./db.js";

const server = new McpServer({
  name: "brain",
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
    "Create a new project or update an existing project's states. States define the lifecycle of tasks (default: pending, active, done, archived).",
  inputSchema: {
    name: z.string().describe("Project name (descriptive, kebab-case preferred)"),
    states: z
      .array(z.string())
      .optional()
      .describe(
        'Custom lifecycle states for tasks in this project. Order matters — first state is the default for new tasks. Defaults to ["pending","active","done","archived"].'
      ),
  },
}, async ({ name, states }) => {
  const project = upsertProject(name, states);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(project) }],
  };
});

// --- Task tools (canonical) ---

const createTasksSchema = {
  project: z.string().describe("Project name"),
  tasks: z
    .array(
      z.object({
        title: z.string().describe("Short description of the task"),
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
          .describe("File paths relevant to this task"),
      })
    )
    .describe("Array of tasks to create"),
};

const createTasksHandler = async ({ project, tasks }: { project: string; tasks: Array<{ title: string; body?: string; sequence?: string; refs?: string[] }> }) => {
  try {
    const ids = createTasks(project, tasks);
    return {
      content: [
        {
          type: "text" as const,
          text: `Created ${ids.length} task(s): ${JSON.stringify(ids)}`,
        },
      ],
    };
  } catch (e) {
    return {
      content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
      isError: true,
    };
  }
};

server.registerTool("create_tasks", {
  description:
    "Create one or more tasks in a project. Tasks are units of work — plans, research, action items. New tasks are always created in the first lifecycle state of the project. If you don't know the project, call list_projects first and ask the user.",
  inputSchema: createTasksSchema,
}, createTasksHandler);

const listTasksSchema = {
  project: z.string().describe("Project name"),
  status: z
    .string()
    .optional()
    .describe("Filter by status (e.g. pending, active, done)"),
};

const listTasksHandler = async ({ project, status }: { project: string; status?: string }) => {
  const tasks = listTasks(project, status);
  if (tasks.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: status
            ? `No ${status} tasks in project "${project}".`
            : `No tasks in project "${project}".`,
        },
      ],
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(tasks, null, 2) }],
  };
};

server.registerTool("list_tasks", {
  description:
    "List tasks for a project, optionally filtered by status. Returns summaries (no body). Use get_task to read the full content of a specific task.",
  inputSchema: listTasksSchema,
}, listTasksHandler);

const getTaskSchema = {
  id: z.coerce.number().describe("Task ID"),
};

const getTaskHandler = async ({ id }: { id: number }) => {
  const task = getTask(id);
  if (!task) {
    return {
      content: [{ type: "text" as const, text: `Task ${id} not found.` }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }],
  };
};

server.registerTool("get_task", {
  description: "Get the full content of a task by ID, including its body.",
  inputSchema: getTaskSchema,
}, getTaskHandler);

const updateTaskSchema = {
  id: z.coerce.number().describe("Task ID"),
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
};

const updateTaskHandler = async ({ id, ...updates }: { id: number; title?: string; body?: string; status?: string; sequence?: string; refs?: string[] }) => {
  try {
    const task = updateTask(id, updates);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }],
    };
  } catch (e) {
    return {
      content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
      isError: true,
    };
  }
};

server.registerTool("update_task", {
  description:
    "Update a task's title, body, status, sequence, or references. Only include fields you want to change.",
  inputSchema: updateTaskSchema,
}, updateTaskHandler);

const deleteTaskSchema = {
  id: z.coerce.number().describe("Task ID"),
};

const deleteTaskHandler = async ({ id }: { id: number }) => {
  try {
    deleteTask(id);
    return {
      content: [{ type: "text" as const, text: `Task ${id} soft-deleted.` }],
    };
  } catch (e) {
    return {
      content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
      isError: true,
    };
  }
};

server.registerTool("delete_task", {
  description:
    "Soft-delete a task. The task can be restored later via the CLI. Use this when a task is no longer needed.",
  inputSchema: deleteTaskSchema,
}, deleteTaskHandler);

const searchTasksSchema = {
  query: z.string().describe("Search term (case-insensitive substring match)"),
  project: z
    .string()
    .optional()
    .describe("Limit search to a specific project"),
  status: z
    .string()
    .optional()
    .describe("Limit search to a specific status"),
};

const searchTasksHandler = async ({ query, project, status }: { query: string; project?: string; status?: string }) => {
  const tasks = searchTasks(query, project, status);
  if (tasks.length === 0) {
    return {
      content: [{ type: "text" as const, text: `No tasks matching "${query}".` }],
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(tasks, null, 2) }],
  };
};

server.registerTool("search_tasks", {
  description:
    "Search tasks by keyword across title, body, and refs. Case-insensitive. Optionally filter by project and/or status. Returns summaries (no body). Use get_task to read matching tasks.",
  inputSchema: searchTasksSchema,
}, searchTasksHandler);

const appendToTaskSchema = {
  id: z.coerce.number().describe("Task ID"),
  text: z.string().describe("Text to append to the task body"),
};

const appendToTaskHandler = async ({ id, text }: { id: number; text: string }) => {
  try {
    const task = appendToTask(id, text);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }],
    };
  } catch (e) {
    return {
      content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
      isError: true,
    };
  }
};

server.registerTool("append_to_task", {
  description:
    "Append text to a task's body. The text is added after two blank lines. Useful for incrementally building up notes, logs, or research.",
  inputSchema: appendToTaskSchema,
}, appendToTaskHandler);

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

// --- list_sets ---

server.registerTool("list_sets", {
  description: "List all sets with their member counts.",
}, async () => {
  const sets = listSets();
  if (sets.length === 0) {
    return {
      content: [{ type: "text" as const, text: "No sets exist yet. Use add_to_set to create one." }],
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(sets, null, 2) }],
  };
});

// --- add_to_set ---

server.registerTool("add_to_set", {
  description:
    "Add a key to a set. The set is auto-created if it doesn't exist. Duplicate keys are silently ignored.",
  inputSchema: {
    set: z.string().describe("Set name"),
    key: z.string().describe("Key to add"),
  },
}, async ({ set, key }) => {
  addToSet(set, key);
  return {
    content: [{ type: "text" as const, text: `Added "${key}" to set "${set}".` }],
  };
});

// --- remove_from_set ---

server.registerTool("remove_from_set", {
  description: "Remove a key from a set.",
  inputSchema: {
    set: z.string().describe("Set name"),
    key: z.string().describe("Key to remove"),
  },
}, async ({ set, key }) => {
  try {
    removeFromSet(set, key);
    return {
      content: [{ type: "text" as const, text: `Removed "${key}" from set "${set}".` }],
    };
  } catch (e) {
    return {
      content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
      isError: true,
    };
  }
});

// --- set_has ---

server.registerTool("set_has", {
  description: "Check if a key exists in a set. Returns true or false.",
  inputSchema: {
    set: z.string().describe("Set name"),
    key: z.string().describe("Key to check"),
  },
}, async ({ set, key }) => {
  const exists = setHas(set, key);
  return {
    content: [{ type: "text" as const, text: String(exists) }],
  };
});

// --- list_set_members ---

server.registerTool("list_set_members", {
  description: "List all keys in a set.",
  inputSchema: {
    set: z.string().describe("Set name"),
  },
}, async ({ set }) => {
  const members = listSetMembers(set);
  if (members.length === 0) {
    return {
      content: [{ type: "text" as const, text: `Set "${set}" is empty or does not exist.` }],
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(members) }],
  };
});

// --- delete_set ---

server.registerTool("delete_set", {
  description: "Delete an entire set and all its members.",
  inputSchema: {
    set: z.string().describe("Set name"),
  },
}, async ({ set }) => {
  try {
    const count = deleteSet(set);
    return {
      content: [{ type: "text" as const, text: `Deleted set "${set}" (${count} member(s)).` }],
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
