import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadSamConfig } from "../dist/sam-parser.js";
import { extractMakeSourceFile } from "../dist/sam-makefile.js";
import { createLambdaExecutor } from "../dist/server.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const logicalId = "SendAppointmentRemindersFunction";
const sourceRelative = "src/functions/send-appointment-reminders/handler.ts";
const sourceHandler = "handler.appointmentRemindersHandler";
const makeOutput = `rm -rf node_modules
corepack pnpm install --frozen-lockfile
corepack pnpm exec esbuild ${sourceRelative} --outfile=".aws-sam/build/${logicalId}/handler.js" --bundle --platform=node --target=node24 --format=cjs --sourcemap "--external:@aws-sdk/*"`;

async function createFakeMake(directory, output, exitCode = 0) {
  if (process.platform === "win32") {
    const file = path.join(directory, "fake-make.cmd");
    if (exitCode === 0) {
      const script = path.join(directory, "fake-make.js");
      await writeFile(script, `process.stdout.write(${JSON.stringify(output)});\n`);
      await writeFile(file, `@echo off\r\nnode "%~dp0fake-make.js"\r\nexit /b 0\r\n`);
    } else {
      await writeFile(
        file,
        `@echo off\r\n>&2 echo simulated make failure\r\nexit /b ${exitCode}\r\n`,
      );
    }
    return file;
  }

  const file = path.join(directory, "fake-make");
  const body =
    exitCode === 0
      ? `#!/bin/sh\nprintf '%s\\n' '${output.replace(/'/g, "'\\''")}'\nexit 0\n`
      : `#!/bin/sh\necho "simulated make failure" >&2\nexit ${exitCode}\n`;
  await writeFile(file, body);
  await chmod(file, 0o755);
  return file;
}

async function createSamProject(directory, { withMakefile = true } = {}) {
  await writeFile(
    path.join(directory, "template.yaml"),
    `AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Resources:
  ${logicalId}:
    Type: AWS::Serverless::Function
    Metadata:
      BuildMethod: makefile
    Properties:
      Handler: ${sourceHandler}
      Runtime: nodejs20.x
      Events:
        Schedule:
          Type: Schedule
          Properties:
            Schedule: cron(0/5 * * * ? *)
  NormalFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: handler.normal
      Runtime: nodejs20.x
`,
  );
  await mkdir(path.dirname(path.join(directory, sourceRelative)), { recursive: true });
  await writeFile(
    path.join(directory, sourceRelative),
    `export const appointmentRemindersHandler = async () => ({ ok: true });\n`,
  );
  if (withMakefile) await writeFile(path.join(directory, "Makefile"), "all:\n\t@echo test\n");
}

test("extracts a source file from make -n output and ignores artifact paths", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "freesls-makefile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.dirname(path.join(directory, sourceRelative)), { recursive: true });
  await writeFile(path.join(directory, sourceRelative), "export const handler = 1;\n");

  assert.equal(
    extractMakeSourceFile(makeOutput, directory, sourceHandler, logicalId),
    path.resolve(directory, sourceRelative),
  );
  assert.throws(
    () => extractMakeSourceFile("rm -rf node_modules", directory, sourceHandler, logicalId),
    /Could not find a source file/,
  );
});

test("reports ambiguous makefile source files", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "freesls-makefile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "src/a"), { recursive: true });
  await mkdir(path.join(directory, "src/b"), { recursive: true });
  await writeFile(path.join(directory, "src/a/handler.ts"), "export const a = 1;\n");
  await writeFile(path.join(directory, "src/b/handler.ts"), "export const b = 1;\n");

  assert.throws(
    () =>
      extractMakeSourceFile(
        "esbuild src/a/handler.ts src/b/handler.ts --outfile=.aws-sam/build/Foo/handler.js",
        directory,
        sourceHandler,
        logicalId,
      ),
    /Ambiguous source file/,
  );
});

test("resolves a SAM makefile function to source and executes it", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "freesls-makefile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await createSamProject(directory);
  const makeCommand = await createFakeMake(directory, makeOutput);

  const loaded = await loadSamConfig(directory, {
    stage: "dev",
    region: "us-east-1",
    params: {},
    cron: true,
    makefile: true,
    makeCommand,
    resolveSSM: false,
  });

  const expectedHandler = path.join(
    path.dirname(sourceRelative),
    "handler.appointmentRemindersHandler",
  );
  assert.equal(loaded.functions.length, 2);
  assert.equal(loaded.functions[0].handler, expectedHandler);
  assert.equal(loaded.functions[1].handler, "handler.normal");
  assert.equal(loaded.schedules.length, 1);
  assert.equal(loaded.schedules[0].handler, expectedHandler);
  assert.equal(loaded.makefileHandlers.length, 1);
  assert.equal(loaded.makefileHandlers[0].sourceFile, sourceRelative.replace(/\//g, path.sep));

  const execute = createLambdaExecutor({ workingDir: directory, port: 0 });
  assert.deepEqual(await execute(loaded.functions[0], {}), { ok: true });
});

test("rejects --makefile without a Makefile", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "freesls-makefile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await createSamProject(directory, { withMakefile: false });
  const makeCommand = await createFakeMake(directory, makeOutput);

  await assert.rejects(
    loadSamConfig(directory, {
      stage: "dev",
      region: "us-east-1",
      params: {},
      cron: true,
      makefile: true,
      makeCommand,
      resolveSSM: false,
    }),
    /--makefile requires a Makefile/,
  );
});

test("rejects a failing makefile target with its stderr", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "freesls-makefile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await createSamProject(directory);
  const makeCommand = await createFakeMake(directory, "", 2);

  await assert.rejects(
    loadSamConfig(directory, {
      stage: "dev",
      region: "us-east-1",
      params: {},
      cron: true,
      makefile: true,
      makeCommand,
      resolveSSM: false,
    }),
    /simulated make failure/,
  );
});

test("CLI rejects --makefile without --sam before touching the project", () => {
  const result = spawnSync(process.execPath, [cliPath, "--makefile", "--no-ssm"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--makefile requires --sam/);
});

test("reports missing GNU Make with installation guidance", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "freesls-makefile-path-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const moduleUrl = pathToFileURL(
    fileURLToPath(new URL("../dist/sam-makefile.js", import.meta.url)),
  ).href;
  const script = `import { resolveGnuMakeCommand } from ${JSON.stringify(moduleUrl)};
try { resolveGnuMakeCommand(); process.exit(0); }
catch (error) { console.error(error.message); process.exit(1); }`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, PATH: directory },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires GNU Make/);
  assert.match(result.stderr, /install GNU Make/i);
});

test("CLI requires a root Makefile when --makefile is used with --sam", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "freesls-makefile-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cliPath, "--sam", "--makefile", "--no-ssm"], {
    cwd: directory,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--makefile requires a Makefile/);
});
