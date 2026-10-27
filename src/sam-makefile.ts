import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SOURCE_PATH_PATTERN = /[^\s"'`]+\.(?:ts|tsx|js|jsx|mjs|cjs)\b/gi;

export interface GnuMakeCommand {
  command: string;
  version: string;
}

export interface MakefileHandlerResult {
  handler: string;
  sourceFile: string;
}

function makeCandidates(): string[] {
  return process.platform === "win32"
    ? ["make", "mingw32-make", "gmake"]
    : ["make", "gmake", "mingw32-make"];
}

function quoteWindowsArgument(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function runCommand(
  command: string,
  args: string[],
  options: Parameters<typeof spawnSync>[2] = {},
) {
  if (process.platform === "win32") {
    const commandLine = [command, ...args].map(quoteWindowsArgument).join(" ");
    return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", commandLine], {
      ...options,
      windowsHide: true,
    });
  }
  return spawnSync(command, args, options);
}

/**
 * Find a GNU Make executable. SAM's makefile builds use GNU Make syntax, so
 * nmake and other implementations are rejected explicitly.
 */
export function resolveGnuMakeCommand(): GnuMakeCommand {
  const nonGnu: string[] = [];

  for (const command of makeCandidates()) {
    const result = runCommand(command, ["--version"], {
      encoding: "utf8",
      timeout: 10000,
    });
    if (result.error) continue;

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (result.status === 0 && output.includes("GNU Make")) {
      return {
        command,
        version:
          output
            .split(/\r?\n/)
            .find(line => line.includes("GNU Make"))
            ?.trim() ?? "",
      };
    }
    if (result.status === 0) nonGnu.push(command);
  }

  if (nonGnu.length > 0) {
    throw new Error(
      `GNU Make is required for --makefile, but ${nonGnu.join(", ")} is not GNU Make. Install GNU Make (for example: choco install make) or run without --makefile.`,
    );
  }
  throw new Error(
    "--makefile requires GNU Make, but none of `make`, `mingw32-make` or `gmake` was found in PATH. Install GNU Make (for example: choco install make) or run without --makefile.",
  );
}

function handlerParts(
  handler: string,
  logicalId: string,
): { fileBase: string; exportName: string } {
  const lastDot = handler.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === handler.length - 1) {
    throw new Error(
      `Invalid Handler for ${logicalId}: expected file.function, for example handler.appointmentRemindersHandler.`,
    );
  }
  return {
    fileBase: path.basename(handler.slice(0, lastDot)),
    exportName: handler.slice(lastDot + 1),
  };
}

/**
 * Extract the source file referenced by a `make -n` command. Artifact paths,
 * node_modules and command flags are ignored. If several candidates exist,
 * prefer the file whose basename matches the Handler file.
 */
export function extractMakeSourceFile(
  output: string,
  workingDirectory: string,
  handler: string,
  logicalId = "function",
): string {
  const { fileBase } = handlerParts(handler, logicalId);
  const candidates: string[] = [];

  for (const match of output.match(SOURCE_PATH_PATTERN) ?? []) {
    const token = match.replace(/[),;]+$/, "");
    if (token.startsWith("-") || token.includes(".aws-sam") || token.includes("node_modules")) {
      continue;
    }

    const resolved = path.isAbsolute(token) ? token : path.resolve(workingDirectory, token);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) continue;
    if (!SOURCE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) continue;
    if (!candidates.includes(resolved)) candidates.push(resolved);
  }

  if (candidates.length === 0) {
    throw new Error(
      `Could not find a source file for ${logicalId} in the output of \`make -B -n build-${logicalId}\`. Ensure the Makefile command prints the source path (for example esbuild src/functions/${logicalId}/handler.ts).`,
    );
  }

  const matching = candidates.filter(
    candidate => path.basename(candidate, path.extname(candidate)) === fileBase,
  );
  if (matching.length === 1) return matching[0];
  if (matching.length > 1) {
    throw new Error(
      `Ambiguous source file for ${logicalId}: ${matching.map(file => path.relative(workingDirectory, file)).join(", ")}. Use a unique Handler name or remove the extra source files from the Makefile command.`,
    );
  }
  if (candidates.length === 1) return candidates[0];

  throw new Error(
    `Ambiguous source file for ${logicalId}: ${candidates.map(file => path.relative(workingDirectory, file)).join(", ")}. Use a unique Handler name or an explicit mapping.`,
  );
}

/**
 * Resolve a makefile-backed SAM function to the original source handler.
 * `make -n` prints commands without executing the Makefile recipes, so
 * `sam build` and dependency installation are not triggered.
 */
export function resolveMakefileHandler(options: {
  workingDirectory: string;
  logicalId: string;
  handler: string;
  makeCommand: string;
  makefilePath?: string;
}): MakefileHandlerResult {
  const { workingDirectory, logicalId, handler, makeCommand } = options;
  const makefilePath = options.makefilePath ?? path.join(workingDirectory, "Makefile");
  if (!fs.existsSync(makefilePath) || !fs.statSync(makefilePath).isFile()) {
    throw new Error(
      `--makefile requires a Makefile at ${makefilePath}. Remove --makefile or place the Makefile at the project root.`,
    );
  }

  const artifactsDir = path.join(workingDirectory, ".aws-sam", "build", logicalId);
  const result = runCommand(makeCommand, ["-B", "-n", `build-${logicalId}`], {
    cwd: workingDirectory,
    encoding: "utf8",
    env: { ...process.env, ARTIFACTS_DIR: artifactsDir },
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60000,
  });

  if (result.error) {
    throw new Error(
      `Could not run \`${makeCommand} -B -n build-${logicalId}\` for ${logicalId}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const details = `${result.stderr ?? ""}`.trim() || `${result.stdout ?? ""}`.trim();
    throw new Error(
      `\`${makeCommand} -B -n build-${logicalId}\` failed for ${logicalId}.${details ? ` ${details}` : ""} Ensure the Makefile contains that target.`,
    );
  }

  const sourceFile = extractMakeSourceFile(
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    workingDirectory,
    handler,
    logicalId,
  );
  const { exportName } = handlerParts(handler, logicalId);
  const extension = path.extname(sourceFile);
  const withoutExtension = sourceFile.slice(0, -extension.length);
  const relativeSource = path.relative(workingDirectory, sourceFile);
  const handlerSource = relativeSource.startsWith("..")
    ? withoutExtension
    : relativeSource.slice(0, -extension.length);

  return {
    handler: `${handlerSource}.${exportName}`,
    sourceFile: relativeSource.startsWith("..") ? sourceFile : relativeSource,
  };
}
