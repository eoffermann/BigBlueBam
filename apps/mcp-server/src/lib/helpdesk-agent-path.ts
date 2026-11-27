/**
 * Every MCP tool that reads or answers helpdesk tickets acts as a support
 * agent, so it calls helpdesk-api's agent surface (mounted at
 * /helpdesk/agents). That surface accepts the caller's Bam API key as
 * `Authorization: Bearer bbam_...` (#339); the customer routes under
 * /helpdesk/tickets accept only a customer's helpdesk_session cookie and
 * must never be called from a tool.
 *
 * `helpdeskAgentPath('/tickets/search')` -> '/helpdesk/agents/tickets/search'.
 */
export const HELPDESK_AGENT_BASE = '/helpdesk/agents';

export function helpdeskAgentPath(path: string): string {
  return `${HELPDESK_AGENT_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}
