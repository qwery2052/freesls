import { randomUUID } from "node:crypto";
import type { ScheduleDefinition } from "./types.js";
import {
  nextCronInstant,
  parseRecurringExpression,
  type ParsedRecurringExpression,
} from "./schedule-expression.js";

export interface ScheduleClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: ScheduleClock = {
  now: Date.now,
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ScheduleRunEvent {
  type: "registered" | "firing" | "delivered" | "failed" | "completed";
  schedule: ScheduleDefinition;
  due?: number;
  next?: number;
}

interface RegisteredSchedule {
  schedule: ScheduleDefinition;
  parsed: ParsedRecurringExpression;
  due?: number;
  timer?: unknown;
}

/**
 * Build the event AWS delivers for a scheduled rule or Scheduler schedule when
 * Target.Input is omitted. The identifiers are local simulations.
 */
export function buildScheduledEvent(
  schedule: ScheduleDefinition,
  due: number,
): Record<string, unknown> {
  return {
    version: "0",
    id: randomUUID(),
    "detail-type": "Scheduled Event",
    source: schedule.method === "scheduler" ? "aws.scheduler" : "aws.events",
    account: schedule.account,
    time: new Date(due).toISOString(),
    region: schedule.region,
    resources: [schedule.ruleArn],
    detail: {},
  };
}

/**
 * Run schedule events declared in serverless.yml or a SAM template.
 * Timers are in-memory, skip missed occurrences, and are cancelled on close().
 */
export class LocalScheduleRunner {
  private readonly entries = new Map<string, RegisteredSchedule>();
  private closed = false;
  private started = false;

  constructor(
    schedules: ScheduleDefinition[],
    private readonly execute: (schedule: ScheduleDefinition, event: unknown) => Promise<unknown>,
    private readonly clock: ScheduleClock = realClock,
    private readonly log: (event: ScheduleRunEvent) => void = () => {},
    private readonly report: (message: string) => void = message => console.error(message),
  ) {
    for (const schedule of schedules) {
      let parsed: ParsedRecurringExpression;
      try {
        parsed = parseRecurringExpression(schedule.expression, schedule.timezone);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid schedule for function ${schedule.functionName}: ${message}`);
      }
      this.entries.set(`${schedule.method}:${schedule.scheduleName}`, {
        schedule,
        parsed,
      });
    }
  }

  start(): void {
    if (this.closed || this.started) return;
    this.started = true;
    const now = this.clock.now();

    for (const entry of this.entries.values()) {
      if (!entry.schedule.enabled) {
        this.log({ type: "registered", schedule: entry.schedule });
        continue;
      }
      const due = this.firstDue(entry, now);
      if (due === null) {
        this.log({ type: "completed", schedule: entry.schedule });
        continue;
      }
      entry.due = due;
      this.arm(entry);
      this.log({ type: "registered", schedule: entry.schedule, due });
    }
  }

  close(): void {
    this.closed = true;
    for (const entry of this.entries.values()) {
      if (entry.timer !== undefined) this.clock.clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    this.entries.clear();
  }

  private firstDue(entry: RegisteredSchedule, now: number): number | null {
    if (entry.parsed.kind === "cron") return nextCronInstant(entry.parsed, now);
    return now + entry.parsed.intervalMs;
  }

  private nextDue(entry: RegisteredSchedule, currentDue: number, now: number): number | null {
    if (entry.parsed.kind === "cron") {
      return nextCronInstant(entry.parsed, Math.max(currentDue, now));
    }
    if (now < currentDue) return currentDue + entry.parsed.intervalMs;
    const missedIntervals = Math.floor((now - currentDue) / entry.parsed.intervalMs) + 1;
    return currentDue + missedIntervals * entry.parsed.intervalMs;
  }

  private arm(entry: RegisteredSchedule): void {
    if (this.closed || entry.due === undefined) return;
    const delay = Math.min(2147483647, Math.max(0, entry.due - this.clock.now()));
    entry.timer = this.clock.setTimeout(() => {
      entry.timer = undefined;
      if (this.closed || entry.due === undefined) return;
      if (this.clock.now() < entry.due) {
        this.arm(entry);
        return;
      }
      void this.fire(entry);
    }, delay);
  }

  private async fire(entry: RegisteredSchedule): Promise<void> {
    if (this.closed || entry.due === undefined) return;
    const due = entry.due;
    this.log({ type: "firing", schedule: entry.schedule, due });

    const event =
      entry.schedule.input === undefined
        ? buildScheduledEvent(entry.schedule, due)
        : structuredClone(entry.schedule.input);

    let failed = false;
    try {
      await this.execute(entry.schedule, event);
    } catch {
      failed = true;
      this.report(
        `[FreeSLS Schedule] Invocation failed for ${entry.schedule.functionName} (${entry.schedule.scheduleName}); inspect it with --debug. Payload and error contents are omitted.`,
      );
      this.log({ type: "failed", schedule: entry.schedule, due });
    }

    if (this.closed) return;
    const next = this.nextDue(entry, due, this.clock.now());
    if (!failed)
      this.log({ type: "delivered", schedule: entry.schedule, due, next: next ?? undefined });
    if (next === null) {
      entry.due = undefined;
      this.log({ type: "completed", schedule: entry.schedule });
      return;
    }
    entry.due = next;
    this.arm(entry);
  }
}
