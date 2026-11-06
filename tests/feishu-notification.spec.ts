import { describe, expect, it } from 'vitest'
import { feishuKind } from '../src/sources/feishu.ts'
import { feishuPrivateNotice, feishuReportStatus } from '../src/sources/feishu-notification.ts'
import type { Ticket } from '../src/core/index.ts'
import { feishuTrigger } from '../src/sources/feishu-trigger.ts'

const config = feishuKind.schema.parse({ notificationBindings: [{ github: 'alice', openId: 'ou_alice', messageId: 'om_consent' }] })
const event = { message_id: 'om_consent', chat_id: 'oc_private', chat_type: 'p2p', sender_id: 'ou_alice', sender_type: 'user',
  content: 'notify github alice', create_time: '1700000000000', mentions: [] }
const route = (input: typeof event = event) => feishuPrivateNotice(config,
  () => feishuTrigger(input, 'ou_bot', 'cli_bot'), 'alice', 'event-1', 'Ticket is ready.')

describe('private Feishu notifications', () => {
  it('requires an explicit private human opt-in matching the configured identity', () => {
    const notice = route()
    expect(notice?.channel.address.chatId).toBe('oc_private')
    expect(route({ ...event, chat_type: 'group' })).toBeUndefined()
    expect(route({ ...event, sender_id: 'ou_other' })).toBeUndefined()
    expect(route({ ...event, sender_type: 'bot' })).toBeUndefined()
    expect(route({ ...event, content: 'notify github bob' })).toBeUndefined()
    expect(route({ ...event, message_id: 'om_other' })).toBeUndefined()
    expect(feishuPrivateNotice(config, () => undefined, 'alice', 'event-1', 'x')).toBeUndefined()
    expect(feishuPrivateNotice(config, () => feishuTrigger(event, 'ou_bot', 'cli_bot'), 'bob', 'event-1', 'x')).toBeUndefined()
  })
  it('does not repeat a recovery already announced on ticket resumption', () => {
    const before = { id: 'ticket', assignments: [{ report: { state: 'blocked', at: '2026-01-01T00:00:00.000Z' } }],
      inputs: [{ kind: 'resumed', at: '2026-01-01T00:00:01.000Z' }] } as Ticket
    const after = { ...before, assignments: [{ report: { state: 'progress', at: '2026-01-01T00:00:02.000Z' } }] } as Ticket
    expect(feishuReportStatus(before, after)).toBeUndefined()
    expect(feishuReportStatus({ ...before, inputs: [] }, after)?.text).toBe('has resumed')
  })
  it('rechecks the binding and direct message setting when delivering', () => {
    const notice = route()!
    expect(feishuKind.channel!.allowed!(notice.channel.address, config)).toBe(true)
    expect(feishuKind.channel!.allowed!(notice.channel.address, { ...config, notificationBindings: [] })).toBe(false)
    expect(feishuKind.channel!.allowed!(notice.channel.address, { ...config, directMessages: false })).toBe(false)
    expect(route()?.id).toBe(notice.id)
  })
})
