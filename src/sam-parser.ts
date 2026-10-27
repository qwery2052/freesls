import fs from "node:fs";
import path from "node:path";
import {
  type ServerlessConfig,
  type RouteDefinition,
  type FunctionDefinition,
  type ScheduleDefinition,
  type MakefileHandlerDefinition,
  type LoadResult,
  DEFAULT_OFFLINE_ENV,
} from "./types.js";
import { parseYaml, resolveSSMValues, type ParserOptions } from "./parser.js";
import { resolveGnuMakeCommand, resolveMakefileHandler } from "./sam-makefile.js";
import {
  boundedScheduleName,
  parseRecurringExpression,
  validateScheduleName,
} from "./schedule-expression.js";
import {
  extractSSMPaths,
  resolveScalarData,
  awsPartition,
  localRoleName,
  localFunctionName,
} from "./resolver.js";

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
    PayloadFormatVersion?: string | number;
    Schedule?: string;
    ScheduleExpression?: string;
    ScheduleExpressionTimezone?: string;
    Enabled?: boolean | string;
    State?: string;
    Input?: unknown;
    Name?: string;
    Description?: string;
    FlexibleTimeWindow?: {
      Mode?: string;
      MaximumWindowInMinutes?: number;
    };
    StartDate?: string;
    EndDate?: string;
    KmsKeyArn?: string;
    GroupName?: string;
    RoleArn?: string;
    PermissionsBoundary?: string;
    OmitName?: boolean;
    DeadLetterConfig?: unknown;
    RetryPolicy?: unknown;
  };
}

export interface SamFunctionProperties {
  Handler?: string;
  FunctionName?: string;
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
  Properties?: Record<string, any>;
  Metadata?: {
    BuildMethod?: string;
    BuildProperties?: { EntryPoints?: unknown };
  };
}

export interface SamTemplate {
  AWSTemplateFormatVersion?: string;
  Transform?: string | string[];
  Description?: string;
  Globals?: {
    Function?: {
      Runtime?: string;
      CodeUri?: string;
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
 * Find the SAM template path.
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
    `No template.yaml or template.yml found in ${workingDirectory}. Check that this is an AWS SAM project.`,
  );
}

/**
 * Merge template defaults and CLI parameters.
 */
export function buildSamParameters(
  templateParameters: Record<string, SamParameterDefinition> = {},
  cliParams: Record<string, string> = {},
  stage = "dev",
): Record<string, string> {
  const resolvedParameters: Record<string, string> = {};

  // Load template defaults.
  for (const [parameterKey, parameterDefinition] of Object.entries(templateParameters)) {
    if (parameterDefinition.Default !== undefined) {
      resolvedParameters[parameterKey] = String(parameterDefinition.Default);
    }
  }

  // CLI stage overrides template defaults.
  if (stage) {
    resolvedParameters.Stage = stage;
    resolvedParameters.stage = stage;
  }

  // Explicit CLI parameters take precedence.
  for (const [cliKey, cliValue] of Object.entries(cliParams)) {
    resolvedParameters[cliKey] = cliValue;
  }

  return resolvedParameters;
}

export interface SamResolutionOptions {
  region: string;
  serviceName: string;
  parameters: Record<string, string>;
  resources?: Record<string, SamResource>;
  ssmValues?: Map<string, string>;
  references?: Map<string, string>;
  strictReferences?: boolean;
}

type SamResolutionContext = SamResolutionOptions & { propertyStack?: unknown[] };

/**
 * Resolve an SSM value or generate an offline mock.
 */
function resolveSsmParameterValue(ssmPath: string, ssmValues?: Map<string, string>): string {
  const normalizedSsmKey = ssmPath.trim();
  const alternativeSsmKey = normalizedSsmKey.startsWith("/")
    ? normalizedSsmKey.slice(1)
    : `/${normalizedSsmKey}`;

  const matchedSsmValue = ssmValues?.get(normalizedSsmKey) ?? ssmValues?.get(alternativeSsmKey);
  if (matchedSsmValue !== undefined && matchedSsmValue !== null) {
    return matchedSsmValue;
  }

  const parameterLeafName = normalizedSsmKey.split("/").pop() || "value";
  return `mock-${parameterLeafName.toLowerCase()}`;
}

/**
 * CloudFormation resolves AWS::SSM::Parameter::Value<...> defaults against Parameter Store.
 * AWS::SSM::Parameter::Name and plain String parameters keep their literal value.
 */
function isSsmValueParameterType(parameterType?: string): boolean {
  return (
    typeof parameterType === "string" && parameterType.startsWith("AWS::SSM::Parameter::Value<")
  );
}

/**
 * Resolve explicit references in resource names.
 */
function resolveTemplatePropertyString(
  propertyValue: unknown,
  fallbackValue: string,
  options: SamResolutionContext,
): string {
  if (propertyValue == null) return fallbackValue;
  const stack = options.propertyStack ?? [];
  if (stack.includes(propertyValue) || stack.length >= 100) {
    throw new Error("Cyclic or excessively nested CloudFormation resource name reference");
  }
  const resolved = resolveSamData(
    propertyValue,
    { ...options, propertyStack: [...stack, propertyValue] },
    false,
  );
  if (typeof resolved === "object") throw new Error("Unsupported intrinsic in resource name");
  return String(resolved);
}

/**
 * Resolve a CloudFormation reference to a parameter or local resource mock.
 */
function resolveCloudFormationRef(
  referenceName: string,
  options: SamResolutionContext,
): string | null {
  const trimmedRef = referenceName.trim();
  if (options.references?.has(trimmedRef)) return options.references.get(trimmedRef)!;
  const resource = options.resources?.[trimmedRef];
  if (
    resource?.Type === "AWS::Serverless::Function" ||
    resource?.Type === "AWS::Lambda::Function"
  ) {
    return resolveTemplatePropertyString(
      resource.Properties?.FunctionName,
      localFunctionName(options.serviceName, trimmedRef),
      options,
    );
  }

  // CloudFormation pseudo parameters.
  if (trimmedRef === "AWS::Region") return options.region;
  if (trimmedRef === "AWS::AccountId") return "123456789012";
  if (trimmedRef === "AWS::StackName") return options.serviceName;
  if (trimmedRef === "AWS::Partition") return awsPartition(options.region);
  if (trimmedRef === "AWS::URLSuffix")
    return options.region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
  if (trimmedRef === "AWS::NoValue") return "";

  // Template and CLI parameters.
  if (options.parameters[trimmedRef] !== undefined) {
    return options.parameters[trimmedRef];
  }

  // System environment variables.
  if (process.env[trimmedRef] !== undefined) {
    return process.env[trimmedRef]!;
  }

  // Local resource mocks.
  const targetResource = options.resources?.[trimmedRef];
  if (targetResource) {
    const resourceType = targetResource.Type || "";
    const resourceProperties = targetResource.Properties || {};

    switch (resourceType) {
      case "AWS::IAM::Role":
        return resolveTemplatePropertyString(
          resourceProperties.RoleName,
          localRoleName(options.serviceName, trimmedRef),
          options,
        );
      case "AWS::SQS::Queue": {
        const queueName = resolveTemplatePropertyString(
          resourceProperties.QueueName,
          `${options.serviceName}-${trimmedRef}`,
          options,
        );
        return `https://sqs.${options.region}.amazonaws.com/123456789012/${queueName}`;
      }
      case "AWS::DynamoDB::Table":
      case "AWS::Serverless::SimpleTable": {
        return resolveTemplatePropertyString(
          resourceProperties.TableName,
          `${options.serviceName}-${trimmedRef}`,
          options,
        );
      }
      case "AWS::S3::Bucket": {
        return resolveTemplatePropertyString(
          resourceProperties.BucketName,
          `${options.serviceName}-${trimmedRef.toLowerCase()}`,
          options,
        );
      }
      case "AWS::SNS::Topic": {
        const topicName = resolveTemplatePropertyString(
          resourceProperties.TopicName,
          `${options.serviceName}-${trimmedRef}`,
          options,
        );
        return `arn:aws:sns:${options.region}:123456789012:${topicName}`;
      }
      case "AWS::Serverless::Api":
      case "AWS::ApiGateway::RestApi":
      case "AWS::Serverless::HttpApi":
      case "AWS::ApiGatewayV2::Api": {
        return `mock-${trimmedRef.toLowerCase()}`;
      }
      default: {
        if (options.strictReferences) return null;
        if (resourceProperties.Name != null) {
          return resolveTemplatePropertyString(resourceProperties.Name, trimmedRef, options);
        }
        return trimmedRef;
      }
    }
  }

  return null;
}

/**
 * Resolve a CloudFormation resource attribute locally.
 */
function resolveCloudFormationGetAtt(
  resourceName: string,
  attributeName: string,
  options: SamResolutionContext,
): string | null {
  if (options.references?.has(`${resourceName}.${attributeName}`))
    return options.references.get(`${resourceName}.${attributeName}`)!;
  const targetResource = options.resources?.[resourceName];
  if (!targetResource) {
    return null;
  }

  const resourceType = targetResource.Type || "";
  const resourceProperties = targetResource.Properties || {};

  if (
    attributeName === "Arn" &&
    ["AWS::Serverless::Function", "AWS::Lambda::Function"].includes(resourceType)
  ) {
    return `arn:${awsPartition(options.region)}:lambda:${options.region}:${options.references?.get("AWS::AccountId") || "123456789012"}:function:${resolveCloudFormationRef(resourceName, options)}`;
  }

  if (attributeName === "Arn") {
    switch (resourceType) {
      case "AWS::SQS::Queue": {
        const queueName = resolveTemplatePropertyString(
          resourceProperties.QueueName,
          `${options.serviceName}-${resourceName}`,
          options,
        );
        return `arn:aws:sqs:${options.region}:123456789012:${queueName}`;
      }
      case "AWS::DynamoDB::Table": {
        const tableName = resolveTemplatePropertyString(
          resourceProperties.TableName,
          `${options.serviceName}-${resourceName}`,
          options,
        );
        return `arn:aws:dynamodb:${options.region}:123456789012:table/${tableName}`;
      }
      case "AWS::IAM::Role": {
        const roleName = resolveTemplatePropertyString(
          resourceProperties.RoleName,
          localRoleName(options.serviceName, resourceName),
          options,
        );
        const rolePath = resolveTemplatePropertyString(resourceProperties.Path, "/", options);
        return `arn:${awsPartition(options.region)}:iam::123456789012:role${rolePath}${roleName}`;
      }
      case "AWS::IAM::ManagedPolicy": {
        const policyName = resolveTemplatePropertyString(
          resourceProperties.ManagedPolicyName,
          `${options.serviceName}-${resourceName}`,
          options,
        );
        return `arn:aws:iam::123456789012:policy/${policyName}`;
      }
      default:
        if (options.strictReferences) return null;
        return `arn:aws:custom:${options.region}:123456789012:${resourceName.toLowerCase()}`;
    }
  }

  if (attributeName === "QueueUrl" && resourceType === "AWS::SQS::Queue") {
    return resolveCloudFormationRef(resourceName, options);
  }

  return options.strictReferences ? null : `${resourceName}.${attributeName}`;
}

/**
 * Resolve SAM substitutions and SSM references in scalar text.
 */
export function resolveSamVariables(
  text: string,
  parameters: Record<string, string>,
  options: Omit<SamResolutionContext, "parameters">,
  resolveSSM = true,
): string {
  const resolutionOptions: SamResolutionContext = {
    ...options,
    parameters,
  };

  let currentResult = text;
  let iterationCount = 0;
  const maxIterations = 10;

  // Preserve dynamic reference version selectors.
  const dynamicSsmRegex = /\{\{\s*resolve:ssm(?:-secure)?:\s*([^{}]+)\}\}/g;

  // Resolve nested substitutions.
  const innermostRegex = resolveSSM ? /\$\{([^{}]+)\}/g : /\$\{\s*(?!ssm:)([^{}]+)\}/g;

  let previousResult = "";
  while (currentResult !== previousResult && iterationCount < maxIterations) {
    previousResult = currentResult;
    currentResult = currentResult.replace(innermostRegex, (fullMatch, expression) => {
      const trimmedExpression = expression.trim();

      // Serverless-style SSM references.
      if (trimmedExpression.startsWith("ssm:")) {
        if (!resolveSSM) return fullMatch;
        const ssmPath = trimmedExpression.slice(4).split("~")[0].trim();
        return resolveSsmParameterValue(ssmPath, options.ssmValues);
      }

      // Resource attributes in substitutions.
      if (trimmedExpression.includes(".")) {
        const dotIndex = trimmedExpression.indexOf(".");
        const targetResourceName = trimmedExpression.slice(0, dotIndex).trim();
        const targetAttributeName = trimmedExpression.slice(dotIndex + 1).trim();

        if (options.resources && options.resources[targetResourceName]) {
          const resolvedGetAtt = resolveCloudFormationGetAtt(
            targetResourceName,
            targetAttributeName,
            resolutionOptions,
          );
          if (resolvedGetAtt !== null) {
            return resolvedGetAtt;
          }
        }
      }

      // Parameters and resource references.
      const resolvedRef = resolveCloudFormationRef(trimmedExpression, resolutionOptions);
      if (resolvedRef !== null) {
        return resolvedRef;
      }

      return fullMatch;
    });
    iterationCount++;
  }

  // Resolve dynamic paths after substitution.
  if (resolveSSM) {
    currentResult = currentResult.replace(dynamicSsmRegex, (_fullMatch, parameterPath) => {
      return resolveSsmParameterValue(parameterPath, options.ssmValues);
    });
  }

  return currentResult;
}

/** Resolve supported intrinsics without flattening unsupported objects. */
function resolveSamData(
  value: unknown,
  options: SamResolutionContext,
  resolveSSM: boolean,
): unknown {
  if (typeof value === "string") {
    return resolveSamVariables(value, options.parameters, options, resolveSSM);
  }
  if (Array.isArray(value)) return value.map(item => resolveSamData(item, options, resolveSSM));
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length === 1) {
    if (typeof object.Ref === "string") {
      return resolveCloudFormationRef(object.Ref, options) ?? value;
    }
    const getAtt = object["Fn::GetAtt"];
    const parts = typeof getAtt === "string" ? getAtt.split(/\.(.*)/s).slice(0, 2) : getAtt;
    if (
      Array.isArray(parts) &&
      parts.length === 2 &&
      parts.every(part => typeof part === "string")
    ) {
      return resolveCloudFormationGetAtt(parts[0], parts[1], options) ?? value;
    }
    const sub = object["Fn::Sub"];
    const template =
      typeof sub === "string" ? sub : Array.isArray(sub) && sub.length === 2 ? sub[0] : undefined;
    const variables = Array.isArray(sub) ? sub[1] : {};
    if (
      typeof template === "string" &&
      variables &&
      typeof variables === "object" &&
      !Array.isArray(variables)
    ) {
      const substitutions = Object.fromEntries(
        Object.entries(variables).map(([key, item]) => [
          key,
          resolveSamData(item, options, resolveSSM),
        ]),
      );
      if (Object.values(substitutions).some(item => item !== null && typeof item === "object"))
        return value;
      let unresolved = false;
      const result = template.replace(/\$\{([^{}]+)\}/g, (match, name: string) => {
        if (name.startsWith("!")) return `\${${name.slice(1)}}`;
        if (Object.hasOwn(substitutions, name)) return String(substitutions[name]);
        const resolved = resolveSamVariables(match, options.parameters, options, resolveSSM);
        if (resolved === match && !name.startsWith("ssm:")) unresolved = true;
        return resolved;
      });
      if (unresolved) return value;
      // Resolve only dynamic SSM references here; do not re-expand escaped substitutions.
      return resolveSSM
        ? result.replace(/\{\{\s*resolve:ssm(?:-secure)?:\s*([^{}]+)\}\}/g, (_match, name) =>
            resolveSsmParameterValue(name, options.ssmValues),
          )
        : result;
    }
  }
  if (Object.keys(object).some(key => key === "Ref" || key.startsWith("Fn::"))) return value;
  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [key, resolveSamData(item, options, resolveSSM)]),
  );
}

/** Convert resolved environment scalars and reject unsupported objects safely. */
function resolveSamEnvironmentMap(
  environmentMap: Record<string, unknown> | undefined,
  baseEnvironment: Record<string, string> = {},
): Record<string, string> {
  const resolvedEnvironment: Record<string, string> = { ...baseEnvironment };
  if (!environmentMap) return resolvedEnvironment;

  for (const [variableKey, rawValue] of Object.entries(environmentMap)) {
    if (rawValue === undefined || rawValue === null) {
      resolvedEnvironment[variableKey] = "";
      continue;
    }

    const resolved = rawValue;
    if (resolved !== null && typeof resolved === "object") {
      throw new Error(
        `Unsupported or unresolved intrinsic/object in environment variable ${variableKey}. Declare a supported local resource or provide --cf-value LogicalId.Attribute=value (stack outputs: Outputs.OutputKey).`,
      );
    }
    resolvedEnvironment[variableKey] = String(resolved ?? "");
  }

  return resolvedEnvironment;
}

/**
 * Resolve the source handler relative to the effective SAM code directory.
 */
function resolveSamHandler(
  functionName: string,
  functionProperties: SamFunctionProperties,
  metadata?: SamResource["Metadata"],
): string {
  for (const field of ["Handler", "CodeUri"] as const) {
    if (functionProperties[field] !== undefined && typeof functionProperties[field] !== "string") {
      throw new Error(`Invalid ${field} for function ${functionName}; expected a string`);
    }
  }
  if (functionProperties.Handler !== undefined && !functionProperties.Handler.trim()) {
    throw new Error(`Invalid Handler for function ${functionName}; expected a non-empty string`);
  }

  const rawHandler = functionProperties.Handler || "index.handler";
  const codeUri = functionProperties.CodeUri?.trim();

  let fullHandler = rawHandler;
  const entryPoints =
    metadata?.BuildMethod === "esbuild" ? metadata.BuildProperties?.EntryPoints : undefined;
  if (entryPoints !== undefined) {
    if (
      !Array.isArray(entryPoints) ||
      entryPoints.length === 0 ||
      !entryPoints.every((entry): entry is string => typeof entry === "string" && !!entry.trim())
    ) {
      throw new Error(
        `Invalid esbuild EntryPoints for function ${functionName}; expected a non-empty array of file paths`,
      );
    }
    const dot = rawHandler.lastIndexOf(".");
    if (dot <= 0 || dot === rawHandler.length - 1) {
      throw new Error(`Invalid Handler for function ${functionName}; expected file.function`);
    }
    const moduleName = path.posix.basename(rawHandler.slice(0, dot).replace(/\\/g, "/"));
    const candidates = entryPoints.map(entry => entry.trim().replace(/\\/g, "/"));
    const matches =
      candidates.length === 1
        ? candidates
        : candidates.filter(
            entry => path.posix.basename(entry, path.posix.extname(entry)) === moduleName,
          );
    if (matches.length !== 1) {
      throw new Error(
        `Cannot select esbuild EntryPoints for function ${functionName}; use one entry point or a unique file matching the Handler module`,
      );
    }
    fullHandler = `${matches[0]}.${rawHandler.slice(dot + 1)}`;
  }

  // Entry points are relative to the function's effective code directory.
  if (codeUri && codeUri !== "." && codeUri !== "./") {
    // Normalize path separators.
    const normalizedUri = codeUri.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
    fullHandler = `${normalizedUri}/${fullHandler}`;
  }
  return fullHandler;
}

/** Normalize HTTP routes using the same handler as direct Lambda invocations. */
function extractSamFunctionRoutes(
  functionName: string,
  functionProperties: SamFunctionProperties,
  resolvedEnvironment: Record<string, string>,
  fullHandler: string,
): RouteDefinition[] {
  const routes: RouteDefinition[] = [];
  const rawEvents = functionProperties.Events;

  const eventEntries: SamEventDefinition[] = Array.isArray(rawEvents)
    ? rawEvents
    : Object.values(rawEvents || {});

  for (const event of eventEntries) {
    const eventType = event?.Type;
    if (eventType !== "Api" && eventType !== "HttpApi") continue;

    const properties = event.Properties || {};
    for (const field of ["Method", "Path"] as const) {
      if (properties[field] !== undefined && typeof properties[field] !== "string") {
        throw new Error(
          `Invalid SAM event ${field} for function ${functionName}; expected a string`,
        );
      }
    }
    const rawPath = properties.Path || "/";
    const method = (properties.Method || "ANY").toUpperCase();
    const formattedPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    const payload = properties.PayloadFormatVersion ?? "2.0";
    const payloadVersion =
      eventType === "Api"
        ? "1.0"
        : payload === 1 || payload === 2
          ? `${payload}.0`
          : String(payload);
    if (payloadVersion !== "1.0" && payloadVersion !== "2.0") {
      throw new Error("Unsupported HTTP API payload version; expected 1.0 or 2.0");
    }

    routes.push({
      functionName,
      method,
      path: formattedPath,
      handler: fullHandler,
      environment: resolvedEnvironment,
      payloadVersion,
    });
  }

  return routes;
}

function samScheduleScalar(value: unknown, field: string): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new Error(`${field} must resolve to a string.`);
}

function assertNoSamScheduleIntrinsic(value: unknown, field: string): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoSamScheduleIntrinsic(item, field);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key === "Ref" || key.startsWith("Fn::"))) {
    throw new Error(
      `${field} contains an unresolved intrinsic. Use supported references or a literal JSON value.`,
    );
  }
  for (const item of Object.values(record)) assertNoSamScheduleIntrinsic(item, field);
}

function parseSamScheduleInput(value: unknown, field: string): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    assertNoSamScheduleIntrinsic(value, field);
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${field} must be valid JSON text.`);
  }
}

function samScheduleEnabled(
  properties: NonNullable<SamEventDefinition["Properties"]>,
  eventType: "Schedule" | "ScheduleV2",
  field: string,
): boolean {
  if (eventType === "ScheduleV2" && properties.Enabled !== undefined) {
    throw new Error(`${field} uses State, not Enabled, for ScheduleV2.`);
  }
  if (
    eventType === "Schedule" &&
    properties.Enabled !== undefined &&
    properties.State !== undefined
  ) {
    throw new Error(`${field} must use Enabled or State, not both.`);
  }

  if (properties.Enabled !== undefined) {
    if (
      typeof properties.Enabled !== "boolean" &&
      properties.Enabled !== "true" &&
      properties.Enabled !== "false"
    ) {
      throw new Error(`${field} Enabled must be true or false.`);
    }
    return properties.Enabled === true || properties.Enabled === "true";
  }
  if (properties.State === undefined) return true;
  if (properties.State !== "ENABLED" && properties.State !== "DISABLED") {
    throw new Error(`${field} State accepts ENABLED or DISABLED.`);
  }
  return properties.State === "ENABLED";
}

function extractSamFunctionSchedules(
  functionName: string,
  functionProperties: SamFunctionProperties,
  handler: string,
  functionEnvironment: Record<string, string>,
  functionArn: string,
  options: ParserOptions,
): ScheduleDefinition[] {
  const schedules: ScheduleDefinition[] = [];
  const rawEvents = functionProperties.Events;
  const eventEntries: Array<[string, SamEventDefinition]> = Array.isArray(rawEvents)
    ? rawEvents.map((event, index) => [`Schedule${index + 1}`, event])
    : Object.entries(rawEvents || {});
  const partition = awsPartition(options.region);
  const account = "123456789012";

  for (const [eventKey, event] of eventEntries) {
    const eventType = event?.Type;
    if (eventType !== "Schedule" && eventType !== "ScheduleV2") continue;

    const properties = event.Properties || {};
    const fieldPrefix = `${eventType} for function ${functionName} (${eventKey})`;
    const isScheduler = eventType === "ScheduleV2";

    if (properties.FlexibleTimeWindow !== undefined) {
      const window = properties.FlexibleTimeWindow;
      if (!window || typeof window !== "object" || Array.isArray(window)) {
        throw new Error(`${fieldPrefix} FlexibleTimeWindow must be an object.`);
      }
      if (window.Mode !== undefined && window.Mode !== "OFF") {
        throw new Error(`${fieldPrefix} supports only FlexibleTimeWindow Mode OFF locally.`);
      }
    }
    if (properties.StartDate !== undefined || properties.EndDate !== undefined) {
      throw new Error(
        `${fieldPrefix} does not support StartDate/EndDate locally. Use the cron year field to bound a schedule.`,
      );
    }
    if (properties.DeadLetterConfig !== undefined || properties.RetryPolicy !== undefined) {
      throw new Error(
        `${fieldPrefix} does not emulate DeadLetterConfig or RetryPolicy. Remove them for local execution.`,
      );
    }
    if (properties.GroupName !== undefined && properties.GroupName !== "default") {
      throw new Error(`${fieldPrefix} supports only GroupName default locally.`);
    }

    const expression =
      eventType === "Schedule"
        ? samScheduleScalar(properties.Schedule, `${fieldPrefix} Schedule`)
        : samScheduleScalar(properties.ScheduleExpression, `${fieldPrefix} ScheduleExpression`);
    const timezone =
      eventType === "Schedule"
        ? "UTC"
        : properties.ScheduleExpressionTimezone === undefined
          ? "UTC"
          : samScheduleScalar(
              properties.ScheduleExpressionTimezone,
              `${fieldPrefix} ScheduleExpressionTimezone`,
            );

    try {
      parseRecurringExpression(expression, timezone);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid schedule for function ${functionName}: ${message}`);
    }

    const scheduleName =
      properties.Name === undefined
        ? validateScheduleName(
            boundedScheduleName(`${functionName}${eventKey}`),
            `Generated schedule name for function ${functionName}`,
          )
        : validateScheduleName(
            samScheduleScalar(properties.Name, `${fieldPrefix} Name`),
            `${fieldPrefix} Name`,
          );
    const description =
      properties.Description === undefined
        ? undefined
        : samScheduleScalar(properties.Description, `${fieldPrefix} Description`);
    if (description !== undefined && description.length > 512) {
      throw new Error(`${fieldPrefix} Description must be at most 512 characters.`);
    }

    schedules.push({
      functionName,
      handler,
      environment: functionEnvironment,
      arn: functionArn,
      scheduleName,
      expression,
      enabled: samScheduleEnabled(properties, eventType, fieldPrefix),
      method: isScheduler ? "scheduler" : "eventBus",
      timezone,
      description,
      input: parseSamScheduleInput(properties.Input, `${fieldPrefix} Input`),
      ruleArn: isScheduler
        ? `arn:${partition}:scheduler:${options.region}:${account}:schedule/default/${scheduleName}`
        : `arn:${partition}:events:${options.region}:${account}:rule/${scheduleName}`,
      region: options.region,
      account,
    });
  }

  return schedules;
}

/**
 * Load an AWS SAM template.
 */
export async function loadSamConfig(
  workingDirectory = process.cwd(),
  options: ParserOptions,
): Promise<LoadResult> {
  Object.assign(process.env, DEFAULT_OFFLINE_ENV);

  const templatePath = findSamTemplatePath(workingDirectory);
  const rawYamlContent = fs.readFileSync(templatePath, "utf-8");
  const initialConfig = parseYaml<SamTemplate>(rawYamlContent);

  const serviceName =
    initialConfig.Description?.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 30) ||
    path.basename(workingDirectory);

  const parameters = buildSamParameters(initialConfig.Parameters, options.params, options.stage);

  // SSM value parameters resolve their default path to the stored value, like ${ssm:...}.
  // CLI --param overrides are literal values and take precedence.
  const ssmValueParameters: Array<{ name: string; path: string }> = [];
  for (const [parameterName, parameterDefinition] of Object.entries(
    initialConfig.Parameters || {},
  )) {
    if (!isSsmValueParameterType(parameterDefinition.Type)) continue;
    if (options.params[parameterName] !== undefined) continue;
    const defaultPath =
      typeof parameterDefinition.Default === "string" ? parameterDefinition.Default.trim() : "";
    if (defaultPath) ssmValueParameters.push({ name: parameterName, path: defaultPath });
  }

  const templateResources = initialConfig.Resources || {};

  const references = new Map<string, string>();
  for (const [key, value] of Object.entries(options.cfValues || {})) references.set(key, value);

  const samOptions = {
    region: options.region,
    serviceName,
    resources: templateResources,
    references,
    strictReferences: Boolean(options.scheduler || options.cfValues),
  };

  // Discover SSM paths from parsed data, including explicit substitutions.
  const resolvedConfigPass1 = resolveSamData(initialConfig, { ...samOptions, parameters }, false);
  const ssmParameterPaths: string[] = [];
  resolveScalarData(resolvedConfigPass1, text => {
    ssmParameterPaths.push(...extractSSMPaths(text));
    return text;
  });
  ssmParameterPaths.push(...ssmValueParameters.map(entry => entry.path));
  const ssmValues = await resolveSSMValues(
    ssmParameterPaths,
    options.region,
    options.resolveSSM,
    workingDirectory,
  );

  for (const { name, path: parameterPath } of ssmValueParameters) {
    parameters[name] = resolveSsmParameterValue(parameterPath, ssmValues);
  }

  const fullSamOptions = {
    ...samOptions,
    ssmValues,
  };

  const finalConfig = resolveSamData(
    initialConfig,
    { ...fullSamOptions, parameters },
    true,
  ) as SamTemplate;

  // Export global function environment variables with default local offline flags.
  const globalSamEnv = finalConfig.Globals?.Function?.Environment?.Variables;
  const globalEnvironment = {
    ...DEFAULT_OFFLINE_ENV,
    ...resolveSamEnvironmentMap(globalSamEnv),
    ...options.envOverrides,
  };
  Object.assign(process.env, globalEnvironment);

  // Extract function routes and declared schedules.
  const routeDefinitions: RouteDefinition[] = [];
  const functions: FunctionDefinition[] = [];
  const scheduleDefinitions: ScheduleDefinition[] = [];
  const makefileHandlers: MakefileHandlerDefinition[] = [];
  const arns = new Set<string>();
  const resources = finalConfig.Resources || {};
  const makeCommand = options.makefile
    ? (options.makeCommand ?? resolveGnuMakeCommand().command)
    : undefined;

  if (options.makefile) {
    const makefilePath = path.join(workingDirectory, "Makefile");
    if (!fs.existsSync(makefilePath) || !fs.statSync(makefilePath).isFile()) {
      throw new Error(
        `--makefile requires a Makefile at ${makefilePath}. Remove --makefile or place the Makefile at the project root.`,
      );
    }
  }

  for (const [resourceName, resourceConfig] of Object.entries(resources)) {
    const resourceType = resourceConfig?.Type;
    if (resourceType !== "AWS::Serverless::Function" && resourceType !== "AWS::Lambda::Function") {
      continue;
    }

    const properties: SamFunctionProperties = {
      ...(resourceType === "AWS::Serverless::Function"
        ? { CodeUri: finalConfig.Globals?.Function?.CodeUri }
        : {}),
      ...resourceConfig.Properties,
    };
    const functionEnv = resolveSamEnvironmentMap(
      properties.Environment?.Variables,
      globalEnvironment,
    );
    // Explicit CLI environment overrides win over global and function environments.
    Object.assign(functionEnv, options.envOverrides);

    let handler = resolveSamHandler(resourceName, properties, resourceConfig.Metadata);
    if (
      resourceType === "AWS::Serverless::Function" &&
      options.makefile &&
      resourceConfig.Metadata?.BuildMethod?.toLowerCase() === "makefile"
    ) {
      const resolved = resolveMakefileHandler({
        workingDirectory,
        logicalId: resourceName,
        handler,
        makeCommand: makeCommand!,
      });
      handler = resolved.handler;
      makefileHandlers.push({
        functionName: resourceName,
        sourceFile: resolved.sourceFile,
        handler,
      });
    }
    const functionRoutes = extractSamFunctionRoutes(resourceName, properties, functionEnv, handler);
    const name = resolveCloudFormationRef(resourceName, { ...fullSamOptions, parameters });
    if (typeof name !== "string" || !/^[\w-]{1,64}$/.test(name))
      throw new Error(
        `Invalid FunctionName for ${resourceName}; use 1-64 letters, digits, underscores or hyphens.`,
      );
    const arn = resolveCloudFormationGetAtt(resourceName, "Arn", {
      ...fullSamOptions,
      parameters,
    })!;
    if (arns.has(arn)) throw new Error(`Duplicate FunctionName for ${resourceName}.`);
    arns.add(arn);
    functions.push({
      functionName: resourceName,
      arn,
      handler,
      environment: functionEnv,
    });
    for (const route of functionRoutes) route.arn = arn;
    routeDefinitions.push(...functionRoutes);
    if (options.cron) {
      scheduleDefinitions.push(
        ...extractSamFunctionSchedules(
          resourceName,
          properties,
          handler,
          functionEnv,
          arn,
          options,
        ),
      );
    }
  }

  const seenScheduleNames = new Map<string, string>();
  for (const schedule of scheduleDefinitions) {
    const key = `${schedule.method}:${schedule.scheduleName}`;
    const previousFunction = seenScheduleNames.get(key);
    if (previousFunction !== undefined) {
      throw new Error(
        `Duplicate ${schedule.method} schedule name ${schedule.scheduleName} in functions ${previousFunction} and ${schedule.functionName}. Use a unique name per method.`,
      );
    }
    seenScheduleNames.set(key, schedule.functionName);
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
    functions,
    schedules: scheduleDefinitions,
    makefileHandlers,
    globalEnv: globalEnvironment,
    framework: "sam",
  };
}
