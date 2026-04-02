import { z } from 'zod/v4'
import { AgentTool } from '../AgentTool/AgentTool.js'
import { ParallelAgentsTool } from '../ParallelAgentsTool/ParallelAgentsTool.js'
import type { Output as ParallelAgentsOutput } from '../ParallelAgentsTool/ParallelAgentsTool.js'
import { ParallelBatchOutputTool } from '../ParallelBatchOutputTool/ParallelBatchOutputTool.js'
import type {
  BatchOutput,
  Output as ParallelBatchOutput,
} from '../ParallelBatchOutputTool/ParallelBatchOutputTool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { PARALLEL_AGENT_WORKFLOW_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

const isBackgroundTasksDisabled = isEnvTruthy(
  process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,
)

const agentLaunchSchema = z.strictObject({
  description: z.string().describe('A short 3-5 word description of the task'),
  prompt: z.string().describe('The task for the agent to perform'),
  subagent_type: z.string().optional().describe('The type of specialized agent to use for this task'),
  model: z.enum(['sonnet', 'opus', 'haiku']).optional().describe('Optional model override for this agent'),
  isolation: z.enum(['worktree']).optional().describe('Optional isolation mode'),
})

const inputSchema = lazySchema(() =>
  z.strictObject({
    agents: z.array(agentLaunchSchema).min(1).max(10).describe('The background agents to launch in parallel'),
    synthesis_description: z.string().describe('A short description for the synthesis step'),
    synthesis_prompt: z.string().describe('Instructions for how to synthesize the child outputs into one final result'),
    synthesis_subagent_type: z.string().optional().describe('Optional specialized agent type for the synthesis step'),
    synthesis_model: z.enum(['sonnet', 'opus', 'haiku']).optional().describe('Optional model override for synthesis'),
    timeout: z.number().min(0).max(600000).default(30000).describe('Max wait time in ms for the batch join step'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    batchId: z.string(),
    batch: z.object({
      batch_id: z.string(),
      description: z.string(),
      expected_count: z.number(),
      completed_count: z.number(),
      successful_children: z.number(),
      failed_children: z.number(),
      killed_children: z.number(),
      running_children: z.number(),
      ready_for_synthesis: z.boolean(),
      summary: z.string(),
      status: z.enum(['completed', 'partial', 'running']),
      children: z.array(
        z.object({
          task_id: z.string(),
          status: z.string(),
          description: z.string(),
          prompt: z.string().optional(),
          output: z.string(),
          result: z.string().optional(),
          error: z.string().optional(),
        }),
      ),
    }),
    synthesis: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

type Output = z.infer<OutputSchema>

type CompletedAgentResult = {
  status: 'completed'
  content: Array<{ type: string; text?: string }>
}

function isParallelAgentsOutput(value: unknown): value is ParallelAgentsOutput {
  return typeof value === 'object' && value !== null && 'batchId' in value && 'agents' in value
}

function isParallelBatchOutput(value: unknown): value is ParallelBatchOutput {
  return typeof value === 'object' && value !== null && 'retrieval_status' in value && 'batch' in value
}

function isCompletedAgentResult(value: unknown): value is CompletedAgentResult {
  return typeof value === 'object' && value !== null && 'status' in value && value.status === 'completed' && 'content' in value
}

function buildSynthesisPrompt(input: Input, batch: BatchOutput): string {
  const successfulChildren = batch.children.filter(
    child => child.status === 'completed',
  )
  const nonSuccessfulChildren = batch.children.filter(
    child => child.status !== 'completed',
  )

  return `${input.synthesis_prompt}\n\nBatch summary:\n${batch.summary}\n\nSuccessful children JSON:\n${jsonStringify(successfulChildren)}\n\nNon-successful children JSON:\n${jsonStringify(nonSuccessfulChildren)}\n\nInstructions:\n- Synthesize primarily from the successful children.\n- If any children failed or were stopped, mention that explicitly in the final synthesis.\n- Do not ignore conflicting evidence across successful children; reconcile it in your answer.\n- Do not simply restate the JSON.`
}

function extractSynthesisText(result: CompletedAgentResult): string {
  return result.content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n\n')
}

export const ParallelAgentWorkflowTool = buildTool({
  name: PARALLEL_AGENT_WORKFLOW_TOOL_NAME,
  searchHint: 'run full parallel agent workflow',
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
    return 'ParallelAgentWorkflow'
  },
  isConcurrencySafe() {
    return true
  },
  getActivityDescription() {
    return 'Running parallel workflow'
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
        message: 'ParallelAgentWorkflow is only available from the main thread.',
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
        message: 'ParallelAgentWorkflow requires permission to spawn background sub-agents.',
      }
    }
    return {
      behavior: 'allow',
      updatedInput: input,
    }
  },
  renderToolUseMessage() {
    return 'Running parallel agent workflow'
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Parallel workflow complete.\nbatch_id: ${content.batchId}\nsummary: ${content.batch.summary}\nsuccessful_children: ${content.batch.successful_children}\nfailed_children: ${content.batch.failed_children}\nkilled_children: ${content.batch.killed_children}\n\nSynthesized result:\n${content.synthesis}`,
    }
  },
  renderToolResultMessage(output) {
    return jsonStringify(output)
  },
  async call(input, context, canUseTool, assistantMessage, onProgress) {
    const launched = await ParallelAgentsTool.call(
      { agents: input.agents },
      context,
      canUseTool,
      assistantMessage,
      onProgress,
    )

    if (!isParallelAgentsOutput(launched.data)) {
      throw new Error('ParallelAgents returned an unexpected result')
    }

    const joined = await ParallelBatchOutputTool.call(
      {
        batch_id: launched.data.batchId,
        block: true,
        timeout: input.timeout,
      },
      context,
      canUseTool,
      assistantMessage,
      onProgress,
    )

    if (!isParallelBatchOutput(joined.data) || !joined.data.batch) {
      throw new Error('ParallelBatchOutput returned an unexpected result')
    }

    const synthesisResult = await AgentTool.call(
      {
        description: input.synthesis_description,
        prompt: buildSynthesisPrompt(input, joined.data.batch),
        subagent_type: input.synthesis_subagent_type,
        model: input.synthesis_model,
      },
      context,
      canUseTool,
      assistantMessage,
      onProgress,
    )

    if (!isCompletedAgentResult(synthesisResult.data)) {
      throw new Error('Synthesis agent did not return a completed result')
    }

    return {
      data: {
        batchId: launched.data.batchId,
        batch: joined.data.batch,
        synthesis: extractSynthesisText(synthesisResult.data),
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
