/** End-to-end routing of private Feishu status notices from a GitHub ticket report. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../src/app/store.ts'
import { issueTrigger } from '../src/sources/github-trigger.ts'
import { feishuTriggerId } from '../src/sources/feishu-trigger.ts'
import { Commands } from '../src/infra/commands.ts'
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
