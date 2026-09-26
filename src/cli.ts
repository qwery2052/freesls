#!/usr/bin/env node

import { Command } from "commander";
import pc from "picocolors";
import { loadServerlessConfig } from "./parser.js";
import { loadSamConfig } from "./sam-parser.js";
import {
  printBanner,
  printEnvironmentSummary,
  printRoutes,
  printSchedulerEvent,
  printLambdaStart,
  printSsmResolutionError,
} from "./printer.js";
import { startServer, createLambdaExecutor } from "./server.js";
import { LocalScheduler, startScheduler } from "./scheduler.js";
import { SSMParameterNotFoundError } from "./ssm.js";
import { DEFAULT_OFFLINE_ENV } from "./types.js";

const program = new Command();

/**
 * Split at the first equals sign so encoded values remain intact.
 */
function parseCliParameters(parameterEntries?: string[], flag = "--param"): Record<string, string> {
  if (!parameterEntries) return {};

  const parsedParameters: Record<string, string> = {};
  for (const parameterEntry of parameterEntries) {
    const assignmentIndex = parameterEntry.indexOf("=");
    const parameterKey = parameterEntry.slice(0, assignmentIndex).trim();
    if (assignmentIndex < 1 || !parameterKey) {
      throw new Error(`Invalid ${flag} assignment. Expected a nonempty key followed by =value.`);
    }
    parsedParameters[parameterKey] = parameterEntry.slice(assignmentIndex + 1).trim();
  }

  return parsedParameters;
}

program
  .name("freesls")
  .description("Offline API Gateway & Lambda Runner (Serverless Framework & AWS SAM)")
  .version("0.4.0", "-v, --version", "Output the current version number")
  .option("-s, --stage <stage>", "Deployment stage", "develop")
  .option("-r, --region <region>", "AWS region", "us-east-1")
  .option("-p, --port <port>", "Local HTTP server port", "4000")
  .option(
    "-b, --base-path <path>",
    "Base path prefix for all endpoints (e.g. /medical-history-app)",
  )
  .option("--prefix <prefix>", "Alias for --base-path")
  .option("--profile <profile>", "AWS CLI/SSO credential profile")
  .option("--param <params...>", "Parameters as key=value (e.g. deploymentStage=develop)")
  .option("-e, --env <vars...>", "Override environment variables as key=value (highest precedence)")
  .option("--sam", "Use an AWS SAM template (template.yaml/template.yml)")
  .option("--sls", "Use Serverless Framework (serverless.yml) [default]")
  .option("--no-ssm", "Disable AWS SSM queries and use local fallbacks or mocks")
  .option("--scheduler", "Enable the local one-time Lambda Scheduler endpoint")
  .option(
    "--cf-value <values...>",
    "Explicit reference values: LogicalId.Attribute=value or Outputs.Key=value",
  )
  .option("--show-env", "Display full environment values without masking", false)
  .option("-d, --debug", "Enable verbose lifecycle debug logging with stage timings", false)
  .action(async commandOptions => {
    let schedulerServer: Awaited<ReturnType<typeof startScheduler>> | undefined;
    const priorEndpoint = process.env.AWS_ENDPOINT_URL_SCHEDULER;
    const restoreEndpoint = () => {
      if (priorEndpoint === undefined) delete process.env.AWS_ENDPOINT_URL_SCHEDULER;
      else process.env.AWS_ENDPOINT_URL_SCHEDULER = priorEndpoint;
    };
    try {
      const serverPort = Number(commandOptions.port);
      if (
        !/^\d+$/.test(commandOptions.port) ||
        !Number.isInteger(serverPort) ||
        serverPort < 1 ||
        serverPort > 65535
      ) {
        throw new Error("Invalid --port. Expected an integer between 1 and 65535.");
      }

      const basePath = (commandOptions.basePath || commandOptions.prefix || "").trim();

      Object.assign(process.env, DEFAULT_OFFLINE_ENV);

      if (commandOptions.profile) {
        process.env.AWS_PROFILE = commandOptions.profile;
      }

      process.env.AWS_REGION = commandOptions.region;

      const customParameters = parseCliParameters(commandOptions.param);

      for (const [parameterKey, parameterValue] of Object.entries(customParameters)) {
        process.env[parameterKey] = parameterValue;
      }

      const isSamMode = Boolean(commandOptions.sam);
      const frameworkDisplayName = isSamMode ? "AWS SAM" : "Serverless Framework";

      if (process.stdout.isTTY) {
        console.clear();
      }

      console.log(
        pc.dim(
          `\n🐾 Starting FreeSLS (${pc.cyan(frameworkDisplayName)}) for stage: ${pc.bold(commandOptions.stage)}...`,
        ),
      );

      const parserOptions = {
        stage: commandOptions.stage,
        region: commandOptions.region,
        params: customParameters,
        resolveSSM: commandOptions.ssm !== false,
        scheduler: Boolean(commandOptions.scheduler),
        cfValues: commandOptions.cfValue
          ? parseCliParameters(commandOptions.cfValue, "--cf-value")
          : undefined,
        envOverrides: parseCliParameters(commandOptions.env, "--env"),
      };

      const {
        config,
        routes,
        functions = [],
        globalEnv,
        framework,
      } = isSamMode
        ? await loadSamConfig(process.cwd(), parserOptions)
        : await loadServerlessConfig(process.cwd(), parserOptions);

      printBanner(
        config.service || "service",
        serverPort,
        commandOptions.stage,
        framework || (isSamMode ? "sam" : "serverless"),
        basePath,
        Boolean(commandOptions.debug),
      );
      printEnvironmentSummary(globalEnv, Boolean(commandOptions.showEnv));
      printRoutes(routes, serverPort, basePath, Boolean(commandOptions.scheduler));

      if (commandOptions.scheduler) {
        const execute = createLambdaExecutor({
          port: serverPort,
          workingDir: process.cwd(),
          stage: commandOptions.stage,
          region: commandOptions.region,
          debug: Boolean(commandOptions.debug),
        });
        const registry = new Map(functions.filter(fn => fn.arn).map(fn => [fn.arn!, fn]));
        if (registry.size !== functions.length) {
          throw new Error(
            "Duplicate or missing local Lambda ARN. Use unique function names and --cf-value overrides.",
          );
        }
        const resolveTargetName = (arn: string) => registry.get(arn)?.functionName ?? arn;
        const scheduler = new LocalScheduler(
          commandOptions.region,
          new Set(registry.keys()),
          async (arn, payload) => {
            const target = registry.get(arn);
            if (!target) throw new Error("Target is no longer registered");
            printLambdaStart(target.functionName);
            // Acceptance and asynchronous handler completion are separate boundaries.
            void Promise.resolve()
              .then(() => execute(target, payload))
              .catch(() => {
                console.error(
                  `[FreeSLS Lambda] Scheduled invocation failed for ${target.functionName}. Inspect the handler with --debug; payload and error contents are omitted.`,
                );
              });
          },
          undefined,
          () => {},
          event => printSchedulerEvent(event, resolveTargetName),
        );
        schedulerServer = await startScheduler(scheduler);
        process.env.AWS_ENDPOINT_URL_SCHEDULER = schedulerServer.endpoint;
        for (const fn of functions)
          fn.environment.AWS_ENDPOINT_URL_SCHEDULER = schedulerServer.endpoint;
        for (const route of routes)
          route.environment.AWS_ENDPOINT_URL_SCHEDULER = schedulerServer.endpoint;
        console.log(
          `Local Scheduler: ${schedulerServer.endpoint} (at schedules, in-memory). SDK v3 clients need signing credentials; existing AWS credentials are preserved.`,
        );
      }

      const serverInstance = await startServer(routes, serverPort, process.cwd(), {
        stage: commandOptions.stage,
        region: commandOptions.region,
        basePath,
        debug: Boolean(commandOptions.debug),
      });

      let shuttingDown = false;
      const handleShutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(pc.dim("\n🐾 Shutting down FreeSLS..."));
        await schedulerServer?.close();
        restoreEndpoint();
        serverInstance.close(() => {
          process.exit(0);
        });
      };

      process.on("SIGINT", handleShutdown);
      process.on("SIGTERM", handleShutdown);
    } catch (error) {
      await schedulerServer?.close();
      restoreEndpoint();
      if (error instanceof SSMParameterNotFoundError) {
        printSsmResolutionError(error.missingParameters, {
          profile: error.profile,
          region: error.region,
        });
      } else if (error instanceof Error && error.message.startsWith("SSM parameters not found:")) {
        const match = error.message.match(/SSM parameters not found: ([^.]+)\./);
        const params = match ? match[1].split(",").map(p => p.trim()) : [];
        printSsmResolutionError(params, {
          profile: process.env.AWS_PROFILE || commandOptions?.profile,
          region: commandOptions?.region,
        });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        console.error(pc.red(`\n[FreeSLS Error] ${message}\n`));
      }
      process.exit(1);
    }
  });

const normalizedArgv = process.argv.map(arg => {
  if (arg === "-sam") return "--sam";
  if (arg === "-sls") return "--sls";
  if (arg === "-V") return "-v";
  return arg;
});

program.parse(normalizedArgv);
