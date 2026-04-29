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
| `brain project create <name> [--states <s,s,s>]` | Create/update a project (default states: `pending,active,done`) |
| `brain project list` | List projects (`name \t count`) |
| `brain project list <project> [--status <s>]` | List tasks in a project (`id \t status \t seq \t title`) |
| `brain project get-task <id>` | Full task as JSON |
| `brain project search <query>` | Full-text search (`id \t project \t status \t title`) |
| `brain project list-deleted [project]` | Trashed tasks (`id \t project \t title \t deleted_at`) |
| `brain project delete-by-status <project> <status>` | Soft-delete all tasks matching a status |
| `brain project restore-task <id>` | Restore a soft-deleted task |
| `brain project empty-trash [project]` | Permanently delete all trashed tasks |
| `brain project delete <project>` | Delete a project only when it has zero tasks (including trashed) |

### `brain queue`

| Command | Description |
|---|---|
| `brain queue list` | List queues (`name \t count`) |
| `brain queue items <queue>` | List items (`id \t value`) |
| `brain queue add <queue>` | Enqueue from stdin; auto-creates queue |
| `brain queue next <queue>` | Claim next FIFO item (`id \t value`); exit 1 if empty |
| `brain queue claimed <queue>` | List items currently claimed by consumers |
| `brain queue release <id>` | Release a claimed item back to the queue |
| `brain queue release-all <queue>` | Release all claimed items in a queue |
| `brain queue delete-item <id>` | Delete item by ID (call after processing) |
| `brain queue delete <queue>` | Delete queue and all items |
| `brain queue run <queue> [flags] <command...>` | Process items in parallel with an external command (see below) |

```bash
find src -name '*.ts' | brain queue add my-queue
```

#### `brain queue run` — parallel queue processing

Claim items from a queue and process them in parallel with an external command. Brain owns the claim/complete lifecycle; your command just does the work.

```bash
brain queue run <queue> [flags] <command...>
```

Everything after the flags is the command to run, verbatim. Example:

```bash
brain queue run review-queue -c 4 tsx .hunt/adversarial-code-review.ts
brain queue run image-queue -c 8 python process.py --mode batch
brain queue run my-queue ./my-worker.sh
```

**Worker contract**

For each queue item, brain spawns one invocation of your command:

- The item's **value** is piped to the worker's **stdin**
- The item's **id** is in the `BRAIN_ITEM_ID` env var (for logging/correlation; brain handles lifecycle)
- Exit **0** → brain deletes the item (complete)
- Exit **non-zero** → brain deletes + re-enqueues the item to the **tail** (so poison items don't block the head)

**Flags**

| Flag | Description |
|---|---|
| `-c, --concurrency <n>` | Max parallel workers (default: 1) |
| `--stream` | Disable TUI; stream progress + worker output line-by-line |
| `-s, --silent` | Disable TUI; show progress lines only (no worker output) |
| `-S, --extra-silent` | Suppress all output (exit code only) |
| `--debug [path]` | Write per-item `stdout` / `stderr` / `meta.json` to a directory (default: `.brain-run/<timestamp>/`) |

Default mode is a live TUI when stdout is a TTY. Non-TTY (pipes, CI) auto-switches to `--stream`.

**Live stats (TUI)**

The TUI shows running averages once at least one worker has finished:

- `avg` / `median` — per-thread runtime across the current session
- `eta` — estimated wall-clock time remaining, computed as `(remaining / workers) × median`. Median is used over mean so a single stuck job doesn't blow up the estimate.

Durations auto-scale: `350ms` → `12.3s` → `2m05s` → `1h32m` → `3d04h`.

**Interactive controls (TUI)**

- `+` / `=` — increase worker count
- `-` — decrease worker count (extra workers wind down as any finishes; pool shrinks immediately)
- `ctrl+c` — drain (finish active workers, don't claim new ones)
- `ctrl+c` twice — force quit (kill workers, release claimed items)

**Exit code**

`0` if all items succeeded, `1` if any failed or were re-enqueued.

**Concurrent consumers**

`brain queue run` uses the same claim semantics as `brain queue next` / MCP `claim_queue_item`, so multiple runners (or a runner + manual consumers) can share a queue safely.

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
| `get_queue_length` | Get number of unclaimed items in a queue |
| `claim_queue_item` | Claim the next FIFO item (hides from other consumers) |
| `complete_queue_item` | Complete (delete) a claimed item by ID |
| `release_queue_item` | Release a claimed item back to the queue |

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

Queues implement a FIFO claim-and-complete pattern that supports safe parallel consumers:

1. **Enqueue** items (`brain queue add` / MCP `enqueue`)
2. **Claim** the next item (`brain queue next` / MCP `claim_queue_item`) — atomically marks it as in-progress and hides it from other consumers
3. **Process** the item
4. **Complete** by deleting the item (`brain queue delete-item` / MCP `complete_queue_item`), or **release** it back to the queue if you couldn't finish (`brain queue release`)
5. Repeat

For batch parallel processing, use `brain queue run` — it handles the whole lifecycle for you.

## Development

```bash
pnpm dev:server    # run MCP server with tsx
pnpm dev:cli       # run CLI with tsx
pnpm test          # run tests
pnpm build         # compile TypeScript
```
