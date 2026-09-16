/** Stack lookups are explicit, read-only and scoped to one configuration load. */
export async function loadStackReferences(
  stack: string,
  region: string,
): Promise<Map<string, string>> {
  const { CloudFormationClient, DescribeStacksCommand, ListStackResourcesCommand } =
    await import("@aws-sdk/client-cloudformation");
  const client = new CloudFormationClient({ region });
  const references = new Map<string, string>();
  try {
    const response = await client.send(new DescribeStacksCommand({ StackName: stack }));
    const description = response.Stacks?.[0];
    if (!description?.StackId) throw new Error("Stack was not returned");
    const arn = description.StackId.split(":");
    references.set("AWS::AccountId", arn[4]);
    references.set("AWS::StackId", description.StackId);
    references.set("AWS::StackName", description.StackName!);
    for (const p of description.Parameters || []) {
      // NoEcho values are not usable configuration data.
      if (p.ParameterKey && p.ParameterValue !== undefined && p.ParameterValue !== "****")
        references.set(p.ParameterKey, p.ParameterValue);
    }
    for (const output of description.Outputs || []) {
      if (output.OutputKey && output.OutputValue !== undefined)
        references.set(`Outputs.${output.OutputKey}`, output.OutputValue);
    }
    let NextToken: string | undefined;
    do {
      const page = await client.send(
        new ListStackResourcesCommand({ StackName: stack, NextToken }),
      );
      for (const resource of page.StackResourceSummaries || []) {
        if (!resource.LogicalResourceId || !resource.PhysicalResourceId) continue;
        // Only these resource types have a supported Ref contract here.
        if (
          [
            "AWS::IAM::Role",
            "AWS::Lambda::Function",
            "AWS::S3::Bucket",
            "AWS::DynamoDB::Table",
            "AWS::SQS::Queue",
            "AWS::SNS::Topic",
          ].includes(resource.ResourceType || "")
        ) {
          references.set(resource.LogicalResourceId, resource.PhysicalResourceId);
        }
      }
      NextToken = page.NextToken;
    } while (NextToken);
    return references;
  } catch (error) {
    const code = error instanceof Error ? error.name : "UnknownError";
    const profile = process.env.AWS_PROFILE || "default";
    const isCredentialError =
      error instanceof Error &&
      (error.name === "CredentialsProviderError" ||
        error.message.includes("SSO") ||
        error.message.toLowerCase().includes("credential"));
    const loginHint = isCredentialError
      ? ` AWS credentials or SSO could not be resolved; run: aws sso login --profile ${profile}.`
      : "";
    throw new Error(
      `CloudFormation lookup failed (${code}). Check --cf-stack, --region and --profile; read access requires DescribeStacks and ListStackResources.${loginHint} No local fallback was applied.`,
      { cause: error },
    );
  } finally {
    client.destroy();
  }
}
