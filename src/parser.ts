import fs from "node:fs";
import path from "node:path";
import { parse, type ScalarTag, type CollectionTag } from "yaml";
import pc from "picocolors";
import {
  type ServerlessConfig,
  type RouteDefinition,
  type LoadResult,
  type FunctionDefinition,
  type ScheduleDefinition,
  type ScheduleTriggerMethod,
  DEFAULT_OFFLINE_ENV,
} from "./types.js";
import {
  boundedScheduleName,
  parseRecurringExpression,
  validateScheduleName,
} from "./schedule-expression.js";
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
  cron?: boolean;
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

const SUPPORTED_SCHEDULE_FIELDS = [
  "rate",
  "cron",
  "enabled",
  "input",
  "inputPath",
  "inputTransformer",
  "name",
  "description",
  "method",
  "timezone",
];

/** Resolve Ref/GetAtt/Sub inside schedule input without re-expanding fetched SSM data. */
function resolveScheduleData(
  value: unknown,
  context: ResolveContext | undefined,
  field: string,
): unknown {
  if (Array.isArray(value))
    return value.map((item, index) => resolveScheduleData(item, context, `${field}[${index}]`));
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const intrinsicKey = keys.find(key => key === "Ref" || key.startsWith("Fn::"));
  if (intrinsicKey !== undefined) {
    if (keys.length !== 1) {
      throw new Error(
        `Unsupported intrinsic object in ${field}. Use one Ref/GetAtt/Sub value or literal data.`,
      );
    }
    if (intrinsicKey === "Ref" || intrinsicKey === "Fn::GetAtt") {
      const resolved = resolveIntrinsicReference(record, context);
      if (resolved !== null) return resolved;
      throw new Error(
        `Cannot resolve ${intrinsicKey} in ${field}. Declare a local resource, provide --cf-value LogicalId.Attribute=value, or use a literal value.`,
      );
    }
    if (intrinsicKey === "Fn::Sub") {
      const resolved = resolveCloudFormationSub(record["Fn::Sub"], context);
      if (resolved !== null) return resolved;
      throw new Error(
        `Cannot resolve Fn::Sub in ${field}. Use supported local references or a literal value.`,
      );
    }
    throw new Error(
      `Unsupported intrinsic ${intrinsicKey} in ${field}. Use literal values, Ref, GetAtt or Sub.`,
    );
  }

  return Object.fromEntries(
    keys.map(key => [key, resolveScheduleData(record[key], context, `${field}.${key}`)]),
  );
}

function scheduleScalar(
  value: unknown,
  context: ResolveContext | undefined,
  field: string,
): string {
  const resolved = resolveScheduleData(value, context, field);
  if (typeof resolved === "string") return resolved.trim();
  if (typeof resolved === "number" || typeof resolved === "boolean") return String(resolved);
  throw new Error(`${field} must resolve to a string.`);
}

function scheduleBoolean(
  value: unknown,
  context: ResolveContext | undefined,
  field: string,
): boolean {
  if (value === undefined) return true;
  const resolved = resolveScheduleData(value, context, field);
  if (typeof resolved === "boolean") return resolved;
  if (resolved === "true") return true;
  if (resolved === "false") return false;
  throw new Error(`${field} must be true or false.`);
}

function parseScheduleMethod(
  value: unknown,
  context: ResolveContext | undefined,
  field: string,
): ScheduleTriggerMethod {
  if (value === undefined) return "eventBus";
  const resolved = scheduleScalar(value, context, field);
  if (resolved === "eventBus" || resolved === "scheduler") return resolved;
  throw new Error(`${field} accepts eventBus or scheduler.`);
}

function parseScheduleInput(
  value: unknown,
  context: ResolveContext | undefined,
  field: string,
): unknown {
  const resolved = resolveScheduleData(value, context, field);
  if (resolved === null || resolved === undefined) return undefined;
  if (typeof resolved !== "string") return resolved;
  try {
    return JSON.parse(resolved);
  } catch {
    throw new Error(`${field} must be valid JSON text.`);
  }
}

interface ParsedServerlessSchedule {
  expressions: string[];
  enabled: boolean;
  method: ScheduleTriggerMethod;
  timezone: string;
  input?: unknown;
  name?: string;
  description?: string;
}

function parseServerlessSchedule(
  rawSchedule: unknown,
  functionName: string,
  context?: ResolveContext,
): ParsedServerlessSchedule {
  const fieldPrefix = `Schedule for function ${functionName}`;
  let expressionSource: unknown;
  let config: Record<string, unknown> = {};

  if (typeof rawSchedule === "string") {
    expressionSource = rawSchedule;
  } else if (rawSchedule && typeof rawSchedule === "object" && !Array.isArray(rawSchedule)) {
    config = rawSchedule as Record<string, unknown>;
    for (const key of Object.keys(config)) {
      if (!SUPPORTED_SCHEDULE_FIELDS.includes(key)) {
        throw new Error(
          `${fieldPrefix} uses unsupported option ${key}. Supported options: ${SUPPORTED_SCHEDULE_FIELDS.join(", ")}.`,
        );
      }
    }
    if (config.inputPath !== undefined) {
      throw new Error(
        `${fieldPrefix} does not support inputPath locally. Use input with an explicit JSON value.`,
      );
    }
    if (config.inputTransformer !== undefined) {
      throw new Error(
        `${fieldPrefix} does not support inputTransformer locally. Use input with an explicit JSON value.`,
      );
    }
    const hasCron = config.cron !== undefined;
    const hasRate = config.rate !== undefined;
    if (hasCron && hasRate) {
      throw new Error(`${fieldPrefix} must use either cron or rate, not both.`);
    }
    expressionSource = hasCron ? config.cron : config.rate;
    if (expressionSource === undefined) {
      throw new Error(`${fieldPrefix} requires a cron or rate expression.`);
    }
  } else {
    throw new Error(
      `${fieldPrefix} must be a cron(...)/rate(...) string or an object with cron or rate.`,
    );
  }

  const expressionValues = Array.isArray(expressionSource) ? expressionSource : [expressionSource];
  if (expressionValues.length === 0) {
    throw new Error(`${fieldPrefix} requires at least one expression.`);
  }
  const expressions = expressionValues.map((value, index) =>
    scheduleScalar(value, context, `${fieldPrefix} expression ${index + 1}`),
  );

  const method = parseScheduleMethod(config.method, context, `${fieldPrefix} method`);
  const configuredTimezone =
    config.timezone === undefined
      ? "UTC"
      : scheduleScalar(config.timezone, context, `${fieldPrefix} timezone`);
  if (method === "eventBus" && configuredTimezone !== "UTC") {
    throw new Error(
      `${fieldPrefix} uses method eventBus, which evaluates in UTC. Use method scheduler to set a timezone.`,
    );
  }
  const timezone = method === "eventBus" ? "UTC" : configuredTimezone;
  const enabled = scheduleBoolean(config.enabled, context, `${fieldPrefix} enabled`);
  const name =
    config.name === undefined
      ? undefined
      : validateScheduleName(
          scheduleScalar(config.name, context, `${fieldPrefix} name`),
          `Schedule name for function ${functionName}`,
        );
  const description =
    config.description === undefined
      ? undefined
      : scheduleScalar(config.description, context, `${fieldPrefix} description`);
  if (description !== undefined && description.length > 512) {
    throw new Error(`${fieldPrefix} description must be at most 512 characters.`);
  }
  const input =
    config.input === undefined || config.input === null
      ? undefined
      : parseScheduleInput(config.input, context, `${fieldPrefix} input`);

  return { expressions, enabled, method, timezone, input, name, description };
}

function extractSchedules(
  functionsConfig: Record<string, any> = {},
  functionsByName: Map<string, FunctionDefinition>,
  options: ParserOptions,
  context?: ResolveContext,
): ScheduleDefinition[] {
  const schedules: ScheduleDefinition[] = [];
  const seenNames = new Map<string, string>();
  const partition = awsPartition(options.region);
  const account = context?.references?.get("AWS::AccountId") || "123456789012";
  let scheduleIndex = 0;

  for (const [functionName, functionConfig] of Object.entries(functionsConfig)) {
    if (!Array.isArray(functionConfig?.events)) continue;
    const functionDefinition = functionsByName.get(functionName);
    if (!functionDefinition) continue;
    const lambdaName = functionDefinition.arn?.split(":function:")[1] || functionName;

    for (const eventConfig of functionConfig.events) {
      if (!eventConfig || typeof eventConfig !== "object" || eventConfig.schedule === undefined) {
        continue;
      }
      const parsed = parseServerlessSchedule(eventConfig.schedule, functionName, context);

      for (
        let expressionIndex = 0;
        expressionIndex < parsed.expressions.length;
        expressionIndex++
      ) {
        scheduleIndex++;
        const expression = parsed.expressions[expressionIndex];
        try {
          parseRecurringExpression(expression, parsed.timezone);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Invalid schedule for function ${functionName}: ${message}`);
        }

        const scheduleName =
          parsed.name === undefined
            ? validateScheduleName(
                boundedScheduleName(`${lambdaName}-schedule-${scheduleIndex}`),
                `Generated schedule name for function ${functionName}`,
              )
            : validateScheduleName(
                parsed.expressions.length > 1
                  ? `${parsed.name}-${expressionIndex + 1}`
                  : parsed.name,
                `Schedule name for function ${functionName}`,
              );

        const nameKey = `${parsed.method}:${scheduleName}`;
        const previousFunction = seenNames.get(nameKey);
        if (previousFunction !== undefined) {
          throw new Error(
            `Duplicate ${parsed.method} schedule name ${scheduleName} in functions ${previousFunction} and ${functionName}. Use a unique name per method.`,
          );
        }
        seenNames.set(nameKey, functionName);

        schedules.push({
          ...functionDefinition,
          scheduleName,
          expression,
          enabled: parsed.enabled,
          method: parsed.method,
          timezone: parsed.timezone,
          description: parsed.description,
          input: parsed.input,
          ruleArn:
            parsed.method === "scheduler"
              ? `arn:${partition}:scheduler:${options.region}:${account}:schedule/default/${scheduleName}`
              : `arn:${partition}:events:${options.region}:${account}:rule/${scheduleName}`,
          region: options.region,
          account,
        });
      }
    }
  }

  return schedules;
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

  const functionsByName = new Map(functions.map(fn => [fn.functionName, fn]));
  const schedules = options.cron
    ? extractSchedules(finalConfig.functions, functionsByName, options, context)
    : [];

  return {
    config: finalConfig,
    routes: routeDefinitions,
    functions,
    schedules,
    globalEnv: globalEnvironment,
    framework: "serverless",
  };
}
