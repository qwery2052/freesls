import fs from "node:fs";
import path from "node:path";
import type { ServerlessConfig, RouteDefinition, LoadResult } from "./types.js";
import { parseYaml, resolveSSMValues, type ParserOptions } from "./parser.js";
import { extractSSMPaths, resolveScalarData } from "./resolver.js";

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
  Properties?: Record<string, any>;
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

  // CloudFormation pseudo parameters.
  if (trimmedRef === "AWS::Region") return options.region;
  if (trimmedRef === "AWS::AccountId") return "123456789012";
  if (trimmedRef === "AWS::StackName") return options.serviceName;
  if (trimmedRef === "AWS::Partition") return "aws";
  if (trimmedRef === "AWS::URLSuffix") return "amazonaws.com";
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
  const targetResource = options.resources?.[resourceName];
  if (!targetResource) {
    return null;
  }

  const resourceType = targetResource.Type || "";
  const resourceProperties = targetResource.Properties || {};

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
          `${options.serviceName}-${resourceName}`,
          options,
        );
        return `arn:aws:iam::123456789012:role/${roleName}`;
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
        return `arn:aws:custom:${options.region}:123456789012:${resourceName.toLowerCase()}`;
    }
  }

  if (attributeName === "QueueUrl" && resourceType === "AWS::SQS::Queue") {
    return resolveCloudFormationRef(resourceName, options);
  }

  return `${resourceName}.${attributeName}`;
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
        `Unsupported or unresolved intrinsic/object in environment variable ${variableKey}`,
      );
    }
    resolvedEnvironment[variableKey] = String(resolved ?? "");
  }

  return resolvedEnvironment;
}

/**
 * Normalize HTTP routes for a SAM function.
 */
function extractSamFunctionRoutes(
  functionName: string,
  functionProperties: SamFunctionProperties,
  resolvedEnvironment: Record<string, string>,
): RouteDefinition[] {
  const routes: RouteDefinition[] = [];
  const rawEvents = functionProperties.Events;
  if (!rawEvents) return routes;

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

  // Include the function's code directory.
  let fullHandler = rawHandler;
  if (codeUri && codeUri !== "." && codeUri !== "./") {
    // Normalize path separators.
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

/**
 * Load an AWS SAM template.
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

  const parameters = buildSamParameters(initialConfig.Parameters, options.params, options.stage);

  const templateResources = initialConfig.Resources || {};

  const samOptions = {
    region: options.region,
    serviceName,
    resources: templateResources,
  };

  // Discover SSM paths from parsed data, including explicit substitutions.
  const resolvedConfigPass1 = resolveSamData(initialConfig, { ...samOptions, parameters }, false);
  const ssmParameterPaths: string[] = [];
  resolveScalarData(resolvedConfigPass1, text => {
    ssmParameterPaths.push(...extractSSMPaths(text));
    return text;
  });
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

  const finalConfig = resolveSamData(
    initialConfig,
    { ...fullSamOptions, parameters },
    true,
  ) as SamTemplate;

  // Export global function environment variables.
  const globalSamEnv = finalConfig.Globals?.Function?.Environment?.Variables;
  const globalEnvironment = resolveSamEnvironmentMap(globalSamEnv);
  Object.assign(process.env, globalEnvironment);

  // Extract function routes.
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
