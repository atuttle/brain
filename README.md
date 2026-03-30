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
| `append_to_chunk` | Append text to a chunk's body |
| `search_chunks` | Full-text search across chunks |
| `delete_chunk` | Soft-delete a chunk |

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

## CLI

Interactive TUI for managing the database:

```bash
node dist/cli.js
```

### Non-interactive CLI flags

These flags bypass the interactive menu and are suitable for scripts, cron jobs, and piping.

**Projects & Chunks**

#### `--list-projects`

List all projects. Outputs `<name>\t<chunk_count>` per line.

```bash
node dist/cli.js --list-projects
```

#### `--list-chunks <project> [--status <status>]`

List records in a project. Outputs `<id>\t<status>\t<sequence>\t<title>` per line.

```bash
node dist/cli.js --list-chunks my-project
node dist/cli.js --list-chunks my-project --status done
```

#### `--get-chunk <id>`

Get full chunk content as JSON.

```bash
node dist/cli.js --get-chunk 42
```

#### `--search <query>`

Full-text search across all projects. Outputs `<id>\t<project>\t<status>\t<title>` per line.

```bash
node dist/cli.js --search "auth middleware"
```

#### `--list-deleted [project]`

List soft-deleted records. Outputs `<id>\t<project>\t<title>\t<deleted_at>`. Project is optional.

```bash
node dist/cli.js --list-deleted
node dist/cli.js --list-deleted my-project
```

#### `--restore-chunk <id>`

Restore a soft-deleted record.

```bash
node dist/cli.js --restore-chunk 42
```

#### `--empty-trash [project]`

Permanently delete all trashed records. Optionally scoped to a project.

```bash
node dist/cli.js --empty-trash
node dist/cli.js --empty-trash my-project
```

**Queues**

#### `--list-queues`

List all queues. Outputs `<name>\t<item_count>` per line.

```bash
node dist/cli.js --list-queues
```

#### `--enqueue <queue-name>`

Bulk-enqueue items from stdin, one per line. The queue is auto-created if it doesn't exist.

```bash
# Enqueue files from find
find src -name '*.ts' | node dist/cli.js --enqueue my-queue

# Enqueue with a heredoc
node dist/cli.js --enqueue todo-queue <<EOF
implement auth
write tests
update docs
EOF
```

Blank lines are ignored.

#### `--list-queue-items <queue-name>`

List all items in a queue. Outputs `<id>\t<value>` per line.

```bash
node dist/cli.js --list-queue-items scrape-queue
```

#### `--next-queue-item <queue-name>`

Peek at the next item in a queue. Outputs `<id>\t<value>`. Produces no output and exits 1 if the queue is empty.

```bash
node dist/cli.js --next-queue-item scrape-queue
```

#### `--delete-queue-item <item-id>`

Delete a queue item by ID (call after processing).

```bash
node dist/cli.js --delete-queue-item 42
```

#### `--delete-queue <queue-name>`

Delete an entire queue and all its items.

```bash
node dist/cli.js --delete-queue scrape-queue
```

**Sets**

#### `--list-sets`

List all sets. Outputs `<name>\t<member_count>` per line.

```bash
node dist/cli.js --list-sets
```

#### `--list-set-members <set-name>`

List all keys in a set (one per line, suitable for piping).

```bash
node dist/cli.js --list-set-members bug-free-controllers
```

#### `--add-to-set <set-name>`

Add keys to a set. Reads from stdin (one key per line) or accepts a single key via `--key`.

```bash
# Bulk add from stdin
find src -name '*.ts' | node dist/cli.js --add-to-set reviewed-files

# Single key
node dist/cli.js --add-to-set reviewed-files --key src/index.ts
```

#### `--remove-from-set <set-name> --key <key>`

Remove a single key from a set.

```bash
node dist/cli.js --remove-from-set reviewed-files --key src/index.ts
```

#### `--set-has <set-name> --key <key>`

Check if a key exists in a set. Prints `true`/`false`. Exits 0 if member, 1 if not.

```bash
node dist/cli.js --set-has reviewed-files --key src/index.ts
```

#### `--in-set <set-name>`

Filter stdin — only pass through lines that **are** members of the set.

```bash
find src -name '*.ts' | node dist/cli.js --in-set reviewed-files
```

#### `--not-in-set <set-name>`

Filter stdin — only pass through lines that **are not** members of the set. Composable with `--enqueue`:

```bash
# Find controllers, exclude already-reviewed ones, enqueue the rest
find com -path '*/controllers/*.cfc' -type f \
  | node dist/cli.js --not-in-set bug-free-controllers \
  | node dist/cli.js --enqueue review-queue
```

#### `--delete-set <set-name>`

Delete an entire set.

```bash
node dist/cli.js --delete-set bug-free-controllers
```

**Maintenance**

#### `--backup`

Create a database backup. Outputs the backup file path on success.

```bash
node dist/cli.js --backup
```

Backups are stored in `~/.mcp-brain/backups/`. Retention: 48 hourly + 30 daily.

#### `--install-cron`

Install an hourly backup cron job.

```bash
node dist/cli.js --install-cron
```

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
