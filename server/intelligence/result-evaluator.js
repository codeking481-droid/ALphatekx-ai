export function evaluateProviderResult(result) {
  if (!result || typeof result.text !== 'string' || !result.text.trim()) {
    return { accepted: false, reason: 'empty_response' }
  }
  return { accepted: true }
}

export function evaluateToolResult(tool, result) {
  if (typeof tool?.verifyResult !== 'function') {
    return { accepted: false, reason: 'No deterministic result verifier is registered.' }
  }
  try {
    const accepted = tool.verifyResult(result)
    if (typeof accepted !== 'boolean') {
      return { accepted: false, reason: 'The registered tool verifier must return a boolean synchronously.' }
    }
    return accepted
      ? { accepted: true, method: 'registered_tool_verifier' }
      : { accepted: false, reason: 'The registered tool verifier did not confirm the result.' }
  } catch (error) {
    return {
      accepted: false,
      reason: `The registered tool verifier failed: ${error.message || 'unknown error'}`,
    }
  }
}

export function evaluateSpecialistResult({
  task,
  output,
  dependencyOutputs,
  evidence,
  independentReview,
  specialistProvider,
}) {
  if (!task || typeof task !== 'object' ||
    typeof task.expectedOutput !== 'string' || !task.expectedOutput.trim() ||
    !Array.isArray(task.acceptanceCriteria) || !task.acceptanceCriteria.length) {
    return { status: 'failed', accepted: false, reason: 'The planned deliverable or acceptance criteria are invalid.' }
  }
  if (typeof output !== 'string' || !output.trim()) {
    return { status: 'failed', accepted: false, reason: 'The specialist output is empty or invalid.' }
  }
  if (!dependencyOutputs || typeof dependencyOutputs !== 'object' || Array.isArray(dependencyOutputs) ||
    !task.dependencies.every((id) => Object.hasOwn(dependencyOutputs, id) && dependencyOutputs[id] !== undefined)) {
    return { status: 'incomplete', accepted: false, reason: 'One or more required dependency outputs are missing.' }
  }
  if (!Array.isArray(evidence) || !evidence.some((item) =>
    item?.kind === 'provider_response' && typeof item.provider === 'string' && typeof item.model === 'string')) {
    return { status: 'failed', accepted: false, reason: 'No supporting provider evidence was recorded.' }
  }
  if (!independentReview) {
    return { status: 'incomplete', accepted: false, reason: 'Independent acceptance review is unavailable.' }
  }
  if (typeof independentReview.provider !== 'string' ||
    independentReview.provider === specialistProvider ||
    independentReview.accepted !== true ||
    independentReview.deliverablesPresent !== true ||
    independentReview.dependencyOutputsValid !== true ||
    !Array.isArray(independentReview.checkedAcceptanceCriteria) ||
    independentReview.checkedAcceptanceCriteria.length !== task.acceptanceCriteria.length ||
    new Set(independentReview.checkedAcceptanceCriteria).size !== task.acceptanceCriteria.length ||
    task.acceptanceCriteria.some((criterion) => !independentReview.checkedAcceptanceCriteria.includes(criterion)) ||
    !Array.isArray(independentReview.issues) || independentReview.issues.length) {
    return {
      status: 'incomplete',
      accepted: false,
      reason: independentReview.provider === specialistProvider
        ? 'Acceptance review was not independent of the specialist.'
        : 'Independent review rejected or did not verify every required criterion.',
    }
  }
  return {
    status: 'verified',
    accepted: true,
    method: 'independent_specialist_review',
    provider: independentReview.provider,
    checks: [
      'valid specialist output',
      'expected deliverable independently checked',
      'all acceptance criteria independently checked',
      'dependency outputs independently checked',
    ],
  }
}
