/**
 * bastion-export-packet (Bastion spec 7, 7.2; M9): build one audit packet as a streamed zip in
 * Bastion's own bucket.
 *
 * This is the ONLY worker job that touches the Bastion bucket directly. It builds its driver from
 * the shared S3_* credentials and BASTION_S3_BUCKET, never S3_BUCKET (createBastionPacketStorage),
 * so a packet can never land in the shared uploads bucket where /files/* could serve it.
 *
 * What goes in the packet is decided by bastion-api (the export-packet engine's `claim`), with the
 * same rules as the auditor room. The personal-data commitments are checked by bastion-api's
 * verify-commitments engine: the worker never holds BASTION_PD_HMAC_KEY.
 *
 * Contents: manifest.json (file fingerprints, every seal with every public key, restore notices,
 * commitment results), controls.csv / controls.jsonl, evidence/*.json, uploaded/* (selected
 * manual files), attestations.csv, exceptions.csv, drift.csv, statement_of_applicability.csv (ISO)
 * and summary.pdf. The zip is streamed (jszip generateNodeStream with streamFiles) into a single
 * `put`; each evidence object is opened only when the zip reaches it, so memory stays flat.
 * Progress lines per stage (spec 7.1): collecting, checking names, writing evidence n/N,
 * rendering summary, zipping, uploading.
 */
import { createHash, randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  createBootstrapDriver,
  isStorageNotFoundError,
  StorageTimeoutError,
  type StorageDriver,
  withStorageTimeout,
} from '@bigbluebam/storage';
import {
  bastionPacketClaimSchema,
  bastionVerifyCommitmentsResultSchema,
  toCsv,
  type BastionCommitmentResult,
  type BastionExportPacketJobData,
  type BastionPacketContents,
  type BastionPacketStage,
} from '@bigbluebam/shared';
import { sanitizeForWinAnsi } from './bill-pdf-generate.job.js';
import { bodyData, parseContract, postBastion } from './bastion-shared.js';

export interface PacketStorageEnv {
  S3_ENDPOINT: string;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
  S3_REGION: string;
  BASTION_S3_BUCKET: string;
}

/** The Bastion bucket, with the shared credentials (spec 7): BASTION_S3_BUCKET, never S3_BUCKET. */
export function createBastionPacketStorage(env: PacketStorageEnv): StorageDriver {
  return createBootstrapDriver({
    S3_ENDPOINT: env.S3_ENDPOINT,
    S3_REGION: env.S3_REGION,
    S3_BUCKET: env.BASTION_S3_BUCKET,
    S3_ACCESS_KEY: env.S3_ACCESS_KEY,
    S3_SECRET_KEY: env.S3_SECRET_KEY,
  });
}

export interface PacketJobDeps {
  post: typeof postBastion;
  storage: StorageDriver;
  /** Minimum gap between progress calls (tests use 0). */
  progressEveryMs?: number;
  /** Evidence read bounds (tests shrink them). */
  readLimits?: PacketReadLimits;
  /** Upper bound on the whole zip upload; default sized from max_packet_bytes (tests shrink it). */
  uploadTimeoutMs?: number;
  /** Heartbeat while the upload runs, so a long build is not reaped (tests shrink it). */
  heartbeatEveryMs?: number;
}

/** The upload bound: at least 15 minutes, else the packet limit at 512 KB/s. */
export function packetUploadTimeoutMs(maxPacketBytes: number): number {
  return Math.max(15 * 60_000, Math.ceil(maxPacketBytes / (512 * 1024)) * 1000);
}

const FINISH_ATTEMPTS = 3;

const COMMITMENT_BATCH = 500;
const COMMITMENT_WORDS: Record<BastionCommitmentResult, string> = {
  intact: 'The recorded names still match.',
  pd_mismatch: 'The recorded names were changed after they were recorded.',
  key_changed: 'Recorded under an older key; cannot be compared.',
  redacted: 'The names were redacted on purpose.',
  no_personal_data: 'No names were recorded.',
};

class PacketTooLargeError extends Error {
  constructor(limit: number) {
    super(`The packet is larger than the ${Math.round(limit / (1024 * 1024))} MB limit in Settings. Pick a shorter period or leave out uploaded files.`);
    this.name = 'PacketTooLargeError';
  }
}

class ClaimLostError extends Error {
  constructor() {
    super('Another worker took over this packet.');
    this.name = 'ClaimLostError';
  }
}

interface ObjectOutcome {
  path: string;
  expected_sha256: string | null;
  sha256: string | null;
  bytes: number;
  status: 'written' | 'missing' | 'hash_mismatch' | 'redacted' | 'no_file';
}

/** Bounds on evidence reads (#311): opening an object, and silence in the middle of its body. */
export interface PacketReadLimits {
  openTimeoutMs: number;
  idleTimeoutMs: number;
}
export const PACKET_READ_LIMITS: PacketReadLimits = { openTimeoutMs: 30_000, idleTimeoutMs: 60_000 };

/** Evidence storage did not answer: the packet fails ("try again"), it never claims the file is missing. */
class EvidenceReadError extends Error {
  constructor(cause: Error) {
    super(`An evidence file could not be read: ${cause.message}`);
    this.name = 'EvidenceReadError';
  }
}

function destroyQuietly(s: unknown): void {
  try {
    (s as { destroy?: () => void } | null)?.destroy?.();
  } catch {
    /* already closed */
  }
}

/**
 * A stream that opens the bucket object only when the zip reaches its entry, hashes as it goes,
 * and reports how it went. Only an object that does not exist becomes the short "Evidence file
 * missing" note (spec 3.4: never hidden; recorded in the manifest). Any other read failure, an
 * open that takes longer than `openTimeoutMs`, or a body that goes quiet for `idleTimeoutMs`
 * fails the stream, and with it the packet (#311). Destroying the stream destroys the GET under
 * it, including one that only resolves afterwards, so no socket is left open.
 */
function lazyObject(
  storage: StorageDriver,
  key: string,
  limits: PacketReadLimits,
  done: (o: { missing: boolean; sha256: string | null; bytes: number }) => void,
): Readable {
  let started = false;
  let source: NodeJS.ReadableStream | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  const hash = createHash('sha256');
  let bytes = 0;
  const clearIdle = () => {
    if (idle) clearTimeout(idle);
    idle = null;
  };
  const armIdle = () => {
    clearIdle();
    idle = setTimeout(() => out.destroy(new EvidenceReadError(new StorageTimeoutError('read', limits.idleTimeoutMs))), limits.idleTimeoutMs);
  };
  const out = new Readable({
    read() {
      if (started) {
        if (source) armIdle();
        source?.resume();
        return;
      }
      started = true;
      const get = storage.getStream(key);
      withStorageTimeout('get', get, limits.openTimeoutMs).then(
        ({ stream }) => {
          if (out.destroyed) {
            destroyQuietly(stream);
            return;
          }
          source = stream;
          armIdle();
          stream.on('data', (chunk: Buffer | string) => {
            armIdle();
            const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
            hash.update(b);
            bytes += b.length;
            if (!out.push(b)) {
              // Waiting on the zip is not the storage's silence.
              clearIdle();
              stream.pause();
            }
          });
          stream.on('end', () => {
            clearIdle();
            done({ missing: false, sha256: hash.digest('hex'), bytes });
            out.push(null);
          });
          stream.on('error', (err: Error) => out.destroy(new EvidenceReadError(err)));
        },
        (err: Error) => {
          // A GET that resolves after its timeout is closed when it arrives.
          void get.then((r) => destroyQuietly(r.stream)).catch(() => undefined);
          if (out.destroyed) return;
          if (!isStorageNotFoundError(err)) {
            out.destroy(new EvidenceReadError(err));
            return;
          }
          done({ missing: true, sha256: null, bytes: 0 });
          out.push(Buffer.from('Evidence file missing\n'));
          out.push(null);
        },
      );
    },
    destroy(err, cb) {
      clearIdle();
      destroyQuietly(source);
      cb(err);
    },
  });
  return out;
}

/** A stream whose body is produced only when the zip reaches it (the manifest, written last). */
function lateBody(make: () => Buffer): Readable {
  let sent = false;
  return new Readable({
    read() {
      if (sent) return;
      sent = true;
      this.push(make());
      this.push(null);
    },
  });
}

function sha256(b: Buffer | string): string {
  return createHash('sha256').update(b).digest('hex');
}

/** summary.pdf: a cover page, then one page per control (spec 7.2). */
export async function renderSummaryPdf(c: BastionPacketContents): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const t = (s: string | null | undefined) => sanitizeForWinAnsi(s ?? '');
  const wrap = (s: string, max = 90) => {
    const words = t(s).split(/\s+/);
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > max) {
        if (cur) lines.push(cur);
        cur = w;
      } else cur = `${cur} ${w}`.trim();
    }
    if (cur) lines.push(cur);
    return lines;
  };
  const counts = new Map<string, number>();
  for (const ctl of c.controls) counts.set(ctl.state_words, (counts.get(ctl.state_words) ?? 0) + 1);
  const cover = pdf.addPage([612, 792]);
  let y = 720;
  cover.drawText(t(`${c.framework.name} audit packet`), { x: 50, y, size: 20, font: bold, color: rgb(0.1, 0.1, 0.3) });
  y -= 28;
  cover.drawText(t(`${c.organization_name}, ${c.packet.period_start} to ${c.packet.period_end}`), { x: 50, y, size: 12, font });
  y -= 18;
  cover.drawText(t(`Generated ${c.generated_at.slice(0, 10)}. ${c.controls.length} controls.`), { x: 50, y, size: 11, font });
  y -= 30;
  for (const [words, n] of counts) {
    cover.drawText(t(`${words}: ${n}`), { x: 60, y, size: 12, font });
    y -= 18;
  }
  y -= 20;
  for (const line of wrap('Bastion shows the evidence this organization collected. It is not an auditor and does not certify anything. Check the signed seals in manifest.json against the public keys listed there.')) {
    cover.drawText(line, { x: 50, y, size: 10, font, color: rgb(0.3, 0.3, 0.3) });
    y -= 14;
  }
  for (const n of c.restore_notices) {
    for (const line of wrap(n)) {
      cover.drawText(line, { x: 50, y, size: 10, font: bold, color: rgb(0.6, 0.1, 0.1) });
      y -= 14;
    }
  }
  for (const ctl of c.controls) {
    const page = pdf.addPage([612, 792]);
    let py = 730;
    page.drawText(t(ctl.title), { x: 50, y: py, size: 16, font: bold });
    py -= 24;
    page.drawText(t(ctl.state_words), { x: 50, y: py, size: 13, font: bold, color: ctl.state === 'met' ? rgb(0.1, 0.5, 0.2) : rgb(0.6, 0.2, 0.1) });
    py -= 20;
    for (const line of wrap(ctl.reason ?? '')) {
      page.drawText(line, { x: 50, y: py, size: 11, font });
      py -= 15;
    }
    py -= 6;
    page.drawText(t(`Requirements: ${ctl.requirement_codes.join(', ') || 'none'}`), { x: 50, y: py, size: 10, font });
    py -= 15;
    page.drawText(t(`Owner: ${ctl.owner ?? 'not set'}`), { x: 50, y: py, size: 10, font });
    py -= 15;
    page.drawText(t(`Last checked: ${ctl.last_evaluated_at ? ctl.last_evaluated_at.slice(0, 10) : 'never'}`), { x: 50, y: py, size: 10, font });
    py -= 15;
    const ev = c.evidence.filter((e) => e.control_key === ctl.control_key);
    page.drawText(t(`Evidence records in the period: ${ev.length}`), { x: 50, y: py, size: 10, font });
  }
  return Buffer.from(await pdf.save());
}

export async function processBastionExportPacketJob(job: Job<BastionExportPacketJobData>, logger: Logger, deps: PacketJobDeps): Promise<'succeeded' | 'failed' | 'skipped'> {
  const started = Date.now();
  const { organization_id, packet_id } = job.data;
  // Unique per attempt (#312): a stalled re-run of the same BullMQ job (same job id) is a
  // different claimant, so the claim fence separates it from a builder that is still alive.
  const claimant = `worker-packet:${job.id ?? packet_id}:${randomUUID()}`;
  const elapsed = () => Date.now() - started;
  const log = (stage: string, extra: Record<string, unknown> = {}) => logger.info({ packet_id, stage, elapsedMs: elapsed(), ...extra }, `bastion-export-packet: ${stage}`);
  const engine = (body: Record<string, unknown>, timeoutMs?: number) =>
    deps.post('/v1/internal/engines/export-packet', { organization_id, packet_id, claimant, ...body }, timeoutMs);

  log('collecting controls (asking bastion-api for the packet contents)');
  const claimRes = await engine({ action: 'claim' }, 120_000);
  if (!claimRes.ok) throw new Error(`bastion-export-packet: claim returned ${claimRes.status}`);
  const claim = parseContract(bastionPacketClaimSchema, bodyData(claimRes), 'export-packet claim');
  if (!claim.claimed || !claim.contents) {
    logger.info({ packet_id, status: claim.status, error: claim.error }, 'bastion-export-packet: not built (already done, taken, or refused)');
    return claim.status === 'failed' ? 'failed' : 'skipped';
  }
  const c = claim.contents;
  const limit = c.packet.max_packet_bytes;
  const readLimits = deps.readLimits ?? PACKET_READ_LIMITS;
  // Every evidence stream opened for this attempt, so a failure can close them all (#311).
  const opened: Readable[] = [];
  let zipStream: NodeJS.ReadableStream | null = null;
  let counted: PassThrough | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  // Once `finish` has been sent, whether it committed is unknown until it answers: from then on
  // this attempt never deletes its zip (the intent row and the object sweep handle a leftover).
  let finishSent = false;
  let lastProgress = 0;
  const progress = async (stage: BastionPacketStage, n: number, force = false) => {
    if (!force && Date.now() - lastProgress < (deps.progressEveryMs ?? 5_000)) return;
    lastProgress = Date.now();
    const r = await engine({ action: 'progress', stage, progress: n });
    const okBody = bodyData<{ ok?: boolean }>(r);
    if (r.ok && okBody?.ok === false) throw new ClaimLostError();
  };

  try {
    log('collected', { controls: c.controls.length, evidence: c.evidence.length, files: c.files.length, holders: c.holders.length });

    // Personal-data commitments, checked by bastion-api in batches (the key stays there).
    await progress('checking_commitments', 0, true);
    const commitments = new Map<string, BastionCommitmentResult>();
    for (let i = 0; i < c.holders.length; i += COMMITMENT_BATCH) {
      const batch = c.holders.slice(i, i + COMMITMENT_BATCH);
      const r = await deps.post('/v1/internal/engines/verify-commitments', { organization_id, holders: batch });
      if (!r.ok) throw new Error(`bastion-export-packet: verify-commitments returned ${r.status}`);
      const parsed = parseContract(bastionVerifyCommitmentsResultSchema, bodyData(r), 'verify-commitments result');
      for (const x of parsed.results) commitments.set(`${x.holder_kind}:${x.holder_id}`, x.result);
      log(`checking recorded names ${Math.min(i + COMMITMENT_BATCH, c.holders.length)}/${c.holders.length}`);
    }

    await progress('rendering_summary', 0, true);
    log('rendering summary');
    const summary = await renderSummaryPdf(c);

    const zip = new JSZip();
    const files: Array<{ path: string; sha256: string; bytes: number }> = [];
    const addText = (path: string, body: string | Buffer) => {
      const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
      files.push({ path, sha256: sha256(buf), bytes: buf.length });
      zip.file(path, buf);
    };
    // Formula-neutralized like every Bastion CSV (packages/shared/src/csv-safe.ts).
    addText(
      'controls.csv',
      toCsv(
        ['control', 'title', 'state', 'why', 'requirements', 'owner', 'last checked'],
        c.controls.map((x) => [x.control_key, x.title, x.state_words, x.reason ?? '', x.requirement_codes.join(' '), x.owner ?? '', x.last_evaluated_at ?? '']),
      ),
    );
    addText('controls.jsonl', c.controls.map((x) => JSON.stringify(x)).join('\n'));
    addText('attestations.csv', c.attestations_csv);
    addText('exceptions.csv', c.exceptions_csv);
    addText('drift.csv', c.drift_csv);
    if (c.soa_csv !== null) addText('statement_of_applicability.csv', c.soa_csv);
    addText('summary.pdf', summary);

    // Evidence and uploaded files, opened one at a time as the zip reaches them. A read failure
    // in any of them aborts the upload (jszip does not always surface an input's error).
    const track = (s: Readable): Readable => {
      opened.push(s);
      s.on('error', (err: Error) => counted?.destroy(err));
      return s;
    };
    const outcomes: ObjectOutcome[] = [];
    const totalObjects = c.evidence.length + c.files.length;
    let written = 0;
    const onObject = (o: ObjectOutcome) => {
      outcomes.push(o);
      written += 1;
      if (written % 50 === 0 || written === totalObjects) log(`writing evidence ${written}/${totalObjects}`);
      void progress('writing_evidence', written).catch((err: Error) => logger.warn({ packet_id, err: err.message }, 'bastion-export-packet: progress not recorded'));
    };
    for (const e of c.evidence) {
      if (e.redacted || !e.object_key) {
        zip.file(e.path, Buffer.from(e.redacted ? 'This evidence file was redacted.\n' : 'No evidence file was recorded.\n'));
        outcomes.push({ path: e.path, expected_sha256: e.content_sha256, sha256: null, bytes: 0, status: e.redacted ? 'redacted' : 'no_file' });
        continue;
      }
      zip.file(
        e.path,
        track(lazyObject(deps.storage, e.object_key, readLimits, (r) =>
          onObject({
            path: e.path,
            expected_sha256: e.content_sha256,
            sha256: r.sha256,
            bytes: r.bytes,
            status: r.missing ? 'missing' : r.sha256 === e.content_sha256 ? 'written' : 'hash_mismatch',
          }),
        )),
        { binary: true },
      );
    }
    for (const f of c.files) {
      if (f.redacted || !f.object_key) {
        zip.file(f.path, Buffer.from(f.redacted ? 'This file was redacted.\n' : 'No file was recorded.\n'));
        outcomes.push({ path: f.path, expected_sha256: f.content_sha256, sha256: null, bytes: 0, status: f.redacted ? 'redacted' : 'no_file' });
        continue;
      }
      zip.file(
        f.path,
        track(lazyObject(deps.storage, f.object_key, readLimits, (r) =>
          onObject({
            path: f.path,
            expected_sha256: f.content_sha256,
            sha256: r.sha256,
            bytes: r.bytes,
            status: r.missing ? 'missing' : !f.content_sha256 || r.sha256 === f.content_sha256 ? 'written' : 'hash_mismatch',
          }),
        )),
        { binary: true },
      );
    }

    // The manifest is the last entry and is produced when the zip reaches it, so it carries the
    // fingerprint and outcome of every object written before it.
    zip.file(
      'manifest.json',
      lateBody(() =>
        Buffer.from(
          JSON.stringify(
            {
              packet_id,
              organization: c.organization_name,
              framework: c.framework.name,
              period: { start: c.packet.period_start, end: c.packet.period_end },
              generated_at: c.generated_at,
              includes_restricted_evidence: c.packet.include_restricted,
              notice: 'Bastion shows the evidence this organization collected. It is not an auditor and does not certify anything.',
              files,
              evidence_files: outcomes.map((o) => ({ ...o, note: o.status === 'missing' ? 'Evidence file missing' : undefined })),
              seals: c.seals,
              public_keys: c.public_keys,
              seal_canonical_form:
                'signature = Ed25519 over canonical JSON (sorted keys, no whitespace) of {org, seal_date, epoch, head_seq, head_hash, signing_key_id}',
              restore_notices: c.restore_notices,
              personal_data_checks: c.holders.map((h) => {
                const result = commitments.get(`${h.holder_kind}:${h.holder_id}`) ?? 'pd_mismatch';
                return { holder_kind: h.holder_kind, holder_id: h.holder_id, result, meaning: COMMITMENT_WORDS[result] };
              }),
            },
            null,
            2,
          ),
        ),
      ),
    );

    await progress('writing_evidence', 0, true);
    log(`zipping and uploading ${totalObjects} evidence objects plus ${files.length + 1} generated files`);
    const hash = createHash('sha256');
    let size = 0;
    const upload = new PassThrough();
    counted = upload;
    const zs = zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 6 } });
    zipStream = zs;
    let tooLarge = false;
    let claimLost = false;
    zs.on('data', (chunk: Buffer) => {
      size += chunk.length;
      hash.update(chunk);
      if (size > limit && !tooLarge) {
        tooLarge = true;
        upload.destroy(new PacketTooLargeError(limit));
      }
    });
    zs.on('error', (err: Error) => upload.destroy(err));
    zs.pipe(upload);
    // Keep the lease alive through a long upload; a lost claim stops the upload (#311).
    heartbeat = setInterval(() => {
      void progress('writing_evidence', written, true).catch((err: Error) => {
        if (err instanceof ClaimLostError) {
          claimLost = true;
          upload.destroy(err);
        } else logger.warn({ packet_id, err: err.message }, 'bastion-export-packet: heartbeat not recorded');
      });
    }, deps.heartbeatEveryMs ?? 60_000);
    await withStorageTimeout(
      'put',
      deps.storage.put(c.packet.object_key, upload, { contentType: 'application/zip' }),
      deps.uploadTimeoutMs ?? packetUploadTimeoutMs(limit),
    );
    clearInterval(heartbeat);
    heartbeat = null;
    if (claimLost) throw new ClaimLostError();
    if (tooLarge) throw new PacketTooLargeError(limit);
    await progress('uploading', size, true);
    const digest = hash.digest('hex');
    const finishBody = { action: 'finish', object_key: c.packet.object_key, content_sha256: digest, size_bytes: size };
    finishSent = true;
    // finish is idempotent on (claimant, key, digest): a retry after a lost response finds its
    // own success. Only a definite "no" is a lost claim.
    let finishOk: boolean | null = null;
    for (let attempt = 1; attempt <= FINISH_ATTEMPTS && finishOk === null; attempt++) {
      try {
        const fin = await engine(finishBody);
        if (fin.ok) finishOk = bodyData<{ ok?: boolean }>(fin)?.ok !== false;
        else if (fin.status >= 400 && fin.status < 500) finishOk = false;
      } catch (err) {
        logger.warn({ packet_id, attempt, err: (err as Error).message }, 'bastion-export-packet: finish did not answer; asking again');
      }
    }
    if (finishOk === null) throw new Error('bastion-api did not answer the finish call');
    if (!finishOk) {
      // A definite no: this attempt's key is referenced by nothing, so it may go.
      finishSent = false;
      throw new ClaimLostError();
    }
    const missing = outcomes.filter((o) => o.status === 'missing').length;
    logger.info(
      { packet_id, size_bytes: size, objects: totalObjects, missing, elapsedMs: elapsed() },
      `bastion-export-packet: done (${Math.round(size / 1024)} KB, ${totalObjects} objects, ${missing} missing)`,
    );
    return 'succeeded';
  } catch (err) {
    // Close every open evidence GET and the zip pipeline (#311).
    if (heartbeat) clearInterval(heartbeat);
    for (const s of opened) destroyQuietly(s);
    destroyQuietly(zipStream);
    destroyQuietly(counted);
    // Only this attempt's own key is ever deleted (#312), and never once finish may have
    // committed: then the row may point at it, and the intent row lets the sweep decide.
    const dropOwnZip = async () => {
      if (finishSent) return;
      await withStorageTimeout('delete', deps.storage.delete(c.packet.object_key), readLimits.openTimeoutMs).catch(() => undefined);
    };
    if (err instanceof ClaimLostError) {
      logger.warn({ packet_id }, 'bastion-export-packet: the claim moved to another worker; stopping');
      await dropOwnZip();
      return 'skipped';
    }
    const plain =
      err instanceof PacketTooLargeError
        ? err.message
        : 'The packet could not be built because evidence storage or bastion-api did not answer. Try building it again.';
    logger.error({ packet_id, err: (err as Error).message, elapsedMs: elapsed() }, 'bastion-export-packet: failed');
    await dropOwnZip();
    const r = await engine({ action: 'fail', error: plain }).catch(() => null);
    if (!r?.ok) throw err;
    return 'failed';
  }
}
