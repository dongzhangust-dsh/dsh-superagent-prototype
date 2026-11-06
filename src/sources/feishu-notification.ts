/** Explicit, opt-in private Feishu notification bindings. */
import { key, latestReport, type OutboundMessage, type Ticket, type Trigger } from '../core/index.ts'
import type { FeishuConfig } from './feishu.ts'
import { feishuTriggerId, SOURCE } from './feishu-trigger.ts'

/** Select only meaningful state transitions; never include a report's private contents. */
export function feishuReportStatus(before: Ticket, after: Ticket): { id: string; text: string } | undefined {
  const previousReport = latestReport(before)
  const previous = previousReport?.state
  const report = latestReport(after)
  if (!report) return
  type PublicStatus = { reason?: string; next?: string }
  type NoticeReport = typeof report & { publicStatus?: PublicStatus; noticeSequence?: number }
  const currentStatus = report as NoticeReport
  const oldStatus = previousReport as NoticeReport | undefined
  const attention = after.attention && after.attention.id !== before.attention?.id
  const state = attention ? 'attention' : report.state === 'blocked' || report.state === 'failed' || report.state === 'ready'
    ? report.state : previous === 'blocked' || previous === 'failed' || (before.attention && !after.attention) ? 'resumed' : undefined
  // Resuming an ended ticket already queues a notice from ticket.resumed; its next progress report
  // must not queue a second recovery for the same transition.
  const alreadyResumed = state === 'resumed' && before.inputs.some(input => input.kind === 'resumed'
    && input.at >= (latestReport(before)?.at ?? ''))
  const detailsChanged = currentStatus.publicStatus?.reason !== oldStatus?.publicStatus?.reason
    || currentStatus.publicStatus?.next !== oldStatus?.publicStatus?.next
  if (!state || alreadyResumed || (!attention && state === previous && !detailsChanged)) return
  const text = { attention: 'needs your attention', blocked: 'is blocked', failed: 'encountered a failure',
    ready: 'is ready', resumed: 'has resumed' }[state]
  const issue = state === 'blocked' || state === 'failed' || state === 'attention'
  const reasons: Record<string, string> = { access: 'access', external_service: 'external service', test_failure: 'test failure', workspace: 'workspace', unknown: 'unknown' }
  const steps: Record<string, string> = { retry: 'Retry the operation', investigate: 'Investigate the issue', wait: 'Wait for the dependency',
    human_response: 'A person needs to respond', unknown: 'Check the assignment for the next step' }
  const reason = reasons[currentStatus.publicStatus?.reason ?? 'unknown'] ?? reasons.unknown
  const next = steps[currentStatus.publicStatus?.next ?? 'unknown'] ?? steps.unknown
  const assignment = after.assignments.findLast(item => item.report === report)
  return { id: key('report', after.id, assignment?.id ?? '', String(currentStatus.noticeSequence ?? report.at), state),
    text: issue ? `${text}.\nReason category: ${reason}.\nNext step: ${next}` : text }
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
