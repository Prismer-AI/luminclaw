/**
 * Tests for SSE — EventBus, backpressure, StdoutSSEWriter, AgentEventSchema
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus, AgentEventSchema, StdoutSSEWriter, type AgentEvent } from '../src/sse.js';

// ── AgentEventSchema ─────────────────────────────────────

describe('AgentEventSchema', () => {
  it('validates agent.start event', () => {
    const event = { type: 'agent.start', data: { sessionId: 's1', agentId: 'researcher' } };
    expect(AgentEventSchema.parse(event)).toEqual(event);
  });

  it('validates agent.end event', () => {
    const event = { type: 'agent.end', data: { sessionId: 's1', toolsUsed: ['bash', 'latex'] } };
    expect(AgentEventSchema.parse(event)).toEqual(event);
  });

  it('validates text.delta event', () => {
    const event = { type: 'text.delta', data: { sessionId: 's1', delta: 'hello' } };
    expect(AgentEventSchema.parse(event)).toEqual(event);
  });

  it('validates tool.start event', () => {
    const event = { type: 'tool.start', data: { sessionId: 's1', tool: 'bash' } };
    expect(AgentEventSchema.parse(event)).toEqual(event);
  });

  it('validates tool.end event', () => {
    const event = { type: 'tool.end', data: { sessionId: 's1', tool: 'bash', result: 'ok' } };
    expect(AgentEventSchema.parse(event)).toEqual(event);
  });

  it('validates tool.approval_required event', () => {
    const event = {
      type: 'tool.approval_required',
      data: { sessionId: 's1', tool: 'bash', toolId: 'call-1', args: { command: 'rm -rf /tmp' }, reason: 'destructive' },
    };
    expect(AgentEventSchema.parse(event)).toEqual(event);
  });

  it('validates tool.approval_response event', () => {
    const event = { type: 'tool.approval_response', data: { toolId: 'call-1', approved: true } };
    expect(AgentEventSchema.parse(event)).toEqual(event);
  });

  it('validates heartbeat event', () => {
    const event = { type: 'heartbeat', data: { timestamp: 12345 } };
    expect(AgentEventSchema.parse(event)).toEqual(event);
  });

  it('validates compaction event', () => {
    const event = { type: 'compaction', data: { summary: 'test summary', droppedCount: 5 } };
    expect(AgentEventSchema.parse(event)).toEqual(event);
  });

  it('validates error event', () => {
    const event = { type: 'error', data: { message: 'something failed' } };
    expect(AgentEventSchema.parse(event)).toEqual(event);
  });

  it('validates directive event', () => {
    const event = { type: 'directive', data: { type: 'SWITCH_COMPONENT', payload: {} } };
    expect(AgentEventSchema.parse(event)).toEqual(event);
  });

  it('validates subagent events', () => {
    const start = { type: 'subagent.start', data: { parentAgent: 'researcher', subAgent: 'latex-expert' } };
    const end = { type: 'subagent.end', data: { parentAgent: 'researcher', subAgent: 'latex-expert' } };
    expect(AgentEventSchema.parse(start)).toEqual(start);
    expect(AgentEventSchema.parse(end)).toEqual(end);
  });

  it('rejects unknown event type', () => {
    const event = { type: 'unknown.event', data: {} };
    expect(() => AgentEventSchema.parse(event)).toThrow();
  });

  it('rejects event with missing required fields', () => {
    const event = { type: 'agent.start', data: { sessionId: 's1' } }; // missing agentId
    expect(() => AgentEventSchema.parse(event)).toThrow();
  });
});

// ── EventBus ─────────────────────────────────────────────

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  const makeEvent = (type: string = 'heartbeat'): AgentEvent => ({
    type: 'heartbeat',
    data: { timestamp: Date.now() },
  } as AgentEvent);

  it('publishes events to subscribers', () => {
    const received: AgentEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const event = makeEvent();
    bus.publish(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);
  });

  it('delivers to multiple subscribers', () => {
    const r1: AgentEvent[] = [];
    const r2: AgentEvent[] = [];
    bus.subscribe((e) => r1.push(e));
    bus.subscribe((e) => r2.push(e));

    bus.publish(makeEvent());

    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
  });

  it('unsubscribes correctly', () => {
    const received: AgentEvent[] = [];
    const unsub = bus.subscribe((e) => received.push(e));

    bus.publish(makeEvent());
    expect(received).toHaveLength(1);

    unsub();
    bus.publish(makeEvent());
    expect(received).toHaveLength(1); // no new event
  });

  it('buffers events for late subscribers', () => {
    bus.publish(makeEvent());
    bus.publish(makeEvent());

    const buffer = bus.getBuffer();
    expect(buffer).toHaveLength(2);
  });

  it('clearBuffer resets buffer and highWaterReached', () => {
    bus.publish(makeEvent());
    expect(bus.getBuffer()).toHaveLength(1);

    bus.clearBuffer();
    expect(bus.getBuffer()).toHaveLength(0);
  });

  it('tracks subscriberCount', () => {
    expect(bus.subscriberCount).toBe(0);

    const unsub1 = bus.subscribe(() => {});
    expect(bus.subscriberCount).toBe(1);

    const unsub2 = bus.subscribe(() => {});
    expect(bus.subscriberCount).toBe(2);

    unsub1();
    expect(bus.subscriberCount).toBe(1);

    unsub2();
    expect(bus.subscriberCount).toBe(0);
  });

  it('drops oldest events when buffer exceeds maxBuffer', () => {
    const smallBus = new EventBus(3);

    for (let i = 0; i < 5; i++) {
      smallBus.publish({ type: 'heartbeat', data: { timestamp: i } } as AgentEvent);
    }

    const buffer = smallBus.getBuffer();
    expect(buffer).toHaveLength(3);
    // Should have events 2, 3, 4 (dropped 0, 1)
    expect((buffer[0].data as { timestamp: number }).timestamp).toBe(2);
    expect((buffer[2].data as { timestamp: number }).timestamp).toBe(4);
  });

  it('tracks droppedCount in getStats', () => {
    const smallBus = new EventBus(3);

    for (let i = 0; i < 5; i++) {
      smallBus.publish(makeEvent());
    }

    const stats = smallBus.getStats();
    expect(stats.droppedCount).toBe(2);
    expect(stats.bufferSize).toBe(3);
    expect(stats.maxBuffer).toBe(3);
  });

  it('emits high-water warning at 80% capacity', () => {
    const smallBus = new EventBus(5); // highWaterMark = 4
    const warnings: AgentEvent[] = [];
    smallBus.subscribe((e) => {
      if (e.type === 'error' && (e.data as { message: string }).message.includes('[backpressure]')) {
        warnings.push(e);
      }
    });

    // Publish 4 events (reaching 80%)
    for (let i = 0; i < 4; i++) {
      smallBus.publish(makeEvent());
    }

    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('getStats returns correct structure', () => {
    const stats = bus.getStats();
    expect(stats).toHaveProperty('bufferSize');
    expect(stats).toHaveProperty('maxBuffer');
    expect(stats).toHaveProperty('droppedCount');
    expect(stats).toHaveProperty('highWaterMark');
    expect(stats.bufferSize).toBe(0);
    expect(stats.maxBuffer).toBe(1000);
    expect(stats.droppedCount).toBe(0);
    expect(stats.highWaterMark).toBe(800);
  });

  it('subscriber error does not break other subscribers', () => {
    const received: AgentEvent[] = [];
    bus.subscribe(() => { throw new Error('boom'); });
    bus.subscribe((e) => received.push(e));

    bus.publish(makeEvent());
    expect(received).toHaveLength(1);
  });
});

// ── StdoutSSEWriter ──────────────────────────────────────

describe('StdoutSSEWriter', () => {
  it('writes SSE-formatted events to stdout', () => {
    const bus = new EventBus();
    const writer = new StdoutSSEWriter(bus);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    writer.start();
    bus.publish({ type: 'heartbeat', data: { timestamp: 123 } } as AgentEvent);
    writer.stop();

    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('event: heartbeat')
    );
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('data: {"timestamp":123}')
    );

    writeSpy.mockRestore();
  });

  it('stops writing after stop()', () => {
    const bus = new EventBus();
    const writer = new StdoutSSEWriter(bus);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    writer.start();
    writer.stop();

    bus.publish({ type: 'heartbeat', data: { timestamp: 456 } } as AgentEvent);

    // Only the first event (before stop) should have caused a write
    const calls = writeSpy.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('456')
    );
    expect(calls).toHaveLength(0);

    writeSpy.mockRestore();
  });

  it('can stop without starting (no-op)', () => {
    const bus = new EventBus();
    const writer = new StdoutSSEWriter(bus);
    expect(() => writer.stop()).not.toThrow();
  });
});
