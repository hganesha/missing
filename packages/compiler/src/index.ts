/**
 * @ehf/compiler: the plan compiler (`harnessc`).
 *
 * The single place that turns a domain package (package.yaml + Ladder Graph workflow +
 * dependencies) into an executable, content-addressed `harness.factory/plan-v2` plan.
 * Output is deterministic: the same package and model profile registry always produce the
 * same bytes and digests.
 */
export {
  COMPILER_IDENTITY,
  COMPILER_NAME,
  COMPILER_VERSION,
  compilePackage,
  LGIR_CORE_REVISION,
  validatePackage,
  type CompiledPlan,
  type CompileOptions,
  type CompilerIdentity,
  type ModelProfileRegistry,
  type PackageInput,
  type ValidationResult,
} from "./compiler.js";
export { CompilerError } from "./errors.js";
export type { AnalysisResult, Diagnostic } from "./lgir.js";
export { directorySource, memorySource, type PackageSource } from "./source.js";
