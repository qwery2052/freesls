import assert from "node:assert/strict";
import test from "node:test";
import {
  CloudFormationClient,
  DescribeStacksCommand,
  ListStackResourcesCommand,
} from "@aws-sdk/client-cloudformation";
import { SSMClient } from "@aws-sdk/client-ssm";
import { loadStackReferences } from "../dist/cloudformation.js";
import { loadServerlessConfig } from "../dist/parser.js";
import { loadSamConfig } from "../dist/sam-parser.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("CloudFormation reads parameters/outputs and paginated resource IDs without inventing attributes", async t => {
  const calls = [];
  let destroyed = 0;
  t.mock.method(CloudFormationClient.prototype, "destroy", () => destroyed++);
  t.mock.method(CloudFormationClient.prototype, "send", async function (command) {
    calls.push(command);
    assert.equal(await this.config.region(), "eu-west-1");
    if (command instanceof DescribeStacksCommand)
      return {
        Stacks: [
          {
            StackName: "deployed",
            StackId: "arn:aws:cloudformation:eu-west-1:999999999999:stack/deployed/id",
            Parameters: [
              { ParameterKey: "Stage", ParameterValue: "dev" },
              { ParameterKey: "Secret", ParameterValue: "****" },
            ],
            Outputs: [
              {
                OutputKey: "RoleArn",
                OutputValue: "arn:aws:iam::999999999999:role/team/scheduler",
              },
            ],
          },
        ],
      };
    assert.ok(command instanceof ListStackResourcesCommand);
    return command.input.NextToken
      ? {
          StackResourceSummaries: [
            {
              LogicalResourceId: "Bucket",
              PhysicalResourceId: "deployed-bucket",
              ResourceType: "AWS::S3::Bucket",
            },
          ],
        }
      : {
          NextToken: "page2",
          StackResourceSummaries: [
            {
              LogicalResourceId: "Role",
              PhysicalResourceId: "scheduler",
              ResourceType: "AWS::IAM::Role",
            },
          ],
        };
  });
  const refs = await loadStackReferences("deployed", "eu-west-1");
  assert.equal(refs.get("AWS::AccountId"), "999999999999");
  assert.equal(refs.get("Role"), "scheduler");
  assert.equal(refs.has("Role.Arn"), false);
  assert.equal(refs.get("Outputs.RoleArn"), "arn:aws:iam::999999999999:role/team/scheduler");
  assert.equal(refs.has("Secret"), false);
  assert.equal(refs.get("Bucket"), "deployed-bucket");
  assert.equal(calls.length, 3);
  await loadStackReferences("another-stack", "eu-west-1");
  assert.equal(calls[3].input.StackName, "another-stack");
  assert.equal(destroyed, 2);
});

test("CloudFormation errors do not silently fall back or expose server response data", async t => {
  let destroyed = false;
  t.mock.method(CloudFormationClient.prototype, "destroy", () => {
    destroyed = true;
  });
  t.mock.method(CloudFormationClient.prototype, "send", async () => {
    throw Object.assign(new Error("sensitive-response"), { name: "AccessDenied" });
  });
  await assert.rejects(
    loadStackReferences("stack", "us-east-1"),
    e => /AccessDenied.*--cf-stack/.test(e.message) && !e.message.includes("sensitive-response"),
  );
  assert.equal(destroyed, true);
});

test("both parsers use stack outputs and explicit role attributes while keeping Lambda targets local", async t => {
  const env = { ...process.env };
  const directory = await mkdtemp(path.join(tmpdir(), "freesls-stack-"));
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    await rm(directory, { recursive: true, force: true });
  });
  t.mock.method(CloudFormationClient.prototype, "send", async command =>
    command instanceof DescribeStacksCommand
      ? {
          Stacks: [
            {
              StackName: "deployed",
              StackId: "arn:aws:cloudformation:eu-west-1:999999999999:stack/deployed/id",
              Outputs: [
                {
                  OutputKey: "RoleArn",
                  OutputValue: "arn:aws:iam::999999999999:role/team/scheduler",
                },
              ],
            },
          ],
        }
      : {
          StackResourceSummaries: [
            {
              LogicalResourceId: "Role",
              PhysicalResourceId: "scheduler",
              ResourceType: "AWS::IAM::Role",
            },
          ],
        },
  );
  await writeFile(
    path.join(directory, "serverless.yml"),
    `service: demo
provider:
  environment:
    ROLE: !Ref Outputs.RoleArn
    OVERRIDE: !GetAtt Role.Arn
    TARGET: !GetAtt TargetLambdaFunction.Arn
functions:
  target:
    handler: handler.run
`,
  );
  await writeFile(
    path.join(directory, "template.yaml"),
    `Description: demo
Globals:
  Function:
    Environment:
      Variables:
        ROLE: !Ref Outputs.RoleArn
        OVERRIDE: !GetAtt Role.Arn
        TARGET: !GetAtt Target.Arn
Resources:
  Target:
    Type: AWS::Serverless::Function
    Properties:
      Handler: handler.run
`,
  );
  for (const load of [loadServerlessConfig, loadSamConfig]) {
    const result = await load(directory, {
      stage: "local",
      region: "eu-west-1",
      params: {},
      scheduler: true,
      cfStack: "deployed",
      cfValues: { "Role.Arn": "arn:aws:iam::999999999999:role/override" },
    });
    assert.equal(result.globalEnv.ROLE, "arn:aws:iam::999999999999:role/team/scheduler");
    assert.equal(result.globalEnv.OVERRIDE, "arn:aws:iam::999999999999:role/override");
    assert.equal(result.globalEnv.TARGET, result.functions[0].arn);
    assert.match(result.functions[0].arn, /:999999999999:function:/);
  }
});

test("CloudFormation reports an absent stack without falling back", async t => {
  let destroyed = false;
  t.mock.method(CloudFormationClient.prototype, "destroy", () => {
    destroyed = true;
  });
  t.mock.method(CloudFormationClient.prototype, "send", async () => ({ Stacks: [] }));
  await assert.rejects(
    loadStackReferences("missing", "us-east-1"),
    e => /CloudFormation lookup failed/.test(e.message) && /--cf-stack/.test(e.message),
  );
  assert.equal(destroyed, true);
});

test("local resolution mode makes no SSM or CloudFormation calls", async t => {
  let awsCalls = 0;
  t.mock.method(SSMClient.prototype, "send", async () => {
    awsCalls++;
    throw new Error("unexpected SSM call");
  });
  t.mock.method(CloudFormationClient.prototype, "send", async () => {
    awsCalls++;
    throw new Error("unexpected CloudFormation call");
  });
  const directory = await mkdtemp(path.join(tmpdir(), "freesls-no-aws-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "serverless.yml"),
    `service: demo
provider:
  environment:
    VALUE: !Sub "arn:aws:sqs:\${AWS::Region}:\${AWS::AccountId}:queue"
functions:
  target:
    handler: handler.run
`,
  );
  await writeFile(
    path.join(directory, "template.yaml"),
    `Description: demo
Resources:
  Target:
    Type: AWS::Serverless::Function
    Properties:
      Handler: handler.run
`,
  );
  const localOptions = { stage: "local", region: "eu-west-1", params: {}, resolveSSM: false };
  await loadServerlessConfig(directory, localOptions);
  await loadSamConfig(directory, localOptions);
  assert.equal(awsCalls, 0);
});
