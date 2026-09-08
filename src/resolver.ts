export interface ResolveContext {
  stage: string;
  region: string;
  serviceName: string;
  params: Record<string, string>;
  rawConfig: any;
  ssmValues?: Map<string, string>;
}

/**
 * Read a nested value using a dotted path.
 */
export function getNestedValue(targetObject: any, pathExpression: string): any {
  return pathExpression
    .split(".")
    .reduce(
      (currentObject, propertyKey) => (currentObject ? currentObject[propertyKey] : undefined),
      targetObject,
    );
}

/**
 * Resolve one fallback term.
 */
function resolveSingleTerm(
  term: string,
  context: ResolveContext,
  resolveSSM: boolean,
): string | null {
  const trimmedTerm = term.trim();

  // Quoted literal.
  if (
    (trimmedTerm.startsWith("'") && trimmedTerm.endsWith("'")) ||
    (trimmedTerm.startsWith('"') && trimmedTerm.endsWith('"'))
  ) {
    return trimmedTerm.slice(1, -1);
  }

  const regexMatch = trimmedTerm.match(/^([a-zA-Z0-9_-]+):(.*)$/);
  if (!regexMatch) return null;

  const [, variableSource, variableExpression] = regexMatch;
  const trimmedExpression = variableExpression.trim();

  switch (variableSource) {
    case "sls":
      return trimmedExpression === "stage" ? context.stage : null;
    case "opt":
      if (trimmedExpression === "stage") return context.stage;
      if (trimmedExpression === "region") return context.region;
      return null;

    case "self": {
      if (trimmedExpression === "service") return context.serviceName;
      if (trimmedExpression === "provider.stage") {
        const providerStage = getNestedValue(context.rawConfig, "provider.stage");
        if (typeof providerStage === "string" && !providerStage.includes("${")) {
          return providerStage;
        }
        return context.stage;
      }
      const nestedValue = getNestedValue(context.rawConfig, trimmedExpression);
      return nestedValue != null ? String(nestedValue) : null;
    }

    case "param":
      return context.params[trimmedExpression] ?? null;

    case "env": {
      const environmentValue = process.env[trimmedExpression];
      return environmentValue !== undefined && environmentValue !== "" ? environmentValue : null;
    }

    case "aws":
      if (trimmedExpression === "region") return context.region;
      if (trimmedExpression === "accountId") return "123456789012";
      return null;

    case "ssm": {
      if (!resolveSSM) {
        // Keep SSM references intact during discovery.
        return `\${${trimmedTerm}}`;
      }
      const ssmKey = trimmedExpression.split("~")[0].trim();
      if (context.ssmValues) {
        const ssmValue = context.ssmValues.get(ssmKey) ?? context.ssmValues.get(trimmedExpression);
        if (ssmValue !== undefined && ssmValue !== null) return ssmValue;
      }
      return null;
    }

    default:
      return null;
  }
}

/**
 * Resolve comma-separated fallback terms.
 */
function resolveExpressionWithFallbacks(
  expression: string,
  context: ResolveContext,
  resolveSSM: boolean,
  depth: number,
): string | null {
  const fallbackParts: string[] = [];
  let quote = "";
  let start = 0;
  for (let index = 0; index < expression.length; index++) {
    const character = expression[index];
    if (quote && character === "\\") {
      index++;
      continue;
    }
    if (character === quote) quote = "";
    else if (!quote && (character === "'" || character === '"')) quote = character;
    else if (!quote && character === ",") {
      fallbackParts.push(expression.slice(start, index).trim());
      start = index + 1;
    }
  }
  fallbackParts.push(expression.slice(start).trim());

  for (const expressionPart of fallbackParts) {
    if (!resolveSSM && expressionPart.startsWith("ssm:")) return `\${${expression}}`;
    const resolvedValue = resolveSingleTerm(expressionPart, context, resolveSSM);
    if (resolvedValue !== null) {
      if (resolveSSM && /^(self|param):/.test(expressionPart)) {
        return resolveVariableText(resolvedValue, context, true, depth + 1);
      }
      return resolvedValue;
    }
  }

  // Use an offline mock only after all SSM fallbacks fail.
  if (resolveSSM && fallbackParts.length > 0) {
    const initialTerm = fallbackParts[0]?.trim() || "";
    if (initialTerm.startsWith("ssm:")) {
      const parameterPath = initialTerm.slice(4).split("~")[0].trim();
      const parameterLeafName = parameterPath.split("/").pop() || "value";
      return `mock-${parameterLeafName.toLowerCase()}`;
    }
  }

  return null;
}

/**
 * Resolve nested variables from the inside out.
 */
export function resolveVariables(text: string, context: ResolveContext, resolveSSM = true): string {
  return resolveVariableText(text, context, resolveSSM, 0);
}

function resolveVariableText(
  text: string,
  context: ResolveContext,
  resolveSSM: boolean,
  depth: number,
): string {
  if (depth >= 10) return text;
  let currentResult = text;
  let iterationCount = 0;
  const maxIterations = 10;

  // Resolve nested paths without consuming SSM references during discovery.
  const innermostRegex = /\$\{(?!\s*ssm:)([^{}]+)\}/g;

  let previousResult = "";
  while (currentResult !== previousResult && iterationCount < maxIterations) {
    previousResult = currentResult;
    currentResult = currentResult.replace(innermostRegex, (fullMatch, innerExpression) => {
      const resolvedValue = resolveExpressionWithFallbacks(innerExpression, context, false, depth);
      return resolvedValue !== null ? resolvedValue : fullMatch;
    });
    iterationCount++;
  }

  // SSM values are data, not another round of configuration expressions.
  return resolveSSM
    ? currentResult.replace(
        /\$\{([^{}]+)\}/g,
        (match, expression) =>
          resolveExpressionWithFallbacks(expression, context, true, depth) ?? match,
      )
    : currentResult;
}

/**
 * Discover SSM names and preserve version selectors.
 */
export function extractSSMPaths(content: string): string[] {
  const discoveredPaths: string[] = [];

  const addValidSSMPath = (candidatePath: string) => {
    const cleanPath = candidatePath.split("~")[0].trim();
    const hasUnresolvedTokens = cleanPath.includes("$") || cleanPath.includes("{");
    if (cleanPath && !hasUnresolvedTokens) {
      discoveredPaths.push(cleanPath);
    }
  };

  // Serverless references.
  const serverlessSsmRegex = /\$\{\s*ssm:([^,}]+)/g;
  let regexMatch: RegExpExecArray | null;

  while ((regexMatch = serverlessSsmRegex.exec(content)) !== null) {
    addValidSSMPath(regexMatch[1]);
  }

  // CloudFormation dynamic references.
  const cloudFormationDynamicReferenceRegex = /\{\{\s*resolve:ssm(?:-secure)?:\s*([^{}]+)\}\}/g;

  while ((regexMatch = cloudFormationDynamicReferenceRegex.exec(content)) !== null) {
    addValidSSMPath(regexMatch[1]);
  }

  return Array.from(new Set(discoveredPaths));
}

/** Transform scalar data without serializing it back to YAML. */
export function resolveScalarData(value: unknown, resolve: (text: string) => string): unknown {
  if (typeof value === "string") return resolve(value);
  if (Array.isArray(value)) return value.map(item => resolveScalarData(item, resolve));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveScalarData(item, resolve)]),
    );
  }
  return value;
}
