# Notification validation and rollback

These steps are for an operator after a candidate has passed its required checks and been separately approved for deployment. They do not authorize changing the running service, stopping another assignment, or sending a message to someone else.

## Isolated verification

Run the type check and regression suite against the exact candidate revision in a separate checkout. Use fake GitHub and Feishu adapters and an isolated state directory; do not point tests at the running state. Cover delivery failure, retry, restart, duplicate transitions, permission revocation and independent channel outcomes. A simulated delivery is not a real Feishu receipt.

## Private binding

An administrator must independently verify that the GitHub account and Feishu open ID belong to the same consenting person. The person sends `notify github <login>` in a direct conversation with the configured bot. The Feishu source must receive direct messages. The administrator adds the verified GitHub login, Feishu open ID and that opt-in message ID to the Feishu source configuration's `notificationBindings` array. An empty array disables these cross-source notices. A binding is not evidence of permission to disclose private source content on GitHub.

To revoke a binding, remove its row from that array; turning off direct messages also prevents private delivery. Confirm that a queued notice is dropped after revocation, rather than sent to a different destination. Keep the existing source configuration and settings revision when editing settings, and do not change admission permissions merely to enable notifications.

## Controlled live check

Only after the operator has authorized a separate candidate deployment and identified a dedicated acceptance issue and their own bot conversation, trigger a known blocked state on that issue. Check that the source issue receives the correct status, category and next step, and that the opted-in private conversation receives the corresponding concise status. Record the revision, event, timestamps, source comment URL and delivery receipt identifiers without copying private conversation content into GitHub. Repeat with one destination temporarily unavailable in an isolated environment to confirm that the other destination is independent. Do not use an unrelated issue, group or person's account.

## Rollback

Before any approved switch, record the exact running revision and configuration and preserve in-flight ticket state and workspaces. If the candidate misroutes or duplicates messages, first remove the affected binding or disable the notification path using the approved operational procedure; inspect pending and failed receipts. Restore the recorded revision only during a separately coordinated service window, retaining the state database and other workers' directories. Verify the running revision and service health after rollback. Do not delete or replay queued messages without first inspecting their destination and delivery status.
