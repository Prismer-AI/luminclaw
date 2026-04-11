/**
 * TS tool schema parity test — verifies TS tools match the canonical spec.
 * The Rust side has a matching test (tool_registration.rs) using the same spec.
 * If either side's schema changes, one of the two tests will fail.
 */

import { describe, it, expect, beforeAll } from 'vitest';

// Canonical schema — source of truth shared conceptually with Rust test.
const CANONICAL: Record<string, {
  required: string[];
  properties: string[];
}> = {
  bash:          { required: ['command'],                         properties: ['command', 'timeout'] },
  read_file:     { required: ['path'],                            properties: ['path', 'offset', 'limit'] },
  write_file:    { required: ['path', 'content'],                 properties: ['path', 'content'] },
  edit_file:     { required: ['path', 'old_string', 'new_string'], properties: ['path', 'old_string', 'new_string', 'replace_all'] },
  list_files:    { required: [],                                  properties: ['path', 'pattern', 'maxDepth'] },
  grep:          { required: ['pattern'],                         properties: ['pattern', 'path', 'glob', 'maxResults'] },
  web_fetch:     { required: ['url'],                             properties: ['url', 'method', 'headers', 'body', 'maxBytes'] },
  think:         { required: ['thought'],                         properties: ['thought'] },
  memory_store:  { required: ['content'],                         properties: ['content', 'tags'] },
  memory_recall: { required: ['query'],                           properties: ['query', 'maxChars'] },
};

const TOOL_NAMES = Object.keys(CANONICAL);

describe('TS tool schemas match canonical spec', () => {
  let specs: any[];

  beforeAll(async () => {
    const { getToolSpecs } = await import('../src/index.js');
    const result = await getToolSpecs();
    specs = result.specs;
  });

  it('has all 10 canonical tools', () => {
    const names = specs.map((s: any) => s.function.name);
    for (const name of TOOL_NAMES) {
      expect(names, `missing tool: ${name}`).toContain(name);
    }
  });

  for (const toolName of TOOL_NAMES) {
    it(`${toolName}: required fields match`, () => {
      const spec = specs.find((s: any) => s.function.name === toolName);
      const actual = (spec.function.parameters.required ?? []).slice().sort();
      const expected = [...CANONICAL[toolName].required].sort();
      expect(actual).toEqual(expected);
    });

    it(`${toolName}: property names match`, () => {
      const spec = specs.find((s: any) => s.function.name === toolName);
      const actual = Object.keys(spec.function.parameters.properties).sort();
      const expected = [...CANONICAL[toolName].properties].sort();
      expect(actual).toEqual(expected);
    });
  }
});
