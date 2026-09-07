import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import type { ServerlessConfig, RouteDefinition, LoadResult } from "./types.js";
import { parseYaml, resolveSSMValues, type ParserOptions } from "./parser.js";
import { extractSSMPaths } from "./resolver.js";

export interface SamParameterDefinition {
  Type?: string;
  Default?: string | number | boolean;
  Description?: string;
}

export interface SamEventDefinition {
  Type?: string;
  Properties?: {
    Path?: string;
    Method?: string;
    RestApiId?: string;
  };
}

export interface SamFunctionProperties {
  Handler?: string;
  Runtime?: string;
  CodeUri?: string;
  Description?: string;
  Environment?: {
    Variables?: Record<string, unknown>;
  };
  Events?: Record<string, SamEventDefinition> | SamEventDefinition[];
}

export interface SamResource {
  Type?: string;
  Properties?: SamFunctionProperties;
}

export interface SamTemplate {
  AWSTemplateFormatVersion?: string;
  Transform?: string | string[];
  Description?: string;
  Globals?: {
    Function?: {
      Runtime?: string;
      Timeout?: number;
      Environment?: {
        Variables?: Record<string, unknown>;
      };
    };
  };
  Parameters?: Record<string, SamParameterDefinition>;
  Resources?: Record<string, SamResource>;
}

/**
 * Encuentra la ruta del template de SAM (template.yaml o template.yml).
 */
export function findSamTemplatePath(workingDirectory: string): string {
  const candidateFiles = ["template.yaml", "template.yml", "Template.yaml", "Template.yml"];
  for (const candidateFile of candidateFiles) {
    const fullPath = path.resolve(workingDirectory, candidateFile);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  throw new Error(
    `No se encontró template.yaml ni template.yml en ${workingDirectory}. Verifica que sea un proyecto AWS SAM.`,
  );
}

/**
 * Extrae los parámetros de SAM combinando los defaults del template y los parámetros de CLI.
 */
export function buildSamParameters(
  templateParameters: Record<string, SamParameterDefinition> = {},
  cliParams: Record<string, string> = {},
  stage = "dev",
): Record<string, string> {
  const resolvedParameters: Record<string, string> = {};

  // 1. Cargar defaults del template
  for (const [parameterKey, parameterDefinition] of Object.entries(templateParameters)) {
    if (parameterDefinition.Default !== undefined) {
      resolvedParameters[parameterKey] = String(parameterDefinition.Default);
    }
  }

  // 2. El stage pasado por CLI tiene prioridad sobre el default del template
  if (stage) {
    resolvedParameters.Stage = stage;
    resolvedParameters.stage = stage;
  }

  // 3. Sobrescribir con los parámetros del CLI (--param key=value)
  for (const [cliKey, cliValue] of Object.entries(cliParams)) {
    resolvedParameters[cliKey] = cliValue;
  }

  return resolvedParameters;
}

/**
 * Resuelve variables de estilo CloudFormation/SAM y SSM en strings:
 * ${AWS::Region}, ${AWS::AccountId}, ${Stage}, ${param}, ${ssm:/path}
 */
export function resolveSamVariables(
  text: string,
  parameters: Record<string, string>,
  options: { region: string; serviceName: string; ssmValues?: Map<string, string> },
  resolveSSM = true,
): string {
  let currentResult = text;
  let iterationCount = 0;
  const maxIterations = 10;

  const innermostRegex = resolveSSM ? /\$\{([^{}]+)\}/g : /\$\{\s*(?!ssm:)([^{}]+)\}/g;

  let previousResult = "";
  while (currentResult !== previousResult && iterationCount < maxIterations) {
    previousResult = currentResult;
    currentResult = currentResult.replace(innermostRegex, (fullMatch, expression) => {
      const trimmed = expression.trim();

      // AWS Pseudo Parameters
      if (trimmed === "AWS::Region") return options.region;
      if (trimmed === "AWS::AccountId") return "123456789012";
      if (trimmed === "AWS::StackName") return options.serviceName;
      if (trimmed === "AWS::Partition") return "aws";
      if (trimmed === "AWS::URLSuffix") return "amazonaws.com";

      // Variables SSM
      if (trimmed.startsWith("ssm:")) {
        if (!resolveSSM) return fullMatch;
        const ssmKey = trimmed.slice(4).split("~")[0].trim();
        const value = options.ssmValues?.get(ssmKey) ?? options.ssmValues?.get(`/${ssmKey}`);
        if (value !== undefined && value !== null) return value;
        const leaf = ssmKey.split("/").pop() || "value";
        return `mock-${leaf.toLowerCase()}`;
      }

      // Parámetros de SAM / CLI
      if (parameters[trimmed] !== undefined) {
        return parameters[trimmed];
      }

      // Variables de entorno de sistema
      if (process.env[trimmed] !== undefined) {
        return process.env[trimmed]!;
      }

      return fullMatch;
    });
    iterationCount++;
  }

  return currentResult;
}

/**
 * Resuelve un diccionario de variables de entorno para SAM.
 */
function resolveSamEnvironmentMap(
  environmentMap: Record<string, unknown> | undefined,
  parameters: Record<string, string>,
  options: { region: string; serviceName: string; ssmValues?: Map<string, string> },
  baseEnvironment: Record<string, string> = {},
): Record<string, string> {
  const resolvedEnvironment: Record<string, string> = { ...baseEnvironment };
  if (!environmentMap) return resolvedEnvironment;

  for (const [variableKey, rawValue] of Object.entries(environmentMap)) {
    const stringValue = String(rawValue ?? "");
    resolvedEnvironment[variableKey] = resolveSamVariables(stringValue, parameters, options, true);
  }

  return resolvedEnvironment;
}

/**
 * Normaliza y extrae las rutas de una función SAM.
 */
function extractSamFunctionRoutes(
  functionName: string,
  functionProperties: SamFunctionProperties,
  resolvedEnvironment: Record<string, string>,
): RouteDefinition[] {
  const routes: RouteDefinition[] = [];
  const rawEvents = functionProperties.Events;
  if (!rawEvents) return routes;

  const rawHandler = functionProperties.Handler || "index.handler";
  const codeUri = functionProperties.CodeUri?.trim();

  // Construir handler completo según CodeUri si aplica
  let fullHandler = rawHandler;
  if (codeUri && codeUri !== "." && codeUri !== "./") {
    // Normalizar separadores a barra inclinada
    const normalizedUri = codeUri.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
    fullHandler = `${normalizedUri}/${rawHandler}`;
  }

  const eventEntries: SamEventDefinition[] = Array.isArray(rawEvents)
    ? rawEvents
    : Object.values(rawEvents);

  for (const event of eventEntries) {
    const eventType = event?.Type;
    if (eventType !== "Api" && eventType !== "HttpApi") continue;

    const properties = event.Properties || {};
    const rawPath = properties.Path || "/";
    const method = (properties.Method || "ANY").toUpperCase();
    const formattedPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;

    routes.push({
      functionName,
      method,
      path: formattedPath,
      handler: fullHandler,
      environment: resolvedEnvironment,
    });
  }

  return routes;
}

/**
 * Carga e interpreta un template de AWS SAM (template.yaml o template.yml).
 */
export async function loadSamConfig(
  workingDirectory = process.cwd(),
  options: ParserOptions,
): Promise<LoadResult> {
  const templatePath = findSamTemplatePath(workingDirectory);
  const rawYamlContent = fs.readFileSync(templatePath, "utf-8");
  const initialConfig = parseYaml<SamTemplate>(rawYamlContent);

  const serviceName =
    initialConfig.Description?.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 30) ||
    path.basename(workingDirectory);

  const parameters = buildSamParameters(
    initialConfig.Parameters,
    options.params,
    options.stage,
  );

  const samOptions = {
    region: options.region,
    serviceName,
  };

  // PASADA 1: Resuelve parámetros y referencias internas
  const resolvedYamlPass1 = resolveSamVariables(rawYamlContent, parameters, samOptions, false);

  // PASADA 2: Extraer rutas SSM y resolverlas
  const ssmParameterPaths = extractSSMPaths(resolvedYamlPass1);
  const ssmValues = await resolveSSMValues(
    ssmParameterPaths,
    options.region,
    options.resolveSSM,
    workingDirectory,
  );

  const fullSamOptions = {
    ...samOptions,
    ssmValues,
  };

  // PASADA 3: Inyectar valores finales
  const resolvedYamlPass3 = resolveSamVariables(
    resolvedYamlPass1,
    parameters,
    fullSamOptions,
    true,
  );
  const finalConfig = parseYaml<SamTemplate>(resolvedYamlPass3);

  // Extraer variables globales de Globals.Function.Environment.Variables
  const globalSamEnv = finalConfig.Globals?.Function?.Environment?.Variables;
  const globalEnvironment = resolveSamEnvironmentMap(
    globalSamEnv,
    parameters,
    fullSamOptions,
  );
  Object.assign(process.env, globalEnvironment);

  // Extraer funciones y rutas de Resources
  const routeDefinitions: RouteDefinition[] = [];
  const resources = finalConfig.Resources || {};

  for (const [resourceName, resourceConfig] of Object.entries(resources)) {
    const resourceType = resourceConfig?.Type;
    if (resourceType !== "AWS::Serverless::Function" && resourceType !== "AWS::Lambda::Function") {
      continue;
    }

    const properties = resourceConfig.Properties || {};
    const functionEnv = resolveSamEnvironmentMap(
      properties.Environment?.Variables,
      parameters,
      fullSamOptions,
      globalEnvironment,
    );

    const functionRoutes = extractSamFunctionRoutes(resourceName, properties, functionEnv);
    routeDefinitions.push(...functionRoutes);
  }

  const serverlessLikeConfig: ServerlessConfig = {
    service: serviceName,
    provider: {
      name: "aws",
      stage: options.stage,
      region: options.region,
      environment: globalEnvironment,
    },
  };

  return {
    config: serverlessLikeConfig,
    routes: routeDefinitions,
    globalEnv: globalEnvironment,
    framework: "sam",
  };
}
