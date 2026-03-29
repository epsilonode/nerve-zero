/**
 * Tests for Kanban root-session launch helper (TDD).
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { launchKanbanRootSessionViaRpc } from './kanban-root-session.js';
import * as gatewayRpc from './gateway-rpc.js';

// ── Test setup ───────────────────────────────────────────────────────

describe('launchKanbanRootSessionViaRpc', () => {
  let calls: Array<{ method: string; params: Record<string, unknown> }>;

  beforeEach(() => {
    calls = [];
    vi.spyOn(gatewayRpc, 'gatewayRpcCall').mockImplementation(async (method, params) => {
      calls.push({ method, params });
      
      // Mock responses
      if (method === 'sessions.patch') {
        return { ok: true };
      }
      if (method === 'chat.send') {
        return { ok: true, runId: 'mock-run-id-12345' };
      }
      return {};
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Test 1: sessions.patch happens before chat.send ─────────────────

  it('calls sessions.patch before chat.send', async () => {
    await launchKanbanRootSessionViaRpc({
      label: 'test-kanban-run',
      task: 'Execute kanban task',
    });

    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0].method).toBe('sessions.patch');
    expect(calls[1].method).toBe('chat.send');
  });

  // ── Test 2: chat.send uses deliver: false ───────────────────────────

  it('calls chat.send with deliver: false', async () => {
    await launchKanbanRootSessionViaRpc({
      label: 'test-kanban-run',
      task: 'Execute kanban task',
    });

    const chatSendCall = calls.find(c => c.method === 'chat.send');
    expect(chatSendCall).toBeDefined();
    expect(chatSendCall?.params.deliver).toBe(false);
  });

  // ── Test 3: model and thinking are forwarded ────────────────────────

  it('forwards model and thinking to sessions.patch when provided', async () => {
    await launchKanbanRootSessionViaRpc({
      label: 'test-kanban-run',
      task: 'Execute kanban task',
      model: 'openai-codex/gpt-5.4',
      thinking: 'high',
    });

    const patchCall = calls.find(c => c.method === 'sessions.patch');
    expect(patchCall).toBeDefined();
    expect(patchCall?.params.model).toBe('openai-codex/gpt-5.4');
    expect(patchCall?.params.thinking).toBe('high');
  });

  it('does not include model/thinking in sessions.patch when not provided', async () => {
    await launchKanbanRootSessionViaRpc({
      label: 'test-kanban-run',
      task: 'Execute kanban task',
    });

    const patchCall = calls.find(c => c.method === 'sessions.patch');
    expect(patchCall).toBeDefined();
    expect(patchCall?.params.model).toBeUndefined();
    expect(patchCall?.params.thinking).toBeUndefined();
  });

  // ── Test 4: returned runId is surfaced ─────────────────────────────

  it('returns runId from chat.send response', async () => {
    const result = await launchKanbanRootSessionViaRpc({
      label: 'test-kanban-run',
      task: 'Execute kanban task',
    });

    expect(result.runId).toBe('mock-run-id-12345');
  });

  // ── Test 5: generated sessionKey is a top-level root key ───────────

  it('returns a deterministic top-level root sessionKey derived from label', async () => {
    const result = await launchKanbanRootSessionViaRpc({
      label: 'test-kanban-run',
      task: 'Execute kanban task',
    });

    expect(result.sessionKey).toBeDefined();
    expect(typeof result.sessionKey).toBe('string');
    expect(result.sessionKey).toMatch(/^kanban-root:/);
  });

  it('uses the sessionKey in both sessions.patch and chat.send', async () => {
    const result = await launchKanbanRootSessionViaRpc({
      label: 'test-kanban-run',
      task: 'Execute kanban task',
    });

    const patchCall = calls.find(c => c.method === 'sessions.patch');
    const chatSendCall = calls.find(c => c.method === 'chat.send');

    expect(patchCall?.params.sessionKey).toBe(result.sessionKey);
    expect(chatSendCall?.params.sessionKey).toBe(result.sessionKey);
  });

  // ── Test 6: idempotency key is generated for chat.send ─────────────

  it('generates an idempotency key for chat.send', async () => {
    await launchKanbanRootSessionViaRpc({
      label: 'test-kanban-run',
      task: 'Execute kanban task',
    });

    const chatSendCall = calls.find(c => c.method === 'chat.send');
    expect(chatSendCall?.params.idempotencyKey).toBeDefined();
    expect(typeof chatSendCall?.params.idempotencyKey).toBe('string');
    expect((chatSendCall?.params.idempotencyKey as string).length).toBeGreaterThan(0);
  });

  it('includes the task in chat.send message', async () => {
    await launchKanbanRootSessionViaRpc({
      label: 'test-kanban-run',
      task: 'Execute kanban task',
    });

    const chatSendCall = calls.find(c => c.method === 'chat.send');
    expect(chatSendCall?.params.message).toBeDefined();
    expect(chatSendCall?.params.message).toContain('Execute kanban task');
  });
});
