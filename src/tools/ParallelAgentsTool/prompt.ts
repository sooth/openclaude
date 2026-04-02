export const DESCRIPTION = 'Launch multiple background sub-agents in parallel'

export function getPrompt(): string {
  return `Use this tool to launch multiple sub-agents in parallel as background tasks.

## When to Use

- When independent work can be split into multiple sub-agent jobs
- When the user explicitly asks for several agents at once
- When the main thread should continue while sub-agents work

## Requirements

- Each item must describe a distinct task
- All launched agents run in the background
- Use this only for genuinely parallelizable work
- Do not use this tool when later tasks depend on earlier agent results

## Output

Returns the launched background agents with:
- batchId
- agentId
- description
- subagent_type
- outputFile

The main thread will be notified automatically when agents complete.

## Recommended Follow-up

- If you need the combined results, save the returned \`batchId\`
- When you're ready to join and synthesize, call \`ParallelBatchOutput\` with that \`batch_id\`
- Use \`block: true\` when you want to wait for the whole batch and then synthesize the child results
- After \`ParallelBatchOutput\` returns, synthesize across all child outputs yourself in your next response

## Notes

- This tool is a thin wrapper around the existing AgentTool background-task flow
- Do not poll or sleep after launching agents unless the user explicitly asks for progress checks`
}
