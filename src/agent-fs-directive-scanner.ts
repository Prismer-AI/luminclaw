/**
 * Node-only DirectiveScanner that watches `{workspaceDir}/.openclaw/directives`
 * for JSON files, parses them as Directives, publishes them to the agent's
 * EventBus, and unlinks the file.
 *
 * Embedded runtimes (iOS, Android) do NOT bundle this — they inject their
 * own DirectiveScanner via createAgentRuntime if directives are needed.
 *
 * @module agent-fs-directive-scanner
 */

import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import type { DirectiveScanner } from './agent.js';
import type { Session, Directive } from './session.js';
import type { EventBus } from './sse.js';
import type { Observer } from './observer.js';

export class FsDirectiveScanner implements DirectiveScanner {
  constructor(
    private readonly workspaceDir: string,
    private readonly bus?: EventBus,
    private readonly observer?: Observer,
  ) {}

  scan(session: Session, knownFiles?: Set<string>): void {
    const dirPath = `${this.workspaceDir}/.openclaw/directives`;
    let files: string[];
    try { files = readdirSync(dirPath).filter(f => f.endsWith('.json')); } catch { return; }
    for (const file of files) {
      if (knownFiles && knownFiles.has(file)) continue;
      try {
        const raw = readFileSync(`${dirPath}/${file}`, 'utf-8');
        const parsed = JSON.parse(raw);
        const directive: Directive = {
          type: parsed.type,
          payload: parsed.payload || {},
          timestamp: parsed.timestamp || String(Date.now()),
        };
        session.addPendingDirective(directive);
        this.bus?.publish({
          type: 'directive',
          data: { type: directive.type, payload: directive.payload, timestamp: directive.timestamp },
        });
        this.observer?.recordEvent({
          type: 'directive_emit', timestamp: Date.now(),
          data: { type: directive.type, payload: directive.payload },
        });
        unlinkSync(`${dirPath}/${file}`);
      } catch { /* skip */ }
    }
  }

  snapshot(): Set<string> {
    const dirPath = `${this.workspaceDir}/.openclaw/directives`;
    try { return new Set(readdirSync(dirPath).filter(f => f.endsWith('.json'))); }
    catch { return new Set(); }
  }
}
