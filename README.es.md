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
> **En Desarrollo Activo y Alcance Actual**
>
> - 🚧 **En Desarrollo Continuo:** FreeSLS se encuentra en desarrollo activo y constante evolución. Se están incorporando mejoras, correcciones y nuevas capacidades continuamente.
> - 🧪 **Modo AWS SAM (Experimental):** El soporte para proyectos AWS SAM (`--sam`) es actualmente experimental y está en desarrollo activo. La emulación de características complejas de CloudFormation es parcial.
> - ⚡ **Alcance Actual:** Por el momento, FreeSLS funciona exclusivamente con **funciones AWS Lambda invocadas mediante eventos HTTP y HTTP API (API Gateway)** tanto para **Serverless Framework** (`serverless.yml`) como para **AWS SAM** (`template.yaml` / `template.yml`). El soporte para otros desencadenadores (SQS, SNS, EventBridge, S3, etc.) está proyectado para futuras versiones. ¡El feedback y los aportes son bienvenidos!

---

## 💡 ¿Por qué FreeSLS?

Las herramientas tradicionales de emulación local para Serverless Framework y AWS SAM a menudo requieren plugins pesados, configuraciones complejas de build, o presentan dificultades al conectar con AWS SSM Parameter Store y al configurar breakpoints en VS Code.

**FreeSLS** ofrece una alternativa moderna, minimalista y ultra-rápida:

- **Soporte Dual de Frameworks**: Ejecuta proyectos de **Serverless Framework** (`serverless.yml`) y **AWS SAM** (`template.yaml` / `template.yml`) con la misma herramienta.
- **Cero configuración de compilación**: Ejecuta archivos TypeScript (`.ts`, `.tsx`) y JavaScript (`.js`, `.mjs`, `.cjs`) directamente usando [jiti](https://github.com/unjs/jiti) con source maps integrados.

  Los handlers de TypeScript usan el compilador de TypeScript para campos y decoradores, y luego Jiti para la carga de módulos y los alias de rutas. El `tsconfig.json` más cercano (incluyendo `extends`) aporta target, campos de clase, decoradores y opciones de JSX. Los decoradores legacy y la metadata de decoradores se activan por defecto cuando no se especifican, manteniendo los valores por defecto previos de Jiti. Las aplicaciones deben cargar su propio runtime de metadata (como `reflect-metadata`) antes de las clases decoradas. La carga transpila archivos individuales sin verificación de tipos; la metadata que requiere inferencia de tipos entre archivos no está disponible. La salida de build y la configuración de módulos no sobrescriben el loader de Jiti. Reinicia tras cambiar los alias de rutas.

- **Resolución real de AWS SSM o Mocks locales**: Consulta parámetros reales de AWS Parameter Store respetando tus perfiles de AWS SSO/CLI, o ejecuta offline con `--no-ssm` usando `ssm.env`, fallbacks o mocks automáticos.
- **Variable de entorno offline**: Inyecta automáticamente `IS_LOCAL=true` en `process.env` y en el contexto de ejecución de las funciones, permitiendo agregar condiciones locales en tu código fácilmente.
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

| Opción                                       | Alias            | Descripción                                                                     | Valor por Defecto                |
| -------------------------------------------- | ---------------- | ------------------------------------------------------------------------------- | -------------------------------- |
| [`--sam`](#--sam)                            | `-sam`           | 🧪 **Experimental:** Usa template de AWS SAM (`template.yaml` / `template.yml`) | `false`                          |
| [`--sls`](#--sls)                            | `-sls`           | Usa template de Serverless Framework (`serverless.yml`)                         | `true` (por defecto)             |
| [`--stage`](#--stage)                        | `-s`             | Stage de despliegue (`dev`, `staging`, `prod`)                                  | `develop`                        |
| [`--region`](#--region)                      | `-r`             | Región de AWS para SSM y contexto Lambda                                        | `us-east-1`                      |
| [`--port`](#--port)                          | `-p`             | Puerto HTTP para el servidor local                                              | `4000`                           |
| [`--base-path`](#--base-path)                | `-b`, `--prefix` | Prefijo de ruta base para todos los endpoints (ej. `/example-base-path`)        | `""` (raíz `/`)                  |
| [`--profile`](#--profile)                    |                  | Perfil de AWS CLI / AWS SSO                                                     | Variables de entorno del sistema |
| [`--param`](#--param)                        |                  | Parámetros clave=valor (se inyectan a `process.env`)                            | `{}`                             |
| [`--no-ssm`](#--no-ssm)                      |                  | Desactiva consultas a AWS SSM (usa `ssm.env`, fallbacks o mocks)                | `false` (resuelve SSM real)      |
| [`--scheduler`](#--scheduler)                |                  | Activa el endpoint Scheduler local para Lambdas y ejecuciones únicas            | `false`                          |
| [`--cf-value <clave=valor...>`](#--cf-value) |                  | Sobrescribe una referencia (por ejemplo `ExampleRole.Arn=arn:...`)              | Ninguno                          |
| [`--show-env`](#--show-env)                  |                  | Muestra los valores de variables sin enmascarar en consola                      | `false` (enmascara secretos)     |
| [`--debug`](#--debug)                        | `-d`             | Activa logs detallados del ciclo de vida con tiempos por etapa                  | `false`                          |
| [`--version`](#--version)                    | `-v`, `-V`       | Muestra la versión actual instalada                                             |                                  |

> [!WARNING]
> **El modo AWS SAM (`--sam`) es Experimental**
>
> La emulación para proyectos AWS SAM se encuentra actualmente en fase **beta / experimental**. Se admiten funciones intrínsecas esenciales (`Ref`, `Fn::GetAtt`, `Fn::Sub`) y referencias dinámicas a SSM (`{{resolve:ssm:...}}`). Las características avanzadas de CloudFormation (como `Mappings`, stacks anidados o funciones intrínsecas no implementadas) son aún parciales.

### Referencia de CLI

Uso detallado de cada opción. Los nombres de la tabla de arriba enlazan aquí.

#### `--sls`

Usa el template de Serverless Framework (`serverless.yml`). Es el valor por defecto; pásalo para anular un `--sam` previo.

```bash
freesls --sls -s dev
```

#### `--sam`

Usa un template de AWS SAM (`template.yaml` / `template.yml`). Experimental (ver la advertencia de arriba).

Para funciones con `Metadata.BuildMethod: esbuild`, FreeSLS ejecuta el archivo fuente indicado en `Metadata.BuildProperties.EntryPoints`, usando la función exportada indicada en `Handler`. Las rutas de entrada son relativas a `Properties.CodeUri`, usando como alternativa `Globals.Function.CodeUri` para funciones SAM y finalmente la carpeta del proyecto. Si hay varias entradas, exactamente un nombre de archivo (sin extensión) debe coincidir con el módulo de Handler; las listas ambiguas o sin coincidencias generan un error explícito. Sin entradas, se utiliza la resolución habitual `CodeUri` + `Handler`. FreeSLS ejecuta el código fuente directamente; no genera un bundle ni aplica otras opciones de compilación de esbuild.

```bash
freesls --sam -s dev
```

#### `--stage`

Alias `-s`. Stage de despliegue que alimenta `${sls:stage}`, `${opt:stage}`, `${self:provider.stage}` y el nombre local de las Lambdas (`${service}-${stage}-${key}`). Por defecto `develop`.

```bash
freesls -s staging
```

#### `--region`

Alias `-r`. Región de AWS para consultas SSM y contexto Lambda. Por defecto `us-east-1`.

```bash
freesls -r eu-west-1
```

#### `--port`

Alias `-p`. Puerto HTTP local. Por defecto `4000`.

```bash
freesls -p 3000
```

#### `--base-path`

Alias `-b` y `--prefix`. Prefijo que se añade a todas las rutas; útil cuando la ruta base desplegada difiere de la local. Por defecto ninguno.

```bash
freesls -b example-base-path
# POST http://localhost:4000/example-base-path/create-campaign
```

#### `--profile`

Perfil de AWS CLI / AWS SSO usado para las consultas SSM. Sin él se usan las credenciales del entorno. Los fallos de SSO indican `aws sso login --profile <perfil>`.

```bash
freesls --profile example-profile
```

#### `--param`

Inyecta pares `clave=valor` en `process.env` y los expone como `${param:clave}`. Repetible; se permiten valores vacíos (`--param empty=`).

```bash
freesls --param deploymentStage=develop --param empty=
```

#### `--no-ssm`

Desactiva las consultas a AWS SSM y resuelve `${ssm:/...}` desde `ssm.env`, fallbacks en YAML o mocks offline. Ver Modo Offline más abajo.

```bash
freesls --no-ssm
```

#### `--scheduler`

Activa el endpoint local de EventBridge Scheduler (una sola vez) e inyecta `AWS_ENDPOINT_URL_SCHEDULER`. Ver Scheduler local más abajo.

```bash
freesls --scheduler --no-ssm
```

#### `--cf-value`

Sobrescribe una referencia que FreeSLS no pueda derivar localmente, como `LogicalId.Atributo=valor` o `Outputs.OutputKey=valor`. Repetible y nunca consulta AWS.

```bash
freesls --scheduler --no-ssm --cf-value ExampleRole.Arn=arn:aws:iam::123456789012:role/team/example
```

#### `--show-env`

Muestra los valores de entorno sin enmascarar. Úsalo solo en local, ya que los secretos se ven en claro.

```bash
freesls --show-env
```

#### `--debug`

Alias `-d`. Logs detallados del ciclo de vida con tiempos por etapa (resolución de ruta, cola, Jiti, invocación, respuesta).

```bash
freesls --debug
```

#### `--version`

Alias `-v` y `-V`. Muestra la versión instalada de FreeSLS.

```bash
freesls --version
```

### Ejemplos comunes

```bash
# Consultar versión instalada
freesls -v

# Ejecutar Serverless Framework en stage 'dev' en el puerto 4000 usando perfil AWS SSO
freesls -s dev -p 4000 --profile mi-empresa-dev

# Ejecutar con un prefijo de ruta base (ej. http://localhost:4000/example-base-path/...)
freesls -s dev -p 4000 --base-path /example-base-path

# Ejecutar proyecto AWS SAM en stage 'dev'
freesls -sam -s dev -p 4000 --profile mi-empresa-dev

# Ejecutar completamente offline sin conexión a AWS
freesls -s local --no-ssm

# Scheduler local (los clientes SDK de la aplicación requieren credenciales de firma)
freesls -s local --scheduler --no-ssm

# Sobrescribir un atributo que CloudFormation no devuelve directamente
freesls --scheduler --no-ssm --cf-value ExampleRole.Arn=arn:aws:iam::123456789012:role/team/example

# Inyectar parámetros personalizados a process.env y ${param:...}
freesls -s dev --param domain=api.local --param deploymentStage=dev

# Ver valores de variables de entorno completas en la terminal sin enmascarar
freesls -s dev --show-env

# Ejecutar con logs de depuración para rastrear tiempos y cuellos de botella
freesls -s dev --debug
```

---

## Scheduler local

`--scheduler` emula EventBridge **Scheduler** para schedules puntuales `at(...)`. No emula el bus de eventos (`PutEvents`) ni las reglas `schedule: cron(...)`.

**Operaciones:** `CreateSchedule`, `GetSchedule`, `UpdateSchedule`, `ListSchedules`, `DeleteSchedule` (solo grupo `default`).

### Cómo funciona, paso a paso

1. FreeSLS registra cada función y le calcula un **ARN simulado**: `arn:<partición>:lambda:<región>:<cuenta>:function:<nombre>`, donde `<cuenta>` es `123456789012` y `<nombre>` es `name` o `${service}-${stage}-${key}`. Ejemplo: `arn:aws:lambda:us-east-1:123456789012:function:example-service-dev-example-function`.
2. Con `--scheduler`, levanta un servidor Scheduler local (loopback, puerto aleatorio) e inyecta `AWS_ENDPOINT_URL_SCHEDULER` **antes de cargar tus módulos**.
3. Tu handler llama `CreateSchedule` con `Target.Arn` = ese ARN simulado (normalmente desde una variable de entorno con `!Sub`/`!GetAtt`).
4. FreeSLS busca ese ARN en su registro y exige coincidencia exacta; si no, rechaza el destino.
5. A la hora indicada invoca la Lambda **local** con el `Input` (JSON). Nada sale a AWS.
6. `GetSchedule`/`DeleteSchedule` leen o eliminan el schedule en memoria.

> El ARN exacto aparece bajo cada endpoint como `└─ arn: ...`. Copia ese valor para `Target.Arn`.

### Ejemplo de principio a fin

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

Ejecuta y observa la consola:

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

### Reprogramar o cancelar

`UpdateSchedule` cambia un schedule existente en el sitio (mismo `Name`/ARN). Es un **reemplazo total**: reenvía todos los campos que quieras conservar, porque los opcionales omitidos vuelven a su valor por defecto (`ActionAfterCompletion` a `NONE`, `State` a `ENABLED`, etc.). Haz `GetSchedule` primero para leer los valores actuales.

```ts
await scheduler.send(
  new UpdateScheduleCommand({
    Name: "example-job",
    ScheduleExpression: "at(2030-02-01T10:00:00)", // nueva fecha
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

`DeleteSchedule` lo cancela:

```ts
await scheduler.send(new DeleteScheduleCommand({ Name: "example-job" }));
```

Ambas operaciones usan el `Name` del schedule (más `GroupName`, `default` en local). La consola imprime `[Scheduler] Schedule updated …` o `[Scheduler] Schedule cancelled …`.

### Listar schedules

`ListSchedules` devuelve los schedules de la sesión (grupo `default`), con `NamePrefix`, `State`, `MaxResults` (1–100) y `NextToken` opcionales para paginar:

```ts
const page = await scheduler.send(
  new ListSchedulesCommand({ NamePrefix: "campaign-", MaxResults: 50 }),
);
for (const summary of page.Schedules ?? []) {
  const detail = await scheduler.send(new GetScheduleCommand({ Name: summary.Name! }));
  // …
}
```

### Credenciales

El SDK de Scheduler firma cada petición, así que necesita credenciales de AWS. Si usas SSO, ejecuta `aws sso login --profile <perfil>` y listo; FreeSLS preserva tus credenciales existentes. En una app exclusivamente local sin credenciales, pon unas ficticias (`AWS_ACCESS_KEY_ID=local`, `AWS_SECRET_ACCESS_KEY=local`).

### Solución de problemas

- `403 AccessDeniedException: Cross-account pass role is not allowed` → la llamada llegó a **AWS real**, no al endpoint local. Arranca con `--scheduler` y usa un `@aws-sdk/client-scheduler` que respete `AWS_ENDPOINT_URL_SCHEDULER`, o define `endpoint: process.env.AWS_ENDPOINT_URL_SCHEDULER` explícitamente.
- `Target.Arn must exactly identify a Lambda registered in this project` → el ARN no coincide con ninguna función local; revisa el `name` o `${service}-${stage}-${key}`.
- `Local one-time schedules must be in the future` → el instante resuelto ya pasó; revisa la fecha y `ScheduleExpressionTimezone`.

### Límites

| Soportado    | Contrato                                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Operaciones  | `CreateSchedule`, `GetSchedule`, `UpdateSchedule`, `ListSchedules`, `DeleteSchedule`; solo grupo `default`                       |
| Fechas       | Fechas futuras `at(...)`; zonas IANA disponibles en ICU de Node, UTC por defecto                                                 |
| Destinos     | ARN exacto de Lambdas registradas del proyecto, incluidas funciones sin eventos HTTP                                             |
| Input        | JSON explícito válido de hasta 256 KB, entregado directamente al handler; usa `'{}'` para un evento vacío                        |
| Estado       | `ENABLED` / `DISABLED`; todavía sin operación de actualización                                                                   |
| Finalización | `NONE` conserva el registro; `DELETE` lo elimina tras entregar o agotar los intentos de entrega                                  |
| Reintentos   | 0–185 intentos adicionales de entrega (185 por defecto), edad del evento 60–86400 segundos (86400 por defecto)                   |
| Idempotencia | El mismo `ClientToken` y parámetros devuelve el ARN original; parámetros distintos generan conflicto; los tokens duran la sesión |

Las opciones no soportadas devuelven errores compatibles con el SDK y una guía: `cron`, `rate`, ventanas flexibles, grupos personalizados, aliases/versiones, Lambdas externas, destinos universales, DLQ, KMS, StartDate/EndDate y placeholders de contexto Scheduler. Las horas inexistentes o ambiguas por cambios de horario se rechazan explícitamente: usa una fecha inequívoca o UTC. No se emula la notificación predeterminada de AWS cuando se omite Input.

Los temporizadores apuntan al instante indicado, sin reproducir la ventana de precisión de 60 segundos de AWS. Las funciones se ejecutan secuencialmente junto a los handlers HTTP; los breakpoints o handlers que bloquean CPU pueden retrasarlas. Los reintentos corresponden a **aceptación de entrega**, no a errores del handler: la aceptación local tiene éxito para destinos registrados, por lo que las políticas de reintento se validan pero no repiten invocaciones. Se usa espera exponencial determinista (de 1 a 60 segundos), sin jitter AWS. Una invocación aceptada se ejecuta una vez: no se emula el servicio de reintentos/DLQ asíncronos de Lambda. Los errores muestran la identidad de la función sin contenido del error o payload; inspecciónalos con el depurador. Las programaciones se pierden al reiniciar, el apagado cancela futuras entregas y no garantiza drenar las invocaciones ya aceptadas.

FreeSLS imprime una línea `[Lambda][start] <functionName>` (verde) en stdout para cada invocación, tanto HTTP como disparada por el Scheduler, y cada petición HTTP termina con una línea resumen `[Lambda][end] MÉTODO /ruta estado (ms)` (magenta), incluidos los errores. Con `--scheduler`, además imprime logs de ciclo de vida: cada schedule recibido (nombre, ARN del destino, hora de disparo en UTC más la zona declarada, estado, acción al finalizar y configuración de reintentos), cuándo se dispara y cuándo se entrega, cancela o expira. Nunca se registra `Target.Input` ni credenciales.

### Resolver referencias a recursos

FreeSLS resuelve `Ref`, `Fn::GetAtt` y `Fn::Sub` en local: Lambdas registradas y roles IAM declarados en tu plantilla. Ejemplo:

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

Los IDs lógicos generados de Serverless convierten `-` en `Dash` y `_` en `Underscore`, ponen la primera letra en mayúscula y añaden `LambdaFunction`. El nombre utiliza `name` o `${service}-${stage}-${key}`. SAM utiliza `FunctionName` o `${service}-${logicalId}`. Los ARN locales usan `--region`, la cuenta simulada `123456789012` y la partición correspondiente (`aws`, `aws-cn`, `aws-us-gov`); nunca consultan AWS. No se despliegan recursos.

En SAM, el nombre local del servicio proviene de `Description` de la plantilla (normalizado y limitado a 30 caracteres), o del nombre de la carpeta del proyecto si no existe. Los nombres de Lambda autogenerados que superan 64 caracteres o contienen caracteres inválidos se normalizan y reciben un sufijo hash estable dentro del límite de 64 caracteres. Los valores explícitos de `FunctionName` se validan sin reescribirlos. `Ref`, `GetAtt` y `Sub` utilizan la misma identidad local. Estos nombres internos no se añaden a las rutas HTTP; solo `--base-path` / `--prefix` añade un prefijo a la URL.

#### Cuando una referencia no se puede resolver: `--cf-value`

Si una referencia apunta a algo **no** declarado en tu plantilla (por ejemplo un rol de otro stack), FreeSLS se detiene con un error accionable. Da el valor a mano:

```bash
freesls --scheduler --no-ssm --cf-value ExampleRole.Arn=arn:aws:iam::123456789012:role/example-scheduler
```

- `LogicalId.Atributo=valor` para `!GetAtt` (incluye el path real del rol al sobrescribir un ARN).
- `Outputs.OutputKey=valor` para outputs de stack.
- Repetible, tiene prioridad sobre la resolución local y **nunca consulta AWS**. Aplica a `!Ref`/`!GetAtt`, no a cadenas `!Sub`.

`--scheduler` o `--cf-value` también hacen que `Ref`/`GetAtt` no resueltos sean errores estrictos; sin ellos, el modo HTTP tradicional de Serverless conserva valores vacíos por compatibilidad. Los mappings `Fn::Sub` no soportados siempre fallan explícitamente.

## 🔒 Modo Offline y Mocks de SSM (`--no-ssm`)

Cuando ejecutas con `--no-ssm`, FreeSLS **no consulta AWS SSM** y resuelve `${ssm:/...}` siguiendo este orden de prioridad. Las llamadas SDK que hagan tus handlers son independientes:

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

### Límites de Ejecución Local

- Las invocaciones se ejecutan secuencialmente en el mismo proceso de Node.js para que las variables de entorno no se solapen. La carga del handler ocurre dentro de ese ámbito y los mapas de fuentes (source maps) permanecen activos para depuración.
- Los módulos transformados comparten una caché normalizada por nombre de archivo dentro de cada invocación, incluidos los imports circulares a través de alias y rutas relativas en Windows. La caché se descarta entre invocaciones para recargar los cambios de código y los entornos de ruta. Los ciclos que usan una exportación antes de que se inicialice aún pueden fallar; FreeSLS no reproduce la semántica de empaquetado (bundling) de esbuild ni ejecuta los plugins de build de Serverless.
- Los módulos nativos de JavaScript y sus dependencias pueden retener las variables de entorno de su primera importación debido a la caché de módulos. Las funciones que comparten dichos módulos no disponen de entornos de ejecución aislados e independientes. Reinicia FreeSLS tras modificar la configuración.
- El reloj de 30 segundos de tiempo restante del contexto es informativo y no un límite forzado. Un handler que nunca termine bloqueará las siguientes invocaciones. El trabajo asíncrono en segundo plano no queda aislado y `callbackWaitsForEmptyEventLoop` no fuerza el vaciado del bucle de eventos.
- Los handlers pueden finalizar mediante un callback, un método de finalización de contexto, una promesa devuelta o un resultado síncrono. Un retorno síncrono `undefined` espera a que el callback o contexto finalicen; la primera finalización en ocurrir determina la respuesta.
- Las rutas REST usan payload v1. Las rutas HTTP API usan por defecto v2, con soporte para anulaciones mediante `provider.httpApi.payload` en Serverless o `PayloadFormatVersion` en eventos SAM. La entrada binaria se infiere del tipo de contenido (Content-Type) y no de la configuración de tipos binarios de API Gateway en AWS.
- El CORS local permite automáticamente cualquier origen con credenciales (incluido `fetch` con `credentials: "include"`), los headers solicitados y los métodos HTTP soportados. Las peticiones preflight se resuelven localmente. Esta política permisiva de desarrollo reemplaza los headers CORS del handler, expone los headers personalizados devueltos y diferencia las respuestas por origen y headers solicitados. Las peticiones sin origen reciben `*` sin credenciales. No emula las restricciones CORS de API Gateway desplegado.
- Las referencias de CloudFormation se resuelven en local. Los valores compatibles de `Ref`, `Fn::GetAtt` y `Fn::Sub` se resuelven desde tu plantilla (o con `--cf-value` explícito); los objetos intrínsecos de entorno no soportados generan errores explícitos. Los identificadores de recursos pueden ser simulados (mocks) y no los identificadores desplegados en AWS.
- `--no-ssm` desactiva las consultas de FreeSLS a SSM, no las llamadas a AWS que hagan tus propios handlers. Los valores de variables de entorno se enmascaran por defecto, incluidos aquellos que comiencen con `mock-`.

Si deseas clonar y contribuir a **FreeSLS**:

```bash
git clone https://github.com/qwery2052/freesls.git
cd freesls

# Instalar dependencias
npm install

# Compilar código TypeScript
npm run build

# Compilar y ejecutar pruebas de regresión locales (no requiere credenciales de AWS)
npm test

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
