# mcp-brain

Persistent chunk-based task memory and work queues for Claude Code via MCP.

## Install

```bash
pnpm install
pnpm build
```

## CLI

Run with no flags for an interactive TUI, or use flags for scriptable access.

```bash
node dist/cli.js            # interactive
node dist/cli.js --flag     # non-interactive
```

All tabular output is `\t`-delimited. Stdin-accepting flags read one item per line, ignoring blanks.

### Chunks

| Flag | Description |
|---|---|
| `--list-projects` | List projects (`name \t count`) |
| `--list-chunks <project> [--status <s>]` | List chunks (`id \t status \t seq \t title`) |
| `--get-chunk <id>` | Full chunk as JSON |
| `--search <query>` | Full-text search (`id \t project \t status \t title`) |
| `--list-deleted [project]` | Trashed chunks (`id \t project \t title \t deleted_at`) |
| `--restore-chunk <id>` | Restore a soft-deleted chunk |
| `--empty-trash [project]` | Permanently delete all trashed chunks |

### Queues

| Flag | Description |
|---|---|
| `--list-queues` | List queues (`name \t count`) |
| `--enqueue <queue>` | Enqueue items from stdin; auto-creates queue |
| `--list-queue-items <queue>` | List items (`id \t value`) |
| `--next-queue-item <queue>` | Peek next FIFO item (`id \t value`); exit 1 if empty |
| `--delete-queue-item <id>` | Delete item by ID (call after processing) |
| `--delete-queue <queue>` | Delete queue and all items |

```bash
find src -name '*.ts' | node dist/cli.js --enqueue my-queue
```

### Sets

| Flag | Description |
|---|---|
| `--list-sets` | List sets (`name \t count`) |
| `--list-set-members <set>` | List keys (one per line) |
| `--add-to-set <set> [--key <k>]` | Add keys from stdin or single `--key` |
| `--remove-from-set <set> --key <k>` | Remove a key |
| `--set-has <set> --key <k>` | Check membership; prints `true`/`false`, exit 0/1 |
| `--in-set <set>` | Filter stdin to members only |
| `--not-in-set <set>` | Filter stdin to non-members only |
| `--delete-set <set>` | Delete set and all members |

```bash
# Enqueue unreviewed controllers
find com -path '*/controllers/*.cfc' -type f \
  | node dist/cli.js --not-in-set bug-free-controllers \
  | node dist/cli.js --enqueue review-queue
```

### Maintenance

| Flag | Description |
|---|---|
| `--backup` | Create backup; prints path. Stored in `~/.mcp-brain/backups/` (48 hourly + 30 daily) |
| `--install-cron` | Install hourly backup cron job |

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
