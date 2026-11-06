/** Explicit, opt-in private Feishu notification bindings. */
import { key, latestReport, type OutboundMessage, type Ticket, type Trigger } from '../core/index.ts'
import type { FeishuConfig } from './feishu.ts'
import { feishuTriggerId, SOURCE } from './feishu-trigger.ts'

/** Select only meaningful state transitions; never include a report's private contents. */
export function feishuReportStatus(before: Ticket, after: Ticket): { id: string; text: string } | undefined {
  const previous = latestReport(before)?.state
  const report = latestReport(after)
  if (!report) return
  const attention = after.attention && after.attention.id !== before.attention?.id
  const state = attention ? 'attention' : report.state === 'blocked' || report.state === 'failed' || report.state === 'ready'
    ? report.state : previous === 'blocked' || previous === 'failed' || (before.attention && !after.attention) ? 'resumed' : undefined
  if (!state || (!attention && state === previous)) return
  const text = { attention: 'needs your attention', blocked: 'is blocked', failed: 'encountered a failure',
    ready: 'is ready', resumed: 'has resumed' }[state]
  return { id: key('report', after.id, report.at, state), text }
}

/**
 * Route only the original GitHub requester's notice. The administrator configures the identity mapping;
 * the recipient must also have sent the exact opt-in in a direct message to this bot. Missing or
 * unverifiable evidence fails closed. The outbox persists and retries the returned message by ID.
 */
export function feishuPrivateNotice(config: FeishuConfig, lookup: (id: string) => Trigger | undefined,
  github: string, eventId: string, text: string, ticketId?: string): OutboundMessage | undefined {
  if (!config.directMessages || !github) return
  const binding = config.notificationBindings.find(row => row.github.toLowerCase() === github.toLowerCase())
  if (!binding) return
  const trigger = lookup(feishuTriggerId(binding.messageId))
  if (!trigger || trigger.source !== SOURCE || !trigger.human || trigger.actor.source !== SOURCE
    || trigger.actor.id !== binding.openId || trigger.meta.direct !== true || trigger.meta.messageId !== binding.messageId
    || trigger.text.trim().toLowerCase() !== `notify github ${binding.github.toLowerCase()}`
    || trigger.channel?.source !== SOURCE || trigger.channel.address.direct !== 'true'
    || trigger.channel.address.messageId !== binding.messageId || trigger.channel.address.chatId !== trigger.meta.chatId
    || !/^oc_[A-Za-z0-9]+$/.test(trigger.channel.address.chatId ?? '')) return
  return { id: key('feishu-private-notice', eventId, binding.github.toLowerCase(), binding.openId, binding.messageId),
    channel: { ...trigger.channel, address: { ...trigger.channel.address, notification: 'true', github: binding.github,
      openId: binding.openId } }, text, kind: 'notice', ...(ticketId ? { ticketId } : {}) }
}
