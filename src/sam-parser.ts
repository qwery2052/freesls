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

export interface SamResolutionOptions {
  region: string;
  serviceName: string;
  parameters: Record<string, string>;
  resources?: Record<string, SamResource>;
  ssmValues?: Map<string, string>;
}

/**
 * Resuelve el valor de un parámetro SSM desde el mapa consultado o genera un mock declarativo.
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
 * Resuelve una propiedad de texto de un recurso, quitando comillas y resolviendo variables internas.
 */
function resolveTemplatePropertyString(
  propertyValue: unknown,
  fallbackValue: string,
  options: SamResolutionOptions,
): string {
  if (typeof propertyValue === "string") {
    const cleanPropertyValue = propertyValue.replace(/^['"]|['"]$/g, "");
    return resolveSamVariables(cleanPropertyValue, options.parameters, options, false);
  }
  return fallbackValue;
}

/**
 * Resuelve una referencia CloudFormation (!Ref o { Ref }) hacia pseudo-parámetros,
 * parámetros de usuario, variables de entorno o recursos.
 */
function resolveCloudFormationRef(
  referenceName: string,
  options: SamResolutionOptions,
): string | null {
  const trimmedRef = referenceName.trim();

  // 1. CloudFormation Pseudo Parameters
  if (trimmedRef === "AWS::Region") return options.region;
  if (trimmedRef === "AWS::AccountId") return "123456789012";
  if (trimmedRef === "AWS::StackName") return options.serviceName;
  if (trimmedRef === "AWS::Partition") return "aws";
  if (trimmedRef === "AWS::URLSuffix") return "amazonaws.com";
  if (trimmedRef === "AWS::NoValue") return "";

  // 2. Parámetros del template o del CLI
  if (options.parameters[trimmedRef] !== undefined) {
    return options.parameters[trimmedRef];
  }

  // 3. Variables de entorno del sistema
  if (process.env[trimmedRef] !== undefined) {
    return process.env[trimmedRef]!;
  }

  // 4. Recursos del template
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
        if (typeof resourceProperties.Name === "string") {
          return resolveTemplatePropertyString(resourceProperties.Name, trimmedRef, options);
        }
        return trimmedRef;
      }
    }
  }

  return null;
}

/**
 * Resuelve un atributo de un recurso CloudFormation (!GetAtt o { "Fn::GetAtt" }).
 */
function resolveCloudFormationGetAtt(
  resourceName: string,
  attributeName: string,
  options: SamResolutionOptions,
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
 * Resuelve variables de estilo CloudFormation/SAM, SSM y funciones intrínsecas en strings:
 * ${AWS::Region}, ${AWS::AccountId}, ${Stage}, ${param}, ${ssm:/path},
 * {{resolve:ssm:...}}, !Ref, !GetAtt
 */
export function resolveSamVariables(
  text: string,
  parameters: Record<string, string>,
  options: {
    region: string;
    serviceName: string;
    ssmValues?: Map<string, string>;
    resources?: Record<string, SamResource>;
  },
  resolveSSM = true,
): string {
  const resolutionOptions: SamResolutionOptions = {
    ...options,
    parameters,
  };

  let currentResult = text;
  let iterationCount = 0;
  const maxIterations = 10;

  // 1. Resolver Dynamic References de CloudFormation: {{resolve:ssm:...}} y {{resolve:ssm-secure:...}}
  const dynamicSsmRegex = /\{\{\s*resolve:ssm(?:-secure)?:\s*([^}:]+)(?::[^}]+)?\s*\}\}/g;
  if (resolveSSM) {
    currentResult = currentResult.replace(dynamicSsmRegex, (_fullMatch, parameterPath) => {
      return resolveSsmParameterValue(parameterPath, options.ssmValues);
    });
  }

  // 2. Resolver funciones intrínsecas en sintaxis YAML (!Ref y !GetAtt)
  currentResult = currentResult.replace(
    /!Ref\s+['"]?([a-zA-Z0-9_:]+)['"]?/g,
    (fullMatch, refIdentifier) => {
      const resolvedRef = resolveCloudFormationRef(refIdentifier, resolutionOptions);
      return resolvedRef !== null ? `'${resolvedRef.replace(/'/g, "''")}'` : fullMatch;
    },
  );

  currentResult = currentResult.replace(
    /!GetAtt\s+['"]?([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)['"]?/g,
    (fullMatch, resourceName, attributeName) => {
      const resolvedGetAtt = resolveCloudFormationGetAtt(
        resourceName,
        attributeName,
        resolutionOptions,
      );
      return resolvedGetAtt !== null ? `'${resolvedGetAtt.replace(/'/g, "''")}'` : fullMatch;
    },
  );

  currentResult = currentResult.replace(
    /!GetAtt\s*\[\s*['"]?([a-zA-Z0-9_]+)['"]?\s*,\s*['"]?([a-zA-Z0-9_]+)['"]?\s*\]/g,
    (fullMatch, resourceName, attributeName) => {
      const resolvedGetAtt = resolveCloudFormationGetAtt(
        resourceName,
        attributeName,
        resolutionOptions,
      );
      return resolvedGetAtt !== null ? `'${resolvedGetAtt.replace(/'/g, "''")}'` : fullMatch;
    },
  );

  // 3. Resolver variables anidadas ${...}
  const innermostRegex = resolveSSM ? /\$\{([^{}]+)\}/g : /\$\{\s*(?!ssm:)([^{}]+)\}/g;

  let previousResult = "";
  while (currentResult !== previousResult && iterationCount < maxIterations) {
    previousResult = currentResult;
    currentResult = currentResult.replace(innermostRegex, (fullMatch, expression) => {
      const trimmedExpression = expression.trim();

      // SSM estilo Serverless Framework: ${ssm:...}
      if (trimmedExpression.startsWith("ssm:")) {
        if (!resolveSSM) return fullMatch;
        const ssmPath = trimmedExpression.slice(4).split("~")[0].trim();
        return resolveSsmParameterValue(ssmPath, options.ssmValues);
      }

      // Referencia a atributo de recurso estilo CloudFormation Sub: ${Resource.Attribute}
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

      // Parámetros de SAM, pseudo-parámetros, variables de entorno o recursos directos
      const resolvedRef = resolveCloudFormationRef(trimmedExpression, resolutionOptions);
      if (resolvedRef !== null) {
        return resolvedRef;
      }

      return fullMatch;
    });
    iterationCount++;
  }

  // 4. Re-intentar resolver Dynamic References si se interpolaron variables previas (ej. ${Stage})
  if (resolveSSM) {
    currentResult = currentResult.replace(dynamicSsmRegex, (_fullMatch, parameterPath) => {
      return resolveSsmParameterValue(parameterPath, options.ssmValues);
    });
  }

  return currentResult;
}

/**
 * Resuelve un diccionario de variables de entorno para SAM.
 */
function resolveSamEnvironmentMap(
  environmentMap: Record<string, unknown> | undefined,
  parameters: Record<string, string>,
  options: {
    region: string;
    serviceName: string;
    ssmValues?: Map<string, string>;
    resources?: Record<string, SamResource>;
  },
  baseEnvironment: Record<string, string> = {},
): Record<string, string> {
  const resolvedEnvironment: Record<string, string> = { ...baseEnvironment };
  if (!environmentMap) return resolvedEnvironment;

  const resolutionOptions: SamResolutionOptions = {
    ...options,
    parameters,
  };

  for (const [variableKey, rawValue] of Object.entries(environmentMap)) {
    if (rawValue === undefined || rawValue === null) {
      resolvedEnvironment[variableKey] = "";
      continue;
    }

    // 1. Manejo de objetos intrínsecos de CloudFormation (ej: { Ref: "Stage" })
    if (typeof rawValue === "object") {
      const objectValue = rawValue as Record<string, any>;
      if (typeof objectValue.Ref === "string") {
        const resolvedRef = resolveCloudFormationRef(objectValue.Ref, resolutionOptions);
        resolvedEnvironment[variableKey] = resolvedRef ?? objectValue.Ref;
        continue;
      }
      if (objectValue["Fn::GetAtt"]) {
        const getAttTarget = objectValue["Fn::GetAtt"];
        if (Array.isArray(getAttTarget) && getAttTarget.length === 2) {
          const resolvedGetAtt = resolveCloudFormationGetAtt(
            String(getAttTarget[0]),
            String(getAttTarget[1]),
            resolutionOptions,
          );
          resolvedEnvironment[variableKey] =
            resolvedGetAtt ?? `${getAttTarget[0]}.${getAttTarget[1]}`;
          continue;
        }
        if (typeof getAttTarget === "string" && getAttTarget.includes(".")) {
          const [resourceName, attributeName] = getAttTarget.split(".");
          const resolvedGetAtt = resolveCloudFormationGetAtt(
            resourceName,
            attributeName,
            resolutionOptions,
          );
          resolvedEnvironment[variableKey] = resolvedGetAtt ?? getAttTarget;
          continue;
        }
      }
    }

    // 2. Manejo de strings
    const stringValue = String(rawValue);

    // Fallback declarativo: si la cadena coincide exactamente con un parámetro o recurso
    if (parameters[stringValue] !== undefined) {
      resolvedEnvironment[variableKey] = parameters[stringValue];
      continue;
    }
    if (options.resources?.[stringValue]) {
      const resolvedResourceRef = resolveCloudFormationRef(stringValue, resolutionOptions);
      if (resolvedResourceRef !== null) {
        resolvedEnvironment[variableKey] = resolvedResourceRef;
        continue;
      }
    }

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

  const parameters = buildSamParameters(initialConfig.Parameters, options.params, options.stage);

  const templateResources = initialConfig.Resources || {};

  const samOptions = {
    region: options.region,
    serviceName,
    resources: templateResources,
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
  const globalEnvironment = resolveSamEnvironmentMap(globalSamEnv, parameters, fullSamOptions);
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
