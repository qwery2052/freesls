import pc from "picocolors";
import type { RouteDefinition } from "./types.js";
import type { SchedulerEvent } from "./scheduler.js";

const CAT_EMOJIS = ["🐱", "😺", "😸", "😻", "😼", "🙀", "🐈", "🐾"] as const;

const METHOD_BADGE_FORMATTERS: Record<string, (methodText: string) => string> = {
  GET: methodText => pc.bold(pc.bgGreen(pc.black(methodText))),
  POST: methodText => pc.bold(pc.bgBlue(pc.white(methodText))),
  PUT: methodText => pc.bold(pc.bgYellow(pc.black(methodText))),
  PATCH: methodText => pc.bold(pc.bgMagenta(pc.white(methodText))),
  DELETE: methodText => pc.bold(pc.bgRed(pc.white(methodText))),
};

export function formatMethod(httpMethod: string): string {
  const normalizedMethod = httpMethod.toUpperCase();
  const formatBadge =
    METHOD_BADGE_FORMATTERS[normalizedMethod] ??
    (methodText => pc.bold(pc.bgWhite(pc.black(methodText))));

  return formatBadge(` ${normalizedMethod} `);
}

export const CAT_COLOR_NAMES = [
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "gray",
  "redBright",
  "greenBright",
  "yellowBright",
  "blueBright",
  "magentaBright",
  "cyanBright",
  "whiteBright",
] as const;

export type CatColor = (typeof CAT_COLOR_NAMES)[number];

/** Low-probability easter egg: every cat line gets its own color. */
export const SHINY_CHANCE = 1 / 200;

export function selectCatColors(
  random: () => number = Math.random,
  shinyChance: number = SHINY_CHANCE,
): { shiny: boolean; colors: [CatColor, CatColor, CatColor] } {
  const indexBelow = (bound: number) => Math.min(bound - 1, Math.floor(random() * bound));
  const shiny = random() < shinyChance;
  if (!shiny) {
    const color = CAT_COLOR_NAMES[indexBelow(CAT_COLOR_NAMES.length)];
    return { shiny, colors: [color, color, color] };
  }
  const pool = [...CAT_COLOR_NAMES];
  const colors = Array.from({ length: 3 }, () => pool.splice(indexBelow(pool.length), 1)[0]);
  return { shiny, colors: colors as [CatColor, CatColor, CatColor] };
}

export function printBanner(
  serviceName: string,
  port: number,
  stage: string,
  framework: "serverless" | "sam" = "serverless",
  basePath = "",
  debug = false,
) {
  const frameworkBadge =
    framework === "sam"
      ? pc.bold(pc.bgYellow(pc.black(" AWS SAM ")))
      : pc.bold(pc.bgMagenta(pc.white(" SLS ")));
  const debugBadge = debug ? `  ${pc.bold(pc.bgGreen(pc.black(" DEBUG ")))}` : "";

  const { shiny, colors } = selectCatColors();
  const shinyBadge = shiny ? `  ${pc.bold(pc.bgYellow(pc.black(" ✨ SHINY ")))}` : "";

  const bannerArt = `
   ${pc[colors[0]]("/\\_/\\")}   ${pc.bold(pc.cyan("FreeSLS"))} ${pc.dim("v0.4.0-beta.6")}  ${frameworkBadge}${debugBadge}${shinyBadge}
  ${pc[colors[1]]("( o.o )")}  ${pc.dim("Offline API Gateway & Lambda Runner")}
   ${pc[colors[2]]("> ^ <")}   ${pc.green("●")} Service: ${pc.bold(serviceName)} ${pc.dim(`[stage: ${stage}]`)}
  `;

  console.log(bannerArt);
  console.log(pc.dim("─".repeat(60)));
  const cleanBase = basePath
    ? (basePath.startsWith("/") ? basePath : `/${basePath}`).replace(/\/+$/, "")
    : "";
  console.log(
    ` ${pc.bold("Local Endpoint:")} ${pc.underline(pc.cyan(`http://localhost:${port}${cleanBase}`))}`,
  );
  console.log(pc.dim("─".repeat(60)));
}

export function logDebug(stage: string, message: string, elapsedMs?: number, requestId?: string) {
  const timestamp = new Date().toISOString().slice(11, 23);
  const reqTag = requestId ? pc.dim(`[${requestId}] `) : "";
  const timing = elapsedMs !== undefined ? pc.green(` (+${elapsedMs}ms)`) : "";
  const stageTag = pc.bold(pc.green(`[${stage}]`));
  console.log(
    `  ${pc.bold(pc.green("[DEBUG]"))} ${pc.dim(timestamp)} ${reqTag}${stageTag} ${message}${timing}`,
  );
}

export function printDebugHeaders(headers: Record<string, string>, requestId?: string) {
  const reqTag = requestId ? pc.dim(` [${requestId}]`) : "";
  const headerEntries = Object.entries(headers);
  const borderLength = 66;

  console.log(
    `\n  ${pc.bold(pc.magenta("/////////////////////"))} ${pc.magenta("🐾")} ${pc.bold(pc.green("/\\_/\\"))} ${pc.bold(pc.cyan("HEADERS"))}${reqTag} ${pc.bold(pc.magenta("/".repeat(Math.max(4, borderLength - 36 - (requestId ? requestId.length + 3 : 0)))))}`,
  );

  if (headerEntries.length === 0) {
    console.log(`     ${pc.dim("(no headers received)")}`);
  } else {
    for (const [key, value] of headerEntries) {
      console.log(
        `   ${pc.magenta("🐾")} ${pc.bold(pc.cyan(key.padEnd(26)))} ${pc.dim("=")} ${pc.white(value)}`,
      );
    }
  }

  console.log(
    `  ${pc.bold(pc.magenta("/".repeat(borderLength - 14)))} ${pc.bold(pc.green("(=^･ω･^=)///"))}\n`,
  );
}

function maskSensitiveValue(valueToMask: string): string {
  if (!valueToMask) return "";
  if (valueToMask === "true" || valueToMask === "false") return valueToMask;
  if (valueToMask.length <= 4) return "*".repeat(valueToMask.length);
  if (valueToMask.length <= 8) return `${valueToMask.slice(0, 2)}...${valueToMask.slice(-2)}`;
  return `${valueToMask.slice(0, 4)}...${valueToMask.slice(-4)}`;
}

export function printEnvironmentSummary(
  environmentVariables: Record<string, string>,
  showValues = false,
) {
  const environmentKeys = Object.keys(environmentVariables);
  console.log(
    `\n ${pc.magenta("🐾")} ${pc.bold("Environment Variables Loaded:")} ${pc.dim(`(${environmentKeys.length} resolved)`)}`,
  );

  if (!showValues) {
    console.log(pc.dim("   (Use --show-env to display full, unmasked values)\n"));
  } else {
    console.log(pc.yellow("   ⚠️  Displaying plaintext values (--show-env enabled)\n"));
  }

  if (environmentKeys.length === 0) {
    console.log(pc.dim("   No global environment variables defined."));
    return;
  }

  for (const environmentKey of environmentKeys) {
    const rawValue = environmentVariables[environmentKey] ?? "";
    const isMockedValue = rawValue.startsWith("mock-");

    let displayValue = rawValue;
    if (!showValues) {
      displayValue = maskSensitiveValue(displayValue);
    }

    const statusBadge = isMockedValue ? pc.yellow("⚠️  mocked") : pc.green("✅ loaded");

    console.log(
      `   ${statusBadge}  ${pc.bold(pc.white(environmentKey.padEnd(28)))} ${pc.dim("=")} ${pc.cyan(displayValue)}`,
    );
  }

  console.log();
}

export function printRoutes(routes: RouteDefinition[], port: number, basePath = "") {
  console.log(pc.dim("─".repeat(60)));
  console.log(`\n ${pc.bold("⚡ Registered Endpoints:")}\n`);

  if (routes.length === 0) {
    console.log(pc.yellow("  ⚠️  No HTTP/HTTP API events found in this service.\n"));
    return;
  }

  const cleanBase = basePath
    ? (basePath.startsWith("/") ? basePath : `/${basePath}`).replace(/\/+$/, "")
    : "";

  for (const route of routes) {
    const methodBadge = formatMethod(route.method);
    const routePath = route.path.startsWith("/") ? route.path : `/${route.path}`;
    const fullPath = `${cleanBase}${routePath === "/" && cleanBase ? "" : routePath}`;
    const endpointUrl = pc.white(`http://localhost:${port}${pc.bold(fullPath)}`);
    const handlerDetail =
      pc.dim(`└─ handler: `) + pc.yellow(route.handler) + pc.dim(` (${route.functionName})`);

    console.log(`  ${methodBadge}  ${endpointUrl}`);
    console.log(`     ${handlerDetail}`);
    if (route.arn) console.log(`     ${pc.dim("└─ arn: ")}${pc.cyan(route.arn)}`);
    console.log();
  }

  console.log(pc.dim("─".repeat(60)));
  console.log(pc.italic(pc.dim("  Ready for requests... (Ctrl+C to exit)\n")));
}

function randomCatFace(): string {
  return CAT_EMOJIS[Math.floor(Math.random() * CAT_EMOJIS.length)];
}

function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return "unknown";
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Print Scheduler lifecycle events. Never includes Target.Input or credentials.
 */
export function printSchedulerEvent(
  event: SchedulerEvent,
  resolveTarget?: (arn: string) => string,
) {
  const face = pc.magenta(randomCatFace());
  const targetName = resolveTarget ? resolveTarget(event.target) : event.target;

  switch (event.type) {
    case "received": {
      const dueText = event.due
        ? `${new Date(event.due).toISOString()} (${event.timezone ?? "UTC"})`
        : "unknown";
      const relative = event.due ? pc.dim(` · in ${formatDuration(event.due - Date.now())}`) : "";
      console.log(
        `${face} ${pc.bold(pc.cyan("[Scheduler]"))} Schedule received ${pc.bold(event.name)}`,
      );
      console.log(`   ${pc.dim("├─ target:")} ${pc.yellow(targetName)}`);
      console.log(`   ${pc.dim("│  arn:")}    ${pc.dim(event.target)}`);
      console.log(`   ${pc.dim("├─ fires: ")} ${pc.white(dueText)}${relative}`);
      console.log(
        `   ${pc.dim("└─ actions:")} ${pc.white(event.state ?? "ENABLED")} ${pc.dim("· after run")} ${pc.white(event.action ?? "NONE")} ${pc.dim("· retries")} ${pc.white(String(event.retries ?? 0))} ${pc.dim("· max age")} ${pc.white(`${event.maxAgeSeconds ?? 0}s`)}`,
      );
      break;
    }
    case "firing":
      console.log(
        `${face} ${pc.bold(pc.cyan("[Scheduler]"))} Firing ${pc.bold(event.name)} ${pc.dim("→")} ${pc.yellow(targetName)}`,
      );
      break;
    case "delivered":
      console.log(
        `${face} ${pc.bold(pc.green("[Scheduler]"))} Delivered ${pc.bold(event.name)} ${pc.dim("· schedule processed")}`,
      );
      break;
    case "cancelled":
      console.log(
        `${face} ${pc.bold(pc.yellow("[Scheduler]"))} Schedule cancelled ${pc.bold(event.name)}`,
      );
      break;
    case "expired":
      console.log(
        `${face} ${pc.bold(pc.red("[Scheduler]"))} Delivery expired ${pc.bold(event.name)}`,
      );
      break;
    case "failed":
      console.log(
        `${face} ${pc.bold(pc.red("[Scheduler]"))} Delivery failed (retries exhausted) ${pc.bold(event.name)}`,
      );
      break;
  }
}

function statusColor(statusCode: number) {
  const statusText = `${statusCode}`;
  return statusCode >= 500
    ? pc.red(statusText)
    : statusCode >= 400
      ? pc.yellow(statusText)
      : pc.green(statusText);
}

/**
 * Print a Lambda invocation start (HTTP route or Scheduler-triggered).
 */
export function printLambdaStart(functionName: string) {
  const face = pc.magenta(randomCatFace());
  console.log(
    `${face} ${pc.bold(pc.magenta("[Lambda]"))}${pc.bold(pc.green("[start]"))} ${pc.bold(functionName)}`,
  );
}

/**
 * Print a Lambda invocation end (HTTP response summary), including errors.
 */
export function printLambdaEnd(
  method: string,
  path: string,
  statusCode: number,
  durationMs: number,
) {
  const face = pc.magenta(randomCatFace());
  console.log(
    `${face} ${pc.bold(pc.magenta("[Lambda]"))}${pc.bold(pc.magenta("[end]"))} ${formatMethod(method)} ${pc.white(path)} ${statusColor(statusCode)} ${pc.dim(`(${durationMs}ms)`)}`,
  );
}

export function printSsmResolutionError(
  missingParameters: string[],
  _context: { profile?: string; region?: string } = {},
) {
  const countText = missingParameters.length > 1 ? ` (${missingParameters.length})` : "";
  console.log(
    `\n ${pc.magenta("🐾 (x.x)")} ${pc.bold(pc.red(`Missing SSM Parameters${countText}:`))}`,
  );

  for (const param of missingParameters) {
    console.log(`   ${pc.red("✖")} ${pc.bold(pc.yellow(param))}`);
    if (param.includes(":")) {
      const selector = param.slice(param.indexOf(":") + 1);
      if (/^\d+$/.test(selector) && Number(selector) > 50) {
        console.log(
          pc.dim(`     └─ `) +
            pc.cyan(`⚠️  ':${selector}'`) +
            pc.dim(` is treated as an SSM version, not a port or default value.`),
        );
      }
    }
  }

  console.log(
    `\n   ${pc.cyan("💡 Tip:")} ${pc.dim("Add to")} ${pc.bold(pc.white("ssm.env"))} ${pc.dim("or run with")} ${pc.cyan("--no-ssm")} ${pc.dim("to test offline")}\n`,
  );
}
