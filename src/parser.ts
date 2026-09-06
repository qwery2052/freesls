import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { ServerlessConfig, RouteDefinition } from "./types.js";
import { SSMResolver } from "./ssm.js";
import { extractSSMPaths, resolveVariables, type ResolveContext } from "./resolver.js";

const cfnTags = ["!Ref", "!GetAtt", "!Sub", "!Join", "!Select", "!Split", "!ImportValue"];
const customTags = cfnTags.map(tag => ({
  tag,
  resolve: (val: unknown) => (typeof val === "string" ? val : JSON.stringify(val)),
}));

export interface ParserOptions {
  stage: string;
  region: string;
  params: Record<string, string>;
  resolveSSM?: boolean;
}

export async function loadServerlessConfig(
  workingDir = process.cwd(),
  options: ParserOptions,
): Promise<{
  config: ServerlessConfig;
  routes: RouteDefinition[];
  globalEnv: Record<string, string>;
}> {
  const ymlPath = path.resolve(workingDir, "serverless.yml");
  if (!fs.existsSync(ymlPath)) {
    throw new Error(`No se encontró serverless.yml en ${workingDir}`);
  }

  const rawContent = fs.readFileSync(ymlPath, "utf-8");
  const initialConfig = parse(rawContent, { customTags }) as any;

  const serviceName =
    typeof initialConfig.service === "object"
      ? initialConfig.service.name
      : String(initialConfig.service || "");

  const ctx: ResolveContext = {
    stage: options.stage,
    region: options.region,
    serviceName,
    params: options.params,
    rawConfig: initialConfig,
  };

  // PASADA 1: Resuelve las variables internas (${self:service}, ${self:provider.stage}, etc.)
  // dejando las rutas SSM planas (ej: ${ssm:/api-bot-secop/develop/USERS_TABLE})
  const pass1 = resolveVariables(rawContent, ctx, false);

  // PASADA 2: Extraer rutas SSM limpias y consultar AWS
  let ssmValues = new Map<string, string>();
  if (options.resolveSSM) {
    const ssmPaths = extractSSMPaths(pass1);
    const resolver = new SSMResolver(options.region);
    ssmValues = await resolver.resolveAll(ssmPaths);
  } else {
    const ssmPaths = extractSSMPaths(pass1);
    for (const p of ssmPaths) {
      const varName = p.split("/").pop() || "value";
      ssmValues.set(p, `mock-${varName.toLowerCase()}`);
    }
  }

  ctx.ssmValues = ssmValues;

  // PASADA 3: Inyectar valores de SSM y resolver fallbacks
  const finalConfig = parse(pass1, { customTags }) as ServerlessConfig;

  const globalEnv: Record<string, string> = {};
  if (finalConfig.provider?.environment) {
    for (const [k, v] of Object.entries(finalConfig.provider.environment)) {
      const resolved = resolveVariables(String(v), ctx, true);
      globalEnv[k] = resolved;
      process.env[k] = resolved;
    }
  }

  const routes: RouteDefinition[] = [];
  const functions = finalConfig.functions || {};

  for (const [fnName, fnConfig] of Object.entries<any>(functions)) {
    if (!fnConfig.events || !Array.isArray(fnConfig.events)) continue;

    for (const event of fnConfig.events) {
      const http = event.http ?? event.httpApi;
      if (!http) continue;

      const method = (
        typeof http === "string" ? http.split(" ")[0] : http.method || "ANY"
      ).toUpperCase();
      let routePath = typeof http === "string" ? http.split(" ")[1] : http.path || "/";

      if (!routePath.startsWith("/")) routePath = `/${routePath}`;

      const fnEnv: Record<string, string> = { ...globalEnv };
      if (fnConfig.environment) {
        for (const [k, v] of Object.entries(fnConfig.environment)) {
          const resolved = resolveVariables(String(v), ctx, true);
          fnEnv[k] = resolved;
        }
      }

      routes.push({
        functionName: fnName,
        method,
        path: routePath,
        handler: fnConfig.handler,
        environment: fnEnv,
      });
    }
  }

  return { config: finalConfig, routes, globalEnv };
}
