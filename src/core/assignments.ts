/** What the Executor and its workers report about the Assignments that run tickets. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, liveTicket, runningAssignment, waitsForPerson } from './model.ts'
import type { PublicStatus, ReportState, Ticket } from './model.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Replies } from './replies.ts'
import { automatic, type Tickets } from './tickets.ts'

/** What an Assignment reports: a worker's report, or the Executor's own (`waiting` after an idle turn, `failed` after an error). */
export interface WorkerReport {
  state: ReportState
  summary: string
  /** Public, bounded status classifications; never put report text or logs in these fields. */
  publicStatus?: PublicStatus
  /** The worker explicitly designates this question for publication to its original source. */
  publicQuestion?: boolean
  /** Open question for a person: a string asks it, `null` clears an open one, and `undefined` keeps the current one. */
  question?: string | null
  /** The person's message whose request raised the question; routes the question to the channel where it was written. */
  askedBy?: string
  /** The person's question this report answers, which the worker thereby takes up; authorizes the main Session to send an answer reply. */
  answers?: string
}
const RECOVERY_NOTE = 'The host restarted during this ticket. Inspect the current worktree, git history and GitHub state before continuing. Do not repeat an already completed external operation. Finish the original assignment and report its status.'

/**
 * Assignments records what the Executor and its workers report about the Assignments that run tickets: one started, Inputs
 * reached it or failed to, its worker's Session took Inputs into a step, a turn of its worker ended, a host restart
 * interrupted it, and a worker's report with its question for a person. It depends on
 * Tickets to restart or end a ticket and on Replies to withdraw a question a report replaced; the Engine routes the
 * Executor's lifecycle callbacks and its workers' reports here.
 */
export class Assignments extends EnginePart {
  constructor(options: EngineOptions, private readonly tickets: Tickets, private readonly replies: Replies) { super(options) }

  /** Marks a non-ended assignment running, queues delivery of waiting undelivered inputs on an open ticket, and emits `assignment.started`. */
  started(ticketId: string, assignmentId: string): void {
    const ticket = this.require(ticketId)
    const assignment = ticket.assignments.find(item => item.id === assignmentId)
    if (!assignment || assignment.state === 'ended') return
    assignment.state = 'running'; assignment.startedAt ??= this.now()
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    if (liveTicket(ticket) && ticket.undelivered.length) this.options.executor.deliver(ticket, assignment)
    this.emit('assignment.started', { ticketId, assignmentId })
  }
  /**
   * Marks `inputIds` delivered on the ticket's running assignment and clears any prior `delivery` failure; ignored if no
   * longer running. Its worker reads each once its Session takes it into a step (see `read`).
   */
  delivered(ticketId: string, assignmentId: string, inputIds: string[]): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    ticket.undelivered = ticket.undelivered.filter(id => !inputIds.includes(id)); ticket.updatedAt = this.now()
    runningAssignment(ticket)!.deliveredAt = ticket.updatedAt
    for (const input of ticket.inputs) {
      if (input.kind === 'trigger' && inputIds.includes(input.id)) { input.readAt ??= null; input.deliveredTo = assignmentId }
    }
    delete ticket.delivery
    this.repo.tickets.save(ticket)
  }
  /** Records when the worker's Session of an open ticket took `inputIds` into a step, from which its model reads them. */
  read(ticketId: string, inputIds: string[]): void {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) return
    for (const input of ticket.inputs) if (input.kind === 'trigger' && inputIds.includes(input.id)) input.readAt ||= this.now()
    this.repo.tickets.save(ticket)
  }
  turnEnded(ticketId: string, assignmentId: string): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    runningAssignment(ticket)!.idleAt = this.now()
    this.repo.tickets.save(ticket)
  }
  deliveryFailed(ticketId: string, assignmentId: string, error: string): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    ticket.delivery = { error: error.slice(0, 300), at: this.now() }
    this.repo.tickets.save(ticket)
  }
  /**
   * Handles a running assignment interrupted by a host restart: restarts it with a recovery note unless its latest report is
   * `waiting`, `ready`, `blocked`, or `failed` and no input was delivered after that report, in which case it keeps its
   * session and flushes any waiting undelivered inputs.
   */
  interrupted(ticketId: string, assignmentId: string): void {
    const ticket = this.running(ticketId, assignmentId)
    const running = ticket && runningAssignment(ticket)
    if (!ticket || !running) return
    const report = running.report
    const busy = !!running.deliveredAt && !!report && running.deliveredAt >= report.at
    const settled = !!report && ['waiting', 'ready', 'blocked', 'failed'].includes(report.state) && !busy
    if (!settled) this.tickets.restart(ticket, running, 'hostRestarted', RECOVERY_NOTE)
    else if (ticket.undelivered.length) this.options.executor.deliver(ticket, running)
  }
  /**
   * Records a worker status report on an open ticket's current assignment, updating `attention`, `answers`, held automated
   * inputs, and ending the ticket when `dropped` or when `ready` and not waiting on followed threads (`followsDone`).
   * @throws UserError for an unknown or ended ticket, an ended assignment, a question combined with a ready result or answer,
   * or a question/answer referencing a non-human or unreached trigger.
   */
  report(ticketId: string, report: WorkerReport): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    if (report.question && (report.state === 'ready' || report.answers)) throw new UserError('questionWithResult')
    if (report.askedBy && !report.question) throw new UserError('askerWithoutQuestion')
    const person = (id: string, channel: boolean) => {
      const trigger = this.repo.triggers.get(id)
      return !!trigger?.human && (!channel || !!trigger.channel) && this.reaches(ticket, trigger, false)
    }
    if (report.askedBy && !person(report.askedBy, true)) throw new UserError('notAsker')
    if (report.answers && !person(report.answers, false)) throw new UserError('notAnswerable')
    const assignment = runningAssignment(ticket) ?? latestAssignment(ticket)
    if (!assignment) throw new UserError('unknownAssignment')
    if (assignment.state === 'ended') throw new UserError('assignmentEnded')
    const at = this.now()
    const priorReport = assignment.report
    const priorStatus = priorReport
    const precedingReport = priorReport ?? ticket.assignments.slice(0, -1).reverse().find(item => item.report)?.report
    const wasWaiting = waitsForPerson(ticket)
    const previous = ticket.attention
    const ask = (question: string) => ({ id: key('attention', ticketId, question, at, previous?.id ?? ''), question, ...(report.askedBy ? { triggerId: report.askedBy } : {}) })
    const asked = report.question && (report.question !== previous?.question || report.askedBy !== previous?.triggerId) ? ask(report.question) : previous
    const attention = report.question === null || report.state === 'ready' ? undefined : asked
    if (attention) ticket.attention = attention
    else delete ticket.attention
    // A replaced or cleared attention question withdraws any pending unsent reply for the previous question from the outbox.
    if (previous && previous.id !== attention?.id) this.replies.withdrawAttention(previous.id)
    const signature = key(report.state, attention?.id ?? '', report.publicStatus?.reason ?? 'unknown', report.publicStatus?.next ?? 'unknown')
    const issue = report.state === 'blocked' || report.state === 'failed'
    const recovered = report.state === 'progress' && (precedingReport?.state === 'blocked' || precedingReport?.state === 'failed')
    const notify = (issue && (priorStatus?.noticeSignature !== signature || !wasWaiting)) || recovered
      || (report.state === 'ready' && priorStatus?.noticeSignature !== signature)
    const sequence = (priorStatus?.noticeSequence ?? 0) + (notify ? 1 : 0)
    // The sequence survives restarts and distinguishes repeated transitions even when the clock does not advance.
    assignment.report = { state: report.state, summary: report.summary, at, noticeSequence: sequence,
      ...(report.publicStatus ? { publicStatus: report.publicStatus } : {}),
      ...(notify ? { noticeSignature: signature } : priorStatus?.noticeSignature ? { noticeSignature: priorStatus.noticeSignature } : {}) }
    ticket.updatedAt = at
    if (report.answers && !ticket.answers?.includes(report.answers)) ticket.answers = [...ticket.answers ?? [], report.answers]
    if (report.answers) this.takeUp(ticketId, report.answers)
    if (report.state === 'blocked' || report.state === 'failed') ticket.undelivered = ticket.undelivered.filter(id => !automatic(ticket.inputs.find(input => input.id === id)))
    this.repo.tickets.save(ticket)
    const source = this.source(ticket)
    const channel = source?.channel
    // Feishu group conversations are not authorized for unsolicited status messages.
    const allowed = channel?.source !== 'feishu' || (source?.source === 'feishu' && source.meta.direct === true && channel.address.direct === 'true')
    // Only an explicitly source-facing question addressed to the original human may share the attention reply key.
    // Keeping that key preserves withdrawal and lets the existing supervisor reply reuse the queued question.
    const publicQuestion = !!(report.publicQuestion && report.question && attention && source?.human && channel && allowed
      && source.source === channel.source && (!attention.triggerId || attention.triggerId === source.id))
    if (publicQuestion && attention && channel) {
      const fallback = key('attention-unverified', attention.id)
      if (this.options.outbox.status(fallback)) this.options.outbox.withdraw(fallback)
      const prefix = channel.source === 'github' ? 'This is by an automated agent, not a human.\n\n' : ''
      this.options.outbox.send({ id: key('attention-reply', attention.id), channel, text: prefix + attention.question, kind: 'reply', ticketId })
    } else if (report.state === 'progress' && report.question && attention && source?.human && channel && allowed
      && source.source === channel.source && (!attention.triggerId || attention.triggerId === source.id)
      && !this.options.outbox.status(key('attention-reply', attention.id))) {
      const prefix = channel.source === 'github' ? 'This is by an automated agent, not a human.\n\n' : ''
      this.options.outbox.send({ id: key('attention-unverified', attention.id), channel,
        text: prefix + 'A human decision is needed. The specific question needs verification; reply here to follow up.', kind: 'notice', ticketId })
    }
    // Worker summaries and logs are never copied into automatic notices; only fixed classifications are sent.
    if (notify) {
      if (channel && allowed) {
        const prefix = channel.source === 'github' ? 'This is by an automated agent, not a human.\n\n' : ''
        const status = report.state === 'blocked' ? 'The assignment is blocked.' : report.state === 'failed' ? 'The assignment failed.'
          : report.state === 'ready' ? 'The assignment is ready.' : 'Work on the assignment has resumed.'
        const reasons: Record<string, string> = { access: 'access', external_service: 'external service', test_failure: 'test failure', workspace: 'workspace', unknown: 'unknown' }
        const steps: Record<string, string> = { retry: 'Retry the operation.', investigate: 'Investigate the issue.', wait: 'Wait for the dependency.',
          human_response: 'A person needs to respond.', unknown: 'Check the assignment for the next step.' }
        // Older workers may report a question without marking it safe for the source. Give a
        // useful next step without guessing at, or publishing, the question's private content.
        const next = report.publicStatus?.next ?? 'unknown'
        const questionFallback = attention && !publicQuestion ? '\nThe specific question needs verification; reply here to follow up.' : ''
        const details = issue ? `\nReason category: ${reasons[report.publicStatus?.reason ?? 'unknown'] ?? 'unknown'}.\n`
          + `Human question: ${attention ? 'reported' : 'not reported'}.${questionFallback}\nNext step: ${steps[next] ?? steps.unknown}` : ''
        this.options.outbox.send({ id: key('assignment-status', assignment.id, String(sequence)),
          channel, text: prefix + status + details, kind: 'notice', ticketId })
      }
    }
    // A ticket that follows Threads ends with them: a ready report ends it only once followsDone holds, with that outcome.
    const ready = !ticket.follows?.length ? 'completed' : this.tickets.followsDone(ticket)?.outcome
    // A dropped report after a close the ticket deferred ends it as the close did, which its final notice tells.
    const outcome = report.state === 'dropped' ? this.tickets.followsDone(ticket)?.outcome ?? 'dropped' : report.state === 'ready' ? ready : undefined
    if (outcome) this.tickets.end(ticketId, 'executor', outcome, at)
    return this.require(ticketId)
  }
  /** The ticket, while it is open and `assignmentId` runs it. */
  private running(ticketId: string, assignmentId: string): Ticket | undefined {
    const ticket = this.require(ticketId)
    return liveTicket(ticket) && runningAssignment(ticket)?.id === assignmentId ? ticket : undefined
  }
}
