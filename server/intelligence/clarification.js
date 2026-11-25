export const HIGH_RISK_CONFIRMATION = 'Please confirm the intended scope before any high-impact or irreversible action.'

export function evaluateClarification(spec) {
  const clarificationQuestions = []
  const executionQuestions = []
  for (const missing of spec.missingInformation) {
    const question = missing.clarificationQuestion.trim()
    if (missing.requiredFor === 'drafting') clarificationQuestions.push(question)
    else if (question) executionQuestions.push(question)
    else executionQuestions.push(`Before execution, confirm whether to assume: ${missing.safeAssumption.trim()}`)
  }
  for (const ambiguity of spec.ambiguities) {
    if (ambiguity.kind === 'conflict' || ambiguity.blocksDrafting) {
      clarificationQuestions.push(ambiguity.clarificationQuestion.trim())
    } else if (ambiguity.blocksExecution) {
      executionQuestions.push(ambiguity.clarificationQuestion.trim())
    }
  }
  for (const assumption of spec.assumptions) {
    if (!assumption.safeForDrafting) clarificationQuestions.push(assumption.clarificationQuestion.trim())
  }
  if (['high', 'critical'].includes(spec.riskClassification)) executionQuestions.push(HIGH_RISK_CONFIRMATION)
  const questions = unique(clarificationQuestions)
  const beforeExecution = unique(executionQuestions)
  return {
    clarificationRequired: questions.length > 0,
    clarificationQuestions: questions,
    executionQuestions: beforeExecution,
    confirmationRequiredBeforeExecution: beforeExecution.length > 0,
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}
