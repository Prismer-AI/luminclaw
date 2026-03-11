/**
 * Tests for Log — createLogger, log levels, DEBUG filtering
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger, _resetLogState, type Logger } from '../src/log.js';

describe('createLogger', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetLogState();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env.LOG_LEVEL;
    delete process.env.DEBUG;
    _resetLogState();
  });

  it('returns a Logger with debug/info/warn/error methods', () => {
    const log = createLogger('test');
    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
  });

  it('writes info messages to stderr', () => {
    const log = createLogger('mymod');
    log.info('hello world');
    expect(stderrSpy).toHaveBeenCalledOnce();
    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).toContain('INF');
    expect(output).toContain('[lumin:mymod]');
    expect(output).toContain('hello world');
  });

  it('includes JSON data in output', () => {
    const log = createLogger('test');
    log.info('operation', { key: 'value', count: 42 });
    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).toContain('"key":"value"');
    expect(output).toContain('"count":42');
  });

  it('writes warn and error at default log level', () => {
    const log = createLogger('test');
    log.warn('warning msg');
    log.error('error msg');
    expect(stderrSpy).toHaveBeenCalledTimes(2);
    expect((stderrSpy.mock.calls[0][0] as string)).toContain('WRN');
    expect((stderrSpy.mock.calls[1][0] as string)).toContain('ERR');
  });

  it('suppresses debug at default (info) level', () => {
    const log = createLogger('test');
    log.debug('should not appear');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('emits debug when LOG_LEVEL=debug', () => {
    process.env.LOG_LEVEL = 'debug';
    _resetLogState();
    const log = createLogger('test');
    log.debug('visible');
    expect(stderrSpy).toHaveBeenCalledOnce();
    expect((stderrSpy.mock.calls[0][0] as string)).toContain('DBG');
  });

  it('suppresses info when LOG_LEVEL=warn', () => {
    process.env.LOG_LEVEL = 'warn';
    _resetLogState();
    const log = createLogger('test');
    log.info('should not appear');
    expect(stderrSpy).not.toHaveBeenCalled();
    log.warn('visible');
    expect(stderrSpy).toHaveBeenCalledOnce();
  });

  it('suppresses info and warn when LOG_LEVEL=error', () => {
    process.env.LOG_LEVEL = 'error';
    _resetLogState();
    const log = createLogger('test');
    log.info('nope');
    log.warn('nope');
    expect(stderrSpy).not.toHaveBeenCalled();
    log.error('visible');
    expect(stderrSpy).toHaveBeenCalledOnce();
  });
});

describe('DEBUG pattern matching', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetLogState();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    delete process.env.LOG_LEVEL;
    delete process.env.DEBUG;
    _resetLogState();
  });

  it('emits debug for matching DEBUG=lumin:* pattern', () => {
    process.env.DEBUG = 'lumin:*';
    _resetLogState();
    const log = createLogger('agent');
    log.debug('match');
    expect(stderrSpy).toHaveBeenCalledOnce();
    expect((stderrSpy.mock.calls[0][0] as string)).toContain('DBG');
  });

  it('emits debug for exact DEBUG=lumin:agent', () => {
    process.env.DEBUG = 'lumin:agent';
    _resetLogState();
    const log = createLogger('agent');
    log.debug('match');
    expect(stderrSpy).toHaveBeenCalledOnce();
  });

  it('does not emit debug when DEBUG pattern does not match', () => {
    process.env.DEBUG = 'lumin:server';
    _resetLogState();
    const log = createLogger('agent');
    log.debug('no match');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('handles comma-separated DEBUG patterns', () => {
    process.env.DEBUG = 'lumin:agent,lumin:server';
    _resetLogState();
    const agentLog = createLogger('agent');
    const serverLog = createLogger('server');
    const toolLog = createLogger('tools');

    agentLog.debug('yes');
    serverLog.debug('yes');
    toolLog.debug('no');

    expect(stderrSpy).toHaveBeenCalledTimes(2);
  });

  it('DEBUG overrides LOG_LEVEL for debug messages only', () => {
    process.env.LOG_LEVEL = 'warn'; // would suppress debug normally
    process.env.DEBUG = 'lumin:agent';
    _resetLogState();
    const log = createLogger('agent');
    log.debug('visible via DEBUG override');
    expect(stderrSpy).toHaveBeenCalledOnce();
  });
});

describe('log format', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetLogState();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    _resetLogState();
  });

  it('includes timestamp in HH:mm:ss.SSS format', () => {
    const log = createLogger('test');
    log.info('tick');
    const output = stderrSpy.mock.calls[0][0] as string;
    // Match HH:mm:ss.SSS pattern at the beginning
    expect(output).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}/);
  });

  it('ends with newline', () => {
    const log = createLogger('test');
    log.info('end');
    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output.endsWith('\n')).toBe(true);
  });

  it('omits data JSON when no data provided', () => {
    const log = createLogger('test');
    log.info('no data');
    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).not.toContain('{');
  });
});
