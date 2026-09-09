export interface HttpEventOptions {
  path?: string;
  method?: string;
  cors?: boolean;
}

export type HttpEvent = string | HttpEventOptions;

export interface ServerlessFunction {
  handler: string;
  environment?: Record<string, string | number | boolean>;
  events?: Array<{
    http?: HttpEvent;
    httpApi?: HttpEvent;
  }>;
}

export interface ServerlessConfig {
  service: string;
  provider?: {
    name?: string;
    runtime?: string;
    stage?: string;
    region?: string;
    environment?: Record<string, string | number | boolean>;
  };
  functions?: Record<string, ServerlessFunction>;
}

export interface RouteDefinition {
  functionName: string;
  method: string;
  path: string;
  handler: string;
  environment: Record<string, string>;
  payloadVersion?: "1.0" | "2.0";
}

export interface LoadResult {
  config: ServerlessConfig;
  routes: RouteDefinition[];
  globalEnv: Record<string, string>;
  framework?: "serverless" | "sam";
}

export interface APIGatewayProxyEvent {
  body: string | null;
  headers: Record<string, string | undefined>;
  multiValueHeaders: Record<string, string[] | undefined>;
  httpMethod: string;
  isBase64Encoded: boolean;
  path: string;
  pathParameters: Record<string, string | undefined> | null;
  queryStringParameters: Record<string, string | undefined> | null;
  multiValueQueryStringParameters: Record<string, string[] | undefined> | null;
  stageVariables: Record<string, string> | null;
  requestContext: Record<string, unknown>;
  resource?: string;
}

export interface APIGatewayProxyResult {
  statusCode: number;
  headers?: Record<string, boolean | number | string>;
  multiValueHeaders?: Record<string, Array<boolean | number | string>>;
  body?: string;
  isBase64Encoded?: boolean;
  cookies?: string[];
}

export interface APIGatewayProxyEventV2 {
  version: "2.0";
  routeKey: string;
  rawPath: string;
  rawQueryString: string;
  cookies?: string[];
  headers: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  pathParameters?: Record<string, string>;
  requestContext: Record<string, unknown>;
  body: string | null;
  isBase64Encoded: boolean;
}

export interface LambdaContext {
  functionName: string;
  functionVersion: string;
  invokedFunctionArn: string;
  memoryLimitInMB: string;
  awsRequestId: string;
  logGroupName: string;
  logStreamName: string;
  getRemainingTimeInMillis: () => number;
  callbackWaitsForEmptyEventLoop: boolean;
  done: (error?: unknown, result?: unknown) => void;
  fail: (error: unknown) => void;
  succeed: (messageOrObject: unknown) => void;
}

export interface ServerOptions {
  port: number;
  workingDir: string;
  stage?: string;
  region?: string;
  basePath?: string;
}
