const methods = new Set(['get_state', 'create_plan', 'cancel_analysis', 'apply_plan', 'discard_plan', 'archive_plan']);
export async function answerQuickRequest(request, call, reviewLocked = false) {
  const id = request?.id;
  if (typeof id !== 'string' || id.length > 80) return null;
  if (!methods.has(request.method)) return { id, error: 'This command is unavailable in quick access.' };
  if (reviewLocked && ['create_plan', 'apply_plan', 'discard_plan', 'archive_plan'].includes(request.method)) {
    return { id, error: 'Save or cancel your plan edits in the main window before continuing.' };
  }
  try { return { id, result: await call(request.method, request.args ?? {}) }; }
  catch (error) { return { id, error: error.message }; }
}
