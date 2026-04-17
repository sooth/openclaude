import { z } from 'zod/v4'
import type { AppState } from '../../state/AppState.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { TaskState } from '../../tasks/types.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { AbortError } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { extractTextContent } from '../../utils/messages.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { sleep } from '../../utils/sleep.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getTaskOutput } from '../../utils/task/diskOutput.js'
import { PARALLEL_BATCH_OUTPUT_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    batch_id: z.string().describe('The parallel agent batch ID'),
    block: semanticBoolean(z.boolean().default(true)).describe(
      'Whether to wait for the batch to complete',
    ),
    timeout: z.number().min(0).max(600000).default(30000).describe(
      'Max wait time in ms when block=true',
    ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

type ChildOutput = {
  task_id: string
  status: string
  description: string
  prompt?: string
  output: string
  result?: string
  error?: string
}

export type BatchOutput = {
  batch_id: string
  description: string
  expected_count: number
  completed_count: number
  successful_children: number
  failed_children: number
  killed_children: number
  running_children: number
  ready_for_synthesis: boolean
  summary: string
  status: 'completed' | 'partial' | 'running'
  children: ChildOutput[]
}

export type Output = {
  retrieval_status: 'success' | 'timeout' | 'not_ready'
  batch: BatchOutput | null
}

const outputSchema = lazySchema(() =>
  z.object({
    retrieval_status: z.enum(['success', 'timeout', 'not_ready']),
    batch: z
      .object({
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
      })
      .nullable(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

type ParallelAgentBatchState = AppState['parallelAgentBatches'][string]

function isLocalAgentTask(task: TaskState | undefined): task is LocalAgentTaskState {
  return !!task && task.type === 'local_agent'
}

async function getChildOutput(task: LocalAgentTaskState): Promise<ChildOutput> {
  const diskOutput = await getTaskOutput(task.id)
  const cleanResult = task.result
    ? extractTextContent(task.result.content, '\n')
    : undefined

  return {
    task_id: task.id,
    status: task.status,
    description: task.description,
    prompt: task.prompt,
    output: cleanResult || diskOutput,
    result: cleanResult || diskOutput,
    error: task.error,
  }
}

async function buildBatchOutput(
  batchId: string,
  getAppState: () => AppState,
): Promise<BatchOutput | null> {
  const appState = getAppState()
  const batch = appState.parallelAgentBatches[batchId] as
    | ParallelAgentBatchState
    | undefined

  if (!batch) {
    return null
  }

  const children = await Promise.all(
    batch.childTaskIds
      .map(id => appState.tasks[id] as TaskState | undefined)
      .filter(isLocalAgentTask)
      .map(getChildOutput),
  )

  const successfulChildren = children.filter(
    child => child.status === 'completed',
  ).length
  const failedChildren = children.filter(
    child => child.status === 'failed',
  ).length
  const killedChildren = children.filter(
    child => child.status === 'killed',
  ).length
  const completedCount = successfulChildren + failedChildren + killedChildren
  const runningChildren = Math.max(batch.expectedCount - completedCount, 0)

  const status: BatchOutput['status'] =
    completedCount === 0
      ? 'running'
      : completedCount === batch.expectedCount
        ? 'completed'
        : 'partial'

  const readyForSynthesis = completedCount === batch.expectedCount
  const summary = readyForSynthesis
    ? `Batch complete: ${successfulChildren} succeeded, ${failedChildren} failed, ${killedChildren} stopped.`
    : `Batch in progress: ${completedCount}/${batch.expectedCount} finished, ${runningChildren} still running.`

  return {
    batch_id: batch.id,
    description: batch.description,
    expected_count: batch.expectedCount,
    completed_count: completedCount,
    successful_children: successfulChildren,
    failed_children: failedChildren,
    killed_children: killedChildren,
    running_children: runningChildren,
    ready_for_synthesis: readyForSynthesis,
    summary,
    status,
    children,
  }
}

async function waitForBatchCompletion(
  batchId: string,
  getAppState: () => AppState,
  timeoutMs: number,
  abortController?: AbortController,
): Promise<BatchOutput | null> {
  const startTime = Date.now()

  while (Date.now() - startTime < timeoutMs) {
    if (abortController?.signal.aborted) {
      throw new AbortError()
    }

    const batch = await buildBatchOutput(batchId, getAppState)
    if (!batch) {
      return null
    }
    if (batch.completed_count === batch.expected_count) {
      return batch
    }

    await sleep(100)
  }

  return buildBatchOutput(batchId, getAppState)
}

export const ParallelBatchOutputTool = buildTool({
  name: PARALLEL_BATCH_OUTPUT_TOOL_NAME,
  searchHint: 'wait for and read parallel batch outputs',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  userFacingName() {
    return 'ParallelBatchOutput'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.batch_id
  },
  async validateInput({ batch_id }, { getAppState }) {
    const batch = getAppState().parallelAgentBatches[batch_id]
    if (!batch) {
      return {
        result: false,
        message: `No parallel batch found with ID: ${batch_id}`,
        errorCode: 1,
      }
    }

    return { result: true }
  },
  async call(input: Input, toolUseContext, _canUseTool, _parentMessage, onProgress) {
    const { batch_id, block, timeout } = input

    if (!block) {
      const batch = await buildBatchOutput(batch_id, toolUseContext.getAppState)
      if (!batch) {
        throw new Error(`No parallel batch found with ID: ${batch_id}`)
      }

      return {
        data: {
          retrieval_status:
            batch.completed_count === batch.expected_count
              ? 'success'
              : 'not_ready',
          batch,
        },
      }
    }

    if (onProgress) {
      onProgress({
        toolUseID: `parallel-batch-output-${Date.now()}`,
        data: {
          type: 'waiting_for_task',
          taskDescription: `parallel batch ${batch_id}`,
          taskType: 'local_agent',
        },
      })
    }

    const batch = await waitForBatchCompletion(
      batch_id,
      toolUseContext.getAppState,
      timeout,
      toolUseContext.abortController,
    )

    if (!batch) {
      return {
        data: {
          retrieval_status: 'timeout',
          batch: null,
        },
      }
    }

    return {
      data: {
        retrieval_status:
          batch.completed_count === batch.expected_count
            ? 'success'
            : 'timeout',
        batch,
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    if (!content.batch) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: 'Parallel batch output unavailable',
      }
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `${jsonStringify(content.batch)}\n\nThe batch output is ready. Read across the child results, reconcile differences, and provide one synthesized answer to the user rather than echoing this JSON verbatim unless they asked for raw output.`,
    }
  },
  renderToolUseMessage() {
    return 'Reading parallel batch output'
  },
  renderToolResultMessage(output) {
    return output.batch
      ? jsonStringify(output.batch)
      : 'Parallel batch output unavailable'
  },
}) satisfies ToolDef<InputSchema, Output>
