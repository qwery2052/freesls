import express, { type Request, type Response } from "express";
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

/**
 * Convierte rutas de sintaxis Serverless a sintaxis compatible con Express 5.
 * Ej: /users/{id} -> /users/:id
 * Ej: /files/{proxy+} -> /files/*proxy
 */
export function serverlessPathToExpressPath(slsPath: string): string {
  let p = slsPath;
  // Convertir {proxy+} o {nombre+} a *nombre
  p = p.replace(/\{([a-zA-Z0-9_-]+)\+\}/g, "*$1");
  // Convertir {param} a :param
  p = p.replace(/\{([a-zA-Z0-9_-]+)\}/g, ":$1");
  return p;
}

/**
 * Resuelve la ruta física del archivo que contiene el handler en el proyecto.
 * Soporta TypeScript (.ts, .tsx) y JavaScript (.js, .mjs, .cjs).
 */
export function resolveHandlerPath(
  workingDir: string,
  handlerStr: string,
): { filePath: string; functionName: string } {
  const lastDot = handlerStr.lastIndexOf(".");
  if (lastDot === -1) {
    throw new Error(`Handler inválido: "${handlerStr}". Debe tener formato "archivo.función"`);
  }

  const relativePath = handlerStr.substring(0, lastDot);
  const functionName = handlerStr.substring(lastDot + 1);

  const extensions = [".ts", ".js", ".mjs", ".cjs", ".tsx", ".jsx"];

  // 1. Verificar si ya tiene extensión
  const directPath = path.resolve(workingDir, relativePath);
  if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
    return { filePath: directPath, functionName };
  }

  // 2. Probar extensiones directas (priorizar .ts si existe)
  for (const ext of extensions) {
    const candidate = path.resolve(workingDir, relativePath + ext);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return { filePath: candidate, functionName };
    }
  }

  // 3. Probar subdirectorio con index
  for (const ext of extensions) {
    const candidate = path.resolve(workingDir, relativePath, `index${ext}`);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return { filePath: candidate, functionName };
    }
  }

  // 4. Si el proyecto compila en dist/, comprobar también dist/
  for (const ext of [".js", ".mjs", ".cjs"]) {
    const candidate = path.resolve(workingDir, "dist", relativePath + ext);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return { filePath: candidate, functionName };
    }
  }

  throw new Error(
    `No se encontró el archivo del handler para "${handlerStr}" en "${workingDir}" (se buscaron extensiones .ts, .js, .mjs, .cjs)`,
  );
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
  const jiti = createJiti(options.workingDir, {
    sourceMaps: true,
    tsconfigPaths: true,
    moduleCache: false,
    fsCache: false,
  });

  // Middleware de CORS por defecto para desarrollo local
  app.use((req: Request, res: Response, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Amz-Date, X-Api-Key, X-Amz-Security-Token",
    );
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD");
    res.header("Access-Control-Allow-Credentials", "true");

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // Registrar cada ruta definida en serverless.yml
  for (const route of routes) {
    const expressPath = serverlessPathToExpressPath(route.path);
    const method = route.method.toLowerCase();

    const handlerMiddleware = async (req: Request, res: Response) => {
      const startTime = Date.now();

      try {
        // 1. Resolver el archivo del handler
        const { filePath, functionName } = resolveHandlerPath(options.workingDir, route.handler);

        // 2. Cargar el módulo con jiti (soporta TS nativo + source maps para breakpoints)
        const mod = (await jiti.import(filePath)) as any;
        const handlerFn =
          mod[functionName] ||
          mod.default?.[functionName] ||
          (functionName === "default" ? mod.default : undefined);

        if (typeof handlerFn !== "function") {
          throw new Error(
            `La función "${functionName}" no fue exportada en el módulo "${filePath}". Exportaciones encontradas: ${Object.keys(mod).join(", ")}`,
          );
        }

        // 3. Inyectar variables de entorno de la función
        const originalEnv: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(route.environment)) {
          originalEnv[k] = process.env[k];
          process.env[k] = v;
        }

        // 4. Construir pathParameters
        const pathParameters: Record<string, string> = {};
        for (const [key, val] of Object.entries(req.params)) {
          if (Array.isArray(val)) {
            pathParameters[key] = val.join("/");
          } else if (typeof val === "string") {
            pathParameters[key] = val;
          }
        }

        // 5. Construir queryStringParameters
        const queryStringParameters: Record<string, string> = {};
        const multiValueQueryStringParameters: Record<string, string[]> = {};
        for (const [key, val] of Object.entries(req.query)) {
          if (Array.isArray(val)) {
            multiValueQueryStringParameters[key] = val.map(String);
            queryStringParameters[key] = String(val[val.length - 1]);
          } else if (val !== undefined && val !== null) {
            queryStringParameters[key] = String(val);
            multiValueQueryStringParameters[key] = [String(val)];
          }
        }

        // 6. Construir headers y multiValueHeaders
        const headers: Record<string, string> = {};
        const multiValueHeaders: Record<string, string[]> = {};
        for (const [key, val] of Object.entries(req.headers)) {
          if (Array.isArray(val)) {
            multiValueHeaders[key] = val;
            headers[key] = val.join(",");
          } else if (val !== undefined) {
            headers[key] = String(val);
            multiValueHeaders[key] = [String(val)];
          }
        }

        // 7. Preparar body
        let bodyString: string | null = null;
        const isBase64Encoded = false;
        if (req.body && Buffer.isBuffer(req.body) && req.body.length > 0) {
          bodyString = req.body.toString("utf-8");
        }

        // 8. Construir evento APIGatewayProxyEvent
        const event: APIGatewayProxyEvent = {
          body: bodyString,
          headers,
          multiValueHeaders,
          httpMethod: req.method.toUpperCase(),
          isBase64Encoded,
          path: req.path,
          pathParameters: Object.keys(pathParameters).length > 0 ? pathParameters : null,
          queryStringParameters:
            Object.keys(queryStringParameters).length > 0 ? queryStringParameters : null,
          multiValueQueryStringParameters:
            Object.keys(multiValueQueryStringParameters).length > 0
              ? multiValueQueryStringParameters
              : null,
          stageVariables: null,
          requestContext: {
            accountId: "offlineContext_accountId",
            apiId: "offlineContext_apiId",
            httpMethod: req.method.toUpperCase(),
            identity: {
              sourceIp: req.ip || "127.0.0.1",
              userAgent: req.get("user-agent") || "",
            },
            path: req.path,
            protocol: req.protocol.toUpperCase(),
            requestId: `offline_${crypto.randomUUID()}`,
            requestTimeEpoch: Date.now(),
            resourceId: "offlineContext_resourceId",
            resourcePath: route.path,
            stage: options.stage || "dev",
          },
          resource: route.path,
        };

        // 9. Construir contexto Lambda simulado
        const timeoutMs = 30000;
        const context: LambdaContext = {
          functionName: route.functionName,
          functionVersion: "$LATEST",
          invokedFunctionArn: `arn:aws:lambda:${options.region || "us-east-1"}:123456789012:function:${route.functionName}`,
          memoryLimitInMB: "1024",
          awsRequestId: crypto.randomUUID(),
          logGroupName: `/aws/lambda/${route.functionName}`,
          logStreamName: `[$LATEST]${crypto.randomBytes(16).toString("hex")}`,
          getRemainingTimeInMillis: () => Math.max(0, timeoutMs - (Date.now() - startTime)),
          done: () => {},
          fail: () => {},
          succeed: () => {},
        };

        // 10. Invocar handler (soporta async y estilo callback)
        let result: APIGatewayProxyResult | any;
        try {
          if (handlerFn.length >= 3) {
            result = await new Promise((resolve, reject) => {
              let called = false;
              const cb = (err: any, res: any) => {
                if (called) return;
                called = true;
                if (err) reject(err);
                else resolve(res);
              };
              try {
                const maybePromise = handlerFn(event, context, cb);
                if (maybePromise && typeof maybePromise.then === "function") {
                  maybePromise.then(resolve).catch(reject);
                }
              } catch (err) {
                reject(err);
              }
            });
          } else {
            result = await handlerFn(event, context);
          }
        } finally {
          // Restaurar variables de entorno previas
          for (const [k, v] of Object.entries(originalEnv)) {
            if (v === undefined) {
              delete process.env[k];
            } else {
              process.env[k] = v;
            }
          }
        }

        // 11. Formatear y enviar respuesta HTTP
        const statusCode = typeof result?.statusCode === "number" ? result.statusCode : 200;

        if (result?.headers) {
          for (const [k, v] of Object.entries(result.headers)) {
            if (v !== undefined && v !== null) {
              res.setHeader(k, String(v));
            }
          }
        }

        if (result?.multiValueHeaders) {
          for (const [k, values] of Object.entries(result.multiValueHeaders)) {
            if (Array.isArray(values)) {
              res.setHeader(k, values.map(String));
            }
          }
        }

        res.status(statusCode);

        if (result?.isBase64Encoded && typeof result?.body === "string") {
          res.send(Buffer.from(result.body, "base64"));
        } else if (typeof result?.body === "string") {
          res.send(result.body);
        } else if (result?.body !== undefined) {
          res.json(result.body);
        } else if (result !== undefined && typeof result === "object") {
          res.json(result);
        } else {
          res.end();
        }

        // 12. Logging en terminal
        const duration = Date.now() - startTime;
        const statusColor = statusCode >= 500 ? pc.red : statusCode >= 400 ? pc.yellow : pc.green;
        console.log(
          `  ${formatMethod(req.method)} ${pc.white(req.path)} ${statusColor(`${statusCode}`)} ${pc.dim(`(${duration}ms)`)}`,
        );
      } catch (err: any) {
        const duration = Date.now() - startTime;
        console.error(
          `\n  ${pc.bgRed(pc.white(" LAMBDA ERROR "))} ${pc.bold(pc.white(route.functionName))} ${pc.dim(`(${duration}ms)`)}`,
        );
        console.error(pc.red(`  ${err.stack || err.message || err}\n`));

        if (!res.headersSent) {
          res.status(500).json({
            errorMessage: err.message || "Error interno ejecutando la función Lambda",
            errorType: err.name || "Error",
            stackTrace: err.stack ? err.stack.split("\n") : [],
          });
        }
      }
    };

    if (method === "any") {
      app.all(expressPath, handlerMiddleware);
    } else if (typeof (app as any)[method] === "function") {
      (app as any)[method](expressPath, handlerMiddleware);
    } else {
      app.all(expressPath, handlerMiddleware);
    }
  }

  // 404 para rutas no registradas
  app.use((req: Request, res: Response) => {
    console.log(`  ${formatMethod(req.method)} ${pc.dim(req.path)} ${pc.yellow("404 Not Found")}`);
    res.status(404).json({
      message: `Ruta no encontrada en FreeSLS: ${req.method} ${req.path}`,
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
  workingDir: string,
  options: { stage?: string; region?: string } = {},
): Promise<http.Server> {
  const app = createServerApp(routes, {
    port,
    workingDir,
    stage: options.stage,
    region: options.region,
  });

  return new Promise((resolve, reject) => {
    const server = http.createServer(app);

    server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        console.error(
          pc.red(`\n[FreeSLS Error] El puerto ${pc.bold(port)} ya está en uso por otro proceso.\n`),
        );
      } else {
        console.error(pc.red(`\n[FreeSLS Server Error] ${err.message}\n`));
      }
      reject(err);
    });

    server.listen(port, () => {
      resolve(server);
    });
  });
}
