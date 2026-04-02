export const DESCRIPTION = 'Launch, join, and synthesize a parallel agent batch'

export function getPrompt(): string {
  return `Use this tool for the full parallel-agent workflow in one call.

## What it does

1. Launches multiple background agents in parallel
2. Waits for the batch to finish
3. Synthesizes the combined child outputs with a dedicated synthesis sub-agent

## When to Use

- When the user wants one end-to-end parallel workflow
- When you want combined results without manually calling ParallelAgents and ParallelBatchOutput separately
- When the parallel tasks are independent and a final synthesis step is needed

## Requirements

- The child agent tasks must be genuinely parallelizable
- The synthesis prompt should describe how to combine the child outputs
- Use this only from the main thread

## Output

Returns:
- batchId
- batch summary
- synthesized result

## Example

If the user says something like "spin up 5 agents to inspect 5 independent areas and give me one answer," prefer this tool over manually chaining ParallelAgents and ParallelBatchOutput.

The synthesized result should usually be the basis for your next response to the user.`
}

