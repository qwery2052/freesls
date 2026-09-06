import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import pc from "picocolors";
import { Spinner } from "./spinner.js";

export class SSMResolver {
  private client: SSMClient;
  private cache = new Map<string, string>();

  constructor(region = "us-east-1") {
    this.client = new SSMClient({ region });
  }

  async resolveAll(paths: string[]): Promise<Map<string, string>> {
    const uniquePaths = Array.from(new Set(paths)).filter(p => p && !this.cache.has(p));

    if (uniquePaths.length === 0) return this.cache;

    const profile = process.env.AWS_PROFILE || "default";
    const region = process.env.AWS_REGION || "us-east-1";

    const spinner = new Spinner(
      `Resolviendo ${uniquePaths.length} parámetros en AWS SSM [Profile: ${pc.bold(profile)} | Region: ${pc.bold(region)}]...`,
    );
    spinner.start();

    const batchSize = 10;
    const failedParameters: string[] = [];

    for (let i = 0; i < uniquePaths.length; i += batchSize) {
      const batch = uniquePaths.slice(i, i + batchSize);
      try {
        const response = await this.client.send(
          new GetParametersCommand({ Names: batch, WithDecryption: true }),
        );

        response.Parameters?.forEach(param => {
          if (param.Name && param.Value) {
            this.cache.set(param.Name, param.Value);
          }
        });

        // Si AWS nos dice que alguno de los parámetros no existe en la cuenta
        if (response.InvalidParameters && response.InvalidParameters.length > 0) {
          failedParameters.push(...response.InvalidParameters);
        }
      } catch (err: any) {
        spinner.stop(false, pc.red("Falla al conectar con AWS SSM"));
        console.error(pc.red(`\n[SSM Connection Error] ${err.message}`));
        if (err.name === "CredentialsProviderError" || err.message?.includes("SSO")) {
          console.error(
            pc.yellow(
              `\n💡 Tip: Tu sesión de AWS SSO puede haber expirado. Ejecuta:\n   aws sso login --profile ${profile}\n`,
            ),
          );
        }
        process.exit(1);
      }
    }

    if (failedParameters.length > 0) {
      spinner.stop(false, pc.red(`Falla al obtener parámetros de SSM`));
      console.error(
        pc.bold(pc.red("\nLos siguientes parámetros no existen en AWS Parameter Store:")),
      );
      failedParameters.forEach(p => console.error(`  ${pc.red("✖")} ${pc.yellow(p)}`));
      console.error(
        pc.dim("\nVerifica que los nombres de ruta en el YAML o el stage sean los correctos.\n"),
      );
      process.exit(1);
    }

    spinner.stop(
      true,
      pc.green(
        `Todos los parámetros de SSM se resolvieron con éxito (${uniquePaths.length}/${uniquePaths.length})`,
      ),
    );
    return this.cache;
  }

  get(path: string): string {
    const val = this.cache.get(path);
    if (!val) {
      throw new Error(`Parámetro no encontrado en caché de SSM: ${path}`);
    }
    return val;
  }
}
