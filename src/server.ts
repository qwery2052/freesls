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
  APIGatewayProxyResult,
  LambdaContext,
  ServerOptions,
} from "./types.js";
import { formatMethod } from "./printer.js";

const DEFAULT_TIMEOUT_MILLISECONDS = 30000;
const SUPPORTED_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs", ".tsx", ".jsx"];

/**
 * Convierte rutas de sintaxis Serverless a sintaxis compatible con Express 5.
 * Ej: /users/{id} -> /users/:id
 * Ej: /files/{proxy+} -> /files/*proxy
 */
export function serverlessPathToExpressPath(serverlessPath: string): string {
  return serverlessPath
    .replace(/\{([a-zA-Z0-9_-]+)\+\}/g, "*$1")
    .replace(/\{([a-zA-Z0-9_-]+)\}/g, ":$1");
}

/**
 * Resuelve la ruta física del archivo que contiene el handler en el proyecto.
 * Soporta TypeScript (.ts, .tsx) y JavaScript (.js, .mjs, .cjs).
 */
export function resolveHandlerPath(
  workingDirectory: string,
  handlerExpression: string,
): { filePath: string; functionName: string } {
  const lastDotIndex = handlerExpression.lastIndexOf(".");
  if (lastDotIndex === -1) {
    throw new Error(
      `Handler inválido: "${handlerExpression}". Debe tener formato "archivo.función"`,
    );
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

  throw new Error(
    `No se encontró el archivo del handler para "${handlerExpression}" en "${workingDirectory}" (se buscaron extensiones .ts, .js, .mjs, .cjs)`,
  );
}

/**
 * Normaliza y extrae los parámetros de ruta de la petición.
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
 * Normaliza y extrae los parámetros de query string de la petición.
 */
function extractQueryParameters(rawQuery: Request["query"]): {
  queryStringParameters: Record<string, string> | null;
  multiValueQueryStringParameters: Record<string, string[]> | null;
} {
  const queryStringParameters: Record<string, string> = {};
  const multiValueQueryStringParameters: Record<string, string[]> = {};

  for (const [queryKey, queryValue] of Object.entries(rawQuery)) {
    if (Array.isArray(queryValue)) {
      multiValueQueryStringParameters[queryKey] = queryValue.map(String);
      queryStringParameters[queryKey] = String(queryValue[queryValue.length - 1]);
    } else if (queryValue !== undefined && queryValue !== null) {
      queryStringParameters[queryKey] = String(queryValue);
      multiValueQueryStringParameters[queryKey] = [String(queryValue)];
    }
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
 * Normaliza y extrae las cabeceras HTTP de la petición.
 */
function extractHeaders(rawHeaders: Request["headers"]): {
  headers: Record<string, string>;
  multiValueHeaders: Record<string, string[]>;
} {
  const headers: Record<string, string> = {};
  const multiValueHeaders: Record<string, string[]> = {};

  for (const [headerKey, headerValue] of Object.entries(rawHeaders)) {
    if (Array.isArray(headerValue)) {
      multiValueHeaders[headerKey] = headerValue;
      headers[headerKey] = headerValue.join(",");
    } else if (headerValue !== undefined) {
      headers[headerKey] = String(headerValue);
      multiValueHeaders[headerKey] = [String(headerValue)];
    }
  }

  return { headers, multiValueHeaders };
}

/**
 * Ejecuta una acción dentro de un entorno de variables temporal, restaurando el original al finalizar.
 */
async function withTemporaryEnvironment<ExecutionResult>(
  targetEnvironment: Record<string, string>,
  executionCallback: () => Promise<ExecutionResult>,
): Promise<ExecutionResult> {
  const originalEnvironmentBackup: Record<string, string | undefined> = {};

  for (const [envKey, envValue] of Object.entries(targetEnvironment)) {
    originalEnvironmentBackup[envKey] = process.env[envKey];
    process.env[envKey] = envValue;
  }

  try {
    return await executionCallback();
  } finally {
    for (const [envKey, originalValue] of Object.entries(originalEnvironmentBackup)) {
      if (originalValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = originalValue;
      }
    }
  }
}

/**
 * Construye el payload de evento compatible con AWS APIGatewayProxyEvent.
 */
function buildApiGatewayEvent(
  request: Request,
  routeDefinition: RouteDefinition,
  options: ServerOptions,
): APIGatewayProxyEvent {
  const pathParameters = extractPathParameters(request.params);
  const { queryStringParameters, multiValueQueryStringParameters } = extractQueryParameters(
    request.query,
  );
  const { headers, multiValueHeaders } = extractHeaders(request.headers);

  let bodyString: string | null = null;
  if (request.body && Buffer.isBuffer(request.body) && request.body.length > 0) {
    bodyString = request.body.toString("utf-8");
  }

  return {
    body: bodyString,
    headers,
    multiValueHeaders,
    httpMethod: request.method.toUpperCase(),
    isBase64Encoded: false,
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
      protocol: request.protocol.toUpperCase(),
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
 * Construye el contexto simulado de AWS Lambda.
 */
function buildLambdaContext(
  routeDefinition: RouteDefinition,
  options: ServerOptions,
  startTime: number,
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
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };
}

/**
 * Ejecuta una función handler soportando promesas y callbacks tradicionales.
 */
async function invokeLambdaHandler(
  handlerFunction: any,
  event: APIGatewayProxyEvent,
  context: LambdaContext,
): Promise<APIGatewayProxyResult | any> {
  if (handlerFunction.length >= 3) {
    return new Promise((resolve, reject) => {
      let callbackInvoked = false;
      const callbackHandler = (callbackError: any, callbackResult: any) => {
        if (callbackInvoked) return;
        callbackInvoked = true;
        if (callbackError) reject(callbackError);
        else resolve(callbackResult);
      };

      try {
        const potentialPromise = handlerFunction(event, context, callbackHandler);
        if (potentialPromise && typeof potentialPromise.then === "function") {
          potentialPromise.then(resolve).catch(reject);
        }
      } catch (invocationError) {
        reject(invocationError);
      }
    });
  }

  return handlerFunction(event, context);
}

/**
 * Envía la respuesta HTTP basada en el resultado de la función Lambda.
 */
function sendLambdaResponse(response: Response, lambdaResult: APIGatewayProxyResult | any): void {
  const statusCode = typeof lambdaResult?.statusCode === "number" ? lambdaResult.statusCode : 200;

  if (lambdaResult?.headers) {
    for (const [headerKey, headerValue] of Object.entries(lambdaResult.headers)) {
      if (headerValue !== undefined && headerValue !== null) {
        response.setHeader(headerKey, String(headerValue));
      }
    }
  }

  if (lambdaResult?.multiValueHeaders) {
    for (const [headerKey, headerValues] of Object.entries(lambdaResult.multiValueHeaders)) {
      if (Array.isArray(headerValues)) {
        response.setHeader(headerKey, headerValues.map(String));
      }
    }
  }

  response.status(statusCode);

  if (lambdaResult?.isBase64Encoded && typeof lambdaResult?.body === "string") {
    response.send(Buffer.from(lambdaResult.body, "base64"));
  } else if (typeof lambdaResult?.body === "string") {
    response.send(lambdaResult.body);
  } else if (lambdaResult?.body !== undefined) {
    response.json(lambdaResult.body);
  } else if (lambdaResult !== undefined && typeof lambdaResult === "object") {
    response.json(lambdaResult);
  } else {
    response.end();
  }
}

/**
 * Crea la aplicación Express configurada con todas las rutas y middlewares.
 */
export function createServerApp(
  routes: RouteDefinition[],
  options: ServerOptions,
): express.Express {
  const app = express();

  // Middleware para capturar cualquier tipo de body en Buffer crudo
  app.use(express.raw({ type: "*/*", limit: "10mb" }));

  // Instancia de jiti configurada con source maps para debugging y recarga en caliente
  const jitiRuntime = createJiti(options.workingDir, {
    sourceMaps: true,
    tsconfigPaths: true,
    moduleCache: false,
    fsCache: false,
  });

  // Middleware de CORS por defecto para desarrollo local
  app.use((request: Request, response: Response, nextFunction: NextFunction) => {
    response.header("Access-Control-Allow-Origin", "*");
    response.header(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Amz-Date, X-Api-Key, X-Amz-Security-Token",
    );
    response.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD");
    response.header("Access-Control-Allow-Credentials", "true");

    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }
    nextFunction();
  });

  // Registrar cada ruta definida en serverless.yml
  for (const route of routes) {
    const expressPath = serverlessPathToExpressPath(route.path);
    const normalizedMethod = route.method.toLowerCase();

    const handlerMiddleware = async (request: Request, response: Response) => {
      const startTime = Date.now();

      try {
        const { filePath, functionName } = resolveHandlerPath(options.workingDir, route.handler);

        const importedModule = (await jitiRuntime.import(filePath)) as any;
        const targetHandler =
          importedModule[functionName] ||
          importedModule.default?.[functionName] ||
          (functionName === "default" ? importedModule.default : undefined);

        if (typeof targetHandler !== "function") {
          throw new Error(
            `La función "${functionName}" no fue exportada en el módulo "${filePath}". Exportaciones encontradas: ${Object.keys(importedModule).join(", ")}`,
          );
        }

        const apiGatewayEvent = buildApiGatewayEvent(request, route, options);
        const lambdaContext = buildLambdaContext(route, options, startTime);

        const lambdaResult = await withTemporaryEnvironment(route.environment, () =>
          invokeLambdaHandler(targetHandler, apiGatewayEvent, lambdaContext),
        );

        sendLambdaResponse(response, lambdaResult);

        const executionDuration = Date.now() - startTime;
        const statusCode =
          typeof lambdaResult?.statusCode === "number" ? lambdaResult.statusCode : 200;
        const statusColor = statusCode >= 500 ? pc.red : statusCode >= 400 ? pc.yellow : pc.green;

        console.log(
          `  ${formatMethod(request.method)} ${pc.white(request.path)} ${statusColor(`${statusCode}`)} ${pc.dim(`(${executionDuration}ms)`)}`,
        );
      } catch (executionError: any) {
        const executionDuration = Date.now() - startTime;
        console.error(
          `\n  ${pc.bgRed(pc.white(" LAMBDA ERROR "))} ${pc.bold(pc.white(route.functionName))} ${pc.dim(`(${executionDuration}ms)`)}`,
        );
        console.error(
          pc.red(`  ${executionError.stack || executionError.message || executionError}\n`),
        );

        if (!response.headersSent) {
          response.status(500).json({
            errorMessage: executionError.message || "Error interno ejecutando la función Lambda",
            errorType: executionError.name || "Error",
            stackTrace: executionError.stack ? executionError.stack.split("\n") : [],
          });
        }
      }
    };

    if (normalizedMethod === "any") {
      app.all(expressPath, handlerMiddleware);
    } else if (typeof (app as any)[normalizedMethod] === "function") {
      (app as any)[normalizedMethod](expressPath, handlerMiddleware);
    } else {
      app.all(expressPath, handlerMiddleware);
    }
  }

  // 404 para rutas no registradas
  app.use((request: Request, response: Response) => {
    console.log(
      `  ${formatMethod(request.method)} ${pc.dim(request.path)} ${pc.yellow("404 Not Found")}`,
    );
    response.status(404).json({
      message: `Ruta no encontrada en FreeSLS: ${request.method} ${request.path}`,
    });
  });

  return app;
}

/**
 * Inicia el servidor HTTP local en el puerto indicado.
 */
export async function startServer(
  routes: RouteDefinition[],
  port: number,
  workingDirectory: string,
  options: { stage?: string; region?: string } = {},
): Promise<http.Server> {
  const app = createServerApp(routes, {
    port,
    workingDir: workingDirectory,
    stage: options.stage,
    region: options.region,
  });

  return new Promise((resolve, reject) => {
    const serverInstance = http.createServer(app);

    serverInstance.on("error", (serverError: any) => {
      if (serverError.code === "EADDRINUSE") {
        console.error(
          pc.red(`\n[FreeSLS Error] El puerto ${pc.bold(port)} ya está en uso por otro proceso.\n`),
        );
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
