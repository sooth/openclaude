import { z } from 'zod/v4'
import { AgentTool } from '../AgentTool/AgentTool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { createAgentId } from '../../utils/uuid.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { PARALLEL_AGENTS_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

const isBackgroundTasksDisabled = isEnvTruthy(
  process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,
)

type AsyncAgentLaunchResult = {
  status: 'async_launched'
  agentId: string
  description: string
  prompt: string
  outputFile: string
  canReadOutputFile?: boolean
}

function isAsyncAgentLaunchResult(value: unknown): value is AsyncAgentLaunchResult {
  return typeof value === 'object' && value !== null && 'status' in value && value.status === 'async_launched'
}

const agentLaunchSchema = z.strictObject({
  description: z.string().describe('A short 3-5 word description of the task'),
  prompt: z.string().describe('The task for the agent to perform'),
  subagent_type: z.string().optional().describe('The type of specialized agent to use for this task'),
  model: z.enum(['sonnet', 'opus', 'haiku']).optional().describe("Optional model override for this agent"),
  isolation: z.enum(['worktree']).optional().describe('Optional isolation mode'),
})

const inputSchema = lazySchema(() =>
  z.strictObject({
    agents: z
      .array(agentLaunchSchema)
      .min(1)
      .max(10)
      .describe('The background agents to launch in parallel'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

type AgentLaunch = z.infer<typeof agentLaunchSchema>

const launchedAgentSchema = z.object({
  agentId: z.string().describe('The ID of the background agent'),
  description: z.string().describe('The task description'),
  subagent_type: z.string().describe('The launched agent type'),
  outputFile: z.string().describe('Path to the agent output file'),
})

const outputSchema = lazySchema(() =>
  z.object({
    batchId: z.string().describe('The parallel batch ID'),
    agents: z.array(launchedAgentSchema),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

function getEffectiveAgentType(agent: AgentLaunch): string {
  return agent.subagent_type ?? 'general-purpose'
}

export const ParallelAgentsTool = buildTool({
  name: PARALLEL_AGENTS_TOOL_NAME,
  searchHint: 'launch multiple background sub-agents',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'ParallelAgents'
  },
  isEnabled() {
    return !isBackgroundTasksDisabled
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.agents.map(agent => ({
      description: agent.description,
      subagent_type: getEffectiveAgentType(agent),
    }))
  },
  getActivityDescription(input) {
    const count = input?.agents?.length ?? 0
    return count > 0 ? `Launching ${count} background agents` : 'Launching background agents'
  },
  async validateInput(_input, context) {
    if (isBackgroundTasksDisabled) {
      return {
        result: false,
        message: 'Background tasks are disabled in this session.',
        errorCode: 1,
      }
    }

    if (context.agentId) {
      return {
        result: false,
        message:
          'ParallelAgents is only available from the main thread. Sub-agents should use the Agent tool directly.',
        errorCode: 1,
      }
    }

    return { result: true }
  },
  async checkPermissions(input, context): Promise<PermissionResult> {
    const appState = context.getAppState()
    if ('external' === 'ant' && appState.toolPermissionContext.mode === 'auto') {
      return {
        behavior: 'passthrough',
        message: 'ParallelAgents requires permission to spawn background sub-agents.',
      }
    }
    return {
      behavior: 'allow',
      updatedInput: input,
    }
  },
  renderToolUseMessage(input) {
    const count = input.agents?.length ?? 0
    if (count === 0) return null
    return `Launching ${count} parallel agents`
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const lines = content.agents.map(agent => {
      return [
        `agentId: ${agent.agentId}`,
        `description: ${agent.description}`,
        `subagent_type: ${agent.subagent_type}`,
        `output_file: ${agent.outputFile}`,
      ].join('\n')
    })

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: [
        {
          type: 'text',
          text: `Launched ${content.agents.length} background agents.\nbatch_id: ${content.batchId}\n${lines.join('\n\n')}\n\nIf you later need the combined results, call ParallelBatchOutput with batch_id: ${content.batchId}. Use block=true to wait for completion, then synthesize the child outputs in your next response.`,
        },
      ],
    }
  },
  renderToolResultMessage(output) {
    if (output.agents.length === 0) return null
    return jsonStringify(output)
  },
  async call(input, context, canUseTool, assistantMessage, onProgress) {
    const batchId = `parallel_${createAgentId()}`
    const batchDescription =
      input.agents.length === 1
        ? input.agents[0]!.description
        : `${input.agents.length} parallel agents`

    context.setAppState(prev => ({
      ...prev,
      parallelAgentBatches: {
        ...prev.parallelAgentBatches,
        [batchId]: {
          id: batchId,
          description: batchDescription,
          childTaskIds: [],
          expectedCount: input.agents.length,
          toolUseId: context.toolUseId,
          notified: false,
        },
      },
    }))

    const launches = await Promise.all(
      input.agents.map(async (agent, index) => {
        const childInput = {
          description: agent.description,
          prompt: agent.prompt,
          subagent_type: agent.subagent_type,
          model: agent.model,
          run_in_background: true,
          isolation: agent.isolation,
        }
        const childToolUseId = `${context.toolUseId ?? PARALLEL_AGENTS_TOOL_NAME}:${index + 1}`
        const childContext = {
          ...context,
          toolUseId: childToolUseId,
        }

        const permission = await canUseTool(
          AgentTool,
          childInput,
          childContext,
          assistantMessage,
          childToolUseId,
        )

        if (permission.behavior !== 'allow') {
          throw new Error(`Permission denied for background agent "${agent.description}"`)
        }

        const result = await AgentTool.call(
          permission.updatedInput ?? childInput,
          childContext,
          canUseTool,
          assistantMessage,
          onProgress,
        )

        const data = result.data
        if (!isAsyncAgentLaunchResult(data)) {
          throw new Error(`Expected async background launch for agent "${agent.description}"`)
        }

        context.setAppState(prev => {
          const batch = prev.parallelAgentBatches[batchId]
          const task = prev.tasks[data.agentId]
          if (!batch || !task || task.type !== 'local_agent') {
            return prev
          }

          return {
            ...prev,
            tasks: {
              ...prev.tasks,
              [data.agentId]: {
                ...task,
                batchId,
              },
            },
            parallelAgentBatches: {
              ...prev.parallelAgentBatches,
              [batchId]: {
                ...batch,
                childTaskIds: [...batch.childTaskIds, data.agentId],
              },
            },
          }
        })

        return {
          agentId: data.agentId,
          description: agent.description,
          subagent_type: getEffectiveAgentType(agent),
          outputFile: data.outputFile,
        }
      }),
    )

    return {
      data: {
        batchId,
        agents: launches,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
