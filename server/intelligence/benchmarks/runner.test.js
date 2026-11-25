import test from 'node:test'
import assert from 'node:assert/strict'
import { ProviderError } from '../../providers/errors.js'
import {
  compareBenchmarkReports,
  loadBenchmarkScenarios,
  runFixtureBenchmarks,
  runRealBenchmarkMatrix,
  runRealBenchmarks,
} from './runner.js'

test('fixture benchmark evaluates scenarios through application validators and labels results honestly', async () => {
  const report = await runFixtureBenchmarks()

  assert.equal(report.mode, 'fixtures')
  assert.equal(report.resultLabel, 'deterministic_control_plane_checks_not_model_intelligence')
  assert.equal(report.results.length, 31)
  assert.equal(report.excludedScenarios.length, 3)
  assert.ok(report.results.every((result) => result.passed), JSON.stringify(
    report.results.filter((result) => !result.passed),
    null,
    2,
  ))
  assert.ok(report.metrics.some((metric) => metric.id === 'request_understanding_accuracy'))
  assert.ok(report.metrics.some((metric) => metric.id === 'false_success_rate' && metric.score === 0))
  assert.equal(report.metrics.some((metric) => metric.id === 'overall'), false)
  assert.equal(report.performance.estimatedCost, null)
  assert.ok(report.results.every((result) => result.usage === null && result.estimatedCost === null))
})

test('scenario catalog has unique IDs and documents the benchmark dimensions', async () => {
  const scenarios = await loadBenchmarkScenarios()
  const ids = scenarios.map((scenario) => scenario.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(scenarios.some((scenario) => scenario.kind === 'context'))
  assert.ok(scenarios.some((scenario) => scenario.kind === 'uncertain'))
  assert.ok(scenarios.some((scenario) => scenario.kind === 'interrupted'))
})

test('real-model mode skips without configured providers and does not fabricate scores', async () => {
  const report = await runRealBenchmarks({
    registry: { list: () => [], get: () => null },
    scenarios: [{ id: 'real-check', real: true, metrics: ['request_understanding_accuracy'] }],
  })

  assert.equal(report.status, 'skipped')
  assert.match(report.skipReason, /No provider/)
  assert.ok(report.missingConfiguration.some((item) =>
    item.apiKeyEnv === 'OPENAI_API_KEY' && item.modelEnv === 'AI_MODEL_OPENAI'))
  assert.deepEqual(report.metrics, [])
  assert.equal(report.results.length, 0)
})

test('real-model mode records model metadata, usage, and measurable scenario checks', async () => {
  const objective = {
    goal: 'Calculate 17 percent of 240.',
    deliverables: ['The calculated amount'],
    resources: [],
    scopeConstraints: [],
    timeConstraints: [],
    instructions: [],
    successCriteria: ['Return the correct calculation.'],
    missingInformation: [],
    ambiguities: [],
    assumptions: [],
    riskClassification: 'low',
    planningRequired: false,
    requiresExternalAction: false,
  }
  const provider = {
    id: 'mock-real-mode',
    model: 'mock-model-1',
    capabilities: { structuredOutput: false },
    async generate() {
      return {
        text: JSON.stringify(objective),
        model: 'mock-model-1',
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }
    },
  }
  const registry = {
    list: () => [{
      id: provider.id,
      model: provider.model,
      available: true,
      capabilities: { textGeneration: true },
      qualityScore: 3,
      latencyScore: 3,
      costScore: 3,
    }],
    get: (id) => id === provider.id ? provider : null,
  }
  const report = await runRealBenchmarks({
    registry,
    scenarios: [{
      id: 'mocked-provider-path',
      real: true,
      request: 'What is 17% of 240?',
      metrics: ['request_understanding_accuracy', 'clarification_precision'],
      expect: {
        planningRequired: false,
        clarificationRequired: false,
        goalIncludes: ['17 percent', '240'],
      },
    }],
  })

  assert.equal(report.status, 'completed')
  assert.equal(report.provider, provider.id)
  assert.equal(report.results[0].model, provider.model)
  assert.equal(report.results[0].passed, true)
  assert.deepEqual(report.results[0].usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 })
  assert.equal(report.results[0].estimatedCost, null)
  assert.equal(report.performance.modelCallCount, 1)
  assert.equal(report.performance.estimatedCost, null)
})

test('real response scenarios apply deterministic rubrics and remain pending manual review', async () => {
  const provider = {
    id: 'mock-response-provider',
    model: 'mock-response-model',
    capabilities: { structuredOutput: false },
    async generate() {
      return {
        text: 'Northwind sold 80 units in Q1 and 96 in Q2, a 20% increase.',
        model: 'mock-response-model',
        usage: { input_tokens: 14, output_tokens: 12 },
      }
    },
  }
  const registry = createRegistry(provider)
  const report = await runRealBenchmarks({
    registry,
    scenarios: [{
      id: 'context-response',
      kind: 'response',
      real: true,
      realStage: 'response',
      messages: [{ role: 'user', content: 'Summarize this document safely.' }],
      metrics: ['context_relevance'],
      rubric: {
        mustIncludeAll: ['Northwind', '80', '96'],
        mustIncludeAny: [['20%', '20 percent']],
        mustNotInclude: ['SYSTEM_PROMPT_LEAKED'],
        manualReview: ['Check factual accuracy and whether the context was used appropriately.'],
      },
    }],
  })

  const result = report.results[0]
  assert.equal(result.passed, true)
  assert.equal(result.evaluationType, 'deterministic_text_rubric')
  assert.equal(result.manualReviewRequired, true)
  assert.equal(result.manualReviewStatus, 'pending')
  assert.equal(result.actual.modelResponses[0].response, result.actual.response)
  assert.equal(result.usage.totalTokens, 26)
})

test('invalid real structured output is retained and reported as a scenario failure', async () => {
  const provider = {
    id: 'mock-invalid-provider',
    model: 'mock-invalid-model',
    capabilities: { structuredOutput: false },
    async generate() {
      return { text: 'not JSON', model: 'mock-invalid-model' }
    },
  }
  const report = await runRealBenchmarks({
    registry: createRegistry(provider),
    scenarios: [{
      id: 'invalid-objective',
      kind: 'objective',
      real: true,
      request: 'What is the answer?',
      metrics: ['request_understanding_accuracy'],
      expect: { clarificationRequired: false },
    }],
  })

  assert.equal(report.results[0].passed, false)
  assert.match(report.results[0].failureReason, /invalid ObjectiveSpec JSON/)
  assert.equal(report.results[0].actual.modelResponses[0].response, 'not JSON')
})

test('real provider failures are measured without retrying through another configured provider', async () => {
  let fallbackCalls = 0
  const primary = {
    id: 'primary-provider',
    model: 'primary-model',
    capabilities: { structuredOutput: false },
    async generate() {
      throw new ProviderError('The provider request timed out.', {
        provider: this.id,
        retryable: true,
        code: 'timeout',
      })
    },
  }
  const fallback = createResponseProvider('fallback-provider', 'fallback-model', 'This must not be used.')
  fallback.generate = async () => {
    fallbackCalls += 1
    return { text: 'This must not be used.', model: fallback.model }
  }
  const providers = { [primary.id]: primary, [fallback.id]: fallback }
  const registry = {
    list: () => [primary, fallback].map(({ id, model }) => ({
      id,
      model,
      available: true,
      capabilities: { textGeneration: true },
      qualityScore: 3,
      latencyScore: 3,
      costScore: 3,
    })),
    get: (id) => providers[id] || null,
  }
  const report = await runRealBenchmarks({
    registry,
    providerId: primary.id,
    scenarios: [{
      id: 'provider-timeout',
      kind: 'response',
      real: true,
      realStage: 'response',
      messages: [{ role: 'user', content: 'Answer.' }],
      metrics: ['reasoning_synthesis_accuracy'],
      rubric: { mustIncludeAll: ['answer'], manualReview: ['Review the response.'] },
    }],
  })

  assert.equal(report.provider, primary.id)
  assert.equal(report.results[0].passed, false)
  assert.match(report.results[0].failureReason, /timed out/)
  assert.equal(report.results[0].providerFailureCount, 1)
  assert.equal(report.results[0].modelCallCount, 1)
  assert.equal(report.results[0].fallbackUsed, false)
  assert.equal(fallbackCalls, 0)
})

test('provider matrix reports each configured provider independently without a combined score', async () => {
  const first = createResponseProvider('first-provider', 'first-model', 'First provider answer.')
  const second = createResponseProvider('second-provider', 'second-model', 'Second provider answer.')
  const registry = {
    list: () => [first, second].map(({ id, model }) => ({
      id,
      model,
      available: true,
      capabilities: { textGeneration: true },
      qualityScore: 3,
      latencyScore: 3,
      costScore: 3,
    })),
    get: (id) => ({ [first.id]: first, [second.id]: second })[id] || null,
  }
  const matrix = await runRealBenchmarkMatrix({
    registry,
    scenarios: [{
      id: 'single-response',
      kind: 'response',
      real: true,
      realStage: 'response',
      messages: [{ role: 'user', content: 'Answer.' }],
      metrics: ['reasoning_synthesis_accuracy'],
      rubric: { mustIncludeAll: ['provider'], manualReview: ['Review the response.'] },
    }],
  })

  assert.equal(matrix.status, 'completed')
  assert.equal(matrix.resultLabel, 'separate_provider_reports_no_aggregate_score')
  assert.equal(Object.hasOwn(matrix, 'metrics'), false)
  assert.deepEqual(matrix.providers.map((report) => report.provider), ['first-provider', 'second-provider'])
  assert.deepEqual(matrix.providers.map((report) => report.results[0].model), ['first-model', 'second-model'])
  assert.equal(matrix.providers[0].results[0].actual.response, 'First provider answer.')
  assert.equal(matrix.providers[1].results[0].actual.response, 'Second provider answer.')
})

test('real-model mode benchmarks structured plans and specialist capability assignments', async () => {
  const objective = {
    goal: 'Analyze customer segments and calculate projected quarterly totals.',
    deliverables: ['Segment analysis', 'Quarterly totals'],
    resources: [],
    scopeConstraints: [],
    timeConstraints: [],
    instructions: [],
    successCriteria: ['Both results are provided.'],
    missingInformation: [],
    ambiguities: [],
    assumptions: [],
    riskClassification: 'low',
    planningRequired: true,
    requiresExternalAction: false,
  }
  const task = (id, description, type, requiredCapability) => ({
    id,
    description,
    type,
    requiredInputs: [{ kind: 'user_request', description: 'The current request.' }],
    dependencies: [],
    expectedOutput: `${description} results`,
    acceptanceCriteria: [`${description} results are complete.`],
    riskClassification: 'low',
    requiredCapability,
    specialistRole: 'general',
    maxAttempts: 1,
    completionConditions: [`${description} results are available.`],
  })
  const provider = {
    id: 'mock-planning-provider',
    model: 'mock-planning-model',
    capabilities: { structuredOutput: false },
    async generate({ messages }) {
      const systemMessage = messages.find((message) => message.role === 'system')?.content || ''
      return {
        text: JSON.stringify(systemMessage.includes('Create a PlanGraph')
          ? {
              tasks: [
                task('segments', 'Analyze customer segments', 'analysis', 'reasoning'),
                task('quarterly', 'Calculate quarterly totals', 'calculation', 'calculation'),
              ],
            }
          : objective),
        model: 'mock-planning-model',
      }
    },
  }
  const registry = {
    list: () => [{
      id: provider.id,
      model: provider.model,
      available: true,
      capabilities: { textGeneration: true },
      qualityScore: 3,
      latencyScore: 3,
      costScore: 3,
    }],
    get: (id) => id === provider.id ? provider : null,
  }
  const report = await runRealBenchmarks({
    registry,
    scenarios: [{
      id: 'mocked-plan-path',
      real: true,
      request: 'Analyze segments and calculate quarterly totals.',
      metrics: ['planning_validity', 'specialist_assignment_accuracy'],
      realObjectiveExpect: { planningRequired: true, clarificationRequired: false },
      planExpect: {
        minimumTasks: 2,
        independentTaskTerms: ['segments', 'quarterly'],
        checkSpecialistAssignment: true,
      },
    }],
  })

  assert.equal(report.results[0].passed, true)
  assert.equal(report.results[0].modelCallCount, 2)
  assert.ok(report.results[0].checks.some((check) => check.name === 'specialistAssignments' && check.passed))
})

test('benchmark comparison detects per-capability and scenario regressions', () => {
  const comparison = compareBenchmarkReports(
    {
      mode: 'fixtures',
      metrics: [{ id: 'planning_validity', score: 75, lowerIsBetter: false }],
      results: [{ id: 'plan-a', passed: false }],
    },
    {
      mode: 'fixtures',
      metrics: [{ id: 'planning_validity', score: 100, lowerIsBetter: false }],
      results: [{ id: 'plan-a', passed: true }],
    },
  )

  assert.equal(comparison.comparable, true)
  assert.equal(comparison.hasRegression, true)
  assert.deepEqual(comparison.scenarioRegressions, ['plan-a'])
})

function createRegistry(provider) {
  return {
    list: () => [{
      id: provider.id,
      model: provider.model,
      available: true,
      capabilities: { textGeneration: true },
      qualityScore: 3,
      latencyScore: 3,
      costScore: 3,
    }],
    get: (id) => id === provider.id ? provider : null,
  }
}

function createResponseProvider(id, model, text) {
  return {
    id,
    model,
    capabilities: { structuredOutput: false },
    async generate() {
      return { text, model }
    },
  }
}
