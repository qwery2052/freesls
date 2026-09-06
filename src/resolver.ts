export interface ResolveContext {
  stage: string;
  region: string;
  serviceName: string;
  params: Record<string, string>;
  rawConfig: any;
  ssmValues?: Map<string, string>;
}

export function getNestedValue(obj: any, pathStr: string): any {
  return pathStr.split(".").reduce((acc, part) => (acc ? acc[part] : undefined), obj);
}

/**
 * Resuelve una sola variable individual.
 */
function resolveSingleTerm(term: string, ctx: ResolveContext, resolveSSM: boolean): string | null {
  const clean = term.trim();

  // Literal con comillas 'valor' o "valor"
  if (
    (clean.startsWith("'") && clean.endsWith("'")) ||
    (clean.startsWith('"') && clean.endsWith('"'))
  ) {
    return clean.slice(1, -1);
  }

  const match = clean.match(/^([a-zA-Z0-9_-]+):(.*)$/);
  if (!match) return null;

  const [, source, value] = match;
  const expr = value.trim();

  switch (source) {
    case "sls":
    case "opt":
      return expr === "stage" ? ctx.stage : ctx.stage;

    case "self": {
      if (expr === "service") return ctx.serviceName;
      if (expr === "provider.stage") {
        const val = getNestedValue(ctx.rawConfig, "provider.stage");
        if (typeof val === "string" && !val.includes("${")) {
          return val;
        }
        return ctx.stage;
      }
      const val = getNestedValue(ctx.rawConfig, expr);
      return val !== undefined ? String(val) : "";
    }

    case "param":
      return ctx.params[expr] ?? "";

    case "env": {
      const e = process.env[expr];
      return e !== undefined && e !== "" ? e : null;
    }

    case "aws":
      if (expr === "region") return ctx.region;
      if (expr === "accountId") return "123456789012";
      return "";

    case "ssm": {
      if (!resolveSSM) {
        // En primera pasada, preservamos intacta la referencia ssm
        return `\${${clean}}`;
      }
      const ssmKey = expr.split("~")[0].trim();
      if (ctx.ssmValues) {
        const val = ctx.ssmValues.get(ssmKey) ?? ctx.ssmValues.get(expr);
        if (val) return val;
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
  expr: string,
  ctx: ResolveContext,
  resolveSSM: boolean,
): string | null {
  // Separar por comas fuera de comillas simples
  const parts = expr.split(/,(?=(?:[^']*'[^']*')*[^']*$)/).map(p => p.trim());

  for (const part of parts) {
    const resolved = resolveSingleTerm(part, ctx, resolveSSM);
    if (resolved !== null) {
      return resolved;
    }
  }

  return null;
}

/**
 * Resuelve variables de adentro hacia afuera repetidamente.
 */
export function resolveVariables(text: string, ctx: ResolveContext, resolveSSM = true): string {
  let result = text;
  let iterations = 0;
  const maxIterations = 10;

  // Si resolveSSM es false, ignoramos los bloques ${ssm:...} externos
  // para que sus variables anidadas (${self:...}) se resuelvan primero sin consumir el bloque
  const innermostRegex = resolveSSM ? /\$\{([^{}]+)\}/g : /\$\{\s*(?!ssm:)([^{}]+)\}/g;

  let previous = "";
  while (result !== previous && iterations < maxIterations) {
    previous = result;
    result = result.replace(innermostRegex, (fullMatch, innerExpr) => {
      const resolved = resolveExpressionWithFallbacks(innerExpr, ctx, resolveSSM);
      return resolved !== null ? resolved : fullMatch;
    });
    iterations++;
  }

  return result;
}

/**
 * Extrae todas las rutas SSM del texto una vez que ya no tienen variables anidadas adentro.
 */
export function extractSSMPaths(content: string): string[] {
  // Captura la parte de la ruta en ${ssm:/mi/ruta, ...} o ${ssm:/mi/ruta}
  const ssmRegex = /\$\{\s*ssm:([^,}]+)/g;
  const paths: string[] = [];
  let match;

  while ((match = ssmRegex.exec(content)) !== null) {
    const candidate = match[1].trim();
    const cleanPath = candidate.split("~")[0].trim();

    // Solo tomamos rutas válidas de SSM (/...) que no tengan restos sin resolver ($)
    if (cleanPath.startsWith("/") && !cleanPath.includes("$") && !cleanPath.includes("{")) {
      paths.push(cleanPath);
    }
  }

  return Array.from(new Set(paths));
}
