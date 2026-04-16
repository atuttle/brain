import logUpdate from "log-update";
import pc from "picocolors";

export type SlotPhase = "idle" | "run" | "done" | "error" | "winding_down";

export interface SlotState {
  phase: SlotPhase;
  label: string;
  startedAt: number;
}

export interface RunDisplayState {
  queueName: string;
  slots: SlotState[];
  maxWorkers: number;
  completed: number;
  failed: number;
  remaining: number;
  draining: boolean;
  elapsed: number;
}

const PHASE_COLORS: Record<SlotPhase, (s: string) => string> = {
  idle: pc.dim,
  run: pc.cyan,
  done: pc.green,
  error: pc.red,
  winding_down: pc.yellow,
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "\u2026";
}

function formatTime(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function render(state: RunDisplayState): string {
  const lines: string[] = [""];
  const sep = pc.dim("\u2800".repeat(80));

  // Header
  const drainingTag = state.draining
    ? pc.yellow(" DRAINING")
    : "";
  lines.push(
    `${pc.bold("brain queue run")} ${pc.dim("\u2800")} ${pc.white(state.queueName)} ${pc.dim("\u2800")} ${state.maxWorkers} workers ${pc.dim("\u2800")} ${formatTime(state.elapsed)}${drainingTag}`
  );
  lines.push(sep);

  // Slot rows
  for (let i = 0; i < state.slots.length; i++) {
    const slot = state.slots[i];
    const num = `#${String(i + 1).padStart(2, " ")}`;
    const isExcess = i >= state.maxWorkers;

    if (slot.phase === "idle") {
      lines.push(`  ${pc.dim(num)}  ${pc.dim("\u25CB idle")}`);
      continue;
    }

    const displayPhase = isExcess ? "winding_down" : slot.phase;
    const color = PHASE_COLORS[displayPhase];
    const phaseLabel = isExcess ? "wind" : slot.phase;
    const slotElapsed = formatTime(Date.now() - slot.startedAt);
    const label = truncate(slot.label, 80);
    lines.push(
      `  ${pc.dim(num)}  ${color("\u25CF")} ${color(phaseLabel.padEnd(5))} ${pc.dim(slotElapsed)}  ${label}`
    );
  }

  lines.push("");

  // Summary
  const parts: string[] = [];
  parts.push(pc.green(`completed: ${state.completed}`));
  parts.push(pc.red(`failed: ${state.failed}`));
  parts.push(pc.dim(`remaining: ${state.remaining}`));
  lines.push("  " + parts.join("  "));

  lines.push(sep);
  lines.push(
    pc.dim("  +/- workers  \u00B7  ctrl+c drain  \u00B7  ctrl+c\u00D72 quit")
  );

  return lines.join("\n");
}

let destroyed = false;

export function update(state: RunDisplayState): void {
  if (destroyed) return;
  logUpdate(render(state));
}

export function destroy(state: RunDisplayState): void {
  destroyed = true;
  logUpdate(render(state));
  logUpdate.done();
}

export function reset(): void {
  destroyed = false;
}
