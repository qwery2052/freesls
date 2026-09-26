import assert from "node:assert/strict";
import test from "node:test";
import {
  CAT_COLOR_NAMES,
  SHINY_CHANCE,
  printLambdaEnd,
  printLambdaStart,
  printRoutes,
  printSchedulerEvent,
  selectCatColors,
} from "../dist/printer.js";

const sequence = values => {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
};

test("normal banner uses a single random cat color", () => {
  const { shiny, colors } = selectCatColors(sequence([0.9, 0.5]));
  assert.equal(shiny, false);
  assert.equal(colors[0], colors[1]);
  assert.equal(colors[1], colors[2]);
  assert.ok(CAT_COLOR_NAMES.includes(colors[0]));
});

test("shiny banner uses three distinct cat colors", () => {
  const { shiny, colors } = selectCatColors(sequence([0, 0, 0, 0]));
  assert.equal(shiny, true);
  assert.equal(new Set(colors).size, 3);
  for (const color of colors) assert.ok(CAT_COLOR_NAMES.includes(color));
});

test("shiny probability boundary and constant", () => {
  assert.equal(SHINY_CHANCE, 1 / 200);
  assert.equal(selectCatColors(() => SHINY_CHANCE).shiny, false);
  assert.equal(selectCatColors(() => SHINY_CHANCE / 2).shiny, true);
});

test("printRoutes shows the simulated ARN under the handler when enabled", t => {
  const lines = [];
  t.mock.method(console, "log", (...args) => lines.push(args.join(" ")));
  const arn = "arn:aws:lambda:us-east-1:123456789012:function:demo-dev-cancel-campaign";
  printRoutes(
    [
      {
        functionName: "cancel-campaign",
        handler: "src/functions/cancel-campaign/handler.cancelCampaignHandler",
        method: "POST",
        path: "/cancel-campaign",
        environment: {},
        arn,
      },
    ],
    3000,
    "/messaging-campaigns",
    true,
  );
  const output = lines.join("\n");
  assert.match(output, /└─ handler: /);
  assert.match(output, /└─ arn: /);
  assert.ok(output.includes(arn));
});

test("printRoutes hides the ARN by default", t => {
  const lines = [];
  t.mock.method(console, "log", (...args) => lines.push(args.join(" ")));
  const arn = "arn:aws:lambda:us-east-1:123456789012:function:demo-dev-cancel-campaign";
  printRoutes(
    [
      {
        functionName: "cancel-campaign",
        handler: "src/functions/cancel-campaign/handler.cancelCampaignHandler",
        method: "POST",
        path: "/cancel-campaign",
        environment: {},
        arn,
      },
    ],
    3000,
    "/messaging-campaigns",
  );
  const output = lines.join("\n");
  assert.match(output, /└─ handler: /);
  assert.doesNotMatch(output, /└─ arn: /);
  assert.ok(!output.includes(arn));
});

test("printRoutes omits the ARN line when the route has no ARN", t => {
  const lines = [];
  t.mock.method(console, "log", (...args) => lines.push(args.join(" ")));
  printRoutes(
    [{ functionName: "demo", handler: "h.handler", method: "GET", path: "/demo", environment: {} }],
    3000,
    "",
    true,
  );
  const output = lines.join("\n");
  assert.match(output, /└─ handler: /);
  assert.doesNotMatch(output, /└─ arn: /);
});

test("printSchedulerEvent shows target, zulu time and timezone without payload", t => {
  const lines = [];
  t.mock.method(console, "log", (...args) => lines.push(args.join(" ")));
  printSchedulerEvent(
    {
      type: "received",
      name: "campaign-1",
      target: "arn:aws:lambda:us-east-1:123456789012:function:demo-send",
      due: Date.parse("2030-01-01T15:00:00Z"),
      timezone: "America/Bogota",
      state: "ENABLED",
      action: "DELETE",
      retries: 2,
      maxAgeSeconds: 3600,
    },
    () => "demo-send",
  );
  const output = lines.join("\n");
  assert.match(output, /Schedule received/);
  assert.ok(output.includes("demo-send"));
  assert.ok(output.includes("2030-01-01T15:00:00.000Z"));
  assert.ok(output.includes("America/Bogota"));
  assert.ok(output.includes("DELETE"));
});

test("printLambdaStart shows the start tag and function name only", t => {
  const lines = [];
  t.mock.method(console, "log", (...args) => lines.push(args.join(" ")));
  printLambdaStart("demo-send");
  const output = lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
  assert.match(output, /\[Lambda\]\[start\] demo-send/);
  assert.doesNotMatch(output, /arn:/);
});

test("printLambdaEnd shows the end tag with method, status and duration", t => {
  const lines = [];
  t.mock.method(console, "log", (...args) => lines.push(args.join(" ")));
  printLambdaEnd("POST", "/campaign", 500, 24586);
  const output = lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
  assert.match(output, /\[Lambda\]\[end\]/);
  assert.match(output, /POST\s+\/campaign\s+500\s+\(24586ms\)/);
});
