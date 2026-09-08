export interface ResolveContext {
  stage: string;
  region: string;
  serviceName: string;
  params: Record<string, string>;
  rawConfig: any;
  ssmValues?: Map<string, string>;
}

/**
 * Obtiene un valor anidado a partir de una notación por puntos (ej. "provider.stage").
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
 * Resuelve una sola variable individual.
 */
function resolveSingleTerm(
  term: string,
  context: ResolveContext,
  resolveSSM: boolean,
): string | null {
  const trimmedTerm = term.trim();

  // Literal con comillas 'valor' o "valor"
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
    case "opt":
      return context.stage;

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
      return nestedValue !== undefined ? String(nestedValue) : "";
    }

    case "param":
      return context.params[trimmedExpression] ?? "";

    case "env": {
      const environmentValue = process.env[trimmedExpression];
      return environmentValue !== undefined && environmentValue !== "" ? environmentValue : null;
    }

    case "aws":
      if (trimmedExpression === "region") return context.region;
      if (trimmedExpression === "accountId") return "123456789012";
      return "";

    case "ssm": {
      if (!resolveSSM) {
        // En primera pasada, preservamos intacta la referencia ssm
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
      return "";
  }
}

/**
 * Resuelve una expresión con comas / fallbacks.
 * Ej: "ssm:/path/KEY, env:KEY, 'fallback'"
 */
function resolveExpressionWithFallbacks(
  expression: string,
  context: ResolveContext,
  resolveSSM: boolean,
): string | null {
  // Separar por comas fuera de comillas simples
  const fallbackParts = expression.split(/,(?=(?:[^']*'[^']*')*[^']*$)/).map(part => part.trim());

  for (const expressionPart of fallbackParts) {
    const resolvedValue = resolveSingleTerm(expressionPart, context, resolveSSM);
    if (resolvedValue !== null) {
      return resolvedValue;
    }
  }

  // Si estamos en la pasada final (resolveSSM === true) y ningún término resolvió,
  // pero el primer término era un ssm (ej. ${ssm:/ruta/parametro}),
  // generamos el mock automático de salvavidas para asegurar que nunca quede una variable sin resolver
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
 * Resuelve variables de adentro hacia afuera repetidamente.
 */
export function resolveVariables(text: string, context: ResolveContext, resolveSSM = true): string {
  let currentResult = text;
  let iterationCount = 0;
  const maxIterations = 10;

  // Si resolveSSM es false, ignoramos los bloques ${ssm:...} externos
  // para que sus variables anidadas (${self:...}) se resuelvan primero sin consumir el bloque
  const innermostRegex = resolveSSM ? /\$\{([^{}]+)\}/g : /\$\{\s*(?!ssm:)([^{}]+)\}/g;

  let previousResult = "";
  while (currentResult !== previousResult && iterationCount < maxIterations) {
    previousResult = currentResult;
    currentResult = currentResult.replace(innermostRegex, (fullMatch, innerExpression) => {
      const resolvedValue = resolveExpressionWithFallbacks(innerExpression, context, resolveSSM);
      return resolvedValue !== null ? resolvedValue : fullMatch;
    });
    iterationCount++;
  }

  return currentResult;
}

/**
 * Extrae todas las rutas SSM del texto (tanto formato Serverless ${ssm:/path}
 * como Dynamic References de CloudFormation/SAM {{resolve:ssm:/path}}).
 */
export function extractSSMPaths(content: string): string[] {
  const discoveredPaths: string[] = [];

  const addValidSSMPath = (candidatePath: string) => {
    const cleanPath = candidatePath.split("~")[0].trim();
    const hasUnresolvedTokens = cleanPath.includes("$") || cleanPath.includes("{");
    if (cleanPath.startsWith("/") && !hasUnresolvedTokens) {
      discoveredPaths.push(cleanPath);
    }
  };

  // 1. Sintaxis Serverless Framework: ${ssm:/mi/ruta, ...} o ${ssm:/mi/ruta}
  const serverlessSsmRegex = /\$\{\s*ssm:([^,}]+)/g;
  let regexMatch: RegExpExecArray | null;

  while ((regexMatch = serverlessSsmRegex.exec(content)) !== null) {
    addValidSSMPath(regexMatch[1]);
  }

  // 2. Sintaxis CloudFormation / SAM Dynamic References:
  // {{resolve:ssm:/ruta}} o {{resolve:ssm-secure:/ruta}} (con o sin versión :1 al final)
  const cloudFormationDynamicReferenceRegex =
    /\{\{\s*resolve:ssm(?:-secure)?:\s*([^}:]+)(?::[^}]+)?\s*\}\}/g;

  while ((regexMatch = cloudFormationDynamicReferenceRegex.exec(content)) !== null) {
    addValidSSMPath(regexMatch[1]);
  }

  return Array.from(new Set(discoveredPaths));
}
