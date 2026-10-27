/** Revision preconditions guard execution; retries retain the original receipt. */
export function taskCommandBody(value: unknown) {
  const {
    expectedTask: _task,
    expectedPlanRevision: _plan,
    ...body
  } = (value ?? {}) as Record<string, unknown>;
  return body;
}
