/**
 * auto-clear.ts — Turn-based auto-clearing of completed tasks.
 *
 * Two modes:
 * - "on_task_complete": each completed task gets its own REMINDER_INTERVAL countdown, deleted individually
 * - "on_list_complete": countdown starts when ALL tasks are completed, cleared as a batch
 *
 * Both use the same turn delay (REMINDER_INTERVAL) for consistency.
 *
 * Both countdowns are measured in turns and only tick at `turn_start`, so they stop
 * the moment the agent does. That is fine while the conversation continues — the
 * turns keep coming — but a run that ends right after its last completion, which is
 * the usual shape, leaves the finished list sitting there with its countdown frozen,
 * and the next batch of work is then added to it.
 *
 * `startNewBatch()` covers that case. It has to tell a new batch from the same batch
 * still being built, and the store cannot: an agent adding its next task to a list it
 * has just finished looks identical either way. The run boundary is what separates
 * them — work added within the run that completed the list belongs to it, work added
 * after that run ended does not — so the sweep is armed by `onRunEnded()`.
 */

import type { TaskStore } from "./task-store.js";

export type AutoClearMode = "never" | "on_list_complete" | "on_task_complete";

export class AutoClearManager {
  /** Per-task: turn when task was marked completed ("on_task_complete" mode). */
  private completedAtTurn = new Map<string, number>();
  /** Turn when ALL tasks became completed ("on_list_complete" mode). */
  private allCompletedAtTurn: number | null = null;
  /** An agent run has ended since the current list was last added to. */
  private runEnded = false;

  constructor(
    private getStore: () => TaskStore,
    private getMode: () => AutoClearMode,
    /** How many turns completed tasks linger before auto-clearing. */
    private clearDelayTurns = 4,
  ) {}

  /** Record a task completion. Call AFTER cascade logic. */
  trackCompletion(taskId: string, currentTurn: number): void {
    const mode = this.getMode();
    if (mode === "never") return;

    if (mode === "on_task_complete") {
      this.completedAtTurn.set(taskId, currentTurn);
    } else if (mode === "on_list_complete") {
      this.checkAllCompleted(currentTurn);
    }
  }

  /** Check if all tasks are completed and start/reset the batch countdown. */
  private checkAllCompleted(currentTurn: number): void {
    const tasks = this.getStore().list();
    if (tasks.length > 0 && tasks.every(t => t.status === "completed")) {
      if (this.allCompletedAtTurn === null) this.allCompletedAtTurn = currentTurn;
    } else {
      this.allCompletedAtTurn = null;
    }
  }

  /** Reset batch countdown (e.g., when a new task is created or task goes non-completed). */
  resetBatchCountdown(): void {
    this.allCompletedAtTurn = null;
  }

  /** No automatic retry, compaction or queued continuation is coming, so the list as
   *  it stands is this run's final one. Also true of a list carried into a resumed or
   *  forked session: the run that produced it ended with the session before. */
  onRunEnded(): void {
    this.runEnded = true;
  }

  /** A task is about to be created. If a run has ended since this list was last added
   *  to and there is nothing left to do on it, the list belongs to the batch before
   *  this one — retire it, so the new task starts on a clean list instead of being
   *  appended to rows the user already saw finished.
   *
   *  Left alone otherwise: a list with unfinished work in it, and a list the agent is
   *  still building inside the same run (create, complete, create again), which would
   *  otherwise lose every step as soon as the next one was added. */
  startNewBatch(): void {
    this.allCompletedAtTurn = null;
    const afterFinishedRun = this.runEnded;
    this.runEnded = false;
    // Cheap-first: list() re-reads the file on a file-backed store.
    if (!afterFinishedRun || this.getMode() === "never") return;
    const tasks = this.getStore().list();
    if (tasks.length > 0 && tasks.every(t => t.status === "completed")) {
      this.getStore().clearCompleted();
      this.completedAtTurn.clear();
    }
  }

  /** Reset all tracking state (e.g., on new session). */
  reset(): void {
    this.completedAtTurn.clear();
    this.allCompletedAtTurn = null;
    this.runEnded = false;
  }

  /**
   * Called on each turn start. Deletes tasks whose linger period has expired.
   * Returns true if any tasks were cleared.
   */
  onTurnStart(currentTurn: number): boolean {
    const mode = this.getMode();
    let cleared = false;

    if (mode === "on_task_complete") {
      for (const [taskId, turn] of this.completedAtTurn) {
        const task = this.getStore().get(taskId);
        if (!task || task.status !== "completed") {
          // Task was deleted or reverted — drop stale tracking entry
          this.completedAtTurn.delete(taskId);
        } else if (currentTurn - turn >= this.clearDelayTurns) {
          this.getStore().delete(taskId);
          this.completedAtTurn.delete(taskId);
          cleared = true;
        }
      }
    } else if (mode === "on_list_complete" && this.allCompletedAtTurn !== null) {
      if (currentTurn - this.allCompletedAtTurn >= this.clearDelayTurns) {
        this.getStore().clearCompleted();
        this.allCompletedAtTurn = null;
        cleared = true;
      }
    }

    return cleared;
  }
}
