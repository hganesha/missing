/**
 * A compilation refusal.
 *
 * `message` is the full diagnostic (`package.skill_binding_duplicate:screening.sanctions.execute`),
 * byte-for-byte the text the compiler has always emitted, so documentation, tests and
 * authoring diagnostics that match on it keep working. `code` is the stable prefix before the
 * first `:` (`package.skill_binding_duplicate`), or a phrase such as `parse package.yaml`.
 */
export class CompilerError extends Error {
  readonly code: string;

  constructor(code: string, message: string = code) {
    super(message);
    this.name = "CompilerError";
    this.code = code;
  }
}

/** Refuse with a `code:detail` message; the code is everything before the first colon. */
export function refuse(message: string): never {
  const separator = message.indexOf(":");
  throw new CompilerError(separator === -1 ? message : message.slice(0, separator), message);
}
