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
  requestContext: Record<string, any>;
  resource?: string;
}

export interface APIGatewayProxyResult {
  statusCode: number;
  headers?: Record<string, boolean | number | string>;
  multiValueHeaders?: Record<string, Array<boolean | number | string>>;
  body?: string;
  isBase64Encoded?: boolean;
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
  done: (error?: Error | null, result?: any) => void;
  fail: (error: Error | string) => void;
  succeed: (messageOrObject: any) => void;
}

export interface ServerOptions {
  port: number;
  workingDir: string;
  stage?: string;
  region?: string;
}
