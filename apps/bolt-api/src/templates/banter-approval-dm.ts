// ---------------------------------------------------------------------------
// Banter approval DM template
// ---------------------------------------------------------------------------
//
// Wave 3.2 deliverable: a reusable Bolt automation template that sends a
// Banter DM to an approver whenever an approval is requested. This template
// replaces the original design's bespoke "approval DM" flow in banter-api
// with a Bolt-driven automation that anyone can clone and customize from
// the Bolt template gallery.
//
// The trigger event `approval.requested` is registered in the catalog
// (apps/bolt-api/src/services/event-catalog.ts, source `platform`) and
// emitted by the platform POST /v1/approvals producer at
// apps/api/src/routes/approval.routes.ts. Any other subsystem that needs
// to request approval (Brief publish-request, Bond deal-close sign-off,
// Bill invoice approval, etc.) should call that route rather than emit
// the event directly, so the payload shape stays consistent.
//
// Parameter templating uses the same `{{ event.<field> }}` style as the
// other templates in template.service.ts. The two fields consumed are:
//   - {{ event.approver.id }}  -> banter_send_dm to_user_id
//   - {{ event.body }}         -> banter_send_dm content

import type { AutomationTemplate } from '../services/template.service.js';

export const banterApprovalDmTemplate: AutomationTemplate = {
  id: 'tpl_banter_approval_dm',
  name: 'Send approval request DM',
  description:
    'When an approval is requested, send a Banter DM to the approver with the approval details. Works for any subsystem that emits approval.requested events (Brief publish-requests, Bond deal sign-offs, Bill invoice approvals, etc.).',
  category: 'notifications',
  trigger_source: 'platform',
  trigger_event: 'approval.requested',
  conditions: [
    {
      sort_order: 0,
      field: 'event.approver.id',
      operator: 'is_not_empty',
      value: null,
      logic_group: 'and',
    },
  ],
  actions: [
    {
      sort_order: 0,
      mcp_tool: 'banter_send_dm',
      parameters: {
        to_user_id: '{{ event.approver.id }}',
        content: '{{ event.body }}',
      },
      on_error: 'continue',
    },
  ],
};
