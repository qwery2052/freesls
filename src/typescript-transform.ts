import path from "node:path";
import ts from "typescript";
import type { JitiOptions } from "jiti";

export function createTypeScriptTransform(
  transform: NonNullable<JitiOptions["transform"]>,
): NonNullable<JitiOptions["transform"]> {
  return options => {
    if (!options.ts || !options.filename) return transform(options);

    let compilerOptions: ts.CompilerOptions = {};
    const configPath = ts.findConfigFile(path.dirname(options.filename), ts.sys.fileExists);
    if (configPath) {
      const config = ts.readConfigFile(configPath, ts.sys.readFile);
      if (config.error)
        throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
      const parsed = ts.parseJsonConfigFileContent(
        config.config,
        { ...ts.sys, readDirectory: () => [] },
        path.dirname(configPath),
      );
      // Loading a handler does not require it to belong to the project's build inputs.
      const errors = parsed.errors.filter(error => error.code !== 18003);
      if (errors.length)
        throw new Error(
          ts.formatDiagnostics(errors, {
            getCanonicalFileName: file => file,
            getCurrentDirectory: ts.sys.getCurrentDirectory,
            getNewLine: () => "\n",
          }),
        );
      compilerOptions = parsed.options;
    }

    const result = ts.transpileModule(options.source, {
      fileName: options.filename,
      reportDiagnostics: true,
      compilerOptions: {
        target: compilerOptions.target ?? ts.ScriptTarget.ESNext,
        experimentalDecorators: compilerOptions.experimentalDecorators ?? true,
        emitDecoratorMetadata:
          compilerOptions.emitDecoratorMetadata ?? compilerOptions.experimentalDecorators !== false,
        useDefineForClassFields: compilerOptions.useDefineForClassFields,
        jsx: compilerOptions.jsx ?? ts.JsxEmit.Preserve,
        jsxFactory: compilerOptions.jsxFactory,
        jsxFragmentFactory: compilerOptions.jsxFragmentFactory,
        jsxImportSource: compilerOptions.jsxImportSource,
        // Jiti must still lower imports, including async ESM dependencies and import.meta.
        module: ts.ModuleKind.Preserve,
        inlineSourceMap: true,
        inlineSources: true,
      },
    });
    const errors = result.diagnostics?.filter(
      error => error.category === ts.DiagnosticCategory.Error,
    );
    if (errors?.length)
      throw new Error(ts.flattenDiagnosticMessageText(errors[0].messageText, "\n"));
    return transform({ ...options, source: result.outputText, ts: false });
  };
}
