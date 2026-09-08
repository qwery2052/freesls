import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import pc from "picocolors";
import type { ServerlessConfig, RouteDefinition, LoadResult } from "./types.js";
import { SSMResolver } from "./ssm.js";
import { extractSSMPaths, resolveVariables, type ResolveContext } from "./resolver.js";

const cloudFormationTags = [
  "!Ref",
  "!GetAtt",
  "!Sub",
  "!Join",
  "!Select",
  "!Split",
  "!ImportValue",
];

const customTags = cloudFormationTags.map(tagName => ({
  tag: tagName,
  resolve: (resolvedValue: unknown) =>
    typeof resolvedValue === "string" ? resolvedValue : JSON.stringify(resolvedValue),
}));

export const parseYaml = <ParsedResult = any>(yamlContent: string): ParsedResult =>
  parse(yamlContent, { customTags });

export interface ParserOptions {
  stage: string;
  region: string;
  params: Record<string, string>;
  resolveSSM?: boolean;
}

/**
 * Resuelve un diccionario de variables de entorno usando el contexto.
 */
export function resolveEnvironmentVariables(
  environmentVariables: Record<string, unknown> | undefined,
  context: ResolveContext,
  baseEnvironment: Record<string, string> = {},
): Record<string, string> {
  const resolvedEnvironment: Record<string, string> = { ...baseEnvironment };
  if (!environmentVariables) return resolvedEnvironment;

  for (const [variableKey, variableValue] of Object.entries(environmentVariables)) {
    resolvedEnvironment[variableKey] = resolveVariables(String(variableValue), context, true);
  }
  return resolvedEnvironment;
}

/**
 * Carga valores de mock desde el archivo ssm.env ubicado en la raíz del proyecto.
 */
function loadSSMEnvFile(workingDirectory: string): Map<string, string> {
  const ssmEnvFilePath = path.resolve(workingDirectory, "ssm.env");
  const ssmValuesMap = new Map<string, string>();

  if (!fs.existsSync(ssmEnvFilePath)) {
    return ssmValuesMap;
  }

  const ssmEnvContent = fs.readFileSync(ssmEnvFilePath, "utf-8");
  const fileLines = ssmEnvContent.split(/\r?\n/);

  for (const rawLine of fileLines) {
    const trimmedLine = rawLine.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) continue;

    const assignmentIndex = trimmedLine.indexOf("=");
    if (assignmentIndex === -1) continue;

    const parameterKey = trimmedLine.slice(0, assignmentIndex).trim();
    const parameterValue = trimmedLine.slice(assignmentIndex + 1).trim();

    if (parameterKey) {
      ssmValuesMap.set(parameterKey, parameterValue);
      if (parameterKey.startsWith("/")) {
        ssmValuesMap.set(parameterKey.slice(1), parameterValue);
      } else {
        ssmValuesMap.set(`/${parameterKey}`, parameterValue);
      }
    }
  }

  return ssmValuesMap;
}

/**
 * Resuelve valores SSM consultando AWS o cargando mocks locales desde ssm.env.
 */
export async function resolveSSMValues(
  parameterPaths: string[],
  region: string,
  resolveSSM = false,
  workingDirectory = process.cwd(),
): Promise<Map<string, string>> {
  if (resolveSSM) {
    const ssmResolver = new SSMResolver(region);
    return ssmResolver.resolveAll(parameterPaths);
  }

  const ssmMocksFromEnv = loadSSMEnvFile(workingDirectory);
  if (ssmMocksFromEnv.size > 0) {
    console.log(pc.dim(`🐾 SSM offline: cargados mocks desde ssm.env`));
  } else {
    console.log(pc.dim(`🐾 SSM offline: operando con fallbacks y mocks locales`));
  }

  return ssmMocksFromEnv;
}

/**
 * Normaliza la definición de un evento HTTP/HTTP API.
 */
function parseHttpEvent(httpEventConfig: unknown): { method: string; path: string } | null {
  if (!httpEventConfig) return null;

  let httpMethod = "ANY";
  let routePath = "/";

  if (typeof httpEventConfig === "string") {
    const stringParts = httpEventConfig.trim().split(/\s+/);
    httpMethod = stringParts[0] || "ANY";
    routePath = stringParts[1] || "/";
  } else if (typeof httpEventConfig === "object" && httpEventConfig !== null) {
    const objectConfig = httpEventConfig as { method?: string; path?: string };
    httpMethod = objectConfig.method || "ANY";
    routePath = objectConfig.path || "/";
  }

  return {
    method: httpMethod.toUpperCase(),
    path: routePath.startsWith("/") ? routePath : `/${routePath}`,
  };
}

/**
 * Extrae las definiciones de rutas a partir de la configuración de funciones.
 */
function extractRoutes(
  functionsConfig: Record<string, any> = {},
  globalEnvironment: Record<string, string>,
  context: ResolveContext,
): RouteDefinition[] {
  const routeDefinitions: RouteDefinition[] = [];

  for (const [functionName, functionConfig] of Object.entries(functionsConfig)) {
    if (!Array.isArray(functionConfig?.events)) continue;

    const functionEnvironment = resolveEnvironmentVariables(
      functionConfig.environment,
      context,
      globalEnvironment,
    );

    for (const eventConfig of functionConfig.events) {
      const parsedHttp = parseHttpEvent(eventConfig?.http ?? eventConfig?.httpApi);
      if (!parsedHttp) continue;

      routeDefinitions.push({
        functionName,
        method: parsedHttp.method,
        path: parsedHttp.path,
        handler: functionConfig.handler,
        environment: functionEnvironment,
      });
    }
  }

  return routeDefinitions;
}

export async function loadServerlessConfig(
  workingDirectory = process.cwd(),
  options: ParserOptions,
): Promise<LoadResult> {
  const serverlessYamlPath = path.resolve(workingDirectory, "serverless.yml");
  if (!fs.existsSync(serverlessYamlPath)) {
    throw new Error(`No se encontró serverless.yml en ${workingDirectory}`);
  }

  const rawYamlContent = fs.readFileSync(serverlessYamlPath, "utf-8");
  const initialConfig = parseYaml<any>(rawYamlContent);

  const serviceName =
    typeof initialConfig.service === "object"
      ? initialConfig.service.name
      : String(initialConfig.service || "");

  const context: ResolveContext = {
    stage: options.stage,
    region: options.region,
    serviceName,
    params: options.params,
    rawConfig: initialConfig,
  };

  // PASADA 1: Resuelve las variables internas (${self:...}, ${opt:...})
  const resolvedYamlPass1 = resolveVariables(rawYamlContent, context, false);

  // PASADA 2: Extraer rutas SSM y resolverlas (AWS o mocks)
  const ssmParameterPaths = extractSSMPaths(resolvedYamlPass1);
  context.ssmValues = await resolveSSMValues(
    ssmParameterPaths,
    options.region,
    options.resolveSSM,
    workingDirectory,
  );

  // PASADA 3: Inyectar valores de SSM y resolver fallbacks
  const finalConfig = parseYaml<ServerlessConfig>(resolvedYamlPass1);

  // Resuelve variables de entorno del provider y las exporta a process.env
  const globalEnvironment = resolveEnvironmentVariables(finalConfig.provider?.environment, context);
  Object.assign(process.env, globalEnvironment);

  // Extrae y resuelve las rutas definidas en functions
  const routeDefinitions = extractRoutes(finalConfig.functions, globalEnvironment, context);

  return {
    config: finalConfig,
    routes: routeDefinitions,
    globalEnv: globalEnvironment,
    framework: "serverless",
  };
}
