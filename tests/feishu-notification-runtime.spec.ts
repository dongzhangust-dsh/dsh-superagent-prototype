/** End-to-end routing of private Feishu status notices from a GitHub ticket report. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../src/app/store.ts'
import { issueTrigger } from '../src/sources/github-trigger.ts'
import { githubKind } from '../src/sources/github.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { feishuTriggerId } from '../src/sources/feishu-trigger.ts'
import { Commands } from '../src/infra/commands.ts'
import { Runtime } from '../src/app/runtime.ts'
import { Context } from '@deepseek-ai/cordis'
import { testMachine } from './fixtures/deployment.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

const lark = () => vi.mocked(Commands.prototype.lark)

/** Configures Alice's explicit binding before the Runtime starts. */
const bind = (store: Store) => {
  const settings = store.settings()
  store.saveSettings({ ...settings, sources: { ...settings.sources, feishu: { ...settings.sources.feishu!,
    config: { ...settings.sources.feishu!.config, notificationBindings: [{ github: 'alice', openId: 'ou_alice', messageId: 'om_notice' }] } } } })
}

describe('private Feishu status notices', () => {
  let h: Host
  beforeEach(async () => {
    h = await startRuntime()
    bind(h.runtime.store)
    h.runtime.receive(feishu('notice', 'notify github alice', { chat_id: 'oc_private', chat_type: 'p2p' }))
    await h.runtime.idle()
  })
  afterEach(async () => { await h.stop() })
  it('retains the opt-in as evidence without assessing it or creating a ticket', async () => {
    const id = feishuTriggerId('om_notice')
    expect(h.runtime.store.triggers.get(id)?.text).toBe('notify github alice')
    expect(h.runtime.store.triggers.disposition(id)?.filtered?.code).toBe('notification_opt_in')
    expect(h.candidates()).not.toContain(id)
    expect(h.runtime.store.tickets.open()).toHaveLength(0)
    h.runtime.engine.reevaluate(id)
    await h.runtime.pump(); await h.runtime.idle()
    expect(h.candidates()).not.toContain(id)
    expect(h.runtime.store.tickets.open()).toHaveLength(0)
    const ordinary = feishu('ordinary', 'Please fix my issue', { chat_id: 'oc_private', chat_type: 'p2p' })
    expect(h.runtime.receive(ordinary)).toBe('stored')
    await h.runtime.idle()
    expect(h.candidates()).toContain(ordinary.id)
  })
  it('atomically queues source and authorized private notices for an unavailable evaluation', async () => {
    const issue = issueTrigger({ number: 15, title: 'Bug', body: '@agent-bot help', user: { login: 'alice', type: 'User' },
      created_at: '2026-09-09T00:00:00Z', html_url: 'https://github.com/acme/widgets/issues/15' }, 'agent-bot')
    h.runtime.receive(issue)
    await h.runtime.idle()
    await h.runtime.settings.pause(true, 'panel')
    const originalSend = h.runtime.outbox.send.bind(h.runtime.outbox)
    const send = vi.spyOn(h.runtime.outbox, 'send').mockImplementation(message => {
      if (message.channel.address.notification === 'true') throw new Error('queue failed')
      originalSend(message)
    })
    expect(() => h.runtime.engine.decide(issue.id, { kind: 'unavailable', reason: 'private failure detail' })).toThrow('queue failed')
    expect(h.runtime.store.receipts.waiting().filter(item => item.channel.source === 'github')).toHaveLength(0)
    send.mockRestore()
    h.runtime.engine.decide(issue.id, { kind: 'unavailable', reason: 'private failure detail' })
    const waiting = h.runtime.store.receipts.waiting()
    const source = waiting.filter(item => item.channel.source === 'github')
    const notices = waiting.filter(item => item.channel.address.notification === 'true')
    expect(source).toHaveLength(1)
    expect(notices).toHaveLength(1)
    expect(notices[0]!.text).toContain('GitHub #15')
    expect(notices[0]!.text).not.toContain('private failure detail')
    expect(notices[0]!.ticketId).toBeUndefined()
  })
  it('does not queue a private unavailable notice without a binding', async () => {
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, feishu: { ...settings.sources.feishu!,
      config: { ...settings.sources.feishu!.config, notificationBindings: [] } } } })
    const issue = issueTrigger({ number: 16, title: 'Bug', body: '@agent-bot help', user: { login: 'alice', type: 'User' },
      created_at: '2026-09-09T00:00:00Z', html_url: 'https://github.com/acme/widgets/issues/16' }, 'agent-bot')
    h.runtime.receive(issue)
    await h.runtime.idle()
    await h.runtime.settings.pause(true, 'panel')
    h.runtime.engine.decide(issue.id, { kind: 'unavailable', reason: 'failure' })
    const waiting = h.runtime.store.receipts.waiting()
    expect(waiting.filter(item => item.channel.source === 'github')).toHaveLength(1)
    expect(waiting.filter(item => item.channel.address.notification === 'true')).toHaveLength(0)
  })
  it('routes a ready report with a minimal private message', async () => {
    const issue = issueTrigger({ number: 7, title: 'Bug', body: '@agent-bot It breaks', user: { login: 'alice', type: 'User' },
      created_at: '2026-09-09T00:00:00Z', html_url: 'https://github.com/acme/widgets/issues/7' }, 'agent-bot')
    const { sessionId } = await h.acceptedTicket(issue)
    lark().mockClear()
    await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'private implementation detail' })
    await h.runtime.pump(); await h.runtime.sendReplies()
    const calls = lark().mock.calls.filter(([args]) => args.includes('om_notice'))
    expect(calls).toHaveLength(1)
    expect(String(calls[0]![0])).toContain('GitHub #7')
    expect(String(calls[0]![0])).toContain('is ready')
    expect(String(calls[0]![0])).not.toContain('private implementation detail')
    expect(String(calls[0]![0])).toContain('im,+messages-reply,--message-id,om_notice')
  })
  it('sends a private failed notice when the executor cannot launch a worker', async () => {
    const issue = issueTrigger({ number: 14, title: 'Bug', body: '@agent-bot help', user: { login: 'alice', type: 'User' },
      created_at: '2026-09-09T00:00:00Z', html_url: 'https://github.com/acme/widgets/issues/14' }, 'agent-bot')
    h.controller.create.mockRejectedValueOnce(new Error('private launch failure'))
    lark().mockClear()
    const { ticket } = await h.acceptedTicket(issue)
    await h.runtime.pump(); await h.runtime.sendReplies()
    expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.state).toBe('failed')
    const calls = lark().mock.calls.filter(([args]) => args.includes('om_notice')).map(([args]) => String(args))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('GitHub #14')
    expect(calls[0]).toContain('encountered a failure')
    expect(calls[0]).not.toContain('private launch failure')
  })
  it('sends one blocked notice and one recovery notice for repeated reports', async () => {
    const issue = issueTrigger({ number: 9, title: 'Bug', body: '@agent-bot help', user: { login: 'alice', type: 'User' },
      created_at: '2026-09-09T00:00:00Z', html_url: 'https://github.com/acme/widgets/issues/9' }, 'agent-bot')
    const { sessionId } = await h.acceptedTicket(issue)
    lark().mockClear()
    for (const state of ['blocked', 'blocked', 'progress', 'progress'] as const) {
      await h.runTool(sessionId, 'orchestrator_report', { state, summary: 'private detail' })
      await h.runtime.pump(); await h.runtime.sendReplies()
    }
    const calls = lark().mock.calls.filter(([args]) => args.includes('om_notice')).map(([args]) => String(args))
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('is blocked')
    expect(calls[1]).toContain('has resumed')
    expect(calls.join(' ')).not.toContain('private detail')
  })
  it('sends a new fixed-category notice when details change within a blocked state', async () => {
    const issue = issueTrigger({ number: 13, title: 'Bug', body: '@agent-bot help', user: { login: 'alice', type: 'User' },
      created_at: '2026-09-09T00:00:00Z', html_url: 'https://github.com/acme/widgets/issues/13' }, 'agent-bot')
    const { sessionId } = await h.acceptedTicket(issue)
    lark().mockClear()
    for (const reason of ['access', 'access', 'test_failure'] as const) {
      await h.runTool(sessionId, 'orchestrator_report', { state: 'blocked', summary: 'secret details',
        public_status: { reason, next: 'investigate' } })
      await h.runtime.pump(); await h.runtime.sendReplies()
    }
    const calls = lark().mock.calls.filter(([args]) => args.includes('om_notice')).map(([args]) => String(args))
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('Reason category: access')
    expect(calls[1]).toContain('Reason category: test failure')
    expect(calls[1]).toContain('Next step: Investigate the issue')
    expect(calls.join(' ')).not.toContain('secret details')
  })
  it('delivers the private notice while the independent GitHub notice retries', async () => {
    const issue = issueTrigger({ number: 11, title: 'Bug', body: '@agent-bot help', user: { login: 'alice', type: 'User' },
      created_at: '2026-09-09T00:00:00Z', html_url: 'https://github.com/acme/widgets/issues/11' }, 'agent-bot')
    const { sessionId } = await h.acceptedTicket(issue)
    await h.runtime.settings.pause(true, 'panel')
    await h.runTool(sessionId, 'orchestrator_report', { state: 'blocked', summary: 'private detail' })
    const waiting = h.runtime.store.receipts.waiting()
    const privateReceipt = waiting.find(item => item.channel.address.notification === 'true')!
    const sourceReceipt = waiting.find(item => item.ticketId === privateReceipt.ticketId && item.channel.source === 'github')!
    expect(sourceReceipt).toBeDefined()
    const send = vi.spyOn(h.runtime.sources, 'send').mockImplementation(async message => {
      if (message.id === sourceReceipt.id) throw new Error('temporary GitHub failure')
      return 'sent'
    })
    await h.runtime.settings.pause(false, 'panel')
    await h.runtime.pump(); await h.runtime.sendReplies()
    expect(h.runtime.outbox.status(privateReceipt.id)).toBe('sent')
    expect(h.runtime.outbox.status(sourceReceipt.id)).toBe('pending')
    send.mockImplementation(async () => 'sent')
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 5001 })
    try { await h.runtime.pump(); await h.runtime.sendReplies() } finally { vi.useRealTimers() }
    expect(h.runtime.outbox.status(sourceReceipt.id)).toBe('sent')
    expect(send.mock.calls.filter(([message]) => message.id === privateReceipt.id)).toHaveLength(1)
  })
  it('delivers a persisted pending notice after the Runtime restarts', async () => {
    const issue = issueTrigger({ number: 12, title: 'Bug', body: '@agent-bot help', user: { login: 'alice', type: 'User' },
      created_at: '2026-09-09T00:00:00Z', html_url: 'https://github.com/acme/widgets/issues/12' }, 'agent-bot')
    const { sessionId } = await h.acceptedTicket(issue)
    await h.runtime.settings.pause(true, 'panel')
    await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'done' })
    const receipt = h.runtime.store.receipts.waiting().find(item => item.channel.address.notification === 'true')!
    expect(receipt.status).toBe('pending')
    await h.runtime.stop()
    const context = new Context()
    for (const name of ['agents', 'llm', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'subprocess', 'webServer', 'jobs', 'subagents']) {
      context.reflect.provide(name, (h.ctx as unknown as Record<string, unknown>)[name])
    }
    const restarted = new Runtime(context, testMachine({ stateDir: h.directory }), vi.fn())
    try {
      await restarted.ready
      restarted.sources.register(feishuKind); restarted.sources.register(githubKind)
      lark().mockClear()
      await restarted.settings.pause(false, 'panel')
      await restarted.pump(); await restarted.sendReplies()
      expect(restarted.outbox.status(receipt.id)).toBe('sent')
      expect(lark().mock.calls.filter(([args]) => args.includes('om_notice'))).toHaveLength(1)
    } finally { await restarted.stop() }
  })
  it('drops a queued private notice when its binding is revoked', async () => {
    const issue = issueTrigger({ number: 10, title: 'Bug', body: '@agent-bot help', user: { login: 'alice', type: 'User' },
      created_at: '2026-09-09T00:00:00Z', html_url: 'https://github.com/acme/widgets/issues/10' }, 'agent-bot')
    const { sessionId } = await h.acceptedTicket(issue)
    await h.runtime.settings.pause(true, 'panel')
    lark().mockClear()
    await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'done' })
    const receipt = h.runtime.store.receipts.waiting().find(item => item.channel.address.notification === 'true')!
    const settings = h.runtime.store.settings()
    const source = settings.sources.feishu!
    h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, feishu: { ...source,
      config: { ...source.config, notificationBindings: [] } } } })
    await h.runtime.settings.pause(false, 'panel')
    await h.runtime.pump(); await h.runtime.sendReplies()
    expect(h.runtime.outbox.status(receipt.id)).toBe('dropped')
    expect(lark().mock.calls.filter(([args]) => args.includes('om_notice'))).toEqual([])
  })
  it('drops a queued private notice after the GitHub Source is disabled', async () => {
    const issue = issueTrigger({ number: 8, title: 'Bug', body: '@agent-bot It breaks', user: { login: 'alice', type: 'User' },
      created_at: '2026-09-09T00:00:00Z', html_url: 'https://github.com/acme/widgets/issues/8' }, 'agent-bot')
    const { sessionId } = await h.acceptedTicket(issue)
    await h.runtime.settings.pause(true, 'panel')
    lark().mockClear()
    await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'done' })
    const receipt = h.runtime.store.receipts.waiting().find(item => item.channel.address.notification === 'true')!
    expect(receipt.status).toBe('pending')
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, github: { ...settings.sources.github!, enabled: false } } })
    await h.runtime.settings.pause(false, 'panel')
    await h.runtime.pump(); await h.runtime.sendReplies()
    expect(h.runtime.outbox.status(receipt.id)).toBe('dropped')
    expect(lark().mock.calls.filter(([args]) => args.includes('om_notice'))).toEqual([])
  })
})
