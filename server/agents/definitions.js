export const AGENT_DEFINITIONS = Object.freeze([
  {
    id: 'research-reasoning',
    name: 'Research and Reasoning',
    role: 'Complete one bounded research, reasoning, writing, calculation, or review task using only supplied context and its declared inputs.',
    permissions: ['model:invoke', 'tool:read'],
    capabilities: ['reasoning', 'research', 'writing', 'calculation', 'review'],
    inputContract: ['task', 'objective', 'request', 'contextMessages', 'attachmentContext', 'dependencyOutputs', 'attempt', 'workflowContext'],
    outputContract: ['output'],
    maxAttempts: 3,
  },
  {
    id: 'execution',
    name: 'Execution',
    role: 'Execute only the single registered tool declared by an authorized PlanGraph task; never access a computer or account directly.',
    permissions: ['tool:approved', 'tool:read'],
    capabilities: ['tool_execution'],
    inputContract: ['task', 'objective', 'request', 'contextMessages', 'attachmentContext', 'dependencyOutputs', 'attempt', 'workflowContext'],
    outputContract: ['status', 'result', 'evidence'],
    maxAttempts: 2,
  },
])

export function getAgentDefinition(agentId) {
  return AGENT_DEFINITIONS.find((agent) => agent.id === agentId)
}
