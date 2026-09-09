#!/usr/bin/env node

import { Command } from "commander";
import pc from "picocolors";
import { loadServerlessConfig } from "./parser.js";
import { loadSamConfig } from "./sam-parser.js";
import {
  printBanner,
  printEnvironmentSummary,
  printRoutes,
  printSsmResolutionError,
} from "./printer.js";
import { startServer } from "./server.js";
import { SSMParameterNotFoundError } from "./ssm.js";

const program = new Command();

/**
 * Split at the first equals sign so encoded values remain intact.
 */
function parseCliParameters(parameterEntries?: string[]): Record<string, string> {
  if (!parameterEntries) return {};

  const parsedParameters: Record<string, string> = {};
  for (const parameterEntry of parameterEntries) {
    const assignmentIndex = parameterEntry.indexOf("=");
    const parameterKey = parameterEntry.slice(0, assignmentIndex).trim();
    if (assignmentIndex < 1 || !parameterKey) {
      throw new Error("Invalid --param assignment. Expected a nonempty key followed by =value.");
    }
    parsedParameters[parameterKey] = parameterEntry.slice(assignmentIndex + 1).trim();
  }

  return parsedParameters;
}

program
  .name("freesls")
  .description("Offline API Gateway & Lambda Runner (Serverless Framework & AWS SAM)")
  .version("0.2.4", "-v, --version", "Output the current version number")
  .option("-s, --stage <stage>", "Deployment stage", "develop")
  .option("-r, --region <region>", "AWS region", "us-east-1")
  .option("-p, --port <port>", "Local HTTP server port", "4000")
  .option("--profile <profile>", "AWS CLI/SSO credential profile")
  .option("--param <params...>", "Parameters as key=value (e.g. deploymentStage=develop)")
  .option("--sam", "Use an AWS SAM template (template.yaml/template.yml)")
  .option("--sls", "Use Serverless Framework (serverless.yml) [default]")
  .option("--no-ssm", "Disable AWS SSM queries and use local fallbacks or mocks")
  .option("--show-env", "Display full environment values without masking", false)
  .action(async commandOptions => {
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
      };

      const { config, routes, globalEnv, framework } = isSamMode
        ? await loadSamConfig(process.cwd(), parserOptions)
        : await loadServerlessConfig(process.cwd(), parserOptions);

      printBanner(
        config.service || "service",
        serverPort,
        commandOptions.stage,
        framework || (isSamMode ? "sam" : "serverless"),
      );
      printEnvironmentSummary(globalEnv, Boolean(commandOptions.showEnv));
      printRoutes(routes, serverPort);

      const serverInstance = await startServer(routes, serverPort, process.cwd(), {
        stage: commandOptions.stage,
        region: commandOptions.region,
      });

      const handleShutdown = () => {
        console.log(pc.dim("\n🐾 Shutting down FreeSLS..."));
        serverInstance.close(() => {
          process.exit(0);
        });
      };

      process.on("SIGINT", handleShutdown);
      process.on("SIGTERM", handleShutdown);
    } catch (error) {
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
