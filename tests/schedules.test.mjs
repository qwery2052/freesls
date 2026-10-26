import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRecurringExpression, nextCronInstant } from "../dist/schedule-expression.js";
import { LocalScheduleRunner, buildScheduledEvent } from "../dist/schedule-runner.js";
import { loadServerlessConfig } from "../dist/parser.js";
import { loadSamConfig } from "../dist/sam-parser.js";
import { createLambdaExecutor } from "../dist/server.js";

const lambdaArn = "arn:aws:lambda:us-east-1:123456789012:function:worker";

function scheduleDefinition(overrides = {}) {
  return {
    functionName: "worker",
    handler: "handler.worker",
    environment: {},
    arn: lambdaArn,
    scheduleName: "worker-schedule-1",
    expression: "cron(* * * * ? *)",
    enabled: true,
    method: "eventBus",
    timezone: "UTC",
    ruleArn: "arn:aws:events:us-east-1:123456789012:rule/worker-schedule-1",
    region: "us-east-1",
    account: "123456789012",
    ...overrides,
  };
}

class Clock {
  time = Date.parse("2030-01-01T00:00:30Z");
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
        .filter(([, task]) => task.due <= to)
        .sort((left, right) => left[1].due - right[1].due)[0];
      if (!entry) break;
      this.time = entry[1].due;
      this.tasks.delete(entry[0]);
      entry[1].fn();
      await new Promise(resolve => setImmediate(resolve));
    }
    this.time = to;
  }
}

test("parses AWS cron fields, names, lists and rate expressions", () => {
  const everyFive = parseRecurringExpression("cron(*/5 * * * ? *)", "UTC");
  assert.equal(
    new Date(nextCronInstant(everyFive, Date.parse("2030-01-01T15:02:00Z"))).toISOString(),
    "2030-01-01T15:05:00.000Z",
  );

  const weekdays = parseRecurringExpression("cron(0 12 ? * MON-FRI *)", "America/Bogota");
  assert.equal(
    new Date(nextCronInstant(weekdays, Date.parse("2030-01-01T15:00:00Z"))).toISOString(),
    "2030-01-01T17:00:00.000Z",
  );

  const quarterly = parseRecurringExpression("cron(0 0 1 JAN,APR,JUL,OCT ? *)", "UTC");
  assert.equal(
    new Date(nextCronInstant(quarterly, Date.parse("2030-02-01T00:00:00Z"))).toISOString(),
    "2030-04-01T00:00:00.000Z",
  );

  const lastFriday = parseRecurringExpression("cron(15 10 ? * 6L 2030)", "UTC");
  assert.equal(
    new Date(nextCronInstant(lastFriday, Date.parse("2030-01-01T00:00:00Z"))).toISOString(),
    "2030-01-25T10:15:00.000Z",
  );

  const thirdTuesday = parseRecurringExpression("cron(0 9 ? * 3#3 *)", "UTC");
  assert.equal(
    new Date(nextCronInstant(thirdTuesday, Date.parse("2030-01-01T00:00:00Z"))).toISOString(),
    "2030-01-15T09:00:00.000Z",
  );

  const nearestWeekday = parseRecurringExpression("cron(0 9 15W * ? *)", "UTC");
  assert.equal(
    new Date(nextCronInstant(nearestWeekday, Date.parse("2030-01-01T00:00:00Z"))).toISOString(),
    "2030-01-15T09:00:00.000Z",
  );

  // 31W skips February because it has no 31st; March 31, 2030 is a Sunday.
  const nearestThirtyFirst = parseRecurringExpression("cron(0 9 31W * ? *)", "UTC");
  assert.equal(
    new Date(nextCronInstant(nearestThirtyFirst, Date.parse("2030-02-01T00:00:00Z"))).toISOString(),
    "2030-03-29T09:00:00.000Z",
  );

  const lastDay = parseRecurringExpression("cron(0 9 L * ? *)", "UTC");
  assert.equal(
    new Date(nextCronInstant(lastDay, Date.parse("2030-01-01T00:00:00Z"))).toISOString(),
    "2030-01-31T09:00:00.000Z",
  );

  const lastWeekday = parseRecurringExpression("cron(0 9 LW * ? *)", "UTC");
  assert.equal(
    new Date(nextCronInstant(lastWeekday, Date.parse("2030-01-01T00:00:00Z"))).toISOString(),
    "2030-01-31T09:00:00.000Z",
  );

  const everySaturday = parseRecurringExpression("cron(0 9 ? * L *)", "UTC");
  assert.equal(
    new Date(nextCronInstant(everySaturday, Date.parse("2030-01-01T00:00:00Z"))).toISOString(),
    "2030-01-05T09:00:00.000Z",
  );

  assert.equal(parseRecurringExpression("rate(5 minutes)", "UTC").intervalMs, 300000);
  assert.equal(parseRecurringExpression("rate(1 hour)", "UTC").intervalMs, 3600000);
  assert.equal(parseRecurringExpression("rate(2 days)", "UTC").intervalMs, 172800000);
});

test("rejects Unix cron, ambiguous day fields and invalid rates", () => {
  for (const expression of [
    "0 12 * * 0-5",
    "cron(0 12 * * 0-5)",
    "cron(0 12 * * * *)",
    "cron(0 12 ? * ? *)",
    "cron(0 12 * * ? 1969)",
    "cron(0 12 ? * 3#1,6#3 *)",
    "at(2030-01-01T10:00:00)",
    "rate(5 minute)",
    "rate(1 minutes)",
    "rate(0 minutes)",
    "cron(0 12 ? * MON-FRI *",
  ]) {
    assert.throws(
      () => parseRecurringExpression(expression, "UTC"),
      error => error.name === "ScheduleExpressionError",
      expression,
    );
  }
  assert.throws(
    () => parseRecurringExpression("cron(0 12 ? * MON-FRI *)", "not-a-zone"),
    /Unknown ScheduleExpressionTimezone/,
  );
  assert.throws(
    () => parseRecurringExpression(`cron(${"0 ".repeat(130)}*)`, "UTC"),
    /at most 256 characters/,
  );
  assert.throws(
    () => parseRecurringExpression("cron(0 12 ? * MON-FRI *)", "A".repeat(51)),
    /at most 50 characters/,
  );
});

test("handles DST gaps and overlaps like EventBridge Scheduler", () => {
  const spring = parseRecurringExpression("cron(30 2 * * ? *)", "America/New_York");
  assert.equal(
    nextCronInstant(spring, Date.parse("2030-03-09T08:00:00Z")),
    Date.parse("2030-03-11T06:30:00Z"),
  );

  const fall = parseRecurringExpression("cron(30 1 * * ? *)", "America/New_York");
  assert.equal(
    nextCronInstant(fall, Date.parse("2030-11-02T06:00:00Z")),
    Date.parse("2030-11-03T05:30:00Z"),
  );
  // The repeated 01:30 occurrence is skipped; the next invocation is the next day.
  assert.equal(
    nextCronInstant(fall, Date.parse("2030-11-03T05:30:00Z")),
    Date.parse("2030-11-04T06:30:00Z"),
  );
});

test("finite cron years and explicit UTC schedules behave deterministically", () => {
  const expired = parseRecurringExpression("cron(0 0 1 1 ? 2020)", "UTC");
  assert.equal(nextCronInstant(expired, Date.parse("2030-01-01T00:00:00Z")), null);

  const utc = parseRecurringExpression("cron(0 12 * * ? *)", "UTC");
  assert.equal(
    nextCronInstant(utc, Date.parse("2030-01-01T00:00:00Z")),
    Date.parse("2030-01-01T12:00:00Z"),
  );
});

test("runner invokes cron schedules repeatedly, respects input and closes timers", async () => {
  const clock = new Clock();
  const delivered = [];
  const runner = new LocalScheduleRunner(
    [
      scheduleDefinition(),
      scheduleDefinition({
        scheduleName: "disabled",
        enabled: false,
      }),
    ],
    async (_schedule, event) => {
      delivered.push(event);
    },
    clock,
  );
  runner.start();
  assert.equal(clock.tasks.size, 1);
  await clock.advance(Date.parse("2030-01-01T00:03:30Z"));
  assert.equal(delivered.length, 3);
  assert.equal(delivered[0].source, "aws.events");
  assert.equal(delivered[0]["detail-type"], "Scheduled Event");
  assert.deepEqual(delivered[0].resources, [
    "arn:aws:events:us-east-1:123456789012:rule/worker-schedule-1",
  ]);
  runner.close();
  assert.equal(clock.tasks.size, 0);
});

test("runner uses Target input instead of the default scheduled event", async () => {
  const clock = new Clock();
  const delivered = [];
  const input = { campaignId: "example", nested: { enabled: true } };
  const runner = new LocalScheduleRunner(
    [scheduleDefinition({ input })],
    async (_schedule, event) => {
      delivered.push(event);
    },
    clock,
  );
  runner.start();
  await clock.advance(Date.parse("2030-01-01T00:01:30Z"));
  assert.deepEqual(delivered, [input]);
  assert.notEqual(delivered[0], input);
  runner.close();
});

test("runner rate schedules start after one interval and keep recurring", async () => {
  const clock = new Clock();
  const delivered = [];
  const runner = new LocalScheduleRunner(
    [scheduleDefinition({ expression: "rate(5 minutes)" })],
    async (_schedule, event) => {
      delivered.push(event);
    },
    clock,
  );
  runner.start();
  assert.equal([...clock.tasks.values()][0].due, Date.parse("2030-01-01T00:05:30Z"));
  await clock.advance(Date.parse("2030-01-01T00:10:31Z"));
  assert.equal(delivered.length, 2);
  runner.close();
});

test("runner skips missed rate occurrences instead of replaying them", async () => {
  const clock = new Clock();
  const delivered = [];
  const runner = new LocalScheduleRunner(
    [scheduleDefinition({ expression: "rate(5 minutes)" })],
    async (_schedule, event) => {
      delivered.push(event);
    },
    clock,
  );
  runner.start();
  const first = [...clock.tasks.values()][0];
  clock.tasks.clear();
  clock.time = Date.parse("2030-01-01T00:25:00Z");
  first.fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(delivered.length, 1);
  assert.equal([...clock.tasks.values()][0].due, Date.parse("2030-01-01T00:25:30Z"));
  runner.close();
});

test("runner logs failures without payloads and continues with the next occurrence", async () => {
  const clock = new Clock();
  const reports = [];
  const events = [];
  let attempts = 0;
  const runner = new LocalScheduleRunner(
    [scheduleDefinition()],
    async () => {
      if (++attempts === 1) throw new Error("handler failed");
    },
    clock,
    event => events.push(event.type),
    message => reports.push(message),
  );
  runner.start();
  await clock.advance(Date.parse("2030-01-01T00:02:30Z"));
  assert.equal(attempts, 2);
  assert.deepEqual(events.slice(0, 3), ["registered", "firing", "failed"]);
  assert.match(reports[0], /Invocation failed/);
  assert.ok(!reports.join(" ").includes("handler failed"));
  runner.close();
});

test("runner marks a finite cron as completed without arming a timer", () => {
  const clock = new Clock();
  const events = [];
  const runner = new LocalScheduleRunner(
    [scheduleDefinition({ expression: "cron(0 0 1 1 ? 2020)" })],
    async () => {},
    clock,
    event => events.push(event.type),
  );
  runner.start();
  assert.equal(clock.tasks.size, 0);
  assert.deepEqual(events, ["completed"]);
  runner.close();
});

test("buildScheduledEvent uses Scheduler identity for method scheduler", () => {
  const schedule = scheduleDefinition({
    method: "scheduler",
    ruleArn: "arn:aws:scheduler:us-east-1:123456789012:schedule/default/worker-schedule-1",
  });
  const event = buildScheduledEvent(schedule, Date.parse("2030-01-01T00:00:00Z"));
  assert.equal(event.source, "aws.scheduler");
  assert.equal(event.time, "2030-01-01T00:00:00.000Z");
  assert.deepEqual(event.resources, [schedule.ruleArn]);
});

test("parses Serverless schedule events with strings, arrays, input and variables", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "freesls-schedules-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "serverless.yml"),
    `service: demo
provider:
  name: aws
functions:
  scheduled-notification:
    handler: handler.notify
    events:
      - schedule: cron(*/5 * * * ? *)
      - schedule:
          cron:
            - cron(0 12 ? * MON-FRI *)
          enabled: false
          input:
            stage: \${sls:stage}
            arn: !Sub 'arn:aws:lambda:\${AWS::Region}:\${AWS::AccountId}:function:target'
  scheduler-method:
    handler: handler.scheduled
    events:
      - schedule:
          cron: cron(0 12 ? * MON-FRI *)
          method: scheduler
          timezone: America/Bogota
  web:
    handler: handler.web
    events:
      - http: POST /run
`,
  );

  const loaded = await loadServerlessConfig(directory, {
    stage: "develop",
    region: "us-east-1",
    params: {},
    cron: true,
    resolveSSM: false,
  });

  assert.equal(loaded.functions.length, 3);
  assert.equal(loaded.routes.length, 1);
  assert.equal(loaded.schedules.length, 3);

  const everyFive = loaded.schedules[0];
  assert.equal(everyFive.functionName, "scheduled-notification");
  assert.equal(everyFive.expression, "cron(*/5 * * * ? *)");
  assert.equal(everyFive.enabled, true);
  assert.equal(everyFive.method, "eventBus");
  assert.equal(everyFive.timezone, "UTC");
  assert.match(everyFive.ruleArn, /^arn:aws:events:us-east-1:123456789012:rule\//);

  const daily = loaded.schedules[1];
  assert.equal(daily.expression, "cron(0 12 ? * MON-FRI *)");
  assert.equal(daily.enabled, false);
  assert.deepEqual(daily.input, {
    stage: "develop",
    arn: "arn:aws:lambda:us-east-1:123456789012:function:target",
  });

  const schedulerMethod = loaded.schedules[2];
  assert.equal(schedulerMethod.method, "scheduler");
  assert.equal(schedulerMethod.timezone, "America/Bogota");
  assert.match(
    schedulerMethod.ruleArn,
    /^arn:aws:scheduler:us-east-1:123456789012:schedule\/default\//,
  );

  const withoutCron = await loadServerlessConfig(directory, {
    stage: "develop",
    region: "us-east-1",
    params: {},
    cron: false,
    resolveSSM: false,
  });
  assert.deepEqual(withoutCron.schedules, []);
});

test("rejects unsupported or invalid Serverless schedule options", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "freesls-schedules-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const cases = [
    [{ cron: "cron(*/5 * * * ? *)", inputPath: "$.detail" }, /inputPath/],
    [{ cron: "cron(*/5 * * * ? *)", inputTransformer: {} }, /inputTransformer/],
    ["cron(0 12 * * 0-5)", /6 fields|Unix cron/],
    [
      { cron: "cron(0 12 ? * MON-FRI *)", method: "eventBus", timezone: "America/Bogota" },
      /eventBus/,
    ],
    [{ cron: "cron(0 12 ? * MON-FRI *)", method: "invalid" }, /eventBus or scheduler/],
    [{ cron: "cron(0 12 ? * MON-FRI *)", name: "bad name" }, /Schedule name/],
    [{ cron: "cron(0 12 ? * MON-FRI *)", unknown: true }, /unsupported option unknown/],
    [
      { cron: "cron(0 12 ? * MON-FRI *)", input: { Ref: "Missing", extra: true } },
      /Unsupported intrinsic object/,
    ],
  ];

  for (const [schedule, expected] of cases) {
    await writeFile(
      path.join(directory, "serverless.yml"),
      JSON.stringify({
        service: "demo",
        functions: {
          invalid: {
            handler: "handler.invalid",
            events: [{ schedule }],
          },
        },
      }),
    );
    await assert.rejects(
      loadServerlessConfig(directory, {
        stage: "dev",
        region: "us-east-1",
        params: {},
        cron: true,
        resolveSSM: false,
      }),
      expected,
    );
  }
});

test("rejects duplicate schedule names per method", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "freesls-schedules-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "serverless.yml"),
    JSON.stringify({
      service: "demo",
      functions: {
        first: {
          handler: "handler.first",
          events: [{ schedule: { cron: "cron(0 12 ? * MON-FRI *)", name: "daily" } }],
        },
        second: {
          handler: "handler.second",
          events: [{ schedule: { cron: "cron(0 13 ? * MON-FRI *)", name: "daily" } }],
        },
      },
    }),
  );
  await assert.rejects(
    loadServerlessConfig(directory, {
      stage: "dev",
      region: "us-east-1",
      params: {},
      cron: true,
      resolveSSM: false,
    }),
    /Duplicate eventBus schedule name daily/,
  );
});

test("supports SAM Schedule/ScheduleV2 and rejects unsupported SAM options", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "freesls-sam-schedules-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "template.yaml"),
    `AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Resources:
  Worker:
    Type: AWS::Serverless::Function
    Properties:
      Handler: handler.worker
      Runtime: nodejs20.x
      Events:
        EveryFive:
          Type: Schedule
          Properties:
            Schedule: cron(*/5 * * * ? *)
        DailyBogota:
          Type: ScheduleV2
          Properties:
            ScheduleExpression: cron(0 12 ? * MON-FRI *)
            ScheduleExpressionTimezone: America/Bogota
            State: ENABLED
            Input: '{"source":"sam"}'
        Disabled:
          Type: Schedule
          Properties:
            Schedule: rate(5 minutes)
            Enabled: false
`,
  );

  const loaded = await loadSamConfig(directory, {
    stage: "dev",
    region: "us-east-1",
    params: {},
    cron: true,
    resolveSSM: false,
  });
  assert.equal(loaded.schedules.length, 3);
  assert.equal(loaded.schedules[0].functionName, "Worker");
  assert.equal(loaded.schedules[0].method, "eventBus");
  assert.equal(loaded.schedules[0].timezone, "UTC");
  assert.equal(loaded.schedules[0].expression, "cron(*/5 * * * ? *)");
  assert.equal(loaded.schedules[1].method, "scheduler");
  assert.equal(loaded.schedules[1].timezone, "America/Bogota");
  assert.deepEqual(loaded.schedules[1].input, { source: "sam" });
  assert.equal(loaded.schedules[2].expression, "rate(5 minutes)");
  assert.equal(loaded.schedules[2].enabled, false);
});

test("rejects SAM schedules with unsupported delivery options", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "freesls-sam-schedules-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "template.yaml"),
    `AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Resources:
  Worker:
    Type: AWS::Serverless::Function
    Properties:
      Handler: handler.worker
      Runtime: nodejs20.x
      Events:
        Daily:
          Type: ScheduleV2
          Properties:
            ScheduleExpression: cron(0 12 ? * MON-FRI *)
            FlexibleTimeWindow:
              Mode: FLEXIBLE
`,
  );
  await assert.rejects(
    loadSamConfig(directory, {
      stage: "dev",
      region: "us-east-1",
      params: {},
      cron: true,
      resolveSSM: false,
    }),
    /FlexibleTimeWindow Mode OFF/,
  );
});

test("rejects unresolved intrinsics in SAM schedule input", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "freesls-sam-schedules-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "template.yaml"),
    `AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Resources:
  Worker:
    Type: AWS::Serverless::Function
    Properties:
      Handler: handler.worker
      Runtime: nodejs20.x
      Events:
        Daily:
          Type: Schedule
          Properties:
            Schedule: cron(0 12 ? * MON-FRI *)
            Input: !Join [",", [a, b]]
`,
  );
  await assert.rejects(
    loadSamConfig(directory, {
      stage: "dev",
      region: "us-east-1",
      params: {},
      cron: true,
      resolveSSM: false,
    }),
    /unresolved intrinsic/,
  );
});

test("runs a declared schedule through the shared Lambda executor", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "freesls-schedule-run-"));
  const originalEnv = { ...process.env };
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    path.join(directory, "handler.cjs"),
    `exports.worker = async (event, context) => ({ event, env: process.env.CRON_ONLY, arn: context.invokedFunctionArn });`,
  );
  await writeFile(
    path.join(directory, "serverless.yml"),
    `service: demo
functions:
  worker:
    handler: handler.worker
    environment:
      CRON_ONLY: isolated
    events:
      - schedule: cron(* * * * ? *)
`,
  );

  const loaded = await loadServerlessConfig(directory, {
    stage: "dev",
    region: "us-east-1",
    params: {},
    cron: true,
    resolveSSM: false,
  });
  const execute = createLambdaExecutor({ workingDir: directory, port: 0 });
  const clock = new Clock();
  const results = [];
  const runner = new LocalScheduleRunner(
    loaded.schedules,
    async (schedule, event) => {
      results.push(await execute(schedule, event));
    },
    clock,
  );
  runner.start();
  await clock.advance(Date.parse("2030-01-01T00:01:30Z"));
  assert.equal(results.length, 1);
  assert.equal(results[0].env, "isolated");
  assert.equal(results[0].event.source, "aws.events");
  assert.equal(results[0].event["detail-type"], "Scheduled Event");
  assert.equal(results[0].arn, lambdaArn.replace("worker", "demo-dev-worker"));
  assert.equal(process.env.CRON_ONLY, originalEnv.CRON_ONLY);
  runner.close();
});

test("CLI --cron works without the Scheduler SDK endpoint", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "freesls-cron-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "serverless.yml"),
    `service: demo
functions:
  worker:
    handler: handler.worker
    events:
      - schedule: cron(*/5 * * * ? *)
`,
  );
  const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "--cron", "--no-ssm", "--port", "45680"], {
      cwd: directory,
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("CLI startup timed out"));
    }, 10000);
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (stdout.includes("Schedules are in-memory")) child.kill();
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timeout);
      if (stdout.includes("Schedules are in-memory")) resolve(stdout);
      else reject(new Error(stderr || "CLI exited before printing schedules"));
    });
  });
  assert.match(output, /Registered Schedules/);
  assert.match(output, /cron\(\*\/5 \* \* \* \? \*\)/);
  assert.doesNotMatch(output, /Local Scheduler:/);
});

test("CLI --cron coexists with --scheduler and prints registered rules", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "freesls-cron-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "serverless.yml"),
    `service: demo
functions:
  worker:
    handler: handler.worker
    events:
      - schedule: cron(*/5 * * * ? *)
`,
  );
  const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const output = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cliPath, "--cron", "--scheduler", "--no-ssm", "--port", "45679"],
      { cwd: directory, env: { ...process.env, NO_COLOR: "1" } },
    );
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("CLI startup timed out"));
    }, 10000);
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (stdout.includes("Local Scheduler:")) child.kill();
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timeout);
      if (stdout.includes("Local Scheduler:")) resolve(stdout);
      else reject(new Error(stderr || "CLI exited before printing schedules"));
    });
  });
  assert.match(output, /Registered Schedules/);
  assert.match(output, /cron\(\*\/5 \* \* \* \? \*\)/);
  assert.match(output, /ENABLED/);
  assert.match(output, /Local Scheduler:/);
});
