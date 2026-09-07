<p align="right">
  <b>English</b> | <a href="./README.es.md">Español</a>
</p>

# 🐾 FreeSLS

<p align="center">
  <b>Offline API Gateway & AWS Lambda Runner for Serverless Framework</b><br>
  Lightweight, fast, with native TypeScript support, AWS SSM resolution, and instant breakpoint debugging.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/freesls"><img src="https://img.shields.io/npm/v/freesls.svg?style=flat-square&color=cb3837" alt="npm version" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg?style=flat-square" alt="Node Version" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.x-blue.svg?style=flat-square" alt="TypeScript" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg?style=flat-square" alt="License" /></a>
</p>

```
   /\_/\   FreeSLS v0.1.0
  ( o.o )  Offline API Gateway & Lambda Runner
   > ^ <   ● Service: user-management-api [stage: dev]
────────────────────────────────────────────────────────────
 Local Endpoint: http://localhost:4000
────────────────────────────────────────────────────────────
```

---

## 💡 Why FreeSLS?

Traditional local emulation tools for Serverless Framework often require heavy plugins, complex Webpack/esbuild pipelines, or struggle with AWS SSM Parameter Store resolution and VS Code breakpoint setup.

**FreeSLS** delivers a modern, minimal, and ultra-fast alternative:

- **Zero Build Configuration**: Run TypeScript (`.ts`, `.tsx`) and JavaScript (`.js`, `.mjs`, `.cjs`) handlers directly using [jiti](https://github.com/unjs/jiti) with built-in source maps.
- **Real AWS SSM Resolution or Local Mocks**: Fetch real parameters from AWS Parameter Store using your AWS SSO/CLI profiles, or run completely offline with `--no-ssm` using `ssm.env`, fallbacks, or automatic mocks.
- **CLI Parameter Injection**: Custom arguments passed via `--param key=value` are automatically exported to `process.env`.
- **Advanced Variable Resolution**: Native support for `${self:...}`, `${opt:...}`, `${env:...}`, `${param:...}`, `${aws:...}`, and fallback chains (`${ssm:/path, env:VAR, 'fallback'}`).
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

Once installed globally, simply run `freesls` in any directory containing a `serverless.yml`:

```bash
freesls -s dev -p 4000
```

Or add a script to your `package.json`:

```json
{
  "scripts": {
    "offline": "freesls -s dev -p 4000 --profile my-aws-profile"
  }
}
```

### CLI Flags

| Flag         | Alias | Description                                                         | Default                          |
| ------------ | ----- | ------------------------------------------------------------------- | -------------------------------- |
| `--stage`    | `-s`  | Target deployment stage (`dev`, `staging`, `prod`)                  | `develop`                        |
| `--region`   | `-r`  | AWS region for SSM and Lambda context                               | `us-east-1`                      |
| `--port`     | `-p`  | HTTP port for the local server                                      | `4000`                           |
| `--profile`  |       | AWS CLI / AWS SSO profile name                                      | System environment credentials   |
| `--param`    |       | Custom key=value parameters (injected into `process.env`)           | `{}`                             |
| `--no-ssm`   |       | Disables AWS SSM queries (uses `ssm.env`, YAML fallbacks, or mocks) | `false` (queries real AWS SSM)   |
| `--show-env` |       | Displays full, unmasked environment variables in console            | `false` (masks sensitive values) |

### Common Examples

```bash
# Run in 'dev' stage on port 4000 using an AWS SSO profile
freesls -s dev -p 4000 --profile my-org-dev

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

By default, **FreeSLS** protects sensitive values. When printing the environment summary, variables containing keywords such as `KEY`, `SECRET`, `PASSWORD`, `TOKEN`, or `AUTH` are automatically masked:

```
 🐾 Environment Variables Loaded: (4 resolved)
   (Use --show-env flag to view full unmasked values)

   ✅ loaded   DATABASE_URL                 = postgres://...5432
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
      "name": "FreeSLS: Debug Local",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "freesls",
      "runtimeArgs": ["-s", "dev", "-p", "4000", "--profile", "your-aws-profile"],
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

To clone and contribute to **FreeSLS**:

```bash
git clone https://github.com/qwery2052/freesls.git
cd freesls

# Install dependencies
npm install

# Compile TypeScript
npm run build

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
