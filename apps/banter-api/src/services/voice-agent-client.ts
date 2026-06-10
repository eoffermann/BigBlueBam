/**
 * Voice-agent client — DEPRECATED (Phase 2 unified-LiveKit cleanup).
 *
 * The Banter-internal call lifecycle (banter_calls rows, livekit_room_name
 * column, invite-agent route) has been retired in favor of the suite-wide
 * Bureau docked-box. A voice agent now lives inside a bureau-managed room
 * named `huddle-banter-{channel_id}` (or any other `huddle-{app}-{id}`)
 * and does not need to know about a banter_calls.id.
 *
 * The remaining surface on this file is still used by:
 *   • The MCP voice-agent tools (if any) that drive spawn/despawn directly.
 *   • Any internal scripts that need to talk to the voice-agent service.
 *
 * `spawnAgent` now accepts an optional `room_name` (which is the canonical
 * bureau room name) and an optional `call_id` for legacy callers. New
 * callers should pass `room_name` only; the voice-agent service joins
 * that LiveKit room and synthesizes a participant.
 *
 * No callers inside banter-api remain after the call.routes.ts rewrite.
 * Keep this file until the voice-agent service migrates its spawn API.
 */

import { env } from '../env.js';

export interface SpawnAgentOptions {
  /**
   * Legacy banter_calls.id. Optional for bureau-managed rooms: the agent
   * does not need to know about a Banter-side call row. The voice-agent
   * service uses this as a correlation key only.
   */
  call_id?: string;
  mode: string;
  /**
   * Canonical room name to join. For bureau-managed flows pass the
   * `huddle-{app}-{surface_id}` name; the voice-agent service joins
   * that LiveKit room and does not look up any banter_calls row.
   */
  room_name?: string;
  config?: Record<string, unknown>;
}

export interface AgentInfo {
  agent_id: string;
  status: string;
}

export interface AgentsListResponse {
  agents: Record<string, { status: string; mode: string }>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${env.VOICE_AGENT_URL}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Voice agent request failed: ${res.status} ${text}`);
  }

  return res.json() as Promise<T>;
}

/**
 * @deprecated Use the Bureau docked-box's spawn flow for new code. This
 * client still works for legacy callers and tests.
 */
export async function spawnAgent(opts: SpawnAgentOptions): Promise<AgentInfo> {
  return request<AgentInfo>('/agents/spawn', {
    method: 'POST',
    body: JSON.stringify({
      // The voice-agent service still requires a non-empty correlation
      // id; for bureau-managed rooms we fall back to the room name so the
      // server can disambiguate concurrent agents in the same room.
      call_id: opts.call_id ?? opts.room_name ?? `bureau:${crypto.randomUUID()}`,
      mode: opts.mode,
      room_name: opts.room_name,
      config: opts.config,
    }),
  });
}

/** @deprecated See `spawnAgent`. */
export async function despawnAgent(agentId: string): Promise<{ status: string }> {
  return request<{ status: string }>(`/agents/${agentId}/despawn`, {
    method: 'POST',
  });
}

/** @deprecated See `spawnAgent`. */
export async function listAgents(): Promise<AgentsListResponse> {
  return request<AgentsListResponse>('/agents');
}

export async function healthCheck(): Promise<{ status: string; agents: number }> {
  return request<{ status: string; agents: number }>('/health');
}
