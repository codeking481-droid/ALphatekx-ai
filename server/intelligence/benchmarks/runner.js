import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { getAgentDefinition } from '../../agents/definitions.js'
import { ProviderError } from '../../providers/errors.js'
import { providerRegistry } from '../../providers/registry.js'
import { executePlanGraph } from '../execution-engine.js'
import { invokeWithProviderFallback } from '../error-recovery.js'
import { resumeExecutionAfterApproval } from '../orchestrator.js'
import { buildObjectiveMessages, parseObjectiveSpec, understandObjective } from '../objective.js'
import { validatePlanGraph } from '../plan-graph.js'
import { createPlanGraph } from '../planner.js'
import { evaluateSpecialistResult } from '../result-evaluator.js'

const SCENARIOS_URL = new URL('./scenarios.json', import.meta.url)
const BASE_OBJECTIVE = {
  goal: 'Complete the user request.',
  deliverables: ['A useful result'],
  resources: [],
  scopeConstraints: [],
  timeConstraints: [],
  instructions: [],
  successCriteria: ['The result addresses the request.'],
  missingInformation: [],
  ambiguities: [],
  assumptions: [],
  riskClassification: 'low',
  planningRequired: false,
  requiresExternalAction: false,
}

export async function loadBenchmarkScenarios() {
  const document = JSON.parse(await readFile(fileURLToPath(SCENARIOS_URL), 'utf8'))
  if (document.version !== 1 || !Array.isArray(document.scenarios)) {
    throw new Error('Unsupported or invalid intelligence benchmark scenario file.')
  }
  const ids = new Set()
  for (const scenario of document.scenarios) {
    if (!scenario.id || ids.has(scenario.id) || !Array.isArray(scenario.metrics) || !scenario.metrics.length) {
      throw new Error('Benchmark scenarios must have unique IDs and at least one metric.')
    }
    if (scenario.real && scenario.realStage === 'response') {
      const rubric = scenario.rubric
      if (!Array.isArray(scenario.messages) || !scenario.messages.length ||
        !rubric || !Array.isArray(rubric.manualReview) || !rubric.manualReview.length ||
        !Array.isArray(rubric.mustIncludeAll || []) ||
        !Array.isArray(rubric.mustIncludeAny || []) ||
        !Array.isArray(rubric.mustNotInclude || []) ||
        !(rubric.mustIncludeAll?.length || rubric.mustIncludeAny?.length || rubric.mustNotInclude?.length)) {
        throw new Error(`Real response scenario "${scenario.id}" requires messages and measurable plus manual review criteria.`)
      }
    } else if (scenario.real &&
      !(scenario.expect || scenario.realObjectiveExpect || scenario.planExpect)) {
      throw new Error(`Real scenario "${scenario.id}" requires explicit expected behavior.`)
    }
    ids.add(scenario.id)
  }
  return document.scenarios
}

export async function runFixtureBenchmarks({ scenarios } = {}) {
  const catalog = scenarios || await loadBenchmarkScenarios()
  const selected = catalog.filter((scenario) => scenario.kind !== 'response')
  const results = []
  for (const scenario of selected) {
    try {
      const actual = await evaluateFixtureScenario(scenario)
      const checks = compareExpected(actual, scenario.expect)
      results.push({
        id: scenario.id,
        metrics: scenario.metrics,
        input: scenario.request ? { request: scenario.request } : null,
        expected: scenario.expect,
        passed: checks.every((check) => check.passed),
        falseSuccess: scenario.metrics.includes('false_success_rate')
          ? detectsFalseSuccess(actual, scenario.expect)
          : null,
        checks,
        actual,
        provider: 'deterministic-fixture',
        model: null,
        latencyMs: null,
        usage: null,
        estimatedCost: null,
      })
    } catch (error) {
      results.push({
        id: scenario.id,
        metrics: scenario.metrics,
        input: scenario.request ? { request: scenario.request } : null,
        expected: scenario.expect,
        passed: false,
        falseSuccess: scenario.metrics.includes('false_success_rate') ? true : null,
        checks: [{ name: 'scenario_execution', passed: false, reason: safeError(error) }],
        actual: null,
        provider: 'deterministic-fixture',
        model: null,
        latencyMs: null,
        usage: null,
        estimatedCost: null,
        failureReason: safeError(error),
      })
    }
  }
  return buildReport({
    mode: 'fixtures',
    results,
    excludedScenarios: catalog.filter((scenario) => scenario.kind === 'response').map((scenario) => ({
      id: scenario.id,
      reason: 'Requires a real provider response.',
    })),
  })
}

export async function runRealBenchmarks({
  scenarios,
  registry = providerRegistry,
  providerId,
} = {}) {
  const selected = (scenarios || await loadBenchmarkScenarios()).filter((scenario) => scenario.real)
  const providers = registry.list().filter((provider) => provider.available)
  const provider = providerId
    ? providers.find((candidate) => candidate.id === providerId)
    : providers.find((candidate) => candidate.id === process.env.AI_PROVIDER) || providers[0]
  if (!provider) {
    return buildReport({
      mode: 'real',
      status: 'skipped',
      provider: providerId || null,
      skipReason: providerId
        ? `Provider "${providerId}" is unavailable. Configure its API key and matching model variable.`
        : 'No provider has both a server-side API key and matching model configured.',
      missingConfiguration: providerId ? [providerConfiguration(providerId)] : providerConfigurations(),
      results: [],
    })
  }
  const database = createTelemetryDatabase()
  const results = []
  for (const scenario of selected) {
    const startedAt = performance.now()
    const modelCallsBefore = database.events.length
    const modelResponses = []
    const evaluationRegistry = createIsolatedProviderRegistry(registry, provider.id, modelResponses)
    let activeProvider = evaluationRegistry.get(provider.id)
    let objective
    let planGraph = null
    let objectiveStage = null
    let planningStage = null
    let fallbackUsed = false
    try {
      if (scenario.realStage === 'response') {
        const responseStage = await timed(() => invokeWithProviderFallback(
          evaluationRegistry,
          activeProvider,
          { messages: scenario.messages },
          { requestId: `benchmark-${scenario.id}`, database },
        ))
        fallbackUsed = responseStage.value.fallbackUsed === true
        activeProvider = responseStage.value.provider
        const response = typeof responseStage.value.result?.text === 'string'
          ? responseStage.value.result.text
          : ''
        const checks = evaluateResponseRubric(response, scenario.rubric)
        const actual = {
          response: response.slice(0, 20_000),
          modelResponses,
        }
        results.push({
          id: scenario.id,
          metrics: scenario.metrics,
          input: { messages: scenario.messages },
          expected: scenario.rubric,
          passed: !fallbackUsed && checks.length > 0 && checks.every((check) => check.passed),
          checks,
          actual,
          evaluationType: 'deterministic_text_rubric',
          manualReviewRequired: true,
          manualReviewStatus: 'pending',
          manualReviewCriteria: scenario.rubric.manualReview,
          provider: activeProvider.id,
          model: responseStage.value.result.model || activeProvider.model,
          latencyMs: rounded(performance.now() - startedAt),
          stageLatencyMs: { reasoningAndSynthesis: responseStage.latencyMs },
          modelCallCount: database.events.length - modelCallsBefore,
          providerFailureCount: database.events.slice(modelCallsBefore).filter((event) => event[8] === false).length,
          fallbackUsed,
          usage: mergeUsage([responseStage.value.result.usage]),
          estimatedCost: null,
          costReason: 'Provider pricing is not configured; cost is intentionally not estimated.',
        })
        continue
      }

      objectiveStage = await timed(() => understandObjective(evaluationRegistry, activeProvider, {
        message: scenario.request,
        contextMessages: scenario.contextMessages || [],
        attachmentContext: scenario.attachmentContext || '',
        userId: null,
        requestId: `benchmark-${scenario.id}`,
        database,
      }))
      if (objectiveStage.value.objectiveFallback) {
        throw new Error('The model returned invalid ObjectiveSpec JSON after one repair attempt.')
      }
      objective = objectiveStage.value.objective
      activeProvider = evaluationRegistry.get(objectiveStage.value.provider.id)
      const checks = evaluateObjective(objective, scenario.realObjectiveExpect || scenario.expect).checks
      let planningChecks = []
      const usage = [objectiveStage.value.usage].filter(Boolean)
      fallbackUsed = objectiveStage.value.fallbackUsed === true
      const stageLatency = { understanding: objectiveStage.latencyMs }

      if (objective.planningRequired && !objective.clarificationRequired) {
        planningStage = await timed(() => createPlanGraph(evaluationRegistry, activeProvider, {
          message: scenario.request,
          objective,
          contextMessages: scenario.contextMessages || [],
          attachmentContext: scenario.attachmentContext || '',
          userId: null,
          requestId: `benchmark-${scenario.id}`,
          database,
        }))
        planGraph = planningStage.value.planGraph
        activeProvider = evaluationRegistry.get(planningStage.value.provider.id)
        planningChecks = evaluateRealPlan(planGraph, scenario.planExpect || {})
        usage.push(planningStage.value.usage)
        fallbackUsed ||= planningStage.value.fallbackUsed
        stageLatency.planning = planningStage.latencyMs
      } else if (scenario.planExpect) {
        planningChecks = [{
          name: 'planning_skipped',
          passed: scenario.planExpect.expectSkipped === true,
          expected: scenario.planExpect.expectSkipped === true ? 'no plan was created' : 'a plan was expected',
          actual: scenario.planExpect.expectSkipped === true ? 'no plan was created' : 'no plan was created',
        }]
      }
      if (planGraph && scenario.planExpect?.expectSkipped) {
        planningChecks.push({
          name: 'unnecessary_plan_call',
          passed: false,
          expected: 'no plan',
          actual: 'plan created',
        })
      }
      const allChecks = [...checks, ...planningChecks]
      results.push({
        id: scenario.id,
        metrics: scenario.metrics,
        input: {
          request: scenario.request,
          contextMessages: scenario.contextMessages || [],
          attachmentContext: scenario.attachmentContext || '',
        },
        expected: {
          objective: scenario.realObjectiveExpect || scenario.expect,
          plan: scenario.planExpect || null,
        },
        passed: allChecks.length > 0 && allChecks.every((check) => check.passed),
        checks: allChecks,
        actual: { objective, planGraph, modelResponses },
        evaluationType: 'structured_validation_and_deterministic_rubric',
        manualReviewRequired: true,
        manualReviewStatus: 'pending',
        manualReviewCriteria: scenario.manualReview || [
          'Review semantic correctness, completeness, constraints, and unsupported assumptions.',
        ],
        provider: activeProvider.id,
        model: planningStage?.value.model || objectiveStage.value.model,
        latencyMs: rounded(performance.now() - startedAt),
        stageLatencyMs: stageLatency,
        modelCallCount: database.events.length - modelCallsBefore,
        providerFailureCount: database.events.slice(modelCallsBefore).filter((event) => event[8] === false).length,
        fallbackUsed,
        usage: mergeUsage(usage),
        estimatedCost: null,
        costReason: 'Provider pricing is not configured; cost is intentionally not estimated.',
      })
    } catch (error) {
      results.push({
        id: scenario.id,
        metrics: scenario.metrics,
        input: {
          request: scenario.request,
          contextMessages: scenario.contextMessages || [],
          attachmentContext: scenario.attachmentContext || '',
        },
        expected: {
          objective: scenario.realObjectiveExpect || scenario.expect,
          plan: scenario.planExpect || null,
        },
        passed: false,
        checks: [{ name: 'real_model_run', passed: false, reason: safeError(error) }],
        actual: { objective: objective || null, planGraph, modelResponses },
        evaluationType: 'structured_validation_and_deterministic_rubric',
        manualReviewRequired: true,
        manualReviewStatus: 'pending',
        manualReviewCriteria: scenario.manualReview || [
          'Review semantic correctness, completeness, constraints, and unsupported assumptions.',
        ],
        provider: activeProvider?.id || provider.id,
        model: activeProvider?.model || provider.model || null,
        latencyMs: rounded(performance.now() - startedAt),
        modelCallCount: database.events.length - modelCallsBefore,
        providerFailureCount: database.events.slice(modelCallsBefore).filter((event) => event[8] === false).length,
        fallbackUsed: false,
        usage: null,
        estimatedCost: null,
        failureReason: safeError(error),
      })
    }
  }
  return buildReport({ mode: 'real', provider: provider.id, results })
}

export async function runRealBenchmarkMatrix({
  scenarios,
  registry = providerRegistry,
  providerIds = 'all',
} = {}) {
  const configured = registry.list().filter((provider) => provider.available).map((provider) => provider.id)
  const requested = providerIds === 'all'
    ? configured
    : [...new Set((Array.isArray(providerIds) ? providerIds : [providerIds]).flatMap((value) =>
        String(value).split(',').map((id) => id.trim()).filter(Boolean)))]
  if (!requested.length) {
    return {
      formatVersion: 1,
      mode: 'real_matrix',
      status: 'skipped',
      resultLabel: 'separate_provider_reports_no_aggregate_score',
      skipReason: 'No configured provider is available. Set at least one provider API key and its matching AI_MODEL_* variable.',
      missingConfiguration: providerConfigurations(),
      providers: [],
    }
  }
  const providers = []
  for (const providerId of requested) {
    providers.push(await runRealBenchmarks({ scenarios, registry, providerId }))
  }
  return {
    formatVersion: 1,
    mode: 'real_matrix',
    status: providers.some((report) => report.status === 'completed') ? 'completed' : 'skipped',
    resultLabel: 'separate_provider_reports_no_aggregate_score',
    createdAt: new Date().toISOString(),
    providers,
  }
}

export function compareBenchmarkReports(current, previous) {
  const oldMetrics = new Map((previous.metrics || []).map((metric) => [metric.id, metric]))
  const metricChanges = current.metrics.map((metric) => {
    const prior = oldMetrics.get(metric.id)
    if (!prior || typeof metric.score !== 'number' || typeof prior.score !== 'number') {
      return { id: metric.id, comparable: false }
    }
    const delta = rounded(metric.score - prior.score)
    return {
      id: metric.id,
      comparable: true,
      previousScore: prior.score,
      currentScore: metric.score,
      delta,
      regression: metric.lowerIsBetter ? delta > 0 : delta < 0,
    }
  })
  const previousResults = new Map((previous.results || []).map((result) => [result.id, result]))
  const scenarioRegressions = current.results
    .filter((result) => previousResults.get(result.id)?.passed === true && !result.passed)
    .map((result) => result.id)
  return {
    comparable: current.mode === previous.mode,
    metricChanges,
    scenarioRegressions,
    hasRegression: metricChanges.some((metric) => metric.regression) || scenarioRegressions.length > 0,
  }
}

function buildReport({
  mode,
  results,
  status = 'completed',
  skipReason = null,
  provider = null,
  missingConfiguration = [],
  excludedScenarios = [],
}) {
  const metricIds = [...new Set(results.flatMap((result) => result.metrics))]
  const metrics = metricIds.map((id) => {
    const relevant = results.filter((result) => result.metrics.includes(id))
    const lowerIsBetter = id === 'false_success_rate'
    const unsafe = lowerIsBetter
      ? relevant.filter((result) => result.falseSuccess === true).length
      : 0
    const passed = lowerIsBetter
      ? relevant.length - unsafe
      : relevant.filter((result) => result.passed).length
    return {
      id,
      score: relevant.length
        ? rounded((lowerIsBetter ? unsafe : passed) * 100 / relevant.length)
        : null,
      passed,
      scenarios: relevant.length,
      lowerIsBetter,
      interpretation: lowerIsBetter ? 'lower_is_better' : 'higher_is_better',
    }
  })
  return {
    formatVersion: 1,
    mode,
    resultLabel: mode === 'fixtures' ? 'deterministic_control_plane_checks_not_model_intelligence' : 'real_provider_responses',
    status,
    provider,
    skipReason,
    missingConfiguration,
    excludedScenarios,
    createdAt: new Date().toISOString(),
    metrics,
    performance: summarizePerformance(results),
    results,
  }
}

async function evaluateFixtureScenario(scenario) {
  if (scenario.kind === 'objective') {
    const objective = parseObjectiveSpec(JSON.stringify({ ...BASE_OBJECTIVE, ...scenario.objective }))
    return evaluateObjective(objective, scenario.expect)
  }
  if (scenario.kind === 'plan' || scenario.kind === 'assignment') {
    const graph = buildGraph(scenario.plan)
    let validated
    let validationError = null
    try {
      validated = validatePlanGraph(graph)
    } catch (error) {
      validationError = safeError(error)
    }
    const result = {
      valid: Boolean(validated),
      taskCount: validated?.tasks.length || 0,
      taskDescriptions: (validated?.tasks || graph.tasks).map((task) => `${task.id} ${task.description}`),
      dependencyEdges: validated?.tasks.flatMap((task) => task.dependencies.map((dependency) => [task.id, dependency])) || [],
      error: validationError,
    }
    if (scenario.metrics.includes('specialist_assignment_accuracy')) {
      result.assignmentValid = Boolean(validated && validated.tasks.every(isSpecialistAssignmentValid))
    }
    if (scenario.kind === 'assignment') {
      result.assignmentValid = scenario.plan.tasks.every((task) =>
        isSpecialistAssignmentValid(buildTask(task.id, task)))
    }
    return result
  }
  if (scenario.kind === 'verification') {
    const task = buildTask('verification-task', scenario.task)
    const evaluation = evaluateSpecialistResult({
      task,
      output: scenario.output,
      dependencyOutputs: {},
      evidence: scenario.evidence || [],
      independentReview: scenario.independentReview || null,
      specialistProvider: 'model-a',
    })
    return { status: evaluation.status, accepted: evaluation.accepted, reason: evaluation.reason || null }
  }
  if (scenario.kind === 'context') {
    const messages = buildObjectiveMessages({
      message: scenario.request,
      contextMessages: scenario.contextMessages || [],
      attachmentContext: scenario.attachmentContext || '',
    })
    const allText = messages.map((message) => message.content).join('\n')
    return {
      contains: scenario.expect.contains.map((text) => allText.includes(text)),
      systemContains: scenario.expect.systemContains.map((text) =>
        messages.some((message) => message.role === 'system' && message.content.includes(text))),
    }
  }
  if (scenario.kind === 'fallback') return runFallbackFixture(scenario)
  if (scenario.kind === 'uncertain') return runExecutionStateFixture('uncertain')
  if (scenario.kind === 'interrupted') return runExecutionStateFixture('interrupted')
  if (scenario.kind === 'failed-result') return runFailedResultFixture()
  if (scenario.kind === 'stale-approval') return runStaleApprovalFixture()
  throw new Error(`Unsupported benchmark scenario kind "${scenario.kind}".`)
}

function evaluateObjective(objective, expected) {
  return {
    planningRequired: objective.planningRequired,
    clarificationRequired: objective.clarificationRequired,
    confirmationRequiredBeforeExecution: objective.confirmationRequiredBeforeExecution,
    goal: objective.goal,
    deliverables: objective.deliverables,
    instructions: objective.instructions,
    scopeConstraints: objective.scopeConstraints,
    assumptions: objective.assumptions,
    deliverableCount: objective.deliverables.length,
    missingInformation: objective.missingInformation.map((item) => item.item),
    clarificationQuestions: objective.clarificationQuestions,
    checks: [
      ...checkEqualities(objective, expected, [
        'planningRequired',
        'clarificationRequired',
        'confirmationRequiredBeforeExecution',
      ]),
      ...checkIncludes(objective.goal, expected.goalIncludes, 'goalIncludes'),
      ...checkIncludes(objective.deliverables.join('\n'), expected.deliverablesInclude, 'deliverablesInclude'),
      ...checkIncludes(objective.instructions.join('\n'), expected.instructionsInclude, 'instructionsInclude'),
      ...checkExcludes(objective.deliverables.join('\n'), expected.deliverablesMustNotInclude, 'deliverablesMustNotInclude'),
      ...checkIncludes(objective.missingInformation.map((item) => item.item).join('\n'), expected.missingInformationIncludes, 'missingInformationIncludes'),
      ...checkIncludes(objective.clarificationQuestions.join('\n'), expected.clarificationQuestionIncludes, 'clarificationQuestionIncludes'),
      ...(expected.assumptionsMustBeEmpty ? [{
        name: 'assumptionsMustBeEmpty',
        passed: objective.assumptions.length === 0,
        expected: 0,
        actual: objective.assumptions.length,
      }] : []),
      ...(expected.deliverableCountAtLeast === undefined ? [] : [{
        name: 'deliverableCountAtLeast',
        passed: objective.deliverables.length >= expected.deliverableCountAtLeast,
        expected: expected.deliverableCountAtLeast,
        actual: objective.deliverables.length,
      }]),
    ],
  }
}

function evaluateResponseRubric(response, rubric = {}) {
  const text = String(response || '').toLowerCase()
  const checks = [{
    name: 'nonEmptyResponse',
    passed: Boolean(text.trim()),
    expected: 'non-empty response',
    actual: text.trim().length ? 'non-empty response' : 'empty response',
  }]
  for (const term of rubric.mustIncludeAll || []) {
    checks.push({
      name: `mustInclude:${term}`,
      passed: text.includes(term.toLowerCase()),
      expected: term,
      actual: text.includes(term.toLowerCase()),
    })
  }
  for (const alternatives of rubric.mustIncludeAny || []) {
    const matched = alternatives.find((term) => text.includes(term.toLowerCase()))
    checks.push({
      name: `mustIncludeAny:${alternatives.join('|')}`,
      passed: Boolean(matched),
      expected: alternatives,
      actual: matched || null,
    })
  }
  for (const term of rubric.mustNotInclude || []) {
    checks.push({
      name: `mustNotInclude:${term}`,
      passed: !text.includes(term.toLowerCase()),
      expected: `exclude ${term}`,
      actual: text.includes(term.toLowerCase()),
    })
  }
  return checks
}

function evaluateRealPlan(graph, expected) {
  const tasks = graph.tasks
  const taskText = tasks.map((task) => `${task.id} ${task.description} ${task.expectedOutput}`).join('\n').toLowerCase()
  const checks = []
  if (expected.minimumTasks !== undefined) {
    checks.push({
      name: 'minimumTasks',
      passed: tasks.length >= expected.minimumTasks,
      expected: expected.minimumTasks,
      actual: tasks.length,
    })
  }
  for (const term of expected.requiredTerms || []) {
    checks.push({ name: `requiredTerm:${term}`, passed: taskText.includes(term.toLowerCase()), expected: term, actual: taskText.includes(term.toLowerCase()) })
  }
  for (const term of expected.requiredTaskTerms || []) {
    const found = tasks.some((task) => `${task.id} ${task.description}`.toLowerCase().includes(term.toLowerCase()))
    checks.push({ name: `requiredTaskTerm:${term}`, passed: found, expected: term, actual: found })
  }
  for (const term of expected.independentTaskTerms || []) {
    const task = tasks.find((candidate) => `${candidate.id} ${candidate.description}`.toLowerCase().includes(term.toLowerCase()))
    checks.push({ name: `independentTask:${term}`, passed: Boolean(task && task.dependencies.length === 0), expected: 'task exists without dependencies', actual: task?.dependencies.length ?? null })
  }
  for (const [dependentTerm, dependencyTerm] of expected.dependencyTermPairs || []) {
    const dependent = tasks.find((task) => `${task.id} ${task.description}`.toLowerCase().includes(dependentTerm.toLowerCase()))
    const dependency = tasks.find((task) => `${task.id} ${task.description}`.toLowerCase().includes(dependencyTerm.toLowerCase()))
    checks.push({
      name: `dependency:${dependentTerm}->${dependencyTerm}`,
      passed: Boolean(dependent && dependency && dependent.dependencies.includes(dependency.id)),
      expected: `${dependentTerm} depends on ${dependencyTerm}`,
      actual: dependent?.dependencies || null,
    })
  }
  if (expected.checkSpecialistAssignment) {
    const assignmentValid = tasks.every(isSpecialistAssignmentValid)
    checks.push({
      name: 'specialistAssignments',
      passed: assignmentValid,
      expected: 'each task is assigned to a compatible specialist',
      actual: assignmentValid,
    })
  }
  return checks
}

function createIsolatedProviderRegistry(registry, providerId, modelResponses) {
  const metadata = registry.list().filter((provider) => provider.id === providerId)
  let capturedProvider = null
  return {
    list: () => metadata,
    get(id) {
      if (id !== providerId) return null
      if (capturedProvider) return capturedProvider
      const provider = registry.get(id)
      if (!provider) return null
      capturedProvider = {
        ...provider,
        async generate(request) {
          const result = await provider.generate(request)
          modelResponses.push({
            provider: provider.id,
            model: result?.model || provider.model || null,
            response: typeof result?.text === 'string' ? result.text.slice(0, 20_000) : '',
          })
          return result
        },
      }
      return capturedProvider
    },
  }
}

function providerConfiguration(providerId) {
  const apiKeyNames = {
    openai: 'OPENAI_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    groq: 'GROQ_API_KEY',
    xai: 'XAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    gemini: 'GEMINI_API_KEY',
  }
  return {
    provider: providerId,
    apiKeyEnv: apiKeyNames[providerId] || `${providerId.toUpperCase()}_API_KEY`,
    modelEnv: `AI_MODEL_${providerId.toUpperCase()}`,
  }
}

function providerConfigurations() {
  return ['openai', 'deepseek', 'mistral', 'groq', 'xai', 'openrouter', 'anthropic', 'gemini']
    .map(providerConfiguration)
}

function runFallbackFixture(scenario) {
  let calls = 0
  const primary = createMockProvider('primary', () => {
    calls += 1
    throw new ProviderError('Mock provider failure.', {
      provider: 'primary',
      retryable: scenario.primaryFailure.retryable,
      status: scenario.primaryFailure.retryable ? 503 : 400,
    })
  })
  const fallback = createMockProvider('fallback', () => {
    calls += 1
    return { text: 'fallback response' }
  })
  const providers = { primary, fallback }
  const registry = {
    list: () => ['primary', 'fallback'].map((id) => ({
      id,
      available: true,
      qualityScore: id === 'primary' ? 5 : 4,
      latencyScore: 3,
      costScore: 3,
      capabilities: { textGeneration: true },
    })),
    get: (id) => providers[id],
  }
  return invokeWithProviderFallback(registry, primary, {
    messages: [{ role: 'user', content: 'fixture' }],
  }, {
    database: { async query() { return { rowCount: 1 } } },
  }).then((result) => ({
    provider: result.provider.id,
    calls,
    text: result.result.text,
    failed: false,
  }), () => ({
    provider: 'primary',
    calls,
    text: null,
    failed: true,
  }))
}

async function runExecutionStateFixture(kind) {
  const graph = { tasks: [buildTask('state-task')] }
  let dispatches = 0
  const state = kind === 'uncertain'
    ? {
        taskId: 'state-task',
        status: 'uncertain',
        transitions: ['proposed', 'authorized', 'uncertain'],
        attempts: 1,
        evidence: [{ kind: 'tool_execution', uncertain: true }],
      }
    : null
  const controller = new AbortController()
  if (kind === 'interrupted') controller.abort(new Error('Fixture interruption.'))
  const report = await executePlanGraph({
    planGraph: graph,
    signal: controller.signal,
    initialReport: state ? { tasks: [state] } : null,
    dispatch: async () => {
      dispatches += 1
      throw new Error('An interrupted or uncertain task must not be dispatched.')
    },
  })
  return { status: report.status, dispatches }
}

async function runFailedResultFixture() {
  let dispatches = 0
  const report = await executePlanGraph({
    planGraph: { tasks: [buildTask('failed-task', { maxAttempts: 1 })] },
    dispatch: async (_task, { onAuthorized }) => {
      dispatches += 1
      onAuthorized({ agentId: 'research-reasoning', agentRunId: 'fixture-run' })
      return {
        status: 'failed',
        output: null,
        error: 'Required source data was not available.',
        evidence: [],
      }
    },
  })
  return {
    status: report.status,
    error: report.tasks[0].error,
    dispatches,
  }
}

async function runStaleApprovalFixture() {
  const continuation = {
    version: 1,
    objective: { requiresExternalAction: true },
    planGraph: {
      tasks: [{
        id: 'action',
        requiredInputs: [{ kind: 'tool_output', toolId: 'mock-action' }],
        toolInput: { target: 'approved target' },
      }],
    },
    executionReport: { tasks: [{ taskId: 'action', status: 'awaiting_approval' }] },
    conversationId: 'benchmark-conversation',
  }
  const database = {
    calls: 0,
    async query() {
      this.calls += 1
      return {
        rows: [{
          approval_status: 'approved',
          tool_status: 'completed',
          tool_id: 'mock-action',
          tool_input: { target: 'changed target' },
          agent_run_id: 'benchmark-agent-run',
          input: { continuation },
        }],
      }
    },
  }
  try {
    await resumeExecutionAfterApproval({
      userId: 'benchmark-user',
      approvalId: 'benchmark-approval',
      approvalResult: { status: 'verified', agentRunId: 'benchmark-agent-run', result: { ok: true } },
      registry: { list: () => [], get: () => null },
      database,
    })
    return { rejected: false, status: 200, error: null, databaseQueries: database.calls }
  } catch (error) {
    return {
      rejected: error.status === 409,
      status: error.status || 500,
      error: safeError(error),
      databaseQueries: database.calls,
    }
  }
}

function buildGraph(plan = {}) {
  return {
    tasks: (plan.tasks || []).map((task) => buildTask(task.id, task)),
  }
}

function buildTask(id, overrides = {}) {
  return {
    id,
    description: `Complete ${id}.`,
    type: 'analysis',
    requiredInputs: [{ kind: 'user_request', description: 'The current request.' }],
    dependencies: [],
    expectedOutput: `${id} findings.`,
    acceptanceCriteria: [`${id} findings address the task.`],
    riskClassification: 'low',
    requiredCapability: 'reasoning',
    specialistRole: 'general',
    maxAttempts: 2,
    completionConditions: [`${id} findings are available.`],
    ...overrides,
  }
}

function isSpecialistAssignmentValid(task) {
  const definition = getAgentDefinition(task.specialistRole === 'execution' ? 'execution' : 'research-reasoning')
  return Boolean(definition &&
    definition.capabilities.includes(task.requiredCapability) &&
    ((task.type === 'tool') === (definition.id === 'execution')))
}

function compareExpected(actual, expected) {
  const checks = []
  for (const key of ['planningRequired', 'clarificationRequired', 'confirmationRequiredBeforeExecution']) {
    if (Object.hasOwn(expected, key)) {
      checks.push({ name: key, passed: actual[key] === expected[key], expected: expected[key], actual: actual[key] })
    }
  }
  for (const key of [
    'goalIncludes',
    'deliverablesInclude',
    'instructionsInclude',
    'missingInformationIncludes',
    'clarificationQuestionIncludes',
  ]) {
    const values = expected[key]
    if (!values) continue
    const actualText = ({
      goalIncludes: actual.goal,
      deliverablesInclude: (actual.deliverables || []).join('\n'),
      instructionsInclude: (actual.instructions || []).join('\n'),
      missingInformationIncludes: (actual.missingInformation || []).join('\n'),
      clarificationQuestionIncludes: (actual.clarificationQuestions || []).join('\n'),
    })[key]
    checks.push(...checkIncludes(actualText, values, key))
  }
  checks.push(...checkExcludes(
    (actual.deliverables || []).join('\n'),
    expected.deliverablesMustNotInclude,
    'deliverablesMustNotInclude',
  ))
  if (Object.hasOwn(expected, 'deliverableCountAtLeast')) {
    checks.push({
      name: 'deliverableCountAtLeast',
      passed: actual.deliverableCount >= expected.deliverableCountAtLeast,
      expected: expected.deliverableCountAtLeast,
      actual: actual.deliverableCount,
    })
  }
  if (Object.hasOwn(expected, 'expectSkipped')) {
    checks.push({
      name: 'planningSkipped',
      passed: actual.planningSkipped === expected.expectSkipped,
      expected: expected.expectSkipped,
      actual: actual.planningSkipped,
    })
  }
  if (Object.hasOwn(expected, 'valid')) {
    checks.push({ name: 'valid', passed: actual.valid === expected.valid, expected: expected.valid, actual: actual.valid })
  }
  if (Object.hasOwn(expected, 'taskCount')) {
    checks.push({ name: 'taskCount', passed: actual.taskCount === expected.taskCount, expected: expected.taskCount, actual: actual.taskCount })
  }
  if (expected.requiredTaskTerms) {
    const taskText = (actual.taskDescriptions || []).join('\n')
    for (const term of expected.requiredTaskTerms) {
      checks.push({
        name: `requiredTaskTerm:${term}`,
        passed: taskText.toLowerCase().includes(term.toLowerCase()),
        expected: term,
        actual: taskText.toLowerCase().includes(term.toLowerCase()),
      })
    }
  }
  if (Object.hasOwn(expected, 'dependencyEdges')) {
    const actualEdges = normalizeEdges(actual.dependencyEdges || [])
    const expectedEdges = normalizeEdges(expected.dependencyEdges)
    checks.push({
      name: 'dependencyEdges',
      passed: JSON.stringify(actualEdges) === JSON.stringify(expectedEdges),
      expected: expectedEdges,
      actual: actualEdges,
    })
  }
  if (expected.errorIncludes) {
    checks.push({
      name: 'errorIncludes',
      passed: String(actual.error || '').toLowerCase().includes(expected.errorIncludes.toLowerCase()),
      expected: expected.errorIncludes,
      actual: actual.error || null,
    })
  }
  if (Object.hasOwn(expected, 'assignmentValid')) {
    checks.push({
      name: 'assignmentValid',
      passed: actual.assignmentValid === expected.assignmentValid,
      expected: expected.assignmentValid,
      actual: actual.assignmentValid,
    })
  }
  if (Object.hasOwn(expected, 'status')) {
    checks.push({ name: 'status', passed: actual.status === expected.status, expected: expected.status, actual: actual.status })
  }
  if (Object.hasOwn(expected, 'accepted')) {
    checks.push({ name: 'accepted', passed: actual.accepted === expected.accepted, expected: expected.accepted, actual: actual.accepted })
  }
  if (expected.contains) {
    expected.contains.forEach((value, index) => checks.push({
      name: `contains:${value}`,
      passed: actual.contains?.[index] === true,
      expected: true,
      actual: actual.contains?.[index] === true,
    }))
  }
  if (expected.systemContains) {
    expected.systemContains.forEach((value, index) => checks.push({
      name: `systemContains:${value}`,
      passed: actual.systemContains?.[index] === true,
      expected: true,
      actual: actual.systemContains?.[index] === true,
    }))
  }
  for (const key of ['provider', 'calls', 'text', 'failed', 'dispatches', 'error', 'rejected', 'status']) {
    if (Object.hasOwn(expected, key)) {
      checks.push({ name: key, passed: actual[key] === expected[key], expected: expected[key], actual: actual[key] })
    }
  }
  if (!checks.length) throw new Error('Scenario has no supported expected checks.')
  return checks
}

function detectsFalseSuccess(actual, expected) {
  if (expected.rejected === true) return actual.rejected !== true
  if (expected.accepted === false) return actual.accepted === true
  if (['incomplete', 'failed'].includes(expected.status)) return actual.status === 'verified'
  if (['uncertain', 'interrupted'].includes(expected.status)) return actual.status === 'completed'
  return false
}

function checkEqualities(actual, expected, keys) {
  return keys.filter((key) => Object.hasOwn(expected, key)).map((key) => ({
    name: key,
    passed: actual[key] === expected[key],
    expected: expected[key],
    actual: actual[key],
  }))
}

function checkIncludes(actual, expected, name) {
  return (expected || []).map((value) => ({
    name: `${name}:${value}`,
    passed: String(actual || '').toLowerCase().includes(value.toLowerCase()),
    expected: value,
    actual: actual || '',
  }))
}

function checkExcludes(actual, expected, name) {
  return (expected || []).map((value) => ({
    name: `${name}:${value}`,
    passed: !String(actual || '').toLowerCase().includes(value.toLowerCase()),
    expected: `exclude ${value}`,
    actual: String(actual || '').toLowerCase().includes(value.toLowerCase()),
  }))
}

function normalizeEdges(edges) {
  return edges.map(([from, to]) => `${from}->${to}`).sort()
}

function createMockProvider(id, generate) {
  return {
    id,
    model: `${id}-model`,
    async generate() { return generate() },
  }
}

function createTelemetryDatabase() {
  const events = []
  return {
    events,
    async query(sql, values) {
      if (!sql.includes('INSERT INTO ai_usage_events')) throw new Error('Unexpected query in benchmark telemetry database.')
      events.push(values)
      return { rowCount: 1 }
    },
  }
}

async function timed(operation) {
  const startedAt = performance.now()
  const value = await operation()
  return { value, latencyMs: rounded(performance.now() - startedAt) }
}

function mergeUsage(items) {
  const values = items.filter(Boolean)
  if (!values.length) return null
  const tokens = (keys) => values.reduce((sum, item) => {
    for (const key of keys) {
      if (Number.isFinite(item[key])) return sum + item[key]
    }
    return sum
  }, 0)
  const inputTokens = tokens(['prompt_tokens', 'input_tokens', 'promptTokenCount'])
  const outputTokens = tokens(['completion_tokens', 'output_tokens', 'candidatesTokenCount'])
  return {
    inputTokens: inputTokens || null,
    outputTokens: outputTokens || null,
    totalTokens: inputTokens + outputTokens || null,
  }
}

function summarizePerformance(results) {
  const timedResults = results.filter((result) => Number.isFinite(result.latencyMs))
  const planningLatency = results
    .map((result) => result.stageLatencyMs?.planning)
    .filter(Number.isFinite)
  const modelCallCount = results.reduce((sum, result) => sum + (result.modelCallCount || 0), 0)
  const providerFailureCount = results.reduce((sum, result) => sum + (result.providerFailureCount || 0), 0)
  return {
    measuredScenarioCount: timedResults.length,
    averageLatencyMs: timedResults.length
      ? rounded(timedResults.reduce((sum, result) => sum + result.latencyMs, 0) / timedResults.length)
      : null,
    averagePlanningLatencyMs: planningLatency.length
      ? rounded(planningLatency.reduce((sum, latency) => sum + latency, 0) / planningLatency.length)
      : null,
    providerFailureCount,
    providerFailureRate: modelCallCount ? rounded(providerFailureCount * 100 / modelCallCount) : null,
    fallbackCount: results.filter((result) => result.fallbackUsed === true).length,
    modelCallCount,
    retryFrequency: modelCallCount ? rounded(results.reduce((sum, result) => sum + (result.fallbackUsed ? 1 : 0), 0) * 100 / modelCallCount) : null,
    estimatedCost: null,
    estimatedCostReason: 'Provider pricing is not configured.',
    specialistExecutionLatencyMs: null,
  }
}

function rounded(value) {
  return Math.round(value * 100) / 100
}

function safeError(error) {
  return typeof error?.message === 'string' ? error.message.slice(0, 1000) : 'Benchmark scenario failed.'
}

