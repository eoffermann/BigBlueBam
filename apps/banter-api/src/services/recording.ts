import { RoomServiceClient, EgressClient, EncodedFileOutput, EncodedFileType } from 'livekit-server-sdk';
import { env } from '../env.js';

let roomClient: RoomServiceClient | null = null;
let egressClient: EgressClient | null = null;

function getRoomClient(): RoomServiceClient {
  if (!roomClient) {
    if (!env.LIVEKIT_HOST || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
      throw new Error('LiveKit is not configured');
    }
    roomClient = new RoomServiceClient(env.LIVEKIT_HOST, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  }
  return roomClient;
}

function getEgressClient(): EgressClient {
  if (!egressClient) {
    if (!env.LIVEKIT_HOST || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
      throw new Error('LiveKit is not configured');
    }
    egressClient = new EgressClient(env.LIVEKIT_HOST, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  }
  return egressClient;
}

/**
 * Start recording a room to a file.
 * Returns the egress ID for tracking.
 */
export async function startRecording(roomName: string, outputPrefix: string): Promise<string> {
  const egress = getEgressClient();
  const output = new EncodedFileOutput({
    filepath: `${outputPrefix}/{room_name}-{time}.mp4`,
    fileType: EncodedFileType.MP4,
    // For S3/MinIO storage, configure s3 output:
    output: {
      case: 's3',
      value: {
        bucket: env.S3_BUCKET,
        region: env.S3_REGION,
        // Optional since issue #159 (no default credentials); egress fails loudly without them.
        accessKey: env.S3_ACCESS_KEY ?? '',
        secret: env.S3_SECRET_KEY ?? '',
        endpoint: env.S3_ENDPOINT,
        forcePathStyle: true, // Required for MinIO
      },
    },
  });

  const info = await egress.startRoomCompositeEgress(roomName, { file: output });
  return info.egressId;
}

/**
 * Stop an active recording.
 */
export async function stopRecording(egressId: string): Promise<void> {
  const egress = getEgressClient();
  await egress.stopEgress(egressId);
}

/**
 * List active rooms (for monitoring).
 */
export async function listActiveRooms(): Promise<{ name: string; numParticipants: number }[]> {
  const client = getRoomClient();
  const rooms = await client.listRooms();
  return rooms.map((r) => ({
    name: r.name,
    numParticipants: r.numParticipants,
  }));
}

/**
 * Remove a participant from a room (kick).
 */
export async function removeParticipant(roomName: string, participantIdentity: string): Promise<void> {
  const client = getRoomClient();
  await client.removeParticipant(roomName, participantIdentity);
}
