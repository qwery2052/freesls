#!/usr/bin/env node

import { Command } from "commander";
import pc from "picocolors";
import { loadServerlessConfig } from "./parser.js";
import { printBanner, printEnvironmentSummary, printRoutes } from "./printer.js";

const program = new Command();

program
  .name("freesls")
  .description("Offline API Gateway & Lambda Runner")
  .version("0.1.0")
  .option("-s, --stage <stage>", "Stage de despliegue", "develop")
  .option("-r, --region <region>", "Región de AWS", "us-east-1")
  .option("-p, --port <port>", "Puerto del servidor local", "4000")
  .option("--profile <profile>", "Perfil AWS CLI/SSO para credenciales")
  .option("--param <params...>", "Parámetros en formato clave=valor (ej. deploymentStage=develop)")
  .option("--no-ssm", "Desactiva la resolución real de SSM y usa mocks")
  .option(
    "--show-env",
    "Muestra el valor completo de las variables de entorno sin enmascarar",
    false,
  )
  .action(async opts => {
    try {
      const port = parseInt(opts.port, 10);

      if (opts.profile) {
        process.env.AWS_PROFILE = opts.profile;
      }
      process.env.AWS_REGION = opts.region;

      const params: Record<string, string> = {};
      if (opts.param) {
        for (const p of opts.param) {
          const [k, v] = p.split("=");
          if (k && v) params[k.trim()] = v.trim();
        }
      }

      console.log(pc.dim(`\n🐾 Inicializando FreeSLS en stage: ${pc.bold(opts.stage)}...`));

      const { config, routes, globalEnv } = await loadServerlessConfig(process.cwd(), {
        stage: opts.stage,
        region: opts.region,
        params,
        resolveSSM: opts.ssm !== false,
      });

      printBanner(config.service || "service", port, opts.stage);
      printEnvironmentSummary(globalEnv, Boolean(opts.showEnv));
      printRoutes(routes, port);
    } catch (error: any) {
      console.error(pc.red(`\n[freesls Error] ${error.message}\n`));
      process.exit(1);
    }
  });

program.parse(process.argv);
