import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadServerlessConfig, parseYaml } from "../dist/parser.js";
import { loadSamConfig, resolveSamVariables } from "../dist/sam-parser.js";
import { extractSSMPaths, resolveVariables } from "../dist/resolver.js";

const options = { stage: "local", region: "eu-west-1", params: {}, resolveSSM: false };

async function fixture(t, files) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freesls-config-"));
  const environment = { ...process.env };
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all(
    Object.entries(files).map(([name, content]) => writeFile(path.join(directory, name), content)),
  );
  return directory;
}

test("resolver honors option keys, missing fallbacks, and both quote styles", () => {
  const context = { ...options, serviceName: "demo", rawConfig: { custom: { absent: null } } };
  assert.equal(resolveVariables("${opt:region}", context), "eu-west-1");
  assert.equal(resolveVariables('${opt:missing, "a,b"}', context), "a,b");
  assert.equal(resolveVariables('${self:missing, param:missing, "a,b"}', context), "a,b");
  assert.equal(resolveVariables("${self:custom.absent, 'a,b'}", context), "a,b");
  assert.equal(resolveVariables('${ssm:missing, "a,b"}', context), "a,b");
  assert.equal(resolveVariables('${ ssm:missing, "a,b"}', context), "a,b");
  assert.equal(resolveVariables('${param:missing, ssm:missing, "a,b"}', context), "a,b");
  assert.equal(resolveVariables("${AWS::Region}", context), "${AWS::Region}");
});

test("SSM discovery and resolution preserve simple names and dynamic versions", () => {
  assert.deepEqual(
    extractSSMPaths(
      "${ssm:NAME} ${ssm:/path~true} {{resolve:ssm:NAME:7}} {{resolve:ssm-secure:/path:2}}",
    ),
    ["NAME", "/path", "NAME:7", "/path:2"],
  );
  assert.equal(
    resolveSamVariables(
      "{{resolve:ssm:NAME:7}}",
      {},
      {
        ...options,
        serviceName: "demo",
        ssmValues: new Map([
          ["NAME", "wrong"],
          ["NAME:7", "correct"],
        ]),
      },
    ),
    "correct",
  );
});

test("SSM config-derived fallbacks resolve recursively without expanding SSM data", () => {
  const context = {
    ...options,
    serviceName: "demo",
    rawConfig: {
      custom: {
        fallback: "${opt:stage}",
        nested: "${ssm:/missing, self:custom.fallback}",
        stored: "${ssm:/stored}",
        cyclic: "${ssm:/missing, self:custom.cyclic}",
      },
    },
    ssmValues: new Map([["/stored", "${opt:stage}"]]),
  };
  assert.equal(resolveVariables("${ssm:/missing, self:custom.fallback}", context), "local");
  assert.equal(resolveVariables("${ssm:/missing, self:custom.nested}", context), "local");
  assert.equal(resolveVariables("${ssm:/missing, self:custom.stored}", context), "${opt:stage}");
  assert.equal(resolveVariables("${ssm:/stored, self:custom.fallback}", context), "${opt:stage}");
  assert.equal(
    resolveVariables("${ssm:/missing, self:custom.cyclic}", context),
    "${ssm:/missing, self:custom.cyclic}",
  );
});

for (const version of ["1.0", "2.0"]) {
  test(`both parsers normalize unquoted YAML payload ${version}`, async t => {
    const directory = await fixture(t, {
      "serverless.yml": `service: demo
provider:
  httpApi:
    payload: ${version}
functions:
  demo:
    handler: index.handler
    events:
      - httpApi: GET /
`,
      "template.yaml": `Resources:
  Function:
    Type: AWS::Serverless::Function
    Properties:
      Handler: index.handler
      Events:
        Get:
          Type: HttpApi
          Properties:
            Path: /
            Method: GET
            PayloadFormatVersion: ${version}
`,
    });
    assert.equal(
      (await loadServerlessConfig(directory, options)).routes[0].payloadVersion,
      version,
    );
    assert.equal((await loadSamConfig(directory, options)).routes[0].payloadVersion, version);
  });
}

test("SAM resolves nested dynamic paths before looking up SSM values", () => {
  const text = "{{resolve:ssm:/${Stage}/key}} {{resolve:ssm-secure:/${Stage}/secret:3}}";
  const parameters = { Stage: "${Deployment}", Deployment: "local" };
  const context = {
    ...options,
    serviceName: "demo",
    ssmValues: new Map([
      ["/local/key", "${Stage}: literal data"],
      ["/local/secret:3", "selected"],
    ]),
  };
  assert.equal(resolveSamVariables(text, parameters, context), "${Stage}: literal data selected");
  const discovered = resolveSamVariables(text, parameters, context, false);
  assert.deepEqual(extractSSMPaths(discovered), ["/local/key", "/local/secret:3"]);
  assert.equal(
    resolveSamVariables("{{resolve:ssm:/${Missing}/key}}", {}, context),
    "{{resolve:ssm:/${Missing}/key}}",
  );
});

test("SAM nested dynamic paths use offline mocks and fall back only after interpolation", async t => {
  const directory = await fixture(t, {
    "template.yaml": JSON.stringify({
      Resources: {
        Function: {
          Type: "AWS::Serverless::Function",
          Properties: {
            Environment: {
              Variables: {
                FOUND: "{{resolve:ssm:/${Stage}/key:2}}",
                MISSING: "{{resolve:ssm:/${Stage}/missing}}",
                SUB: { "Fn::Sub": "{{resolve:ssm:/${Stage}/key:2}}" },
              },
            },
            Events: { Get: { Type: "Api" } },
          },
        },
      },
    }),
    "ssm.env": "/local/key:2=offline-${Stage}",
  });
  const result = await loadSamConfig(directory, options);
  assert.deepEqual(result.routes[0].environment, {
    FOUND: "offline-${Stage}",
    MISSING: "mock-missing",
    SUB: "offline-${Stage}",
  });
});

test("Serverless treats SSM contents as terminal data in config and environment", async t => {
  const literal = "${opt:stage} ${param:value} ${ssm:SECOND}";
  const directory = await fixture(t, {
    "serverless.yml": JSON.stringify({
      service: "demo",
      provider: {
        environment: { FREESLS_CONFIG_LITERAL: "${ssm:/${opt:stage}/KEY}" },
      },
      functions: {
        demo: {
          handler: "index.handler",
          environment: {
            LOCAL: "${ssm:/${opt:stage}/KEY}",
          },
          events: [{ http: "GET /" }],
        },
      },
    }),
    "ssm.env": `/local/KEY=${literal}\nSECOND=must-not-expand`,
  });
  const result = await loadServerlessConfig(directory, {
    ...options,
    params: { value: "must-not-expand" },
  });
  assert.equal(result.config.provider.environment.FREESLS_CONFIG_LITERAL, literal);
  assert.equal(result.globalEnv.FREESLS_CONFIG_LITERAL, literal);
  assert.equal(result.routes[0].environment.FREESLS_CONFIG_LITERAL, literal);
  assert.equal(result.routes[0].environment.LOCAL, literal);
});

for (const [framework, fields] of [
  ["serverless", ["method", "path", "handler"]],
  ["sam", ["Method", "Path", "Handler", "CodeUri"]],
]) {
  for (const field of fields) {
    test(`${framework} rejects invalid ${field} with a configuration error`, async t => {
      const invalid = { secret: "must-not-leak" };
      let config;
      if (framework === "serverless") {
        const fn = { handler: "index.handler", events: [{ http: { method: "GET", path: "/" } }] };
        if (field === "handler") fn.handler = invalid;
        else fn.events[0].http[field] = invalid;
        config = { service: "demo", functions: { demo: fn } };
      } else {
        const properties = {
          Handler: "index.handler",
          Events: { Get: { Type: "Api", Properties: { Method: "GET", Path: "/" } } },
        };
        if (field === "Method" || field === "Path")
          properties.Events.Get.Properties[field] = invalid;
        else properties[field] = invalid;
        config = {
          Resources: { Function: { Type: "AWS::Serverless::Function", Properties: properties } },
        };
      }
      const directory = await fixture(t, {
        [framework === "sam" ? "template.yaml" : "serverless.yml"]: JSON.stringify(config),
      });
      await assert.rejects(
        () => (framework === "sam" ? loadSamConfig : loadServerlessConfig)(directory, options),
        error => {
          assert.ok(!(error instanceof TypeError));
          assert.match(error.message, new RegExp(`Invalid .*${field}|Invalid ${field}`));
          assert.doesNotMatch(error.message, /must-not-leak/);
          return true;
        },
      );
    });
  }
}

for (const name of [
  { Ref: "Queue" },
  { "Fn::GetAtt": ["Queue", "Arn"] },
  { "Fn::Sub": "${Queue}" },
]) {
  test(`SAM rejects cyclic resource names through ${Object.keys(name)[0]}`, async t => {
    const directory = await fixture(t, {
      "template.yaml": JSON.stringify({
        Resources: {
          Queue: { Type: "AWS::SQS::Queue", Properties: { QueueName: name } },
        },
      }),
    });
    await assert.rejects(
      () => loadSamConfig(directory, options),
      /Cyclic or excessively nested CloudFormation resource name reference/,
    );
  });
}

test("YAML short intrinsics retain their structured scalar and sequence forms", () => {
  assert.deepEqual(
    parseYaml(
      'ref: !Ref Stage\nsub: !Sub ["${Name}", {Name: !Ref Stage}]\natt: !GetAtt [Queue, Arn]\nscalar: !GetAtt Queue.Arn\njoin: !Join [":", [a, b]]',
    ),
    {
      ref: { Ref: "Stage" },
      sub: { "Fn::Sub": ["${Name}", { Name: { Ref: "Stage" } }] },
      att: { "Fn::GetAtt": ["Queue", "Arn"] },
      scalar: { "Fn::GetAtt": "Queue.Arn" },
      join: { "Fn::Join": [":", ["a", "b"]] },
    },
  );
});

test("Serverless resolves parsed scalars without changing YAML data or route payload defaults", async t => {
  const value = "quotes: \"double\" and 'single'\nnext: # data\\tail";
  const directory = await fixture(t, {
    "serverless.yml": `service: demo
provider:
  environment:
    FREESLS_CONFIG_GLOBAL: '\${param:value}'
functions:
  demo:
    handler: index.handler
    environment:
      VALUE: "\${param:value}"
      SIMPLE: '\${ssm:NAME}'
      FALLBACK: '\${self:missing, param:missing, "a,b"}'
    events:
      - http: GET /rest
      - httpApi: GET /http
`,
    "ssm.env": 'NAME=mock: "quotes" # data',
  });
  const result = await loadServerlessConfig(directory, { ...options, params: { value } });
  assert.equal(result.globalEnv.FREESLS_CONFIG_GLOBAL, value);
  assert.equal(result.routes[0].environment.VALUE, value);
  assert.equal(result.routes[0].environment.SIMPLE, 'mock: "quotes" # data');
  assert.equal(result.routes[0].environment.FALLBACK, "a,b");
  assert.deepEqual(
    result.routes.map(route => route.payloadVersion),
    ["1.0", "2.0"],
  );
});

test("Serverless honors provider HTTP API payload version", async t => {
  const directory = await fixture(t, {
    "serverless.yml":
      'service: demo\nprovider:\n  httpApi:\n    payload: "1.0"\nfunctions:\n  demo:\n    handler: index.handler\n    events:\n      - httpApi: GET /\n',
  });
  assert.equal((await loadServerlessConfig(directory, options)).routes[0].payloadVersion, "1.0");
});

test("SAM resolves explicit refs, resource names, and Sub maps without replacing literals", async t => {
  const value = 'quoted "value": # data\nsecond line';
  const directory = await fixture(t, {
    "template.yaml": `Description: demo
Parameters:
  Name:
    Default: default-name
Resources:
  Queue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: !Ref Name
  Function:
    Type: AWS::Serverless::Function
    Properties:
      Handler: index.handler
      Environment:
        Variables:
          LITERAL: Name
          RESOURCE_LITERAL: Queue
          TAG_LITERAL: "!Ref Name"
          REF: !Ref Name
          URL: !Ref Queue
          ARN: !GetAtt [Queue, Arn]
          SUB: !Sub ['prefix-\${Alias}', {Alias: !Ref Name}]
          LONG:
            Fn::Sub: ['prefix-\${Alias}', {Alias: {Ref: Name}}]
          REGION:
            Fn::Sub: '\${AWS::Region}'
          ESCAPED: !Sub '\${!Name}'
          VERSION: '{{resolve:ssm:NAME:7}}'
      Events:
        Rest:
          Type: Api
          Properties: {Path: /rest, Method: get}
        Http:
          Type: HttpApi
          Properties: {Path: /http, Method: get}
        Legacy:
          Type: HttpApi
          Properties: {Path: /legacy, Method: get, PayloadFormatVersion: '1.0'}
`,
    "ssm.env": "NAME=wrong\nNAME:7=selected",
  });
  const result = await loadSamConfig(directory, { ...options, params: { Name: value } });
  const env = result.routes[0].environment;
  assert.equal(env.LITERAL, "Name");
  assert.equal(env.RESOURCE_LITERAL, "Queue");
  assert.equal(env.TAG_LITERAL, "!Ref Name");
  assert.equal(env.REF, value);
  assert.equal(env.URL, `https://sqs.eu-west-1.amazonaws.com/123456789012/${value}`);
  assert.equal(env.ARN, `arn:aws:sqs:eu-west-1:123456789012:${value}`);
  assert.equal(env.SUB, `prefix-${value}`);
  assert.equal(env.LONG, `prefix-${value}`);
  assert.equal(env.REGION, "eu-west-1");
  assert.equal(env.ESCAPED, "${Name}");
  assert.equal(env.VERSION, "selected");
  assert.deepEqual(
    result.routes.map(route => route.payloadVersion),
    ["1.0", "2.0", "1.0"],
  );
});

for (const framework of ["sam", "serverless"]) {
  test(`${framework} rejects unsupported environment objects without exposing values`, async t => {
    const environment = { SECRET: { "Fn::Join": ["", ["sensitive-value"]] } };
    const config =
      framework === "sam"
        ? {
            Resources: {
              Function: {
                Type: "AWS::Serverless::Function",
                Properties: {
                  Environment: { Variables: environment },
                  Events: { Get: { Type: "Api" } },
                },
              },
            },
          }
        : { service: "demo", provider: { environment } };
    const directory = await fixture(t, {
      [framework === "sam" ? "template.yaml" : "serverless.yml"]: JSON.stringify(config),
    });
    await assert.rejects(
      () => (framework === "sam" ? loadSamConfig : loadServerlessConfig)(directory, options),
      error => {
        assert.match(error.message, /Unsupported.*environment variable SECRET/);
        assert.doesNotMatch(error.message, /sensitive-value/);
        return true;
      },
    );
  });
}
