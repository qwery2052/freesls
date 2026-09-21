<p align="right">
  <b>English</b> | <a href="./README.es.md">Español</a>
</p>

# 🐾 FreeSLS

<p align="center">
  <b>Offline API Gateway & AWS Lambda Runner for Serverless Framework & AWS SAM</b><br>
  Lightweight, fast, with native TypeScript support, AWS SSM resolution, and instant breakpoint debugging.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/freesls"><img src="https://img.shields.io/npm/v/freesls.svg?style=flat-square&color=cb3837" alt="npm version" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg?style=flat-square" alt="Node Version" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.x-blue.svg?style=flat-square" alt="TypeScript" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg?style=flat-square" alt="License" /></a>
</p>

```
   /\_/\   FreeSLS v0.4.0-beta.11  [SLS] / [AWS SAM]
  ( o.o )  Offline API Gateway & Lambda Runner
   > ^ <   ● Service: example-service [stage: dev]
────────────────────────────────────────────────────────────
 Local Endpoint: http://localhost:4000
────────────────────────────────────────────────────────────
```

> [!NOTE]
> **Active Development & Current Scope**
>
> - 🚧 **Work in Progress:** FreeSLS is under active and continuous development. Improvements, fixes, and new features are being released regularly.
> - 🧪 **AWS SAM Mode (Experimental):** Running AWS SAM projects (`--sam`) is currently experimental and under active development. Emulation of complex CloudFormation features is partial.
> - ⚡ **Current Scope:** FreeSLS currently focuses specifically on running **AWS Lambda functions invoked via HTTP and HTTP API events (API Gateway)** for both **Serverless Framework** (`serverless.yml`) and **AWS SAM** (`template.yaml` / `template.yml`). Support for additional triggers (such as SQS, SNS, EventBridge, S3) is planned for upcoming releases. Feedback and suggestions are warmly welcomed!

---

## 💡 Why FreeSLS?

Traditional local emulation tools for Serverless Framework and AWS SAM often require heavy plugins, complex build pipelines, or struggle with AWS SSM Parameter Store resolution and VS Code breakpoint setup.

**FreeSLS** delivers a modern, minimal, and ultra-fast alternative:

- **Dual Framework Support**: Run both **Serverless Framework** (`serverless.yml`) and **AWS SAM** (`template.yaml` / `template.yml`) with a single tool.
- **Zero Build Configuration**: Run TypeScript (`.ts`, `.tsx`) and JavaScript (`.js`, `.mjs`, `.cjs`) handlers directly using [jiti](https://github.com/unjs/jiti) with built-in source maps.

  TypeScript handlers use the TypeScript compiler for fields and decorators, then Jiti for module loading and path aliases. The nearest `tsconfig.json` (including `extends`) supplies target, class-field, decorator, and JSX options. Legacy decorators and decorator metadata default to enabled when unspecified, matching Jiti's previous defaults. Applications must load their own metadata runtime (such as `reflect-metadata`) before decorated classes. Loading transpiles individual files without type-checking; metadata requiring cross-file type inference is not available. Build output and module settings do not override Jiti's loader. Restart after changing path aliases.

- **Real AWS SSM Resolution or Local Mocks**: Fetch real parameters from AWS Parameter Store using your AWS SSO/CLI profiles, or run completely offline with `--no-ssm` using `ssm.env`, fallbacks, or automatic mocks.
- **Offline Environment Flag**: Automatically injects `IS_LOCAL=true` into `process.env` and function runtimes, making it simple to write conditional local logic.
- **CLI Parameter Injection**: Custom arguments passed via `--param key=value` are automatically exported to `process.env`.
- **Advanced Variable Resolution**: Native support for `${self:...}`, `${opt:...}`, `${env:...}`, `${param:...}`, `${aws:...}`, CloudFormation pseudo parameters (`${AWS::Region}`, `${AWS::AccountId}`), and fallback chains (`${ssm:/path, env:VAR, 'fallback'}`).
- **Instant Debugging**: Set breakpoints in your Lambda handler code and debug directly in VS Code without intermediate build steps.
- **Express 5 Engine**: Full compatibility with `http` and `httpApi` events, multi-value headers, route parameters (`{id}` and `{proxy+}`), query strings, and JSON or base64 payloads.

---

## 🚀 Installation

The recommended way to use **FreeSLS** is to install it **globally** (`-g`), making it available as a CLI command across any project:

```bash
# With npm (Recommended)
npm install -g freesls

# Or with pnpm
pnpm add -g freesls

# Or with yarn
yarn global add freesls
```

### Alternative Installation Options

You can also install it as a project development dependency:

```bash
npm install --save-dev freesls
# or
pnpm add -D freesls
```

Or run it on the fly without installing using `npx`:

```bash
npx freesls -s dev -p 4000
```

---

## 📖 Usage & CLI Options

By default, FreeSLS looks for `serverless.yml`. To run an AWS SAM project, simply pass `-sam` (or `--sam`):

```bash
# Serverless Framework (default)
freesls -s dev -p 4000

# AWS SAM (template.yaml / template.yml)
freesls -sam -s dev -p 4000
```

Or add a script to your `package.json`:

```json
{
  "scripts": {
    "offline": "freesls -s dev -p 4000 --profile my-aws-profile",
    "offline:sam": "freesls -sam -s dev -p 4000 --profile my-aws-profile"
  }
}
```

### CLI Flags

| Flag                                       | Alias            | Description                                                                   | Default                          |
| ------------------------------------------ | ---------------- | ----------------------------------------------------------------------------- | -------------------------------- |
| [`--sam`](#--sam)                          | `-sam`           | 🧪 **Experimental:** Uses AWS SAM template (`template.yaml` / `template.yml`) | `false`                          |
| [`--sls`](#--sls)                          | `-sls`           | Uses Serverless Framework template (`serverless.yml`)                         | `true` (default)                 |
| [`--stage`](#--stage)                      | `-s`             | Target deployment stage (`dev`, `staging`, `prod`)                            | `develop`                        |
| [`--region`](#--region)                    | `-r`             | AWS region for SSM and Lambda context                                         | `us-east-1`                      |
| [`--port`](#--port)                        | `-p`             | HTTP port for the local server                                                | `4000`                           |
| [`--base-path`](#--base-path)              | `-b`, `--prefix` | Base path prefix for all endpoints (e.g. `/example-base-path`)                | `""` (root `/`)                  |
| [`--profile`](#--profile)                  |                  | AWS CLI / AWS SSO profile name                                                | System environment credentials   |
| [`--param`](#--param)                      |                  | Custom key=value parameters (injected into `process.env`)                     | `{}`                             |
| [`--no-ssm`](#--no-ssm)                    |                  | Disables AWS SSM queries (uses `ssm.env`, YAML fallbacks, or mocks)           | `false` (queries real AWS SSM)   |
| [`--scheduler`](#--scheduler)              |                  | Enable the local one-time Lambda Scheduler endpoint                           | `false`                          |
| [`--cf-value <key=value...>`](#--cf-value) |                  | Override a reference (for example `ExampleRole.Arn=arn:...`)                  | None                             |
| [`--show-env`](#--show-env)                |                  | Displays full, unmasked environment variables in console                      | `false` (masks sensitive values) |
| [`--debug`](#--debug)                      | `-d`             | Enables verbose lifecycle debug logging with stage timings                    | `false`                          |
| [`--version`](#--version)                  | `-v`, `-V`       | Displays the installed FreeSLS version                                        |                                  |

> [!WARNING]
> **AWS SAM Mode (`--sam`) is Experimental**
>
> Emulation for AWS SAM is currently in active **beta / experimental** development. Supported intrinsic functions include `Ref`, `Fn::GetAtt`, `Fn::Sub`, and SSM dynamic references (`{{resolve:ssm:...}}`). Advanced CloudFormation capabilities (such as complex `Mappings`, nested stacks, or unsupported intrinsic functions) are partial.

### CLI Reference

Detailed usage for every flag. The names in the table above link here.

#### `--sls`

Use the Serverless Framework template (`serverless.yml`). This is the default; pass it to override a previous `--sam`.

```bash
freesls --sls -s dev
```

#### `--sam`

Use an AWS SAM template (`template.yaml` / `template.yml`). Experimental (see the warning above).

For functions with `Metadata.BuildMethod: esbuild`, FreeSLS runs the source file from `Metadata.BuildProperties.EntryPoints` using the exported function named in `Handler`. Entry points are relative to `Properties.CodeUri`, falling back to `Globals.Function.CodeUri` for SAM functions, then the project directory. With multiple entry points, exactly one file's basename (without extension) must match the Handler module; ambiguous or unmatched lists fail explicitly. Without entry points, the usual `CodeUri` + `Handler` resolution applies. FreeSLS executes the source directly; it does not run an esbuild bundle or apply other esbuild build options.

```bash
freesls --sam -s dev
```

#### `--stage`

Alias `-s`. Deployment stage used for `${sls:stage}`, `${opt:stage}`, `${self:provider.stage}`, and for naming local Lambdas (`${service}-${stage}-${key}`). Default `develop`.

```bash
freesls -s staging
```

#### `--region`

Alias `-r`. AWS region for SSM lookups and Lambda context. Default `us-east-1`.

```bash
freesls -r eu-west-1
```

#### `--port`

Alias `-p`. Local HTTP port. Default `4000`.

```bash
freesls -p 3000
```

#### `--base-path`

Aliases `-b` and `--prefix`. Prefix added to every route, useful when your deployed API base path differs from the local default. Default none.

```bash
freesls -b example-base-path
# POST http://localhost:4000/example-base-path/create-campaign
```

#### `--profile`

AWS CLI / AWS SSO profile used for SSM lookups. Without it, the environment credentials are used. SSO failures point to `aws sso login --profile <profile>`.

```bash
freesls --profile example-profile
```

#### `--param`

Inject `key=value` pairs into `process.env` and expose them as `${param:key}`. Repeatable; empty values are allowed (`--param empty=`).

```bash
freesls --param deploymentStage=develop --param empty=
```

#### `--no-ssm`

Disable AWS SSM queries and resolve `${ssm:/...}` from `ssm.env`, YAML fallbacks, or offline mocks. See Offline Mode below.

```bash
freesls --no-ssm
```

#### `--scheduler`

Enable the local one-time EventBridge Scheduler endpoint and inject `AWS_ENDPOINT_URL_SCHEDULER`. See Local Scheduler below.

```bash
freesls --scheduler --no-ssm
```

#### `--cf-value`

Override a reference FreeSLS cannot derive locally, as `LogicalId.Attribute=value` or `Outputs.OutputKey=value`. Repeatable and never queries AWS.

```bash
freesls --scheduler --no-ssm --cf-value ExampleRole.Arn=arn:aws:iam::123456789012:role/team/example
```

#### `--show-env`

Print environment values without masking. Use only locally, since secrets are shown in cleartext.

```bash
freesls --show-env
```

#### `--debug`

Alias `-d`. Verbose lifecycle logs with per-stage timings (path resolution, queue, Jiti, invocation, response).

```bash
freesls --debug
```

#### `--version`

Aliases `-v` and `-V`. Print the installed FreeSLS version.

```bash
freesls --version
```

### Common Examples

```bash
# Check installed version
freesls -v

# Run Serverless Framework in 'dev' stage on port 4000 using an AWS SSO profile
freesls -s dev -p 4000 --profile my-org-dev

# Run with a custom base path prefix (e.g. http://localhost:4000/example-base-path/...)
freesls -s dev -p 4000 --base-path /example-base-path

# Run AWS SAM project in 'dev' stage
freesls -sam -s dev -p 4000 --profile my-org-dev

# Run completely offline without AWS credentials
freesls -s local --no-ssm

# Local Scheduler (application SDK clients still require signing credentials)
freesls -s local --scheduler --no-ssm

# Override an attribute that CloudFormation cannot return directly
freesls --scheduler --no-ssm --cf-value ExampleRole.Arn=arn:aws:iam::123456789012:role/team/example

# Inject custom parameters into process.env and ${param:...}
freesls -s dev --param domain=api.local --param deploymentStage=dev

# Display all environment variable values in clear text
freesls -s dev --show-env

# Run with detailed lifecycle timing logs to trace bottlenecks
freesls -s dev --debug
```

---

## Local Scheduler

`--scheduler` emulates EventBridge **Scheduler** for one-time `at(...)` schedules. It does not emulate the EventBridge event bus (`PutEvents`) or `schedule: cron(...)` rules.

**Operations:** `CreateSchedule`, `GetSchedule`, `UpdateSchedule`, `ListSchedules`, `DeleteSchedule` (group `default` only).

### How it works, step by step

1. FreeSLS registers every function and computes its **simulated ARN**: `arn:<partition>:lambda:<region>:<account>:function:<name>`, where `<account>` is `123456789012` and `<name>` is `name` or `${service}-${stage}-${key}`. Example: `arn:aws:lambda:us-east-1:123456789012:function:example-service-dev-example-function`.
2. With `--scheduler`, it starts a local Scheduler server (loopback, random port) and injects `AWS_ENDPOINT_URL_SCHEDULER` **before loading your modules**.
3. Your handler calls `CreateSchedule` with `Target.Arn` set to that simulated ARN (usually from an environment variable built with `!Sub`/`!GetAtt`).
4. FreeSLS looks that ARN up in its registry and requires an exact match; otherwise it rejects the target.
5. At the scheduled time it invokes the **local** Lambda with `Input` (JSON). Nothing is sent to AWS.
6. `GetSchedule`/`DeleteSchedule` read or remove the in-memory schedule.

> The exact ARN is shown under each endpoint as `└─ arn: ...`. Copy that value for `Target.Arn`.

### End-to-end example

`serverless.yml`:

```yaml
service: example-service
provider:
  environment:
    TARGET_ARN: !GetAtt ExampleDashfunctionLambdaFunction.Arn
    SCHEDULER_ROLE_ARN: !GetAtt ExampleRole.Arn
resources:
  Resources:
    ExampleRole:
      Type: AWS::IAM::Role
      Properties:
        RoleName: example-scheduler
functions:
  example-function:
    handler: src/handler.example
```

Handler:

```ts
const scheduler = new SchedulerClient({ region: "us-east-1" });
await scheduler.send(
  new CreateScheduleCommand({
    Name: "example-job",
    ScheduleExpression: "at(2030-01-01T10:00:00)",
    ScheduleExpressionTimezone: "America/Bogota",
    FlexibleTimeWindow: { Mode: "OFF" },
    ActionAfterCompletion: "DELETE",
    Target: {
      Arn: process.env.TARGET_ARN,
      RoleArn: process.env.SCHEDULER_ROLE_ARN,
      Input: JSON.stringify({ example: true }),
    },
  }),
);
```

Run and watch the console:

```bash
freesls -s dev -p 3000 --scheduler --no-ssm
```

```text
Local Scheduler: http://127.0.0.1:50000 (at schedules, in-memory)…

🐾 [Scheduler] Schedule received example-job
   ├─ target: example-function
   │  arn:    arn:aws:lambda:us-east-1:123456789012:function:example-service-dev-example-function
   ├─ fires:  2030-01-01T15:00:00.000Z (America/Bogota) · in 3m 12s
   └─ actions: ENABLED · after run DELETE · retries 185 · max age 86400s

😻 [Scheduler] Firing example-job → example-function
😸 [Lambda][start] example-function
…
😻 [Scheduler] Delivered example-job · schedule processed
```

### Reschedule or cancel

`UpdateSchedule` changes an existing schedule in place (same `Name`/ARN). It is a **full replacement**: resend every field you care about, because omitted optional fields reset to their defaults (`ActionAfterCompletion` back to `NONE`, `State` back to `ENABLED`, etc.). Call `GetSchedule` first to read the current values.

```ts
await scheduler.send(
  new UpdateScheduleCommand({
    Name: "example-job",
    ScheduleExpression: "at(2030-02-01T10:00:00)", // new date
    ScheduleExpressionTimezone: "America/Bogota",
    FlexibleTimeWindow: { Mode: "OFF" },
    ActionAfterCompletion: "DELETE",
    State: "ENABLED",
    Target: {
      Arn: process.env.TARGET_ARN,
      RoleArn: process.env.SCHEDULER_ROLE_ARN,
      Input: JSON.stringify({ example: true }),
    },
  }),
);
```

`DeleteSchedule` cancels it:

```ts
await scheduler.send(new DeleteScheduleCommand({ Name: "example-job" }));
```

Both operations use the schedule `Name` (plus `GroupName`, `default` locally). The console prints `[Scheduler] Schedule updated …` or `[Scheduler] Schedule cancelled …`.

### List schedules

`ListSchedules` returns the schedules of the session (group `default`), with optional `NamePrefix`, `State`, `MaxResults` (1–100) and `NextToken` for pagination:

```ts
const page = await scheduler.send(
  new ListSchedulesCommand({ NamePrefix: "campaign-", MaxResults: 50 }),
);
for (const summary of page.Schedules ?? []) {
  const detail = await scheduler.send(new GetScheduleCommand({ Name: summary.Name! }));
  // …
}
```

### Credentials

The Scheduler SDK signs every request, so it needs AWS credentials. If you use SSO, run `aws sso login --profile <profile>` and you're set; FreeSLS preserves your existing credentials. For a purely local app without any AWS credentials, set dummy ones (`AWS_ACCESS_KEY_ID=local`, `AWS_SECRET_ACCESS_KEY=local`).

### Troubleshooting

- `403 AccessDeniedException: Cross-account pass role is not allowed` → the call reached **real AWS**, not the local endpoint. Start with `--scheduler` and use a `@aws-sdk/client-scheduler` that honors `AWS_ENDPOINT_URL_SCHEDULER`, or set `endpoint: process.env.AWS_ENDPOINT_URL_SCHEDULER` explicitly.
- `Target.Arn must exactly identify a Lambda registered in this project` → the ARN does not match a local function; check the function `name` or `${service}-${stage}-${key}`.
- `Local one-time schedules must be in the future` → the resolved instant already passed; check the date and `ScheduleExpressionTimezone`.

### Limits

| Supported   | Contract                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Operations  | `CreateSchedule`, `GetSchedule`, `UpdateSchedule`, `ListSchedules`, `DeleteSchedule`; group `default` only                            |
| Dates       | Future `at(...)` dates; IANA time zones from Node's ICU data, UTC by default                                                          |
| Targets     | Exact ARNs of registered project Lambdas, including functions without HTTP events                                                     |
| Input       | Explicit valid JSON up to 256 KB, delivered directly to the handler; use `'{}'` for an empty event                                    |
| State       | `ENABLED` / `DISABLED`; no update operation yet                                                                                       |
| Completion  | `NONE` keeps the record; `DELETE` removes it after delivery or exhausted delivery attempts                                            |
| Retries     | 0–185 additional delivery attempts (default 185), event age 60–86400 seconds (default 86400)                                          |
| Idempotency | Reusing a `ClientToken` with the same parameters returns the original ARN; different parameters conflict; tokens live for the session |

Unsupported fields/operations return SDK-compatible errors with corrective guidance: `cron`, `rate`, flexible windows, custom groups, aliases/versions, external Lambdas, universal targets, DLQs, KMS, StartDate/EndDate and Scheduler context placeholders. Missing/ambiguous wall-clock dates during DST transitions are explicitly rejected: use an unambiguous date or UTC. AWS's default notification for omitted Input is not emulated.

Timers aim for the specified instant rather than reproducing AWS's 60-second delivery window. Functions execute serially with HTTP handlers in the same process; breakpoints or CPU-bound handlers can delay execution. Retries apply to **delivery acceptance**, not handler failures: local acceptance succeeds for registered targets, so retry policies are validated but do not repeat handler invocations. Backoff is deterministic exponential (1 second up to 60 seconds), without AWS jitter. Accepted invocations execute once locally; Lambda's own asynchronous retry/DLQ service is not emulated. Handler failures log the function identity without payload/error contents; inspect them with a debugger. Schedules are lost on restart, shutdown cancels future deliveries, and already accepted invocations are not durably drained.

FreeSLS prints a `[Lambda][start] <functionName>` line (green) to stdout for every invocation, both HTTP and Scheduler-triggered, and each HTTP request ends with a `[Lambda][end] METHOD /path status (ms)` summary line (magenta), including error responses. With `--scheduler`, FreeSLS also prints lifecycle logs: each schedule received (name, target ARN, firing time in UTC plus the declared timezone, state, completion action and retry settings), when it fires, and when delivery completes or is cancelled/expired. `Target.Input` and credentials are never logged.

### Resolving resource references

FreeSLS resolves `Ref`, `Fn::GetAtt` and `Fn::Sub` locally: registered Lambdas and IAM roles declared in your template. Example:

```yaml
provider:
  environment:
    TARGET_ARN: !GetAtt ExampleDashfunctionLambdaFunction.Arn
    SCHEDULER_ROLE_ARN: !GetAtt ExampleRole.Arn
resources:
  Resources:
    ExampleRole:
      Type: AWS::IAM::Role
      Properties:
        RoleName: example-scheduler
functions:
  example-function:
    handler: src/handler.example
```

Serverless logical IDs normalize `-` to `Dash`, `_` to `Underscore`, capitalize the first character and append `LambdaFunction`. Function names use `name` or `${service}-${stage}-${key}`. SAM uses `FunctionName` or `${service}-${logicalId}`. Local ARNs use `--region`, the simulated account `123456789012`, and the matching partition (`aws`, `aws-cn`, `aws-us-gov`); they never touch AWS. No resources are deployed.

For SAM, the local service name comes from the template's `Description` (sanitized and limited to 30 characters), or the project directory name when absent. Automatically generated Lambda names that exceed 64 characters or contain invalid characters are normalized and given a stable hash suffix within the 64-character limit. Explicit `FunctionName` values are validated without rewriting. `Ref`, `GetAtt`, and `Sub` use the same local identity. These internal names do not prefix HTTP routes; only `--base-path` / `--prefix` adds a URL prefix.

#### When a reference cannot be resolved: `--cf-value`

If a reference points to something **not** declared in your template (for example a role from another stack), FreeSLS stops with an actionable error. Provide the value by hand:

```bash
freesls --scheduler --no-ssm --cf-value ExampleRole.Arn=arn:aws:iam::123456789012:role/example-scheduler
```

- `LogicalId.Attribute=value` for `!GetAtt` (include the real role path when overriding an ARN).
- `Outputs.OutputKey=value` for stack outputs.
- Repeatable, overrides local resolution, and **never queries AWS**. It applies to `!Ref`/`!GetAtt`, not to `!Sub` strings.

Enabling `--scheduler` or `--cf-value` also makes unresolved `Ref`/`GetAtt` strict errors; without them, Serverless's legacy HTTP-only mode keeps blank values for compatibility. Unsupported `Fn::Sub` mappings always fail explicitly.

## 🔒 Offline Mode & SSM Mocks (`--no-ssm`)

When running with `--no-ssm`, FreeSLS **does not query AWS SSM** and resolves `${ssm:/...}` parameters following this priority chain. Application SDK calls made by your handlers are independent:

```
1. ssm.env file  ──►  2. YAML Fallback  ──►  3. Automatic Safety Mock
```

### 1. `ssm.env` File (in project root)

Create an `ssm.env` file in the root of your project to provide local mock values:

```env
# ssm.env
/my-app/dev/DATABASE_URL=postgres://postgres:localpass@localhost:5432/mydb
/my-app/dev/JWT_SECRET=local-development-secret-key
API_KEY=local-dev-api-key
```

### 2. Serverless YAML Fallbacks

If a parameter is not defined in `ssm.env`, FreeSLS evaluates the fallback expressions defined in your `serverless.yml`:

```yaml
provider:
  environment:
    # If not in ssm.env, falls back to 'localhost:6379'
    REDIS_HOST: ${ssm:/my-app/REDIS_HOST, 'localhost:6379'}

    # If not in ssm.env, evaluates environment variable DB_HOST, then '127.0.0.1'
    DB_HOST: ${ssm:/my-app/DB_HOST, env:DB_HOST, '127.0.0.1'}
```

### 3. Automatic Safety Mock

If a parameter is neither in `ssm.env` nor has a fallback in the YAML, FreeSLS automatically creates `mock-${parameterName}` (e.g. `${ssm:/infra/MY_PARAM}` $\rightarrow$ `"mock-my_param"`), ensuring your local service never crashes due to unresolved parameters.

---

## 🔐 Security & Masking

By default, **FreeSLS** protects sensitive values. When printing the environment summary, **all resolved environment variables** (`✅ loaded`) are automatically masked to prevent accidental exposure of credentials, database URLs, or internal endpoints:

```
 🐾 Environment Variables Loaded: (4 resolved)
   (Use --show-env flag to view full unmasked values)

   ✅ loaded   DATABASE_URL                 = post...5432
   ✅ loaded   API_SECRET_KEY               = abcd...wxyz
   ⚠️  mocked   STRIPE_KEY                   = mock-stripe_key
```

---

## 🐞 VS Code Breakpoint Debugging

Configuring VS Code debugging with **FreeSLS** is straightforward. Add this configuration to your `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "FreeSLS: Debug Serverless",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "freesls",
      "runtimeArgs": ["-s", "dev", "-p", "4000", "--profile", "example-profile"],
      "cwd": "${workspaceFolder}",
      "console": "integratedTerminal",
      "internalConsoleOptions": "neverOpen",
      "skipFiles": ["<node_internals>/**"]
    },
    {
      "name": "FreeSLS: Debug SAM",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "freesls",
      "runtimeArgs": ["-sam", "-s", "dev", "-p", "4000", "--profile", "example-profile"],
      "cwd": "${workspaceFolder}",
      "console": "integratedTerminal",
      "internalConsoleOptions": "neverOpen",
      "skipFiles": ["<node_internals>/**"]
    },
    {
      "name": "FreeSLS: Debug (Scheduler)",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "freesls",
      "runtimeArgs": [
        "-s",
        "dev",
        "-p",
        "3000",
        "--profile",
        "example-profile",
        "--param",
        "deploymentStage=develop",
        "-b",
        "example-base-path",
        "--scheduler"
      ],
      "cwd": "${workspaceFolder}",
      "console": "integratedTerminal",
      "internalConsoleOptions": "neverOpen",
      "skipFiles": ["<node_internals>/**"]
    }
  ]
}
```

1. Set a breakpoint in any Lambda handler (`src/functions/.../handler.ts`).
2. Press `F5` in VS Code.
3. Send an HTTP request (via Postman, cURL, or frontend) to `http://localhost:4000/...`.
4. The breakpoint will hit instantly in your original TypeScript source with full inspection and call stack support.

---

## 📄 Supported `serverless.yml` Syntax

### 1. HTTP Events

Supports both string and object formats:

```yaml
functions:
  getUser:
    handler: src/handlers/user.get
    events:
      - http:
          path: users/{id}
          method: get
      - httpApi:
          path: /users/{id}/details
          method: GET

  proxyAll:
    handler: src/handlers/proxy.handler
    events:
      - http:
          path: files/{proxy+}
          method: ANY
```

### 2. Handler Resolution

FreeSLS automatically locates handlers at:

- `src/handlers/user.get` $\rightarrow$ Resolves `src/handlers/user.ts`, `src/handlers/user.js`, or `src/handlers/user/index.ts` and exports the named function `get` (or `default`).

### 3. Variable Resolution & Fallbacks

```yaml
provider:
  name: aws
  runtime: nodejs20.x
  stage: ${opt:stage, 'dev'}
  environment:
    STAGE: ${self:provider.stage}
    REGION: ${opt:region, 'us-east-1'}
    USERS_TABLE: ${ssm:/my-app/${self:provider.stage}/USERS_TABLE}
    API_KEY: ${ssm:/my-app/API_KEY, env:LOCAL_KEY, 'default_key'}
```

---

## 🛠️ Local Development & Contributing

### Local Execution Limits

- Invocations run serially in the same Node.js process so environment overrides do not overlap. Handler loading happens inside that environment scope, and source maps remain enabled for debugging.
- Transformed modules share a filename-normalized cache within each invocation, including circular imports through aliases and relative paths on Windows. The cache is discarded between invocations so source edits and route environments are reloaded. Cycles that use an export before it is initialized can still fail; FreeSLS does not reproduce esbuild's bundling semantics or execute Serverless build plugins.
- Native JavaScript modules and dependencies may retain their first import-time environment values through module caching. Functions sharing those modules do not have separate Lambda execution environments. Restart FreeSLS after changing configuration.
- The context's 30-second remaining-time clock is advisory, not an enforced timeout. A handler that never completes blocks subsequent invocations. Detached background work is not isolated, and `callbackWaitsForEmptyEventLoop` does not enable event-loop draining.
- Handlers may complete through a callback, context completion method, returned promise, or synchronous result. A bare synchronous `undefined` return waits for callback/context completion; the first completion wins.
- REST routes use payload v1. HTTP API routes default to v2, with Serverless `provider.httpApi.payload` and SAM event `PayloadFormatVersion` overrides supported. Binary input is inferred from content type, not from deployed API Gateway binary-media configuration.
- Local CORS automatically allows any request origin with credentials (including browser `fetch` with `credentials: "include"`), requested headers, and supported HTTP methods. Preflight requests are handled locally. This permissive development policy overrides handler CORS headers, exposes returned custom headers, and varies responses by origin and requested headers. Requests without an origin receive `*` without credentials. It does not emulate deployed API Gateway CORS restrictions.
- CloudFormation references are resolved locally. Supported `Ref`, `Fn::GetAtt`, and `Fn::Sub` values resolve from your template (or an explicit `--cf-value`); unsupported environment intrinsic objects produce explicit errors. Resource identifiers may be mocks, not deployed identifiers.
- `--no-ssm` disables FreeSLS SSM queries, not AWS calls made by your handlers. Environment values are masked by default, including values beginning with `mock-`.

To clone and contribute to **FreeSLS**:

```bash
git clone https://github.com/qwery2052/freesls.git
cd freesls

# Install dependencies
npm install

# Compile TypeScript
npm run build

# Build and run local regression tests (no AWS credentials required)
npm test

# Watch mode
npm run watch

# Format code
npm run format
```

---

## 🤝 Contributing

Contributions are welcome! Feel free to open an Issue or submit a Pull Request:

1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/my-new-feature`).
3. Commit your changes (`git commit -m 'feat: add awesome feature'`).
4. Push to the branch (`git push origin feature/my-new-feature`).
5. Open a Pull Request.

---

## 📜 License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
