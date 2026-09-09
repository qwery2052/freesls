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
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg?style=flat-square" alt="Node Version" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.x-blue.svg?style=flat-square" alt="TypeScript" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg?style=flat-square" alt="License" /></a>
</p>

```
   /\_/\   FreeSLS v0.2.0  [SLS] / [AWS SAM]
  ( o.o )  Offline API Gateway & Lambda Runner
   > ^ <   ● Service: user-management-api [stage: dev]
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

| Flag         | Alias      | Description                                                                   | Default                          |
| ------------ | ---------- | ----------------------------------------------------------------------------- | -------------------------------- |
| `--sam`      | `-sam`     | 🧪 **Experimental:** Uses AWS SAM template (`template.yaml` / `template.yml`) | `false`                          |
| `--sls`      | `-sls`     | Uses Serverless Framework template (`serverless.yml`)                         | `true` (default)                 |
| `--stage`    | `-s`       | Target deployment stage (`dev`, `staging`, `prod`)                            | `develop`                        |
| `--region`   | `-r`       | AWS region for SSM and Lambda context                                         | `us-east-1`                      |
| `--port`      | `-p`             | HTTP port for the local server                                                | `4000`                           |
| `--base-path` | `-b`, `--prefix` | Base path prefix for all endpoints (e.g. `/medical-history-app`)               | `""` (root `/`)                  |
| `--profile`   |                  | AWS CLI / AWS SSO profile name                                                | System environment credentials   |
| `--param`     |                  | Custom key=value parameters (injected into `process.env`)                     | `{}`                             |
| `--no-ssm`    |                  | Disables AWS SSM queries (uses `ssm.env`, YAML fallbacks, or mocks)           | `false` (queries real AWS SSM)   |
| `--show-env`  |                  | Displays full, unmasked environment variables in console                      | `false` (masks sensitive values) |
| `--version`   | `-v`, `-V`       | Displays the installed FreeSLS version                                        |                                  |

> [!WARNING]
> **AWS SAM Mode (`--sam`) is Experimental**
>
> Emulation for AWS SAM is currently in active **beta / experimental** development. Supported intrinsic functions include `Ref`, `Fn::GetAtt`, `Fn::Sub`, and SSM dynamic references (`{{resolve:ssm:...}}`). Advanced CloudFormation capabilities (such as complex `Mappings`, nested stacks, or unsupported intrinsic functions) are partial.

### Common Examples

```bash
# Check installed version
freesls -v

# Run Serverless Framework in 'dev' stage on port 4000 using an AWS SSO profile
freesls -s dev -p 4000 --profile my-org-dev

# Run with a custom base path prefix (e.g. http://localhost:4000/medical-history-app/...)
freesls -s dev -p 4000 --base-path /medical-history-app

# Run AWS SAM project in 'dev' stage
freesls -sam -s dev -p 4000 --profile my-org-dev

# Run completely offline without AWS credentials
freesls -s local --no-ssm

# Inject custom parameters into process.env and ${param:...}
freesls -s dev --param domain=api.local --param deploymentStage=dev

# Display all environment variable values in clear text
freesls -s dev --show-env
```

---

## 🔒 Offline Mode & SSM Mocks (`--no-ssm`)

When running with `--no-ssm`, FreeSLS **does not connect to AWS** and resolves `${ssm:/...}` parameters following this priority chain:

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
      "runtimeArgs": ["-s", "dev", "-p", "4000", "--profile", "your-aws-profile"],
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
      "runtimeArgs": ["-sam", "-s", "dev", "-p", "4000", "--profile", "your-aws-profile"],
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
- Native JavaScript modules and dependencies may retain their first import-time environment values through module caching. Functions sharing those modules do not have separate Lambda execution environments. Restart FreeSLS after changing configuration.
- The context's 30-second remaining-time clock is advisory, not an enforced timeout. A handler that never completes blocks subsequent invocations. Detached background work is not isolated, and `callbackWaitsForEmptyEventLoop` does not enable event-loop draining.
- Handlers may complete through a callback, context completion method, returned promise, or synchronous result. A bare synchronous `undefined` return waits for callback/context completion; the first completion wins.
- REST routes use payload v1. HTTP API routes default to v2, with Serverless `provider.httpApi.payload` and SAM event `PayloadFormatVersion` overrides supported. Binary input is inferred from content type, not from deployed API Gateway binary-media configuration.
- Local CORS uses wildcard origins without credentials. Credentialed browser requests are not supported by this default policy.
- CloudFormation support is partial. Supported `Ref`, `Fn::GetAtt`, and `Fn::Sub` values are resolved locally; unsupported environment intrinsic objects produce explicit errors. Resource identifiers may be mocks, not deployed identifiers.
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
