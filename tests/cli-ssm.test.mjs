import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SSMClient } from "@aws-sdk/client-ssm";
import { SSMResolver } from "../dist/ssm.js";
import { printEnvironmentSummary } from "../dist/printer.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("CLI rejects invalid parameters and ports without printing parameter values", () => {
  for (const args of [
    ["--param", "private-invalid-value"],
    ["--port", "4000oops"],
    ["--port", "65536"],
  ]) {
    const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid --(?:param|port)/);
    assert.doesNotMatch(result.stderr, /private-invalid-value/);
  }
});

test("CLI preserves equals signs and empty parameter values", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "freesls-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "serverless.yml"),
    `service: test
provider:
  environment:
    ENCODED: \${param:encoded}
    EMPTY: \${param:empty, 'not-empty'}
functions:
  example:
    handler: handler.run
    events:
      - http: GET /example
`,
  );
  const output = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cliPath, "--no-ssm", "--show-env", "--param", "encoded=abc==", "empty="],
      {
        cwd: directory,
        env: { ...process.env, NO_COLOR: "1" },
      },
    );
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("CLI startup timed out"));
    }, 10000);
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (stdout.includes("Ready for requests")) child.kill();
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timeout);
      if (stdout.includes("Ready for requests")) resolve(stdout);
      else reject(new Error(stderr || "CLI exited before startup"));
    });
  });
  assert.match(output, /ENCODED\s+= abc==/);
  assert.match(output, /EMPTY\s+=\s*\r?\n/);
  assert.doesNotMatch(output, /not-empty/);
});

test("environment values with a mock prefix are still masked by default", t => {
  const lines = [];
  t.mock.method(console, "log", line => lines.push(String(line ?? "")));
  const secret = "mock-private-value";
  printEnvironmentSummary({ TOKEN: secret });
  assert.ok(!lines.join("\n").includes(secret));
  lines.length = 0;
  printEnvironmentSummary({ TOKEN: secret }, true);
  assert.ok(lines.join("\n").includes(secret));
});

test("SSM batches, deduplicates and caches selector-qualified and empty values", async t => {
  const batches = [];
  t.mock.method(SSMClient.prototype, "send", async command => {
    assert.equal(command.input.WithDecryption, true);
    batches.push(command.input.Names);
    return {
      Parameters: command.input.Names.map(name => {
        const separator = name.indexOf(":");
        return {
          Name: separator === -1 ? name : name.slice(0, separator),
          Selector: separator === -1 ? undefined : name.slice(separator),
          Value: name === "empty" ? "" : `value-${name}`,
        };
      }),
    };
  });
  const resolver = new SSMResolver("eu-west-1");
  const names = [
    "/key:3",
    "/key:release",
    "empty",
    ...Array.from({ length: 9 }, (_, index) => `key${index}`),
  ];
  await resolver.resolveAll([...names, "/key:3"]);
  assert.deepEqual(
    batches.map(batch => batch.length),
    [10, 2],
  );
  assert.equal(resolver.get("/key:3"), "value-/key:3");
  assert.equal(resolver.get("/key:release"), "value-/key:release");
  assert.equal(resolver.get("empty"), "");
  await resolver.resolveAll(names);
  assert.equal(batches.length, 2);
});

test("SSM failures reject instead of terminating the process", async t => {
  t.mock.method(SSMClient.prototype, "send", async () => {
    throw new Error("SSO expired");
  });
  await assert.rejects(new SSMResolver().resolveAll(["key"]), /aws sso login/);
});

test("SSM invalid parameters reject with actionable names", async t => {
  t.mock.method(SSMClient.prototype, "send", async () => ({ InvalidParameters: ["missing"] }));
  await assert.rejects(
    new SSMResolver().resolveAll(["missing"]),
    /SSM parameters not found: missing/,
  );
});
