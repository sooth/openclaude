export const DESCRIPTION = 'Read outputs from a parallel agent batch'

export function getPrompt(): string {
  return `Use this tool to retrieve outputs from a batch launched by ParallelAgents.

## When to Use

- After launching multiple background agents with ParallelAgents
- When you need to wait for the whole batch to complete
- When you want all child outputs gathered in one result for synthesis

## Parameters

- batch_id: The parallel batch ID
- block: Whether to wait for the batch to finish (default true)
- timeout: Maximum wait time in milliseconds when block=true

## Output

Returns:
- batch metadata
- overall batch status
- synthesis-friendly summary fields:
  - successful_children
  - failed_children
  - killed_children
  - running_children
  - ready_for_synthesis
  - summary
- one entry per child task with status, prompt, output, and final result text when available

## Notes

- This is the dedicated join tool for ParallelAgents batches
- Prefer this over manually reading child task output files when you want to synthesize the full batch
- After this tool returns, compare the child outputs, resolve conflicts, and write one synthesized answer for the user
- Do not simply dump the raw batch JSON back to the user unless they explicitly ask for it`
}
