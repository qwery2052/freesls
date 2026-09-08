<p align="right">
  <a href="./README.md">English</a> | <b>Español</b>
</p>

# 🐾 FreeSLS

<p align="center">
  <b>Offline API Gateway & AWS Lambda Runner for Serverless Framework & AWS SAM</b><br>
  Ligero, rápido, con soporte nativo de TypeScript, resolución de AWS SSM y depuración con breakpoints al instante.
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
> **En Desarrollo Activo y Alcance Actual**
>
> - 🚧 **En Desarrollo Continuo:** FreeSLS se encuentra en desarrollo activo y constante evolución. Se están incorporando mejoras, correcciones y nuevas capacidades continuamente.
> - ⚡ **Alcance Actual:** Por el momento, FreeSLS funciona exclusivamente con **funciones AWS Lambda invocadas mediante eventos HTTP y HTTP API (API Gateway)** tanto para **Serverless Framework** (`serverless.yml`) como para **AWS SAM** (`template.yaml` / `template.yml`). El soporte para otros desencadenadores (SQS, SNS, EventBridge, S3, etc.) está proyectado para futuras versiones. ¡El feedback y los aportes son bienvenidos!

---

## 💡 ¿Por qué FreeSLS?

Las herramientas tradicionales de emulación local para Serverless Framework y AWS SAM a menudo requieren plugins pesados, configuraciones complejas de build, o presentan dificultades al conectar con AWS SSM Parameter Store y al configurar breakpoints en VS Code.

**FreeSLS** ofrece una alternativa moderna, minimalista y ultra-rápida:

- **Soporte Dual de Frameworks**: Ejecuta proyectos de **Serverless Framework** (`serverless.yml`) y **AWS SAM** (`template.yaml` / `template.yml`) con la misma herramienta.
- **Cero configuración de compilación**: Ejecuta archivos TypeScript (`.ts`, `.tsx`) y JavaScript (`.js`, `.mjs`, `.cjs`) directamente usando [jiti](https://github.com/unjs/jiti) con source maps integrados.
- **Resolución real de AWS SSM o Mocks locales**: Consulta parámetros reales de AWS Parameter Store respetando tus perfiles de AWS SSO/CLI, o ejecuta offline con `--no-ssm` usando `ssm.env`, fallbacks o mocks automáticos.
- **Inyección de parámetros**: Parámetros pasados vía `--param clave=valor` se inyectan automáticamente en `process.env`.
- **Resolución avanzada de variables**: Soporta sintaxis como `${self:...}`, `${opt:...}`, `${env:...}`, `${param:...}`, `${aws:...}`, pseudo-parámetros CloudFormation (`${AWS::Region}`, `${AWS::AccountId}`) y cadenas de fallback (`${ssm:/path, env:VAR, 'fallback'}`).
- **Depuración instantánea**: Coloca breakpoints en tus funciones Lambda y depúralos en VS Code sin pasos de build intermedios.
- **Emulador Express 5**: Compatible con eventos `http` y `httpApi`, cabeceras multi-valor, parámetros de ruta (`{id}` y `{proxy+}`), query strings y payloads en JSON o base64.

---

## 🚀 Instalación

La forma recomendada de usar **FreeSLS** es instalarlo de manera **global** (`-g`), de modo que esté disponible como comando directo en cualquier proyecto:

```bash
# Con npm (Recomendado)
npm install -g freesls

# O con pnpm
pnpm add -g freesls

# O con yarn
yarn global add freesls
```

### Otras formas de uso:

También puedes instalarlo como dependencia de desarrollo en tu proyecto:

```bash
npm install --save-dev freesls
# o
pnpm add -D freesls
```

O ejecutarlo directamente sin instalar previamente usando `npx`:

```bash
npx freesls -s dev -p 4000
```

---

## 📖 Uso y Comandos

Por defecto, FreeSLS busca `serverless.yml`. Para ejecutar un proyecto de AWS SAM, simplemente agrega `-sam` (o `--sam`):

```bash
# Serverless Framework (por defecto)
freesls -s dev -p 4000

# AWS SAM (template.yaml / template.yml)
freesls -sam -s dev -p 4000
```

O agregar un script a tu `package.json`:

```json
{
  "scripts": {
    "offline": "freesls -s dev -p 4000 --profile mi-perfil-aws",
    "offline:sam": "freesls -sam -s dev -p 4000 --profile mi-perfil-aws"
  }
}
```

### Opciones de CLI

| Opción       | Alias  | Descripción                                                      | Valor por Defecto                |
| ------------ | ------ | ---------------------------------------------------------------- | -------------------------------- |
| `--sam`      | `-sam` | Usa template de AWS SAM (`template.yaml` / `template.yml`)       | `false`                          |
| `--sls`      | `-sls` | Usa template de Serverless Framework (`serverless.yml`)          | `true` (por defecto)             |
| `--stage`    | `-s`   | Stage de despliegue (`dev`, `staging`, `prod`)                   | `develop`                        |
| `--region`   | `-r`   | Región de AWS para SSM y contexto Lambda                         | `us-east-1`                      |
| `--port`     | `-p`   | Puerto HTTP para el servidor local                               | `4000`                           |
| `--profile`  |        | Perfil de AWS CLI / AWS SSO                                      | Variables de entorno del sistema |
| `--param`    |        | Parámetros clave=valor (se inyectan a `process.env`)             | `{}`                             |
| `--no-ssm`   |        | Desactiva consultas a AWS SSM (usa `ssm.env`, fallbacks o mocks) | `false` (resuelve SSM real)      |
| `--show-env` |        | Muestra los valores de variables sin enmascarar en consola       | `false` (enmascara secretos)     |

### Ejemplos comunes

```bash
# Ejecutar Serverless Framework en stage 'dev' en el puerto 4000 usando perfil AWS SSO
freesls -s dev -p 4000 --profile mi-empresa-dev

# Ejecutar proyecto AWS SAM en stage 'dev'
freesls -sam -s dev -p 4000 --profile mi-empresa-dev

# Ejecutar completamente offline sin conexión a AWS
freesls -s local --no-ssm

# Inyectar parámetros personalizados a process.env y ${param:...}
freesls -s dev --param domain=api.local --param deploymentStage=dev

# Ver valores de variables de entorno completas en la terminal sin enmascarar
freesls -s dev --show-env
```

---

## 🔒 Modo Offline y Mocks de SSM (`--no-ssm`)

Cuando ejecutas con `--no-ssm`, FreeSLS **no se conecta a AWS** y resuelve los parámetros `${ssm:/...}` siguiendo este orden de prioridad:

```
1. Archivo ssm.env  ──►  2. Fallback en YAML  ──►  3. Mock automático de seguridad
```

### 1. Archivo `ssm.env` (en la raíz del proyecto)

Si creas un archivo `ssm.env` en la raíz de tu proyecto, FreeSLS cargará automáticamente los valores definidos allí:

```env
# ssm.env
/my-app/dev/DATABASE_URL=postgres://postgres:localpass@localhost:5432/mydb
/my-app/dev/JWT_SECRET=clave-secreta-de-desarrollo-local
API_KEY=local-dev-api-key
```

### 2. Fallbacks de Serverless en `serverless.yml`

Si una variable no está en `ssm.env`, FreeSLS evaluará los fallbacks definidos en tu YAML:

```yaml
provider:
  environment:
    # Si no está en ssm.env, tomará 'localhost:6379'
    REDIS_HOST: ${ssm:/my-app/REDIS_HOST, 'localhost:6379'}

    # Si no está en ssm.env, evaluará la variable de entorno DB_HOST
    DB_HOST: ${ssm:/my-app/DB_HOST, env:DB_HOST, '127.0.0.1'}
```

### 3. Mock automático de seguridad

Si el parámetro no está en `ssm.env` y tampoco tiene fallback en el YAML, FreeSLS generará automáticamente `mock-${nombre}` (ej. `${ssm:/infra/MI_VAR}` $\rightarrow$ `"mock-mi_var"`), evitando que tu aplicación falle por variables sin resolver.

---

## 🔐 Seguridad y Enmascaramiento

Por defecto, **FreeSLS** protege tus credenciales. En la terminal se mostrará un resumen de las variables cargadas, pero **todas las variables resueltas** (`✅ loaded`) serán enmascaradas automáticamente para evitar la exposición accidental de secretos, URLs de base de datos o endpoints internos:

```
 🐾 Environment Variables Loaded: (4 resueltas)
   (Usa el flag --show-env para ver los valores completos sin enmascarar)

   ✅ loaded   DATABASE_URL                 = post...5432
   ✅ loaded   API_SECRET_KEY               = abcd...wxyz
   ⚠️  mocked   STRIPE_KEY                   = mock-stripe_key
```

---

## 🐞 Depuración con Breakpoints en VS Code

Configurar la depuración en VS Code con **FreeSLS** es sumamente sencillo. Crea o actualiza tu archivo `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "FreeSLS: Debug Serverless",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "freesls",
      "runtimeArgs": ["-s", "dev", "-p", "4000", "--profile", "tu-perfil-aws"],
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
      "runtimeArgs": ["-sam", "-s", "dev", "-p", "4000", "--profile", "tu-perfil-aws"],
      "cwd": "${workspaceFolder}",
      "console": "integratedTerminal",
      "internalConsoleOptions": "neverOpen",
      "skipFiles": ["<node_internals>/**"]
    }
  ]
}
```

1. Coloca un punto de interrupción (breakpoint) en cualquier archivo de tu handler (`src/functions/.../handler.ts`).
2. Presiona `F5` en VS Code.
3. Envía una petición HTTP (usando Postman, cURL o tu frontend) a `http://localhost:4000/...`.
4. El breakpoint se activará inmediatamente en tu código TypeScript original con acceso a variables locales y pila de llamadas.

---

## 📄 Sintaxis de `serverless.yml` Soportada

### 1. Eventos HTTP

Soporta sintaxis en cadena y en formato objeto:

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

### 2. Formato de Handlers

FreeSLS ubica automáticamente handlers en:

- `src/handlers/user.get` $\rightarrow$ Busca `src/handlers/user.ts`, `src/handlers/user.js` o `src/handlers/user/index.ts` y extrae la función nombrada `get` (o `default`).

### 3. Resolución de Variables y Fallbacks

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

## 🛠️ Desarrollo del Proyecto

Si deseas clonar y contribuir a **FreeSLS**:

```bash
git clone https://github.com/qwery2052/freesls.git
cd freesls

# Instalar dependencias
npm install

# Compilar código TypeScript
npm run build

# Modo observador (watch)
npm run watch

# Formatear con Prettier
npm run format
```

---

## 🤝 Contribuir

¡Las contribuciones son bienvenidas! Siéntete libre de abrir un _Issue_ o enviar un _Pull Request_:

1. Haz un Fork del repositorio.
2. Crea tu rama de características (`git checkout -b feature/nueva-funcionalidad`).
3. Confirma tus cambios (`git commit -m 'feat: agregar nueva funcionalidad'`).
4. Haz push a tu rama (`git push origin feature/nueva-funcionalidad`).
5. Abre un Pull Request.

---

## 📜 Licencia

Este proyecto está bajo la Licencia MIT. Consulta el archivo [LICENSE](LICENSE) para más detalles.
