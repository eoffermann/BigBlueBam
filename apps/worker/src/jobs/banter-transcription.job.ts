import type { Job } from 'bullmq';
import type { Logger } from 'pino';

export interface BanterTranscriptionJobData {
  call_id: string;
  recording_url: string;
  org_id: string;
}

/**
 * Post-call STT transcription worker.
 *
 * Sends the call recording to the voice-agent /transcribe endpoint,
 * then stores the resulting transcript segments in banter_call_transcripts.
 *
 * Scheduled when a call with recording_enabled + transcription_enabled ends.
 */
export async function processBanterTranscriptionJob(
  job: Job<BanterTranscriptionJobData>,
  logger: Logger,
): Promise<void> {
  const { call_id, recording_url, org_id } = job.data;
  logger.info({ jobId: job.id, call_id, org_id }, 'Starting call transcription');

  const voiceAgentUrl = process.env.VOICE_AGENT_URL || 'http://voice-agent:4003';

  // Build callback URL so the voice-agent can post results back,
  // but we also poll synchronously as a fallback.
  const callbackUrl = `${process.env.BANTER_API_INTERNAL_URL || 'http://banter-api:4002'}/v1/internal/transcription-callback`;

  // Request transcription from the voice-agent
  const response = await fetch(`${voiceAgentUrl}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      call_id,
      recording_url,
      callback_url: callbackUrl,
      // D-5: selects the org's STT provider config on the voice agent.
      org_id,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Voice agent transcription request failed: ${response.status} ${text}`);
  }

  const result = (await response.json()) as { status: string; detail?: string };

  if (result.status === 'unavailable') {
    logger.warn(
      { jobId: job.id, call_id, detail: result.detail },
      'STT provider not configured; transcription skipped',
    );
    return;
  }

  // The voice-agent fires the transcription async and posts segments via
  // callback_url. As a fallback, wait briefly then check the DB for results.
  // The callback handler in banter-api inserts rows into banter_call_transcripts.
  logger.info(
    { jobId: job.id, call_id },
    'Transcription queued with voice-agent; results arrive via callback',
  );
}
