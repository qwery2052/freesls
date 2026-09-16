import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  SchedulerClient,
  CreateScheduleCommand,
  GetScheduleCommand,
  UpdateScheduleCommand,
  DeleteScheduleCommand,
} from "@aws-sdk/client-scheduler";
import { LocalScheduler, scheduleInstant, startScheduler } from "../dist/scheduler.js";
import { loadServerlessConfig } from "../dist/parser.js";
import { createLambdaExecutor, startServer } from "../dist/server.js";

const arn = "arn:aws:lambda:us-east-1:123456789012:function:demo-local-target";
const role = "arn:aws:iam::123456789012:role/scheduler";
const base = () => ({
  ScheduleExpression: "at(2030-01-01T10:00:00)",
  ScheduleExpressionTimezone: "America/Bogota",
  FlexibleTimeWindow: { Mode: "OFF" },
  ActionAfterCompletion: "DELETE",
  Target: {
    Arn: arn,
    RoleArn: role,
    Input: '{"campaignId":"example"}',
    RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 3600 },
  },
});
class Clock {
  time = Date.parse("2030-01-01T14:00:00Z");
  tasks = new Map();
  next = 0;
  now = () => this.time;
  setTimeout = (fn, delay) => {
    const id = ++this.next;
    this.tasks.set(id, { fn, due: this.time + delay });
    return id;
  };
  clearTimeout = id => {
    this.tasks.delete(id);
  };
  async advance(to) {
    while (true) {
      const entry = [...this.tasks]
        .filter(([, t]) => t.due <= to)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!entry) break;
      this.time = entry[1].due;
      this.tasks.delete(entry[0]);
      entry[1].fn();
      await new Promise(resolve => setImmediate(resolve));
    }
    this.time = to;
  }
}

test("wall-clock conversion supports Bogota, fractional offsets and rejects invalid/DST dates", () => {
  assert.equal(
    scheduleInstant(base().ScheduleExpression, "America/Bogota"),
    Date.parse("2030-01-01T15:00:00Z"),
  );
  assert.equal(
    scheduleInstant("at(2030-01-01T10:00:00)", "Asia/Kathmandu"),
    Date.parse("2030-01-01T04:15:00Z"),
  );
  for (const [expression, zone] of [
    ["at(2030-02-30T10:00:00)", "UTC"],
    ["at(2030-01-01T25:00:00)", "UTC"],
    ["cron(0 10 * * ? *)", "UTC"],
    ["at(2030-01-01T10:00:00)", "not-a-zone"],
    ["at(2030-03-10T02:30:00)", "America/New_York"],
    ["at(2030-11-03T01:30:00)", "America/New_York"],
  ]) {
    assert.throws(
      () => scheduleInstant(expression, zone),
      error => error.code === "ValidationException",
    );
  }
});

test("SDK create/get/delete, idempotency, conflicts and actionable modeled errors", async t => {
  const clock = new Clock();
  const delivered = [];
  const scheduler = new LocalScheduler(
    "us-east-1",
    new Set([arn]),
    async (...args) => {
      delivered.push(args);
    },
    clock,
  );
  const server = await startScheduler(scheduler);
  const previous = process.env.AWS_ENDPOINT_URL_SCHEDULER;
  process.env.AWS_ENDPOINT_URL_SCHEDULER = server.endpoint;
  const client = new SchedulerClient({
    region: "us-east-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
    maxAttempts: 1,
  });
  t.after(async () => {
    client.destroy();
    await server.close();
    if (previous === undefined) delete process.env.AWS_ENDPOINT_URL_SCHEDULER;
    else process.env.AWS_ENDPOINT_URL_SCHEDULER = previous;
  });
  const input = { ...base(), Name: "test", ClientToken: "stable" };
  const created = await client.send(new CreateScheduleCommand(input));
  assert.match(created.ScheduleArn, /schedule\/default\/test$/);
  assert.equal(
    (await client.send(new CreateScheduleCommand(input))).ScheduleArn,
    created.ScheduleArn,
  );
  await assert.rejects(
    client.send(new CreateScheduleCommand({ ...input, ClientToken: "different" })),
    error => error.name === "ConflictException",
  );
  // AWS idempotency replays the original response even after the schedule is deleted.
  const replayedInput = {
    ...base(),
    Name: "replayed",
    ClientToken: "reusable",
    ScheduleExpression: "at(2031-01-01T00:00:00)",
  };
  const firstReplay = await client.send(new CreateScheduleCommand(replayedInput));
  await client.send(new DeleteScheduleCommand({ Name: "replayed" }));
  assert.equal(
    (await client.send(new CreateScheduleCommand(replayedInput))).ScheduleArn,
    firstReplay.ScheduleArn,
  );
  await assert.rejects(
    client.send(new GetScheduleCommand({ Name: "replayed" })),
    error => error.name === "ResourceNotFoundException",
  );
  // A different token creates the schedule again under the same name.
  const recreated = await client.send(
    new CreateScheduleCommand({ ...replayedInput, ClientToken: "fresh" }),
  );
  assert.equal(recreated.ScheduleArn, firstReplay.ScheduleArn);
  assert.ok(await client.send(new GetScheduleCommand({ Name: "replayed" })));
  const stored = await client.send(new GetScheduleCommand({ Name: "test" }));
  assert.equal(stored.Target.Input, input.Target.Input);
  assert.ok(stored.CreationDate instanceof Date);
  await clock.advance(Date.parse("2030-01-01T15:00:00Z"));
  assert.deepEqual(delivered, [[arn, { campaignId: "example" }]]);
  await assert.rejects(
    client.send(new GetScheduleCommand({ Name: "test" })),
    error => error.name === "ResourceNotFoundException",
  );
  await client.send(
    new CreateScheduleCommand({
      ...base(),
      Name: "cancel",
      ScheduleExpression: "at(2030-01-02T10:00:00)",
    }),
  );
  await client.send(new DeleteScheduleCommand({ Name: "cancel" }));
  await clock.advance(Date.parse("2030-01-03T15:00:00Z"));
  assert.equal(delivered.length, 1);
  await assert.rejects(
    client.send(
      new CreateScheduleCommand({
        ...base(),
        Name: "invalid",
        ScheduleExpression: "rate(1 minute)",
      }),
    ),
    error => error.name === "ValidationException" && error.message.includes("at("),
  );
});

test("retry delivery acceptance, expiry, disabled schedules, shutdown and long timers", async () => {
  const clock = new Clock();
  let attempts = 0;
  const scheduler = new LocalScheduler(
    "us-east-1",
    new Set([arn]),
    async () => {
      if (++attempts < 3) throw new Error("delivery unavailable");
    },
    clock,
  );
  scheduler.create("retry", base());
  await clock.advance(Date.parse("2030-01-01T15:00:04Z"));
  assert.equal(attempts, 3);
  assert.throws(() => scheduler.get("retry"), /does not exist/);
  scheduler.create("disabled", {
    ...base(),
    State: "DISABLED",
    ScheduleExpression: "at(2031-01-01T00:00:00)",
  });
  scheduler.create("far", { ...base(), ScheduleExpression: "at(2031-01-01T00:00:00)" });
  assert.ok([...clock.tasks.values()].every(task => task.due - clock.now() <= 2147483647));
  await clock.advance(Date.parse("2030-12-31T00:00:00Z"));
  assert.equal(attempts, 3);
  scheduler.close();
  assert.equal(clock.tasks.size, 0);
  const expiredClock = new Clock();
  const messages = [];
  const expired = new LocalScheduler(
    "us-east-1",
    new Set([arn]),
    async () => {
      throw new Error("must not deliver");
    },
    expiredClock,
    m => messages.push(m),
  );
  expired.create("late", base());
  expiredClock.time = Date.parse("2030-01-01T17:00:00Z");
  [...expiredClock.tasks.values()][0].fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(messages[0], /expired/);
  expired.close();
});

test("unsupported inputs fail before registration without echoing payloads", () => {
  const scheduler = new LocalScheduler("us-east-1", new Set([arn]), async () => {}, new Clock());
  const variations = [
    { KmsKeyArn: "secret" },
    { GroupName: "custom" },
    { StartDate: 0 },
    { FlexibleTimeWindow: { Mode: "FLEXIBLE" } },
    { State: "bad" },
    { Target: { ...base().Target, Arn: arn + ":alias" } },
    { Target: { ...base().Target, Arn: arn.replace("demo-local-target", "unregistered") } },
    { Target: { ...base().Target, Input: "secret-payload-not-json" } },
    { Target: { ...base().Target, DeadLetterConfig: {} } },
    { Target: { ...base().Target, RetryPolicy: { MaximumRetryAttempts: 186 } } },
  ];
  for (const variation of variations)
    assert.throws(
      () => scheduler.create("bad", { ...base(), ...variation }),
      e => e.code === "ValidationException" && !e.message.includes("secret"),
    );
  scheduler.close();
});

test("HTTP Lambda creates a Bogota schedule through module-scope SDK and invokes a non-HTTP TypeScript Lambda", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "freesls-scheduler-"));
  const originalEnv = { ...process.env };
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    await rm(directory, { recursive: true, force: true });
  });
  const sdkPath = createRequire(import.meta.url).resolve("@aws-sdk/client-scheduler");
  await writeFile(
    path.join(directory, "caller.cjs"),
    `const { SchedulerClient, CreateScheduleCommand } = require(${JSON.stringify(sdkPath)});
    const client = new SchedulerClient({region:'us-east-1', credentials:{accessKeyId:'local',secretAccessKey:'local'}});
    exports.handler = async () => { const response = await client.send(new CreateScheduleCommand({...${JSON.stringify(base())}, Name:'campaign-example', Target:{...${JSON.stringify(base().Target)}, Arn:process.env.TARGET, RoleArn:process.env.ROLE}})); return {statusCode:200,body:JSON.stringify(response.ScheduleArn)}; };`,
  );
  await writeFile(
    path.join(directory, "target.ts"),
    `export async function handler(event: unknown, context: any) { return {event, flag:process.env.TARGET_ONLY, arn:context.invokedFunctionArn}; }`,
  );
  await writeFile(
    path.join(directory, "serverless.yml"),
    `service: demo
provider:
  environment:
    TARGET: !GetAtt TargetLambdaFunction.Arn
    ROLE: !GetAtt SchedulerRole.Arn
resources:
  Resources:
    SchedulerRole:
      Type: AWS::IAM::Role
      Properties:
        RoleName: scheduler
functions:
  caller:
    handler: caller.handler
    events:
      - http: POST /campaign
  target:
    handler: target.handler
    environment:
      TARGET_ONLY: isolated
`,
  );
  const loaded = await loadServerlessConfig(directory, {
    stage: "local",
    region: "us-east-1",
    params: {},
    scheduler: true,
  });
  assert.equal(loaded.functions.length, 2);
  assert.equal(loaded.routes.length, 1);
  const clock = new Clock();
  const execute = createLambdaExecutor({ workingDir: directory, port: 0 });
  const registry = new Map(loaded.functions.map(fn => [fn.arn, fn]));
  const invocations = [];
  const scheduler = new LocalScheduler(
    "us-east-1",
    new Set(registry.keys()),
    async (arn, input) => {
      invocations.push(execute(registry.get(arn), input));
    },
    clock,
  );
  const endpoint = await startScheduler(scheduler);
  t.after(() => endpoint.close());
  for (const fn of loaded.functions) fn.environment.AWS_ENDPOINT_URL_SCHEDULER = endpoint.endpoint;
  const httpServer = await startServer(loaded.routes, 0, directory);
  t.after(
    () =>
      new Promise(resolve => {
        httpServer.close(resolve);
        httpServer.closeIdleConnections();
      }),
  );
  const response = await fetch(`http://127.0.0.1:${httpServer.address().port}/campaign`, {
    method: "POST",
  });
  assert.equal(response.status, 200);
  await clock.advance(Date.parse("2030-01-01T15:00:00Z"));
  assert.deepEqual(await invocations[0], {
    event: { campaignId: "example" },
    flag: "isolated",
    arn,
  });
  assert.equal(process.env.TARGET_ONLY, originalEnv.TARGET_ONLY);
  assert.throws(() => scheduler.get("campaign-example"), /does not exist/);
});

test("scheduler emits lifecycle log events without leaking the payload", async () => {
  const clock = new Clock();
  const events = [];
  const scheduler = new LocalScheduler(
    "us-east-1",
    new Set([arn]),
    async () => {},
    clock,
    () => {},
    event => events.push(event),
  );

  scheduler.create("logged", base());
  assert.equal(events.at(-1).type, "received");
  assert.equal(events.at(-1).name, "logged");
  assert.equal(events.at(-1).target, arn);
  assert.equal(events.at(-1).state, "ENABLED");
  assert.equal(events.at(-1).action, "DELETE");

  await clock.advance(Date.parse("2030-01-01T15:00:00Z"));
  assert.deepEqual(
    events.map(event => event.type),
    ["received", "firing", "delivered"],
  );
  assert.throws(() => scheduler.get("logged"), /does not exist/);

  scheduler.create("cancelled", {
    ...base(),
    ScheduleExpression: "at(2031-01-01T00:00:00)",
  });
  scheduler.delete("cancelled");
  assert.equal(events.at(-1).type, "cancelled");

  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes("campaignId"));
  assert.ok(!serialized.includes("example"));
  scheduler.close();
});

test("update replaces the schedule and re-arms to the new instant", async () => {
  const clock = new Clock();
  const delivered = [];
  const events = [];
  const scheduler = new LocalScheduler(
    "us-east-1",
    new Set([arn]),
    async (target, input) => {
      delivered.push([target, input]);
    },
    clock,
    () => {},
    event => events.push(event.type),
  );

  scheduler.create("campaign", { ...base(), ScheduleExpression: "at(2030-01-01T10:00:00)" });
  const updatedArn = scheduler.update("campaign", {
    ...base(),
    ScheduleExpression: "at(2030-01-01T12:00:00)",
    Target: { ...base().Target, Input: '{"rescheduled":true}' },
  }).ScheduleArn;
  assert.equal(updatedArn, "arn:aws:scheduler:us-east-1:123456789012:schedule/default/campaign");

  const stored = scheduler.get("campaign");
  assert.equal(stored.ScheduleExpression, "at(2030-01-01T12:00:00)");
  assert.equal(stored.Target.Input, '{"rescheduled":true}');

  await clock.advance(Date.parse("2030-01-01T15:00:00Z")); // old instant (10:00 Bogota)
  assert.equal(delivered.length, 0);
  await clock.advance(Date.parse("2030-01-01T17:00:00Z")); // new instant (12:00 Bogota)
  assert.deepEqual(delivered, [[arn, { rescheduled: true }]]);
  assert.throws(() => scheduler.get("campaign"), /does not exist/);
  assert.ok(events.includes("updated"));
  scheduler.close();
});

test("update fails for unknown schedules and past dates, with idempotent tokens", () => {
  const scheduler = new LocalScheduler("us-east-1", new Set([arn]), async () => {}, new Clock());
  assert.throws(
    () => scheduler.update("missing", base()),
    error => error.code === "ResourceNotFoundException",
  );

  scheduler.create("existing", base());
  assert.throws(
    () =>
      scheduler.update("existing", { ...base(), ScheduleExpression: "at(2020-01-01T00:00:00)" }),
    error => error.code === "ValidationException",
  );

  const token = {
    ...base(),
    ClientToken: "update-token",
    ScheduleExpression: "at(2031-01-01T00:00:00)",
  };
  const first = scheduler.update("existing", token);
  assert.equal(scheduler.update("existing", token).ScheduleArn, first.ScheduleArn);
  assert.throws(
    () => scheduler.update("existing", { ...token, ScheduleExpression: "at(2031-02-01T00:00:00)" }),
    error => error.code === "ConflictException",
  );
  scheduler.close();
});

test("SDK UpdateSchedule changes the date and updates LastModificationDate", async t => {
  const clock = new Clock();
  const scheduler = new LocalScheduler("us-east-1", new Set([arn]), async () => {}, clock);
  const server = await startScheduler(scheduler);
  const previous = process.env.AWS_ENDPOINT_URL_SCHEDULER;
  process.env.AWS_ENDPOINT_URL_SCHEDULER = server.endpoint;
  const client = new SchedulerClient({
    region: "us-east-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
    maxAttempts: 1,
  });
  t.after(async () => {
    client.destroy();
    await server.close();
    if (previous === undefined) delete process.env.AWS_ENDPOINT_URL_SCHEDULER;
    else process.env.AWS_ENDPOINT_URL_SCHEDULER = previous;
  });

  const created = await client.send(new CreateScheduleCommand({ ...base(), Name: "resched" }));
  clock.time += 5000;
  await client.send(
    new UpdateScheduleCommand({
      Name: "resched",
      ScheduleExpression: "at(2030-01-01T12:00:00)",
      ScheduleExpressionTimezone: "America/Bogota",
      FlexibleTimeWindow: { Mode: "OFF" },
      ActionAfterCompletion: "DELETE",
      Target: base().Target,
    }),
  );
  const stored = await client.send(new GetScheduleCommand({ Name: "resched" }));
  assert.equal(stored.ScheduleExpression, "at(2030-01-01T12:00:00)");
  assert.equal(stored.Arn, created.ScheduleArn);
  assert.ok(stored.LastModificationDate instanceof Date);
  assert.ok(stored.LastModificationDate.getTime() > stored.CreationDate.getTime());
});
