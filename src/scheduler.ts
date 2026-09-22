import express from "express";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { awsPartition } from "./resolver.js";

export class SchedulerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}
function invalid(message: string): never {
  throw new SchedulerError("ValidationException", message);
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(`${field} must be an object.`);
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[], field: string) {
  if (Object.keys(value).some(key => !allowed.includes(key)))
    invalid(`Unsupported ${field} option. Accepted fields: ${allowed.join(", ")}.`);
}
function choice(value: unknown, choices: string[], field: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !choices.includes(value))
    invalid(`${field} accepts: ${choices.join(", ")}.`);
  return value;
}

/** Sort recursively so HTTP JSON property ordering does not affect idempotency. */
function canonicalize(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== "ClientToken")
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonicalize(item)]),
      )
    : value;
}

/** Interpret wall-clock dates independently of the host timezone. Reject DST ambiguity explicitly. */
export function scheduleInstant(expression: unknown, timezone: unknown = "UTC"): number {
  if (
    typeof expression !== "string" ||
    !/^at\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\)$/.test(expression)
  )
    invalid(
      "Supported schedule expression: at(YYYY-MM-DDTHH:mm:ss). cron/rate are not supported locally.",
    );
  if (typeof timezone !== "string")
    invalid(
      "ScheduleExpressionTimezone must be an IANA time zone, for example America/Bogota or UTC.",
    );
  const wall = expression.slice(3, -1);
  const utc = Date.parse(`${wall}Z`);
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 19) !== wall)
    invalid("ScheduleExpression contains an invalid calendar date.");
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    invalid(
      "Unknown ScheduleExpressionTimezone. Use an IANA time zone, for example America/Bogota or UTC.",
    );
  }
  const localEpoch = (time: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(time).map(p => [p.type, p.value]));
    return Date.parse(
      `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`,
    );
  };
  const candidates = new Set<number>();
  for (const delta of [-172800000, -86400000, 0, 86400000, 172800000]) {
    const probe = utc + delta;
    const candidate = utc - (localEpoch(probe) - probe);
    if (localEpoch(candidate) === utc) candidates.add(candidate);
  }
  if (candidates.size !== 1)
    invalid(
      "This local date is missing or ambiguous during a timezone transition. Use an unambiguous date or an explicit UTC schedule; local DST gap/overlap emulation is not supported.",
    );
  return [...candidates][0];
}

export interface SchedulerClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realClock: SchedulerClock = {
  now: Date.now,
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
export interface SchedulerEvent {
  type: "received" | "updated" | "firing" | "delivered" | "cancelled" | "expired" | "failed";
  name: string;
  target: string;
  due?: number;
  timezone?: string;
  state?: string;
  action?: string;
  retries?: number;
  maxAgeSeconds?: number;
}

interface Schedule {
  body: Record<string, unknown>;
  arn: string;
  created: number;
  modified: number;
  due: number;
  payload: unknown;
  target: string;
  retries: number;
  maxAge: number;
  attempts: number;
  timer?: unknown;
}

/** Delivery resolves when accepted, not when the asynchronous Lambda handler finishes. */
export class LocalScheduler {
  private schedules = new Map<string, Schedule>();
  private tokens = new Map<string, { fingerprint: string; arn: string }>();
  private closed = false;
  constructor(
    private readonly region: string,
    private readonly targets: ReadonlySet<string>,
    private readonly deliver: (arn: string, input: unknown) => Promise<void>,
    private readonly clock: SchedulerClock = realClock,
    private readonly report: (message: string) => void = message => console.error(message),
    private readonly log: (event: SchedulerEvent) => void = () => {},
  ) {}

  private identity(name: string, group: unknown) {
    if (!/^[\w.-]{1,64}$/.test(name))
      invalid("Name must contain 1-64 letters, digits, underscores, dots or hyphens.");
    if (group !== undefined && group !== "default")
      invalid("Only GroupName default is supported. Omit GroupName or use default.");
  }

  private parse(name: string, input: unknown, operation: string) {
    const body = structuredClone(object(input, operation));
    fields(
      body,
      [
        "Name",
        "ClientToken",
        "Description",
        "GroupName",
        "ScheduleExpression",
        "ScheduleExpressionTimezone",
        "FlexibleTimeWindow",
        "ActionAfterCompletion",
        "State",
        "Target",
      ],
      operation,
    );
    this.identity(name, body.GroupName);
    if (body.Name !== undefined && body.Name !== name) invalid("Name must match the request path.");
    if (
      body.Description !== undefined &&
      (typeof body.Description !== "string" || body.Description.length > 512)
    )
      invalid("Description must be a string of at most 512 characters.");
    const token = body.ClientToken;
    if (token !== undefined && (typeof token !== "string" || !/^[\w-]{1,64}$/.test(token)))
      invalid("ClientToken must contain 1-64 letters, digits, underscores or hyphens.");
    const window = object(body.FlexibleTimeWindow, "FlexibleTimeWindow");
    fields(window, ["Mode"], "FlexibleTimeWindow");
    if (window.Mode !== "OFF")
      invalid(
        "FlexibleTimeWindow must be { Mode: OFF }. Flexible delivery windows are not supported locally.",
      );
    const target = object(body.Target, "Target");
    fields(
      target,
      ["Arn", "RoleArn", "Input", "RetryPolicy"],
      "Target (only registered Lambda functions are supported)",
    );
    if (
      typeof target.Arn !== "string" ||
      !/^arn:aws(?:-cn|-us-gov)?:lambda:[a-z0-9-]+:\d{12}:function:[\w-]{1,64}$/.test(target.Arn) ||
      !this.targets.has(target.Arn)
    )
      invalid(
        "Target.Arn must exactly identify a Lambda registered in this project. External functions, aliases, versions and other AWS targets are not supported locally.",
      );
    if (
      typeof target.RoleArn !== "string" ||
      target.RoleArn.length > 1600 ||
      !/^arn:aws(?:-cn|-us-gov)?:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(target.RoleArn)
    )
      invalid(
        "Target.RoleArn must be an IAM role ARN. Declare a local IAM role or provide --cf-value LogicalId.Arn=value. IAM authorization is not emulated.",
      );
    let payload: unknown;
    if (typeof target.Input !== "string" || Buffer.byteLength(target.Input) > 262144)
      invalid(
        "Target.Input must be an explicit JSON string of at most 262144 bytes. Use '{}' for an empty event; the AWS default notification is not emulated.",
      );
    if (target.Input.includes("<aws.scheduler."))
      invalid(
        "Scheduler context placeholders in Target.Input are not supported locally. Supply explicit JSON values.",
      );
    try {
      payload = JSON.parse(target.Input);
    } catch {
      invalid("Target.Input must contain valid JSON; its contents are not included in this error.");
    }
    const retry = target.RetryPolicy === undefined ? {} : object(target.RetryPolicy, "RetryPolicy");
    fields(retry, ["MaximumRetryAttempts", "MaximumEventAgeInSeconds"], "RetryPolicy");
    const retries = retry.MaximumRetryAttempts ?? 185;
    const age = retry.MaximumEventAgeInSeconds ?? 86400;
    if (!Number.isInteger(retries) || Number(retries) < 0 || Number(retries) > 185)
      invalid("MaximumRetryAttempts must be an integer between 0 and 185.");
    if (!Number.isInteger(age) || Number(age) < 60 || Number(age) > 86400)
      invalid("MaximumEventAgeInSeconds must be an integer between 60 and 86400.");
    body.State = choice(body.State, ["ENABLED", "DISABLED"], "State", "ENABLED");
    body.ActionAfterCompletion = choice(
      body.ActionAfterCompletion,
      ["NONE", "DELETE"],
      "ActionAfterCompletion",
      "NONE",
    );
    body.GroupName = "default";
    body.ScheduleExpressionTimezone ??= "UTC";
    const due = scheduleInstant(body.ScheduleExpression, body.ScheduleExpressionTimezone);
    return {
      body,
      token,
      targetArn: target.Arn,
      payload,
      retries: Number(retries),
      age: Number(age),
      due,
    };
  }

  create(name: string, input: unknown): { ScheduleArn: string } {
    if (this.closed)
      throw new SchedulerError("InternalServerException", "Local Scheduler is shutting down.", 500);
    const { body, token, targetArn, payload, retries, age, due } = this.parse(
      name,
      input,
      "CreateSchedule",
    );
    const fingerprint = JSON.stringify(["create", name, canonicalize(body)]);
    // AWS idempotency replays the original response for the same token even if the
    // schedule was later deleted: the token is not invalidated by DeleteSchedule.
    // Tokens are session-scoped; AWS documents a 24h / resource-lifetime-plus-one-hour window.
    if (typeof token === "string" && this.tokens.has(token)) {
      const prior = this.tokens.get(token)!;
      if (prior.fingerprint !== fingerprint)
        throw new SchedulerError(
          "ConflictException",
          "ClientToken was already used with different schedule parameters.",
          409,
        );
      return { ScheduleArn: prior.arn };
    }
    if (this.schedules.has(name))
      throw new SchedulerError(
        "ConflictException",
        "A schedule with this name already exists in group default. Delete it first or use a different name.",
        409,
      );
    if (due <= this.clock.now())
      invalid(
        "Local one-time schedules must be in the future. Check the date and ScheduleExpressionTimezone.",
      );
    const arn = `arn:${awsPartition(this.region)}:scheduler:${this.region}:123456789012:schedule/default/${name}`;
    const now = this.clock.now();
    const schedule: Schedule = {
      body,
      arn,
      created: now,
      modified: now,
      due,
      payload,
      target: targetArn,
      retries,
      maxAge: age * 1000,
      attempts: 0,
    };
    this.schedules.set(name, schedule);
    if (typeof token === "string") this.tokens.set(token, { fingerprint, arn });
    if (body.State === "ENABLED") this.arm(name, schedule, due);
    this.log({
      type: "received",
      name,
      target: targetArn,
      due,
      timezone: String(body.ScheduleExpressionTimezone),
      state: String(body.State),
      action: String(body.ActionAfterCompletion),
      retries,
      maxAgeSeconds: age,
    });
    return { ScheduleArn: arn };
  }

  update(name: string, input: unknown): { ScheduleArn: string } {
    if (this.closed)
      throw new SchedulerError("InternalServerException", "Local Scheduler is shutting down.", 500);
    const existing = this.schedules.get(name);
    if (!existing)
      throw new SchedulerError(
        "ResourceNotFoundException",
        "Schedule does not exist in this local session.",
        404,
      );
    const { body, token, targetArn, payload, retries, age, due } = this.parse(
      name,
      input,
      "UpdateSchedule",
    );
    const fingerprint = JSON.stringify(["update", name, canonicalize(body)]);
    if (typeof token === "string" && this.tokens.has(token)) {
      const prior = this.tokens.get(token)!;
      if (prior.fingerprint !== fingerprint)
        throw new SchedulerError(
          "ConflictException",
          "ClientToken was already used with different schedule parameters.",
          409,
        );
      return { ScheduleArn: prior.arn };
    }
    if (due <= this.clock.now())
      invalid(
        "Local one-time schedules must be in the future. Check the date and ScheduleExpressionTimezone.",
      );
    if (existing.timer !== undefined) this.clock.clearTimeout(existing.timer);
    const now = this.clock.now();
    const schedule: Schedule = {
      body,
      arn: existing.arn,
      created: existing.created,
      modified: now,
      due,
      payload,
      target: targetArn,
      retries,
      maxAge: age * 1000,
      attempts: 0,
    };
    this.schedules.set(name, schedule);
    if (typeof token === "string") this.tokens.set(token, { fingerprint, arn: existing.arn });
    if (body.State === "ENABLED") this.arm(name, schedule, due);
    this.log({
      type: "updated",
      name,
      target: targetArn,
      due,
      timezone: String(body.ScheduleExpressionTimezone),
      state: String(body.State),
      action: String(body.ActionAfterCompletion),
      retries,
      maxAgeSeconds: age,
    });
    return { ScheduleArn: existing.arn };
  }

  get(name: string, group?: unknown): Record<string, unknown> {
    this.identity(name, group);
    const s = this.schedules.get(name);
    if (!s)
      throw new SchedulerError(
        "ResourceNotFoundException",
        "Schedule does not exist in this local session.",
        404,
      );
    const { ClientToken: _token, ...body } = s.body;
    return structuredClone({
      ...body,
      Name: name,
      Arn: s.arn,
      CreationDate: s.created / 1000,
      LastModificationDate: s.modified / 1000,
    });
  }

  list(query: Record<string, unknown> = {}): {
    Schedules: Array<Record<string, unknown>>;
    NextToken?: string;
  } {
    fields(
      query,
      ["MaxResults", "NamePrefix", "NextToken", "ScheduleGroup", "State"],
      "ListSchedules",
    );
    if (query.ScheduleGroup !== undefined && query.ScheduleGroup !== "default")
      invalid("Only ScheduleGroup default is supported. Omit ScheduleGroup or use default.");
    let maxResults = 100;
    if (query.MaxResults !== undefined) {
      const parsed = Number(query.MaxResults);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100)
        invalid("MaxResults must be an integer between 1 and 100.");
      maxResults = parsed;
    }
    let namePrefix = "";
    if (query.NamePrefix !== undefined) {
      if (typeof query.NamePrefix !== "string" || !/^[\w.-]{1,64}$/.test(query.NamePrefix))
        invalid("NamePrefix must contain 1-64 letters, digits, underscores, dots or hyphens.");
      namePrefix = query.NamePrefix;
    }
    let stateFilter: string | undefined;
    if (query.State !== undefined) {
      if (query.State !== "ENABLED" && query.State !== "DISABLED")
        invalid("State accepts: ENABLED, DISABLED.");
      stateFilter = String(query.State);
    }
    let offset = 0;
    if (query.NextToken !== undefined) {
      let decoded = "";
      try {
        decoded = Buffer.from(String(query.NextToken), "base64url").toString("utf8");
      } catch {
        decoded = "";
      }
      if (!/^\d+$/.test(decoded)) invalid("NextToken is not valid for this local session.");
      offset = Number(decoded);
    }
    const matches = [...this.schedules.entries()]
      .filter(
        ([name, s]) =>
          name.startsWith(namePrefix) &&
          (stateFilter === undefined || s.body.State === stateFilter),
      )
      .sort(([a], [b]) => a.localeCompare(b));
    const page = matches.slice(offset, offset + maxResults);
    const result: { Schedules: Array<Record<string, unknown>>; NextToken?: string } = {
      Schedules: page.map(([name, s]) => ({
        Arn: s.arn,
        Name: name,
        GroupName: "default",
        State: s.body.State,
        CreationDate: s.created / 1000,
        LastModificationDate: s.modified / 1000,
        Target: { Arn: s.target },
      })),
    };
    const nextOffset = offset + page.length;
    if (nextOffset < matches.length)
      result.NextToken = Buffer.from(String(nextOffset)).toString("base64url");
    return result;
  }

  delete(name: string, group?: unknown): void {
    this.identity(name, group);
    const schedule = this.schedules.get(name);
    if (!schedule)
      throw new SchedulerError(
        "ResourceNotFoundException",
        "Schedule does not exist in this local session.",
        404,
      );
    this.removeSchedule(name, schedule);
    this.log({ type: "cancelled", name, target: schedule.target });
  }

  private removeSchedule(name: string, schedule: Schedule) {
    if (this.schedules.get(name) !== schedule) return;
    if (schedule.timer !== undefined) this.clock.clearTimeout(schedule.timer);
    this.schedules.delete(name);
  }

  private arm(name: string, s: Schedule, when: number) {
    if (this.closed || this.schedules.get(name) !== s) return;
    s.timer = this.clock.setTimeout(
      () => {
        if (this.closed || this.schedules.get(name) !== s) return;
        if (this.clock.now() < when) {
          this.arm(name, s, when);
          return;
        }
        void this.dispatch(name, s);
      },
      Math.min(2147483647, Math.max(0, when - this.clock.now())),
    );
  }

  private async dispatch(name: string, s: Schedule) {
    const finish = () => {
      if (s.body.ActionAfterCompletion === "DELETE") this.removeSchedule(name, s);
    };
    if (this.clock.now() - s.due >= s.maxAge) {
      this.report(`[FreeSLS Scheduler] Delivery expired for ${name}.`);
      this.log({ type: "expired", name, target: s.target });
      finish();
      return;
    }
    this.log({ type: "firing", name, target: s.target, due: s.due });
    try {
      await this.deliver(s.target, structuredClone(s.payload));
      this.log({ type: "delivered", name, target: s.target });
      finish();
    } catch {
      if (this.closed || this.schedules.get(name) !== s) return;
      if (s.attempts++ < s.retries && this.clock.now() - s.due < s.maxAge) {
        // Deterministic capped exponential delivery backoff; AWS jitter is not emulated.
        this.arm(
          name,
          s,
          Math.min(
            s.due + s.maxAge,
            this.clock.now() + Math.min(60000, 1000 * 2 ** Math.min(s.attempts - 1, 6)),
          ),
        );
      } else {
        this.report(`[FreeSLS Scheduler] Delivery failed for ${name}; retry policy exhausted.`);
        this.log({ type: "failed", name, target: s.target });
        finish();
      }
    }
  }

  close() {
    this.closed = true;
    for (const schedule of this.schedules.values())
      if (schedule.timer !== undefined) this.clock.clearTimeout(schedule.timer);
    this.schedules.clear();
    this.tokens.clear();
  }
}

export async function startScheduler(
  scheduler: LocalScheduler,
): Promise<{ endpoint: string; close(): Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: "300kb" }));
  app.all("/schedules", (req, res, next) => {
    try {
      if (req.method !== "GET") invalid("ListSchedules only supports GET /schedules.");
      res.json(scheduler.list(req.query));
    } catch (error) {
      next(error);
    }
  });
  app.all("/schedules/:name", (req, res, next) => {
    try {
      fields(
        req.query,
        req.method === "DELETE"
          ? ["groupName", "clientToken"]
          : req.method === "GET"
            ? ["groupName"]
            : [],
        "query",
      );
      if (req.method === "POST") res.json(scheduler.create(String(req.params.name), req.body));
      else if (req.method === "PUT") res.json(scheduler.update(String(req.params.name), req.body));
      else if (req.method === "GET")
        res.json(scheduler.get(String(req.params.name), req.query.groupName));
      else if (req.method === "DELETE") {
        scheduler.delete(String(req.params.name), req.query.groupName);
        res.json({});
      } else
        invalid(
          "Supported operations: CreateSchedule (POST), GetSchedule (GET), UpdateSchedule (PUT), DeleteSchedule (DELETE).",
        );
    } catch (error) {
      next(error);
    }
  });
  app.use((_req, _res, next) =>
    next(
      new SchedulerError(
        "ValidationException",
        "Supported local Scheduler endpoints: POST/GET/PUT/DELETE /schedules/{Name} and GET /schedules.",
      ),
    ),
  );
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const e =
        error instanceof SchedulerError
          ? error
          : new SchedulerError(
              "ValidationException",
              "Invalid request. Send a JSON CreateSchedule body within the 300KB local request limit.",
            );
      res
        .status(e.status)
        .set("x-amzn-errortype", e.code)
        .set("x-amzn-requestid", randomUUID())
        .json({ Message: e.message });
    },
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as import("node:net").AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => {
      scheduler.close();
      return new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      });
    },
  };
}
