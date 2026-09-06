import pc from "picocolors";
import type { RouteDefinition } from "./types.js";

export function formatMethod(method: string): string {
  const m = method.toUpperCase();
  switch (m) {
    case "GET":
      return pc.bold(pc.bgGreen(pc.black(" GET ")));
    case "POST":
      return pc.bold(pc.bgBlue(pc.white(" POST ")));
    case "PUT":
      return pc.bold(pc.bgYellow(pc.black(" PUT ")));
    case "PATCH":
      return pc.bold(pc.bgMagenta(pc.white(" PATCH ")));
    case "DELETE":
      return pc.bold(pc.bgRed(pc.white(" DELETE ")));
    default:
      return pc.bold(pc.bgWhite(pc.black(` ${m} `)));
  }
}

export function printBanner(serviceName: string, port: number, stage: string) {
  const catArt = `
   ${pc.magenta("/\\_/\\")}   ${pc.bold(pc.cyan("FreeSLS"))} ${pc.dim("v0.1.0")}
  ${pc.magenta("( o.o )")}  ${pc.dim("Offline API Gateway & Lambda Runner")}
   ${pc.magenta("> ^ <")}   ${pc.green("●")} Service: ${pc.bold(serviceName)} ${pc.dim(`[stage: ${stage}]`)}
  `;

  console.log(catArt);
  console.log(pc.dim("─".repeat(60)));
  console.log(
    ` ${pc.bold("Local Endpoint:")} ${pc.underline(pc.cyan(`http://localhost:${port}`))}`,
  );
  console.log(pc.dim("─".repeat(60)));
}

// Imprime el resumen de variables de entorno resueltas
export function printEnvironmentSummary(env: Record<string, string>, showValues = false) {
  const keys = Object.keys(env);
  console.log(
    `\n ${pc.magenta("🐾")} ${pc.bold("Environment Variables Loaded:")} ${pc.dim(`(${keys.length} resueltas)`)}`,
  );

  if (!showValues) {
    console.log(
      pc.dim("   (Usa el flag --show-env para ver los valores completos sin enmascarar)\n"),
    );
  } else {
    console.log(pc.yellow("   ⚠️  Mostrando valores en texto plano (--show-env activo)\n"));
  }

  if (keys.length === 0) {
    console.log(pc.dim("   No se definieron variables de entorno globales."));
    return;
  }

  for (const key of keys) {
    const rawVal = env[key] ?? "";
    const isMock = rawVal.startsWith("mock-");

    let displayVal = rawVal;

    // Si NO se activó showValues, enmascaramos strings que contengan palabras sensibles
    if (!showValues) {
      const isSecret = /KEY|SECRET|PASSWORD|TOKEN|AUTH/i.test(key);
      if (isSecret && displayVal.length > 8 && !isMock) {
        displayVal = `${displayVal.slice(0, 4)}...${displayVal.slice(-4)}`;
      }
    }

    const statusBadge = isMock ? pc.yellow("⚠️  mocked") : pc.green("✅ loaded");

    console.log(
      `   ${statusBadge}  ${pc.bold(pc.white(key.padEnd(28)))} ${pc.dim("=")} ${pc.cyan(displayVal)}`,
    );
  }

  console.log();
}
export function printRoutes(routes: RouteDefinition[], port: number) {
  console.log(pc.dim("─".repeat(60)));
  console.log(`\n ${pc.bold("⚡ Endpoints Registrados:")}\n`);

  if (routes.length === 0) {
    console.log(pc.yellow("  ⚠️  No se encontraron eventos HTTP/HTTP-API en este servicio.\n"));
    return;
  }

  for (const route of routes) {
    const badge = formatMethod(route.method);
    const url = pc.white(`http://localhost:${port}${pc.bold(route.path)}`);
    const handlerDetail =
      pc.dim(`└─ handler: `) + pc.yellow(route.handler) + pc.dim(` (${route.functionName})`);

    console.log(`  ${badge}  ${url}`);
    console.log(`     ${handlerDetail}\n`);
  }

  console.log(pc.dim("─".repeat(60)));
  console.log(pc.italic(pc.dim("  Listo para recibir peticiones... (Ctrl+C para salir)\n")));
}
