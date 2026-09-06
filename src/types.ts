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
}
