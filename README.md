# mcp-brain

Persistent chunk-based task memory and work queues for Claude Code via MCP.

## Install

```bash
pnpm install
pnpm build
```

## MCP Server

Start the MCP server (stdio transport):

```bash
node dist/server.js
```

### MCP Tools

**Projects & Chunks**

| Tool | Description |
|---|---|
| `list_projects` | List all projects |
| `create_project` | Create/update a project and its lifecycle states |
| `create_chunks` | Create chunks (units of work) in a project |
| `list_chunks` | List chunk summaries, optionally filtered by status |
| `get_chunk` | Get full chunk content by ID |
| `update_chunk` | Update chunk fields (title, body, status, sequence, refs) |
| `delete_chunk` | Soft-delete a chunk |

**Queues**

| Tool | Description |
|---|---|
| `list_queues` | List all queues with item counts |
| `enqueue` | Add items to a queue (newline-delimited). Auto-creates the queue. |
| `get_queue_length` | Get number of items in a queue |
| `get_next_queue_item` | Peek at the next item (FIFO). Does not remove it. |
| `delete_queue_item` | Delete an item by ID (call after processing) |

## CLI

Interactive TUI for managing the database:

```bash
node dist/cli.js
```

### Non-interactive CLI flags

These flags bypass the interactive menu and are suitable for scripts, cron jobs, and piping.

#### `--backup`

Create a database backup:

```bash
node dist/cli.js --backup
```

Backups are stored in `~/.mcp-brain/backups/`. Retention: 48 hourly + 30 daily.

#### `--enqueue <queue-name>`

Bulk-enqueue items from stdin, one per line. The queue is auto-created if it doesn't exist.

```bash
# Enqueue files from find
find src -name '*.ts' | node dist/cli.js --enqueue my-queue

# Enqueue from a file
cat urls.txt | node dist/cli.js --enqueue scrape-queue

# Enqueue with a heredoc
node dist/cli.js --enqueue todo-queue <<EOF
implement auth
write tests
update docs
EOF
```

Blank lines are ignored.

## Database

SQLite database stored at `~/.mcp-brain/brain.db` by default. Override with:

```bash
export MCP_BRAIN_DB=/path/to/custom.db
```

## Queue Workflow

Queues implement a simple FIFO peek-and-delete pattern:

1. **Enqueue** items (via MCP `enqueue` tool or CLI `--enqueue`)
2. **Peek** at the next item with `get_next_queue_item` -- returns the first item without removing it
3. **Process** the item
4. **Delete** the item with `delete_queue_item` using the returned ID
5. Repeat from step 2

Calling `get_next_queue_item` again before deleting returns the same item. Deleting advances the queue.

## Development

```bash
pnpm dev:server    # run MCP server with tsx
pnpm dev:cli       # run CLI with tsx
pnpm test          # run tests
pnpm build         # compile TypeScript
```
