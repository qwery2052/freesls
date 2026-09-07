#!/usr/bin/env node

import { Command } from "commander";
import pc from "picocolors";
import { loadServerlessConfig } from "./parser.js";
import { loadSamConfig } from "./sam-parser.js";
import { printBanner, printEnvironmentSummary, printRoutes } from "./printer.js";
import { startServer } from "./server.js";

const program = new Command();

/**
 * Parsea los parámetros pasados por CLI en formato clave=valor.
 */
function parseCliParameters(parameterEntries?: string[]): Record<string, string> {
  if (!parameterEntries) return {};

  const parsedParameters: Record<string, string> = {};
  for (const parameterEntry of parameterEntries) {
    const [parameterKey, parameterValue] = parameterEntry.split("=");
    if (parameterKey && parameterValue) {
      parsedParameters[parameterKey.trim()] = parameterValue.trim();
    }
  }

  return parsedParameters;
}

program
  .name("freesls")
  .description("Offline API Gateway & Lambda Runner (Serverless Framework & AWS SAM)")
  .version("0.2.0")
  .option("-s, --stage <stage>", "Stage de despliegue", "develop")
  .option("-r, --region <region>", "Región de AWS", "us-east-1")
  .option("-p, --port <port>", "Puerto del servidor local", "4000")
  .option("--profile <profile>", "Perfil AWS CLI/SSO para credenciales")
  .option("--param <params...>", "Parámetros en formato clave=valor (ej. deploymentStage=develop)")
  .option("--sam", "Usa template de AWS SAM (template.yaml/template.yml)")
  .option("--sls", "Usa template de Serverless Framework (serverless.yml/serverless.yaml) [por defecto]")
  .option("--no-ssm", "Desactiva la resolución real de SSM y usa mocks")
  .option(
    "--show-env",
    "Muestra el valor completo de las variables de entorno sin enmascarar",
    false,
  )
  .action(async commandOptions => {
    try {
      const serverPort = parseInt(commandOptions.port, 10);

      if (commandOptions.profile) {
        process.env.AWS_PROFILE = commandOptions.profile;
      }
      process.env.AWS_REGION = commandOptions.region;

      const customParameters = parseCliParameters(commandOptions.param);

      for (const [parameterKey, parameterValue] of Object.entries(customParameters)) {
        process.env[parameterKey] = parameterValue;
      }

      // Detecta si se solicitó modo SAM vía --sam o el alias -sam
      const isSamMode =
        Boolean(commandOptions.sam) ||
        process.argv.includes("-sam") ||
        process.argv.includes("--sam");

      const frameworkDisplayName = isSamMode ? "AWS SAM" : "Serverless Framework";

      console.log(
        pc.dim(
          `\n🐾 Inicializando FreeSLS (${pc.cyan(frameworkDisplayName)}) en stage: ${pc.bold(commandOptions.stage)}...`,
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
        console.log(pc.dim("\n🐾 Cerrando FreeSLS..."));
        serverInstance.close(() => {
          process.exit(0);
        });
      };

      process.on("SIGINT", handleShutdown);
      process.on("SIGTERM", handleShutdown);
    } catch (error: any) {
      console.error(pc.red(`\n[freesls Error] ${error.message}\n`));
      process.exit(1);
    }
  });

const normalizedArgv = process.argv.map(arg => {
  if (arg === "-sam") return "--sam";
  if (arg === "-sls") return "--sls";
  return arg;
});

program.parse(normalizedArgv);
