// A semantic FAIL is valid only after the native judge completed and returned
// a structured verdict. Runner/parser failures must never qualify a negative.
export function completedJudge(
  runner: { ok: boolean; agentExitCode: number | null },
  verdict: { pass: boolean; reason: string } | null
): { pass: boolean; reason: string } {
  if (!runner.ok || runner.agentExitCode !== 0 || !verdict) {
    throw new Error('Fixed judge did not complete with a structured verdict')
  }
  return verdict
}
