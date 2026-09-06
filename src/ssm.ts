import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import pc from "picocolors";
import { Spinner } from "./spinner.js";

const DEFAULT_BATCH_SIZE = 10;

export class SSMResolver {
  private client: SSMClient;
  private cache = new Map<string, string>();

  constructor(region = "us-east-1") {
    this.client = new SSMClient({ region });
  }

  async resolveAll(parameterPaths: string[]): Promise<Map<string, string>> {
    const uniquePaths = Array.from(new Set(parameterPaths)).filter(
      parameterPath => Boolean(parameterPath) && !this.cache.has(parameterPath),
    );

    if (uniquePaths.length === 0) return this.cache;

    const awsProfile = process.env.AWS_PROFILE || "default";
    const awsRegion = process.env.AWS_REGION || "us-east-1";

    const resolutionSpinner = new Spinner(
      `Resolviendo ${uniquePaths.length} parámetros en AWS SSM [Profile: ${pc.bold(awsProfile)} | Region: ${pc.bold(awsRegion)}]...`,
    );
    resolutionSpinner.start();

    const failedParameters: string[] = [];

    for (let startIndex = 0; startIndex < uniquePaths.length; startIndex += DEFAULT_BATCH_SIZE) {
      const parameterBatch = uniquePaths.slice(startIndex, startIndex + DEFAULT_BATCH_SIZE);
      try {
        const response = await this.client.send(
          new GetParametersCommand({ Names: parameterBatch, WithDecryption: true }),
        );

        response.Parameters?.forEach(parameter => {
          if (parameter.Name && parameter.Value) {
            this.cache.set(parameter.Name, parameter.Value);
          }
        });

        // Si AWS nos dice que alguno de los parámetros no existe en la cuenta
        if (response.InvalidParameters && response.InvalidParameters.length > 0) {
          failedParameters.push(...response.InvalidParameters);
        }
      } catch (connectionError: any) {
        resolutionSpinner.stop(false, pc.red("Falla al conectar con AWS SSM"));
        console.error(pc.red(`\n[SSM Connection Error] ${connectionError.message}`));
        if (
          connectionError.name === "CredentialsProviderError" ||
          connectionError.message?.includes("SSO")
        ) {
          console.error(
            pc.yellow(
              `\n💡 Tip: Tu sesión de AWS SSO puede haber expirado. Ejecuta:\n   aws sso login --profile ${awsProfile}\n`,
            ),
          );
        }
        process.exit(1);
      }
    }

    if (failedParameters.length > 0) {
      resolutionSpinner.stop(false, pc.red(`Falla al obtener parámetros de SSM`));
      console.error(
        pc.bold(pc.red("\nLos siguientes parámetros no existen en AWS Parameter Store:")),
      );
      failedParameters.forEach(parameterName =>
        console.error(`  ${pc.red("✖")} ${pc.yellow(parameterName)}`),
      );
      console.error(
        pc.dim("\nVerifica que los nombres de ruta en el YAML o el stage sean los correctos.\n"),
      );
      process.exit(1);
    }

    resolutionSpinner.stop(
      true,
      pc.green(
        `Todos los parámetros de SSM se resolvieron con éxito (${uniquePaths.length}/${uniquePaths.length})`,
      ),
    );
    return this.cache;
  }

  get(parameterPath: string): string {
    const cachedValue = this.cache.get(parameterPath);
    if (!cachedValue) {
      throw new Error(`Parámetro no encontrado en caché de SSM: ${parameterPath}`);
    }
    return cachedValue;
  }
}
