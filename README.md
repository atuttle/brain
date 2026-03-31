# brain 🧠

Persistent SQLite store that gives Claude Code projects, work queues, and sets — accessible via MCP tools and a scriptable CLI.

- **Projects & Tasks** — organize work into projects with custom lifecycle states (e.g. pending → active → done)
- **Queues** — FIFO work queues for processing items in order (peek, process, delete)
- **Sets** — track membership for filtering and deduplication (e.g. reviewed files, known bugs)

## Why?

I used to track this kind of information in uncommitted files in a hidden folder. Then Claude decided to delete a bunch of those files one too many times, with no way to get them back. I needed a way to give Claude structured access to persistent data without giving it the ability to destroy that data. The MCP tools here are read/write but deletes are soft — the only way to permanently remove anything is through the CLI, where I'm always in the loop.

## Install

```bash
pnpm install
pnpm build
pnpm link --global  # makes `brain` available everywhere
```

## CLI

Bare `brain` launches an interactive TUI. Subcommands are for scripts and piping.

All tabular output is `\t`-delimited. Stdin-accepting commands read one item per line, ignoring blanks.

### `brain project`

| Command | Description |
|---|---|
| `brain project list` | List projects (`name \t count`) |
| `brain project list <project> [--status <s>]` | List tasks in a project (`id \t status \t seq \t title`) |
| `brain project get-task <id>` | Full task as JSON |
| `brain project search <query>` | Full-text search (`id \t project \t status \t title`) |
| `brain project list-deleted [project]` | Trashed tasks (`id \t project \t title \t deleted_at`) |
| `brain project restore-task <id>` | Restore a soft-deleted task |
| `brain project empty-trash [project]` | Permanently delete all trashed tasks |

### `brain queue`

| Command | Description |
|---|---|
| `brain queue list` | List queues (`name \t count`) |
| `brain queue items <queue>` | List items (`id \t value`) |
| `brain queue add <queue>` | Enqueue from stdin; auto-creates queue |
| `brain queue next <queue>` | Peek next FIFO item (`id \t value`); exit 1 if empty |
| `brain queue delete-item <id>` | Delete item by ID (call after processing) |
| `brain queue delete <queue>` | Delete queue and all items |

```bash
find src -name '*.ts' | brain queue add my-queue
```

### `brain set`

| Command | Description |
|---|---|
| `brain set list` | List sets (`name \t count`) |
| `brain set members <set>` | List keys (one per line) |
| `brain set add <set> [--key <k>]` | Add keys from stdin or single `--key` |
| `brain set remove <set> --key <k>` | Remove a key |
| `brain set has <set> --key <k>` | Check membership; prints `true`/`false`, exit 0/1 |
| `brain set in <set>` | Filter stdin to members only |
| `brain set not-in <set>` | Filter stdin to non-members only |
| `brain set delete <set>` | Delete set and all members |

```bash
# Enqueue unreviewed controllers
find com -path '*/controllers/*.cfc' -type f \
  | brain set not-in bug-free-controllers \
  | brain queue add review-queue
```

### `brain backup`

| Command | Description |
|---|---|
| `brain backup` | Create backup; prints path. Stored in `~/.mcp-brain/backups/` (48 hourly + 30 daily) |
| `brain backup install-cron` | Install hourly backup cron job |

## MCP Server

Add to your Claude Code settings (`~/.claude/settings.json`) so Claude manages the process automatically:

```json
{
  "mcpServers": {
    "brain": {
      "command": "node",
      "args": ["/absolute/path/to/brain/dist/server.js"]
    }
  }
}
```

For project-scoped use, add the same config to `.claude/settings.json` in your repo instead.

### MCP Tools

**Projects & Tasks**

| Tool | Description |
|---|---|
| `list_projects` | List all projects |
| `create_project` | Create/update a project and its lifecycle states |
| `create_tasks` | Create tasks in a project |
| `list_tasks` | List task summaries, optionally filtered by status |
| `get_task` | Get full task content by ID |
| `update_task` | Update task fields (title, body, status, sequence, refs) |
| `append_to_task` | Append text to a task's body |
| `search_tasks` | Full-text search across tasks |
| `delete_task` | Soft-delete a task |

**Queues**

| Tool | Description |
|---|---|
| `list_queues` | List all queues with item counts |
| `enqueue` | Add items to a queue (newline-delimited). Auto-creates the queue. |
| `get_queue_length` | Get number of items in a queue |
| `get_next_queue_item` | Peek at the next item (FIFO). Does not remove it. |
| `delete_queue_item` | Delete an item by ID (call after processing) |

**Sets**

| Tool | Description |
|---|---|
| `list_sets` | List all sets with member counts |
| `add_to_set` | Add a key to a set. Auto-creates the set. Duplicates ignored. |
| `remove_from_set` | Remove a key from a set |
| `set_has` | Check if a key exists in a set (returns true/false) |
| `list_set_members` | List all keys in a set |
| `delete_set` | Delete an entire set and all its members |

## Database

SQLite database stored at `~/.mcp-brain/brain.db` by default. Override with:

```bash
export MCP_BRAIN_DB=/path/to/custom.db
```

## Queue Workflow

Queues implement a simple FIFO peek-and-delete pattern:

1. **Enqueue** items (MCP `enqueue` or CLI `--enqueue`)
2. **Peek** at the next item (MCP `get_next_queue_item` or CLI `--next-queue-item`) — returns the first item without removing it
3. **Process** the item
4. **Delete** the item by ID (MCP `delete_queue_item` or CLI `--delete-queue-item`)
5. Repeat from step 2

Peeking again before deleting returns the same item. Deleting advances the queue.

## Development

```bash
pnpm dev:server    # run MCP server with tsx
pnpm dev:cli       # run CLI with tsx
pnpm test          # run tests
pnpm build         # compile TypeScript
```
