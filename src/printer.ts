import pc from "picocolors";
import type { RouteDefinition } from "./types.js";

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

export function printBanner(
  serviceName: string,
  port: number,
  stage: string,
  framework: "serverless" | "sam" = "serverless",
) {
  const frameworkBadge =
    framework === "sam"
      ? pc.bold(pc.bgYellow(pc.black(" AWS SAM ")))
      : pc.bold(pc.bgMagenta(pc.white(" SLS ")));

  const bannerArt = `
   ${pc.magenta("/\\_/\\")}   ${pc.bold(pc.cyan("FreeSLS"))} ${pc.dim("v0.2.1")}  ${frameworkBadge}
  ${pc.magenta("( o.o )")}  ${pc.dim("Offline API Gateway & Lambda Runner")}
   ${pc.magenta("> ^ <")}   ${pc.green("●")} Service: ${pc.bold(serviceName)} ${pc.dim(`[stage: ${stage}]`)}
  `;

  console.log(bannerArt);
  console.log(pc.dim("─".repeat(60)));
  console.log(
    ` ${pc.bold("Local Endpoint:")} ${pc.underline(pc.cyan(`http://localhost:${port}`))}`,
  );
  console.log(pc.dim("─".repeat(60)));
}

function maskSensitiveValue(valueToMask: string): string {
  if (!valueToMask) return "";
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

export function printRoutes(routes: RouteDefinition[], port: number) {
  console.log(pc.dim("─".repeat(60)));
  console.log(`\n ${pc.bold("⚡ Registered Endpoints:")}\n`);

  if (routes.length === 0) {
    console.log(pc.yellow("  ⚠️  No HTTP/HTTP API events found in this service.\n"));
    return;
  }

  for (const route of routes) {
    const methodBadge = formatMethod(route.method);
    const endpointUrl = pc.white(`http://localhost:${port}${pc.bold(route.path)}`);
    const handlerDetail =
      pc.dim(`└─ handler: `) + pc.yellow(route.handler) + pc.dim(` (${route.functionName})`);

    console.log(`  ${methodBadge}  ${endpointUrl}`);
    console.log(`     ${handlerDetail}\n`);
  }

  console.log(pc.dim("─".repeat(60)));
  console.log(pc.italic(pc.dim("  Ready for requests... (Ctrl+C to exit)\n")));
}
