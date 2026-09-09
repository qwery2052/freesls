import express, { type Request, type Response, type NextFunction } from "express";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import pc from "picocolors";
import { createJiti } from "jiti";
import type {
  RouteDefinition,
  APIGatewayProxyEvent,
  APIGatewayProxyEventV2,
  LambdaContext,
  ServerOptions,
} from "./types.js";
import { formatMethod } from "./printer.js";
import { createTypeScriptTransform } from "./typescript-transform.js";

const DEFAULT_TIMEOUT_MILLISECONDS = 30000;
const SUPPORTED_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs", ".tsx", ".jsx"];
let invocationQueue: Promise<unknown> = Promise.resolve();

/**
 * Quote parameter names for Express 5, including names with hyphens or digits.
 */
export function serverlessPathToExpressPath(serverlessPath: string): string {
  return serverlessPath
    .replace(/\{([a-zA-Z0-9_-]+)\+\}/g, '*"$1"')
    .replace(/\{([a-zA-Z0-9_-]+)\}/g, ':"$1"');
}

/**
 * Normalize an optional base path prefix (e.g. "medical-history-app" -> "/medical-history-app").
 */
export function normalizeBasePath(basePath?: string): string {
  if (!basePath) return "";
  const trimmed = basePath.trim().replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}` : "";
}

/**
 * Safely combine a base path prefix and a route path without duplicate slashes.
 */
export function combinePaths(basePath?: string, routePath = ""): string {
  const normalizedBase = normalizeBasePath(basePath);
  const normalizedRoute = routePath.startsWith("/") ? routePath : `/${routePath}`;
  if (!normalizedBase) {
    return normalizedRoute;
  }
  if (normalizedRoute === "/") {
    return normalizedBase;
  }
  return `${normalizedBase}${normalizedRoute}`;
}

/**
 * Resolve TypeScript or JavaScript handler files relative to the project.
 */
export function resolveHandlerPath(
  workingDirectory: string,
  handlerExpression: string,
): { filePath: string; functionName: string } {
  const lastDotIndex = handlerExpression.lastIndexOf(".");
  if (lastDotIndex === -1) {
    throw new Error(`Invalid handler: "${handlerExpression}". Expected "file.function"`);
  }

  const relativeFilePath = handlerExpression.substring(0, lastDotIndex);
  const targetFunctionName = handlerExpression.substring(lastDotIndex + 1);

  const candidateFilePaths = [
    path.resolve(workingDirectory, relativeFilePath),
    ...SUPPORTED_EXTENSIONS.map(extension =>
      path.resolve(workingDirectory, `${relativeFilePath}${extension}`),
    ),
    ...SUPPORTED_EXTENSIONS.map(extension =>
      path.resolve(workingDirectory, relativeFilePath, `index${extension}`),
    ),
    ...[".js", ".mjs", ".cjs"].map(extension =>
      path.resolve(workingDirectory, "dist", `${relativeFilePath}${extension}`),
    ),
  ];

  for (const candidateFilePath of candidateFilePaths) {
    if (fs.existsSync(candidateFilePath) && fs.statSync(candidateFilePath).isFile()) {
      return { filePath: candidateFilePath, functionName: targetFunctionName };
    }
  }

  throw new Error(`Handler file not found for "${handlerExpression}" in "${workingDirectory}"`);
}

/**
 * Normalize Express wildcard arrays into API Gateway path parameters.
 */
function extractPathParameters(
  rawParams: Record<string, string | string[] | undefined>,
): Record<string, string> | null {
  const normalizedParams: Record<string, string> = {};

  for (const [parameterKey, parameterValue] of Object.entries(rawParams)) {
    if (Array.isArray(parameterValue)) {
      normalizedParams[parameterKey] = parameterValue.join("/");
    } else if (typeof parameterValue === "string") {
      normalizedParams[parameterKey] = parameterValue;
    }
  }

  return Object.keys(normalizedParams).length > 0 ? normalizedParams : null;
}

/**
 * Preserve repeated query values without Express query-parser coercion.
 */
function extractQueryParameters(rawQuery: string): {
  queryStringParameters: Record<string, string> | null;
  multiValueQueryStringParameters: Record<string, string[]> | null;
} {
  const queryStringParameters: Record<string, string> = Object.create(null);
  const multiValueQueryStringParameters: Record<string, string[]> = Object.create(null);

  for (const [queryKey, queryValue] of new URLSearchParams(rawQuery)) {
    (multiValueQueryStringParameters[queryKey] ??= []).push(queryValue);
    queryStringParameters[queryKey] = queryValue;
  }

  return {
    queryStringParameters:
      Object.keys(queryStringParameters).length > 0 ? queryStringParameters : null,
    multiValueQueryStringParameters:
      Object.keys(multiValueQueryStringParameters).length > 0
        ? multiValueQueryStringParameters
        : null,
  };
}

/**
 * Use raw headers because Node combines or discards some duplicate headers.
 */
function extractHeaders(rawHeaders: string[]): {
  headers: Record<string, string>;
  multiValueHeaders: Record<string, string[]>;
} {
  const headers: Record<string, string> = Object.create(null);
  const multiValueHeaders: Record<string, string[]> = Object.create(null);

  for (let index = 0; index < rawHeaders.length; index += 2) {
    const key = rawHeaders[index].toLowerCase();
    (multiValueHeaders[key] ??= []).push(rawHeaders[index + 1]);
    headers[key] = rawHeaders[index + 1];
  }

  return { headers, multiValueHeaders };
}

/**
 * Serialize across all apps: process.env is shared by the entire process.
 */
function withTemporaryEnvironment<ExecutionResult>(
  targetEnvironment: Record<string, string>,
  executionCallback: () => Promise<ExecutionResult>,
): Promise<ExecutionResult> {
  const execution = invocationQueue.then(async () => {
    const originalEnvironmentBackup = { ...process.env };

    for (const [envKey, envValue] of Object.entries(targetEnvironment)) {
      process.env[envKey] = envValue;
    }

    try {
      return await executionCallback();
    } finally {
      for (const envKey of Object.keys(process.env)) {
        if (!(envKey in originalEnvironmentBackup)) delete process.env[envKey];
      }
      for (const [envKey, originalValue] of Object.entries(originalEnvironmentBackup)) {
        if (originalValue === undefined) {
          delete process.env[envKey];
        } else {
          process.env[envKey] = originalValue;
        }
      }
    }
  });
  invocationQueue = execution.catch(() => {});
  return execution;
}

/**
 * Build the core REST API (v1) or HTTP API (v2) payload.
 */
function buildApiGatewayEvent(
  request: Request,
  routeDefinition: RouteDefinition,
  options: ServerOptions,
): APIGatewayProxyEvent | APIGatewayProxyEventV2 {
  const pathParameters = extractPathParameters(request.params);
  const rawQueryString = request.originalUrl.split("?").slice(1).join("?");
  const { queryStringParameters, multiValueQueryStringParameters } =
    extractQueryParameters(rawQueryString);
  const { headers, multiValueHeaders } = extractHeaders(request.rawHeaders);

  let bodyString: string | null = null;
  const contentType = (request.get("content-type") || "").split(";")[0].trim().toLowerCase();
  // Without binary-media configuration, infer text from the content type.
  const isText =
    contentType.startsWith("text/") ||
    /(?:json|xml|javascript|x-www-form-urlencoded)$/.test(contentType);
  let isBase64Encoded = false;
  if (request.body && Buffer.isBuffer(request.body) && request.body.length > 0) {
    isBase64Encoded = !isText;
    bodyString = request.body.toString(isBase64Encoded ? "base64" : "utf8");
  }

  if (routeDefinition.payloadVersion === "2.0") {
    for (const [key, values] of Object.entries(multiValueHeaders)) headers[key] = values.join(",");
    const cookies = multiValueHeaders.cookie?.flatMap(value =>
      value
        .split(";")
        .map(cookie => cookie.trim())
        .filter(Boolean),
    );
    delete headers.cookie;
    const routeKey = `${routeDefinition.method.toUpperCase()} ${routeDefinition.path}`;
    return {
      version: "2.0",
      routeKey,
      rawPath: request.path,
      rawQueryString,
      headers,
      ...(cookies?.length ? { cookies } : {}),
      ...(pathParameters ? { pathParameters } : {}),
      ...(multiValueQueryStringParameters
        ? {
            queryStringParameters: Object.fromEntries(
              Object.entries(multiValueQueryStringParameters).map(([key, values]) => [
                key,
                values.join(","),
              ]),
            ),
          }
        : {}),
      body: bodyString,
      isBase64Encoded,
      requestContext: {
        accountId: "offlineContext_accountId",
        apiId: "offlineContext_apiId",
        domainName: request.hostname,
        domainPrefix: "offline",
        routeKey,
        stage: options.stage || "dev",
        requestId: crypto.randomUUID(),
        time: new Date().toUTCString(),
        timeEpoch: Date.now(),
        http: {
          method: request.method,
          path: request.path,
          protocol: `HTTP/${request.httpVersion}`,
          sourceIp: request.ip || "127.0.0.1",
          userAgent: request.get("user-agent") || "",
        },
      },
    };
  }

  return {
    body: bodyString,
    headers,
    multiValueHeaders,
    httpMethod: request.method.toUpperCase(),
    isBase64Encoded,
    path: request.path,
    pathParameters,
    queryStringParameters,
    multiValueQueryStringParameters,
    stageVariables: null,
    requestContext: {
      accountId: "offlineContext_accountId",
      apiId: "offlineContext_apiId",
      httpMethod: request.method.toUpperCase(),
      identity: {
        sourceIp: request.ip || "127.0.0.1",
        userAgent: request.get("user-agent") || "",
      },
      path: request.path,
      protocol: `HTTP/${request.httpVersion}`,
      requestId: `offline_${crypto.randomUUID()}`,
      requestTimeEpoch: Date.now(),
      resourceId: "offlineContext_resourceId",
      resourcePath: routeDefinition.path,
      stage: options.stage || "dev",
    },
    resource: routeDefinition.path,
  };
}

/**
 * The remaining time is advisory only; in-process execution cannot be cancelled.
 */
function buildLambdaContext(
  routeDefinition: RouteDefinition,
  options: ServerOptions,
  startTime: number,
  complete: LambdaContext["done"],
): LambdaContext {
  return {
    functionName: routeDefinition.functionName,
    functionVersion: "$LATEST",
    invokedFunctionArn: `arn:aws:lambda:${options.region || "us-east-1"}:123456789012:function:${routeDefinition.functionName}`,
    memoryLimitInMB: "1024",
    awsRequestId: crypto.randomUUID(),
    logGroupName: `/aws/lambda/${routeDefinition.functionName}`,
    logStreamName: `[$LATEST]${crypto.randomBytes(16).toString("hex")}`,
    getRemainingTimeInMillis: () =>
      Math.max(0, DEFAULT_TIMEOUT_MILLISECONDS - (Date.now() - startTime)),
    callbackWaitsForEmptyEventLoop: false,
    done: complete,
    fail: error => complete(normalizeError(error)),
    succeed: result => complete(null, result),
  };
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  let message: string;
  try {
    message = typeof error === "string" ? error : (JSON.stringify(error) ?? String(error));
  } catch {
    message = "Unknown handler error";
  }
  return new Error(message);
}

type LambdaHandler = (
  event: APIGatewayProxyEvent | APIGatewayProxyEventV2,
  context: LambdaContext,
  callback: LambdaContext["done"],
) => unknown;

// First completion wins. A bare undefined return waits for callback/context completion.
// Detached work and event-loop draining are not tracked; never release the queue on a timer.
function invokeLambdaHandler(
  handlerFunction: LambdaHandler,
  event: APIGatewayProxyEvent | APIGatewayProxyEventV2,
  route: RouteDefinition,
  options: ServerOptions,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const complete: LambdaContext["done"] = (error, result) => {
      if (error !== undefined && error !== null) reject(normalizeError(error));
      else resolve(result);
    };
    const context = buildLambdaContext(route, options, Date.now(), complete);
    try {
      const result = handlerFunction(event, context, complete);
      if (result !== undefined)
        Promise.resolve(result).then(resolve, error => reject(normalizeError(error)));
    } catch (error) {
      reject(normalizeError(error));
    }
  });
}

/**
 * Infer API Gateway default Content-Type when omitted by the handler.
 */
function inferContentType(body: string): string {
  const trimmed = body.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      JSON.parse(trimmed);
      return "application/json";
    } catch {
      // Not valid JSON
    }
  }
  return "text/plain";
}

/**
 * Serialize proxy responses, retaining v1 multi-value precedence and v2 cookies.
 */
function sendLambdaResponse(
  response: Response,
  result: unknown,
  payloadVersion: RouteDefinition["payloadVersion"],
): void {
  const lambdaResult =
    result !== null && typeof result === "object" ? (result as Record<string, unknown>) : {};
  if (payloadVersion === "2.0" && lambdaResult.statusCode === undefined) {
    response
      .status(200)
      .type("application/json")
      .send(JSON.stringify(result) ?? "");
    return;
  }
  const statusCode = typeof lambdaResult.statusCode === "number" ? lambdaResult.statusCode : 200;

  if (lambdaResult.headers && typeof lambdaResult.headers === "object") {
    for (const [headerKey, headerValue] of Object.entries(lambdaResult.headers)) {
      if (headerValue !== undefined && headerValue !== null) {
        response.setHeader(headerKey, String(headerValue));
      }
    }
  }

  if (
    payloadVersion !== "2.0" &&
    lambdaResult.multiValueHeaders &&
    typeof lambdaResult.multiValueHeaders === "object"
  ) {
    for (const [headerKey, headerValue] of Object.entries(lambdaResult.multiValueHeaders)) {
      if (Array.isArray(headerValue)) {
        response.setHeader(headerKey, headerValue.map(String));
      }
    }
  }

  if (payloadVersion === "2.0" && Array.isArray(lambdaResult.cookies)) {
    response.setHeader("Set-Cookie", lambdaResult.cookies.map(String));
  }

  response.status(statusCode);

  if (lambdaResult?.isBase64Encoded && typeof lambdaResult?.body === "string") {
    response.send(Buffer.from(lambdaResult.body, "base64"));
  } else if (typeof lambdaResult?.body === "string") {
    if (!response.getHeader("content-type")) {
      response.setHeader("Content-Type", inferContentType(lambdaResult.body));
    }
    response.send(lambdaResult.body);
  } else if (lambdaResult?.body !== undefined) {
    response.json(lambdaResult.body);
  } else if (
    lambdaResult.statusCode === undefined &&
    result !== undefined &&
    typeof result === "object"
  ) {
    response.json(result);
  } else {
    response.end();
  }
}

/**
 * Create the local HTTP application.
 */
export function createServerApp(
  routes: RouteDefinition[],
  options: ServerOptions,
): express.Express {
  const app = express();

  app.use(express.raw({ type: () => true, limit: "10mb" }));

  // Source maps preserve in-process debugging. Transformed modules reload, but
  // Jiti's native ESM/CJS paths still cache modules and their import-time env.
  // Functions sharing native files/dependencies must not rely on isolated snapshots.
  const jitiRuntime = createJiti(options.workingDir, {
    sourceMaps: true,
    tsconfigPaths: true,
    moduleCache: false,
    fsCache: false,
    tryNative: false,
  });
  jitiRuntime.options.transform = createTypeScriptTransform(jitiRuntime.options.transform!);

  // Wildcard origins cannot be combined with credentialed CORS.
  app.use((request: Request, response: Response, nextFunction: NextFunction) => {
    response.header("Access-Control-Allow-Origin", "*");
    response.header(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Amz-Date, X-Api-Key, X-Amz-Security-Token",
    );
    response.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD");

    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }
    nextFunction();
  });

  const basePath = normalizeBasePath(options.basePath);

  for (const route of routes) {
    const expressPath = combinePaths(basePath, serverlessPathToExpressPath(route.path));
    const normalizedMethod = route.method.toLowerCase();

    const handlerMiddleware = async (request: Request, response: Response) => {
      const startTime = Date.now();

      try {
        const { filePath, functionName } = resolveHandlerPath(options.workingDir, route.handler);

        const lambdaResult = await withTemporaryEnvironment(route.environment, async () => {
          const importedModule = await jitiRuntime.import<Record<string, unknown>>(filePath);
          const defaultExport = importedModule.default;
          const targetHandler =
            importedModule[functionName] ||
            (defaultExport && typeof defaultExport === "object"
              ? (defaultExport as Record<string, unknown>)[functionName]
              : undefined) ||
            (functionName === "default" ? importedModule.default : undefined);

          if (typeof targetHandler !== "function") {
            throw new Error(
              `Function "${functionName}" was not exported by "${filePath}". Available exports: ${Object.keys(importedModule).join(", ")}`,
            );
          }

          const apiGatewayEvent = buildApiGatewayEvent(request, route, options);
          return invokeLambdaHandler(
            targetHandler as LambdaHandler,
            apiGatewayEvent,
            route,
            options,
          );
        });

        sendLambdaResponse(response, lambdaResult, route.payloadVersion ?? "1.0");

        const executionDuration = Date.now() - startTime;
        const statusCode = response.statusCode;
        const statusColor = statusCode >= 500 ? pc.red : statusCode >= 400 ? pc.yellow : pc.green;

        console.log(
          `  ${formatMethod(request.method)} ${pc.white(request.path)} ${statusColor(`${statusCode}`)} ${pc.dim(`(${executionDuration}ms)`)}`,
        );
      } catch (error) {
        const executionError = normalizeError(error);
        const executionDuration = Date.now() - startTime;
        console.error(
          `\n  ${pc.bgRed(pc.white(" LAMBDA ERROR "))} ${pc.bold(pc.white(route.functionName))} ${pc.dim(`(${executionDuration}ms)`)}`,
        );
        console.error(
          pc.red(`  ${executionError.stack || executionError.message || executionError}\n`),
        );

        if (!response.headersSent) {
          response.status(500).json({
            errorMessage: executionError.message,
            errorType: executionError.name || "Error",
            stackTrace: executionError.stack ? executionError.stack.split("\n") : [],
          });
        }
      }
    };

    if (normalizedMethod === "any") {
      app.all(expressPath, handlerMiddleware);
    } else {
      app.all(expressPath, (request, response, next) => {
        if (
          request.method.toLowerCase() === normalizedMethod ||
          (normalizedMethod === "get" && request.method === "HEAD")
        ) {
          return handlerMiddleware(request, response);
        }
        next();
      });
    }
  }

  app.use((request: Request, response: Response) => {
    console.log(
      `  ${formatMethod(request.method)} ${pc.dim(request.path)} ${pc.yellow("404 Not Found")}`,
    );
    response.status(404).json({
      message: `Route not found in FreeSLS: ${request.method} ${request.path}`,
    });
  });

  return app;
}

/**
 * Start the local HTTP server on the requested port.
 */
export async function startServer(
  routes: RouteDefinition[],
  port: number,
  workingDirectory: string,
  options: { stage?: string; region?: string; basePath?: string } = {},
): Promise<http.Server> {
  const app = createServerApp(routes, {
    port,
    workingDir: workingDirectory,
    stage: options.stage,
    region: options.region,
    basePath: options.basePath,
  });

  return new Promise((resolve, reject) => {
    const serverInstance = http.createServer(app);

    serverInstance.on("error", (serverError: NodeJS.ErrnoException) => {
      if (serverError.code === "EADDRINUSE") {
        console.error(pc.red(`\n[FreeSLS Error] Port ${pc.bold(port)} is already in use.\n`));
      } else {
        console.error(pc.red(`\n[FreeSLS Server Error] ${serverError.message}\n`));
      }
      reject(serverError);
    });

    serverInstance.listen(port, () => {
      resolve(serverInstance);
    });
  });
}
