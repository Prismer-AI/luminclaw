/**
 * Basic usage — run an agent with built-in tools.
 *
 * Prerequisites:
 *   export OPENAI_API_KEY=sk-...
 *
 * Run:
 *   npx tsx examples/basic.ts
 */

import { runAgent } from '@prismer/agent-core';

await runAgent(
  {
    content: 'List the files in the current workspace and tell me what you see.',
    sessionId: 'example-basic',
  },
  { stream: true },
);
