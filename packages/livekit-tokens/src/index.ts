/**
 * @bigbluebam/livekit-tokens
 *
 * Thin wrapper around livekit-server-sdk's AccessToken that enforces the
 * shared Bam conventions for room name format, grant defaults, and token
 * lifetime. Wave 2 plans for Board, Banter, and any other conferencing
 * consumers switch their local token minting over to this helper so the
 * contract stays in one place.
 */
import { AccessToken, type VideoGrant } from 'livekit-server-sdk';

export interface MintRoomTokenOptions {
  /**
   * LiveKit API key. Required. Usually sourced from the service's env
   * (LIVEKIT_API_KEY).
   */
  apiKey: string;
  /**
   * LiveKit API secret. Required. Never log this value.
   */
  apiSecret: string;
  /**
   * Stable participant identity. Must be unique per concurrent join - the
   * LiveKit SFU uses this as the primary key for the participant record.
   */
  participantIdentity: string;
  /**
   * Display name visible to other participants. Optional; falls back to
   * the identity when omitted.
   */
  participantName?: string;
  /**
   * Fully-qualified room name. Callers are responsible for namespacing
   * (e.g. `banter_<org>_<channel>_<call>` or
   * `board_<org>_<board>`). This package does not enforce a format so
   * every consuming app can keep its historical shape.
   */
  roomName: string;
  /**
   * Video/audio grants. Defaults are permissive (join, publish, subscribe,
   * publish data). Callers can tighten them per participant role.
   */
  grants?: Partial<VideoGrant>;
  /**
   * Token lifetime in seconds. Defaults to 3600 (1 hour).
   */
  ttlSeconds?: number;
  /**
   * Free-form metadata attached to the participant. Must be JSON-safe;
   * LiveKit surfaces it to other participants, so never include secrets.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Mint a short-lived LiveKit access token for a participant joining a
 * specific room. Returns the encoded JWT ready to hand to the client.
 *
 * This is a thin wrapper so consumers can switch between identity
 * providers and grant defaults without touching the SDK import site.
 */
export async function mintRoomToken(opts: MintRoomTokenOptions): Promise<string> {
  if (!opts.apiKey || !opts.apiSecret) {
    throw new Error('mintRoomToken: apiKey and apiSecret are required');
  }
  if (!opts.participantIdentity) {
    throw new Error('mintRoomToken: participantIdentity is required');
  }
  if (!opts.roomName) {
    throw new Error('mintRoomToken: roomName is required');
  }

  const token = new AccessToken(opts.apiKey, opts.apiSecret, {
    identity: opts.participantIdentity,
    name: opts.participantName ?? opts.participantIdentity,
    ttl: opts.ttlSeconds ?? 3600,
    metadata: opts.metadata ? JSON.stringify(opts.metadata) : undefined,
  });

  const grants: VideoGrant = {
    room: opts.roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    ...(opts.grants ?? {}),
  };
  token.addGrant(grants);

  return token.toJwt();
}

export type { VideoGrant };
