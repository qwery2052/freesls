import fs from "node:fs";
import path from "node:path";
import { parse, type ScalarTag, type CollectionTag } from "yaml";
import pc from "picocolors";
import {
  type ServerlessConfig,
  type RouteDefinition,
  type LoadResult,
  type FunctionDefinition,
  DEFAULT_OFFLINE_ENV,
} from "./types.js";
import { SSMResolver } from "./ssm.js";
import {
  extractSSMPaths,
  getNestedValue,
  resolveVariables,
  resolveScalarData,
  resolveIntrinsicReference,
  resolveCloudFormationSub,
  awsPartition,
  localRoleName,
  type ResolveContext,
} from "./resolver.js";

const cloudFormationTags = [
  "!Ref",
  "!GetAtt",
  "!Sub",
  "!Join",
  "!Select",
  "!Split",
  "!ImportValue",
  "!If",
  "!Equals",
  "!And",
  "!Or",
  "!Not",
  "!Condition",
  "!FindInMap",
  "!Base64",
  "!GetAZs",
  "!Cidr",
];

const customTags: (ScalarTag | CollectionTag)[] = cloudFormationTags.flatMap(tag => {
  const key = tag === "!Ref" ? "Ref" : `Fn::${tag.slice(1)}`;
  const tags: (ScalarTag | CollectionTag)[] = [{ tag, resolve: value => ({ [key]: value }) }];
  if (
    [
      "!Sub",
      "!GetAtt",
      "!Join",
      "!Select",
      "!Split",
      "!If",
      "!Equals",
      "!And",
      "!Or",
      "!Not",
      "!FindInMap",
      "!Cidr",
    ].includes(tag)
  ) {
    tags.push({ tag, collection: "seq", resolve: value => ({ [key]: value.toJSON() }) });
  }
  return tags;
});

export const parseYaml = <ParsedResult = any>(yamlContent: string): ParsedResult =>
  parse(yamlContent, { customTags });

export interface ParserOptions {
  stage: string;
  region: string;
  params: Record<string, string>;
  resolveSSM?: boolean;
  scheduler?: boolean;
  cfValues?: Record<string, string>;
  envOverrides?: Record<string, string>;
}

/**
 * Resolve environment scalars using the current context.
 */
export function resolveEnvironmentVariables(
  environmentVariables: Record<string, unknown> | undefined,
  context?: ResolveContext,
  baseEnvironment: Record<string, string> = {},
): Record<string, string> {
  const resolvedEnvironment: Record<string, string> = { ...baseEnvironment };
  if (!environmentVariables) return resolvedEnvironment;

  for (const [variableKey, variableValue] of Object.entries(environmentVariables)) {
    if (variableValue !== null && typeof variableValue === "object") {
      const objectKeys = Object.keys(variableValue as object);
      if (objectKeys.length === 1 && (objectKeys[0] === "Ref" || objectKeys[0] === "Fn::GetAtt")) {
        const resolved = resolveIntrinsicReference(variableValue, context);
        // Preserve the legacy HTTP-only mode's blank resource references.
        if (resolved !== null || !context?.strictReferences) {
          resolvedEnvironment[variableKey] = resolved ?? "";
          continue;
        }
      }
      if (objectKeys.length === 1 && objectKeys[0] === "Fn::Sub") {
        const subResult = resolveCloudFormationSub(
          (variableValue as Record<string, unknown>)["Fn::Sub"],
          context,
        );
        if (subResult !== null) {
          resolvedEnvironment[variableKey] = subResult;
          continue;
        }
      }
      throw new Error(
        `Unsupported intrinsic or object in environment variable ${variableKey}. Use supported Ref/GetAtt/Sub values, declare a local Lambda or IAM role, or supply --cf-value LogicalId.Attribute=value (stack outputs: Outputs.OutputKey).`,
      );
    }
    resolvedEnvironment[variableKey] = context
      ? resolveVariables(String(variableValue ?? ""), context, true)
      : String(variableValue ?? "");
  }
  return resolvedEnvironment;
}

/**
 * Load local SSM mocks from the project root.
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
 * Fetch SSM values or load offline mocks.
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
    console.log(pc.dim("SSM offline: loaded mocks from ssm.env"));
  } else {
    console.log(pc.dim("SSM offline: using fallbacks and local mocks"));
  }

  return ssmMocksFromEnv;
}

/**
 * Normalize an HTTP event definition.
 */
function parseHttpEvent(httpEventConfig: unknown): { method: string; path: string } | null {
  if (httpEventConfig == null) return null;

  let httpMethod = "ANY";
  let routePath = "/";

  if (typeof httpEventConfig === "string") {
    const stringParts = httpEventConfig.trim().split(/\s+/);
    httpMethod = stringParts[0] || "ANY";
    routePath = stringParts[1] || "/";
  } else if (typeof httpEventConfig === "object" && !Array.isArray(httpEventConfig)) {
    const objectConfig = httpEventConfig as { method?: string; path?: string };
    for (const field of ["method", "path"] as const) {
      if (objectConfig[field] !== undefined && typeof objectConfig[field] !== "string") {
        throw new Error(`Invalid HTTP event ${field}; expected a string`);
      }
    }
    httpMethod = objectConfig.method || "ANY";
    routePath = objectConfig.path || "/";
  } else {
    throw new Error("Invalid HTTP event; expected a string or object");
  }

  return {
    method: httpMethod.toUpperCase(),
    path: routePath.startsWith("/") ? routePath : `/${routePath}`,
  };
}

/**
 * Extract HTTP routes from function definitions.
 */
function extractRoutes(
  functionsConfig: Record<string, any> = {},
  globalEnvironment: Record<string, string>,
  httpApiPayload: unknown = "2.0",
  context?: ResolveContext,
  functions: FunctionDefinition[] = [],
  rawFunctions: Record<string, any> = functionsConfig,
): RouteDefinition[] {
  const routeDefinitions: RouteDefinition[] = [];

  for (const [functionName, functionConfig] of Object.entries(functionsConfig)) {
    if (typeof functionConfig?.handler !== "string" || !functionConfig.handler.trim()) {
      throw new Error(`Invalid handler for function ${functionName}; expected a non-empty string`);
    }

    const functionEnvironment = resolveEnvironmentVariables(
      rawFunctions[functionName]?.environment,
      context,
      globalEnvironment,
    );

    const definition = {
      functionName,
      handler: functionConfig.handler,
      environment: functionEnvironment,
      arn: context?.references?.get(`functions.${functionName}.Arn`),
    };
    functions.push(definition);
    if (!Array.isArray(functionConfig?.events)) continue;

    for (const eventConfig of functionConfig.events) {
      const parsedHttp = parseHttpEvent(eventConfig?.http ?? eventConfig?.httpApi);
      if (!parsedHttp) continue;
      if (typeof functionConfig.handler !== "string" || !functionConfig.handler.trim()) {
        throw new Error(
          `Invalid handler for function ${functionName}; expected a non-empty string`,
        );
      }
      const payloadVersion =
        eventConfig.http != null
          ? "1.0"
          : httpApiPayload === 1 || httpApiPayload === 2
            ? `${httpApiPayload}.0`
            : String(httpApiPayload);
      if (payloadVersion !== "1.0" && payloadVersion !== "2.0") {
        throw new Error("Unsupported HTTP API payload version; expected 1.0 or 2.0");
      }

      routeDefinitions.push({
        ...definition,
        functionName,
        method: parsedHttp.method,
        path: parsedHttp.path,
        handler: functionConfig.handler,
        environment: functionEnvironment,
        payloadVersion,
      });
    }
  }

  return routeDefinitions;
}

export async function loadServerlessConfig(
  workingDirectory = process.cwd(),
  options: ParserOptions,
): Promise<LoadResult> {
  Object.assign(process.env, DEFAULT_OFFLINE_ENV);

  const serverlessYamlPath = path.resolve(workingDirectory, "serverless.yml");
  if (!fs.existsSync(serverlessYamlPath)) {
    throw new Error(`No serverless.yml found in ${workingDirectory}`);
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
    references: new Map(),
    strictReferences: Boolean(options.scheduler || options.cfValues),
  };

  // Discover SSM references in resolved scalar data, never in rewritten YAML.
  const resolvedConfigPass1 = resolveScalarData(initialConfig, text =>
    resolveVariables(text, context, false),
  );

  const ssmParameterPaths: string[] = [];
  resolveScalarData(resolvedConfigPass1, text => {
    ssmParameterPaths.push(...extractSSMPaths(text));
    return text;
  });
  context.ssmValues = await resolveSSMValues(
    ssmParameterPaths,
    options.region,
    options.resolveSSM,
    workingDirectory,
  );

  const finalConfig = resolveScalarData(initialConfig, text =>
    resolveVariables(text, context, true),
  ) as ServerlessConfig;

  const resolvedServiceName = resolveVariables(serviceName, context, true);
  context.serviceName = resolvedServiceName;
  const references = context.references!;
  const partition = awsPartition(options.region);
  const prefix = `arn:${partition}:lambda:${options.region}:${references.get("AWS::AccountId") || "123456789012"}:function:`;
  const names = new Set<string>();
  const logicalIds = new Set<string>();
  const functionLogicalIds = new Map<string, string>();
  for (const [key, fn] of Object.entries(finalConfig.functions || {})) {
    const name =
      (fn as { name?: unknown }).name ?? `${resolvedServiceName}-${options.stage}-${key}`;
    if (typeof name !== "string" || !/^[\w-]{1,64}$/.test(name) || names.has(name))
      throw new Error(
        `Invalid or duplicate Lambda name for function ${key}. Use a unique name of 1-64 letters, digits, underscores or hyphens.`,
      );
    names.add(name);
    const arn = prefix + name;
    // Serverless Framework's generated logical function ID convention.
    const logical =
      key.charAt(0).toUpperCase() +
      key.slice(1).replace(/-/g, "Dash").replace(/_/g, "Underscore") +
      "LambdaFunction";
    if (logicalIds.has(logical))
      throw new Error(
        `Duplicate generated Lambda logical ID ${logical}. Rename one of the functions.`,
      );
    logicalIds.add(logical);
    functionLogicalIds.set(key, logical);
    references.set(logical, name);
    references.set(`${logical}.Arn`, arn);
    references.set(`functions.${key}.Arn`, arn);
  }
  const resources = (finalConfig as any).resources?.Resources || {};
  for (const [key, value] of Object.entries(resources)) {
    const resource = value as {
      Type?: string;
      Properties?: { RoleName?: unknown; Path?: unknown };
    };
    if (resource.Type !== "AWS::IAM::Role") continue;
    const name =
      resource.Properties?.RoleName ??
      localRoleName(`${resolvedServiceName}-${options.stage}`, key);
    const rolePath = resource.Properties?.Path ?? "/";
    // Unsupported unrelated resources must not prevent HTTP startup. A referenced
    // unsupported role is rejected by strict environment resolution instead.
    if (
      typeof name !== "string" ||
      !/^[\w+=,.@-]{1,64}$/.test(name) ||
      typeof rolePath !== "string" ||
      !rolePath.startsWith("/") ||
      !rolePath.endsWith("/")
    )
      continue;
    references.set(key, name);
    references.set(`${key}.Arn`, `arn:${partition}:iam::123456789012:role${rolePath}${name}`);
  }
  for (const [key, value] of Object.entries(options.cfValues || {})) references.set(key, value);
  for (const [key, logical] of functionLogicalIds) {
    references.set(`functions.${key}.Arn`, references.get(`${logical}.Arn`)!);
  }

  // Export provider environment variables with default local offline flags.
  const globalEnvironment = {
    ...DEFAULT_OFFLINE_ENV,
    ...resolveEnvironmentVariables(initialConfig.provider?.environment, context),
    ...options.envOverrides,
  };
  Object.assign(process.env, globalEnvironment);

  const functions: FunctionDefinition[] = [];
  const routeDefinitions = extractRoutes(
    finalConfig.functions,
    globalEnvironment,
    getNestedValue(finalConfig, "provider.httpApi.payload"),
    context,
    functions,
    initialConfig.functions,
  );

  // Explicit CLI environment overrides win over global and function environments.
  for (const route of routeDefinitions) Object.assign(route.environment, options.envOverrides);
  for (const fn of functions) Object.assign(fn.environment, options.envOverrides);

  return {
    config: finalConfig,
    routes: routeDefinitions,
    functions,
    globalEnv: globalEnvironment,
    framework: "serverless",
  };
}
