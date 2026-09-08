import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import pc from "picocolors";
import { Spinner } from "./spinner.js";

const DEFAULT_BATCH_SIZE = 10;

export class SSMResolver {
  private client: SSMClient;
  private cache = new Map<string, string>();

  constructor(private readonly region = "us-east-1") {
    this.client = new SSMClient({ region });
  }

  async resolveAll(parameterPaths: string[]): Promise<Map<string, string>> {
    const uniquePaths = Array.from(new Set(parameterPaths)).filter(
      parameterPath => Boolean(parameterPath) && !this.cache.has(parameterPath),
    );

    if (uniquePaths.length === 0) return this.cache;

    const awsProfile = process.env.AWS_PROFILE || "default";

    const resolutionSpinner = new Spinner(
      `Resolving ${uniquePaths.length} AWS SSM parameters [Configured profile: ${pc.bold(awsProfile)} | Region: ${pc.bold(this.region)}]...`,
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
          if (parameter.Name && parameter.Value !== undefined) {
            this.cache.set(`${parameter.Name}${parameter.Selector ?? ""}`, parameter.Value);
          }
        });

        if (response.InvalidParameters && response.InvalidParameters.length > 0) {
          failedParameters.push(...response.InvalidParameters);
        }
      } catch (connectionError) {
        resolutionSpinner.stop(false, pc.red("AWS SSM request failed"));
        const error =
          connectionError instanceof Error ? connectionError : new Error(String(connectionError));
        const loginHint =
          error.name === "CredentialsProviderError" || error.message.includes("SSO")
            ? ` Check your credentials or run: aws sso login --profile ${awsProfile}`
            : "";
        throw new Error(`Unable to resolve AWS SSM parameters: ${error.message}.${loginHint}`, {
          cause: error,
        });
      }
    }

    if (failedParameters.length > 0) {
      resolutionSpinner.stop(false, pc.red("SSM parameters not found"));
      throw new Error(
        `SSM parameters not found: ${failedParameters.join(", ")}. Check the configured names and stage.`,
      );
    }

    resolutionSpinner.stop(
      true,
      pc.green(`SSM parameters resolved (${uniquePaths.length}/${uniquePaths.length})`),
    );
    return this.cache;
  }

  get(parameterPath: string): string {
    const cachedValue = this.cache.get(parameterPath);
    if (cachedValue === undefined) {
      throw new Error(`SSM parameter not found in cache: ${parameterPath}`);
    }
    return cachedValue;
  }
}
