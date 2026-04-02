import React from 'react'
import { describe, expect, it } from 'bun:test'
import { renderToString } from '../../utils/staticRender.js'
import { renderGroupedAgentToolUse } from './UI.js'

describe('renderGroupedAgentToolUse', () => {
  it('counts grouped agent tool uses from assistant tool_use messages', async () => {
    const output = await renderToString(
      <>
        {renderGroupedAgentToolUse(
          [
            {
              param: {
                id: 'agent-1',
                input: {
                  description: 'Count tool use',
                  prompt: 'Use Read once',
                  subagent_type: 'general-purpose',
                },
              },
              isResolved: true,
              isError: false,
              isInProgress: false,
              progressMessages: [
                {
                  data: {
                    message: {
                      type: 'assistant',
                      message: {
                        content: [
                          {
                            type: 'tool_use',
                            id: 'tool-1',
                            name: 'Read',
                            input: { file_path: '/tmp/example.txt' },
                          },
                        ],
                        usage: {
                          input_tokens: 0,
                          output_tokens: 0,
                          cache_creation_input_tokens: 0,
                          cache_read_input_tokens: 0,
                        },
                      },
                    },
                  },
                } as any,
              ],
              result: {
                param: {
                  tool_use_id: 'agent-1',
                  type: 'tool_result',
                  content: [{ type: 'text', text: 'done' }],
                },
                output: {
                  status: 'completed',
                },
              },
            } as any,
          ],
          {
            shouldAnimate: false,
            tools: [] as any,
          },
        )}
      </>,
      120,
    )

    expect(output).toContain('1 tool use')
  })
})
