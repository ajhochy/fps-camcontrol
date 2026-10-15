// Static single-process FFmpeg session: one source/encoder -> tee -> {local MP4, fifo -> FLV/RTMP publisher}.
// Developer proof helpers only (issue #66); no app code imports this module.
export type TeeSession = {
  width: number; height: number; fps: number; seconds: number;
  recordingPath: string; publishUrl: string;
  queueSize?: number;              // fifo queue_size in packets (video+audio)
  dropOnOverflow?: boolean;        // fifo drop_pkts_on_overflow
  recoveryWaitSeconds?: number;    // fifo recovery_wait_time
  recordingOnFail?: 'abort' | 'ignore';
  rwTimeoutMicros?: number;        // tcp write timeout inside the fifo slave, 0/undefined = none
  sendBufferBytes?: number;        // tcp SO_SNDBUF for the publisher connection, undefined = OS default
  toneLeftHz?: number; toneRightHz?: number;
};
const UNSAFE = /[\[\]|:\\'",=\s]/;
const LOCAL_PUBLISH = /^rtmp:\/\/127\.0\.0\.1:\d+\/[\w/]+$/;

/** The tee slave list shared by every session shape: recording slave 0 first, publisher behind a fifo that never blocks the tee. */
export function teeMuxSpec(s: Pick<TeeSession, 'recordingPath' | 'publishUrl' | 'queueSize' | 'dropOnOverflow' | 'recoveryWaitSeconds' | 'recordingOnFail' | 'rwTimeoutMicros' | 'sendBufferBytes'>): string {
  if (UNSAFE.test(s.recordingPath)) throw new Error('Recording path contains tee-reserved characters');
  if (!LOCAL_PUBLISH.test(s.publishUrl)) throw new Error('Proof publishers may only target a local 127.0.0.1 endpoint');
  const queue = s.queueSize ?? 60;
  const recording = ['f=mp4', 'movflags=+frag_keyframe+hybrid_fragmented', 'flush_packets=1', `onfail=${s.recordingOnFail ?? 'ignore'}`].join(':');
  // Protocol options ride the fifo slave's format_opts (tee-escaped: '=' -> \\=, ':' -> \\:).
  const protocolOpts = [...(s.rwTimeoutMicros ? [`rw_timeout\\=${s.rwTimeoutMicros}`] : []), ...(s.sendBufferBytes ? [`send_buffer_size\\=${s.sendBufferBytes}`] : [])];
  const publisher = ['f=fifo', 'fifo_format=flv', `queue_size=${queue}`, `drop_pkts_on_overflow=${s.dropOnOverflow === false ? 0 : 1}`,
    'attempt_recovery=1', 'recover_any_error=1', 'restart_with_keyframe=1', `recovery_wait_time=${s.recoveryWaitSeconds ?? 1}`,
    ...(protocolOpts.length ? [`format_opts=${protocolOpts.join('\\:')}`] : []), 'onfail=ignore'].join(':');
  return `[${recording}]${s.recordingPath}|[${publisher}]${s.publishUrl}`;
}

export function teeSessionArgs(s: TeeSession): string[] {
  const { width, height, fps, seconds } = s;
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 1280 && n % 2 === 0)) throw new Error('Proof sessions are limited to 720p');
  if (!Number.isInteger(fps) || fps < 24 || fps > 30) throw new Error('Proof sessions are limited to 30 fps');
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 90) throw new Error('Proof sessions are limited to 90 s');
  const spec = teeMuxSpec(s);
  const l = s.toneLeftHz ?? 440, r = s.toneRightHz ?? 1000;
  return ['-hide_banner', '-nostdin', '-v', 'info', '-stats_period', '1',
    '-re', '-f', 'lavfi', '-i', `testsrc2=s=${width}x${height}:r=${fps}`,
    '-re', '-f', 'lavfi', '-i', `aevalsrc=sin(2*PI*${l}*t)|sin(2*PI*${r}*t):s=48000`,
    '-t', String(seconds), '-c:v', 'h264_videotoolbox', '-allow_sw', '0', '-pix_fmt', 'yuv420p', '-bf', '0', '-g', String(fps * 2),
    '-force_key_frames', 'expr:gte(t,n_forced*2)', '-b:v', '2500k', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k',
    '-flags', '+global_header', '-map', '0:v:0', '-map', '1:a:0', '-f', 'tee', spec];
}

/** Qualified program profile (issue #64 evidence, 2026-10-15): UltraStudio Recorder 3G delivers 1080p30 at exactly 30/1, not 30000/1001. */
export const PROGRAM_PROFILE = { width: 1920, height: 1080, fps: '30/1', videoBitrateK: 6000, audioChannels: 2, audioRate: 48000, keyframeSeconds: 2 } as const;

export type CaptureTeeSession = {
  recordingPath: string; publishUrl: string;
  width?: number; height?: number; fps?: string;      // default PROGRAM_PROFILE (1080p30, 30/1)
  videoBitrateK?: number; audioChannels?: number;
  queueSize?: number; dropOnOverflow?: boolean; recoveryWaitSeconds?: number; recordingOnFail?: 'abort' | 'ignore'; rwTimeoutMicros?: number; sendBufferBytes?: number;
};
/**
 * ONE ffmpeg for the whole session: the capture helper's Matroska stream arrives on stdin (carrying DeckLink stream-time
 * PTS), is encoded once, and tee writes the MP4 (slave 0) and the fifo-isolated FLV publisher (slave 1).
 */
export function captureTeeArgs(s: CaptureTeeSession): string[] {
  const p = PROGRAM_PROFILE;
  const width = s.width ?? p.width, height = s.height ?? p.height, fps = s.fps ?? p.fps;
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 1920 && n % 2 === 0)) throw new Error('Capture sessions are limited to 1080p');
  const m = /^(\d+)\/(\d+)$/.exec(fps);
  if (!m || !['25/1', '30000/1001', '30/1'].includes(fps)) throw new Error('Capture fps must be a qualified rational (25/1, 30000/1001 or 30/1)');
  const rate = Number(m[1]) / Number(m[2]);
  const channels = s.audioChannels ?? p.audioChannels;
  if (channels !== 2) throw new Error('Streaming profile is stereo; capture more channels with the helper but select/downmix before this stage');
  const bitrate = s.videoBitrateK ?? p.videoBitrateK;
  if (!Number.isInteger(bitrate) || bitrate < 500 || bitrate > 20000) throw new Error('videoBitrateK must be 500-20000');
  const spec = teeMuxSpec(s);
  return ['-hide_banner', '-nostdin', '-v', 'info', '-stats_period', '1',
    '-thread_queue_size', '64', '-f', 'matroska', '-i', 'pipe:0',
    '-map', '0:v:0', '-map', '0:a:0',
    '-vf', `fps=${fps}`, '-af', 'aresample=async=1000:first_pts=0',
    '-c:v', 'h264_videotoolbox', '-allow_sw', '0', '-pix_fmt', 'yuv420p', '-bf', '0', '-g', String(Math.round(rate * p.keyframeSeconds)),
    '-force_key_frames', `expr:gte(t,n_forced*${p.keyframeSeconds})`, '-b:v', `${bitrate}k`,
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-c:a', 'aac', '-ar', String(p.audioRate), '-ac', String(channels), '-b:a', '128k',
    '-flags', '+global_header', '-f', 'tee', spec];
}
