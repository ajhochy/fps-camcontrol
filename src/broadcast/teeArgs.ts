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
export function teeSessionArgs(s: TeeSession): string[] {
  const { width, height, fps, seconds } = s;
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 1280 && n % 2 === 0)) throw new Error('Proof sessions are limited to 720p');
  if (!Number.isInteger(fps) || fps < 24 || fps > 30) throw new Error('Proof sessions are limited to 30 fps');
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 90) throw new Error('Proof sessions are limited to 90 s');
  if (UNSAFE.test(s.recordingPath)) throw new Error('Recording path contains tee-reserved characters');
  if (!/^rtmp:\/\/127\.0\.0\.1:\d+\/[\w/]+$/.test(s.publishUrl)) throw new Error('Proof publishers may only target a local 127.0.0.1 endpoint');
  const l = s.toneLeftHz ?? 440, r = s.toneRightHz ?? 1000;
  const queue = s.queueSize ?? 60;
  const recording = ['f=mp4', 'movflags=+frag_keyframe+hybrid_fragmented', 'flush_packets=1', `onfail=${s.recordingOnFail ?? 'ignore'}`].join(':');
  // Protocol options ride the fifo slave's format_opts (tee-escaped: '=' -> \\=, ':' -> \\:).
  const protocolOpts = [...(s.rwTimeoutMicros ? [`rw_timeout\\=${s.rwTimeoutMicros}`] : []), ...(s.sendBufferBytes ? [`send_buffer_size\\=${s.sendBufferBytes}`] : [])];
  const publisher = ['f=fifo', 'fifo_format=flv', `queue_size=${queue}`, `drop_pkts_on_overflow=${s.dropOnOverflow === false ? 0 : 1}`,
    'attempt_recovery=1', 'recover_any_error=1', 'restart_with_keyframe=1', `recovery_wait_time=${s.recoveryWaitSeconds ?? 1}`,
    ...(protocolOpts.length ? [`format_opts=${protocolOpts.join('\\:')}`] : []), 'onfail=ignore'].join(':');
  return ['-hide_banner', '-nostdin', '-v', 'info', '-stats_period', '1',
    '-re', '-f', 'lavfi', '-i', `testsrc2=s=${width}x${height}:r=${fps}`,
    '-re', '-f', 'lavfi', '-i', `aevalsrc=sin(2*PI*${l}*t)|sin(2*PI*${r}*t):s=48000`,
    '-t', String(seconds), '-c:v', 'h264_videotoolbox', '-allow_sw', '0', '-pix_fmt', 'yuv420p', '-bf', '0', '-g', String(fps * 2),
    '-force_key_frames', 'expr:gte(t,n_forced*2)', '-b:v', '2500k', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k',
    '-flags', '+global_header', '-map', '0:v:0', '-map', '1:a:0', '-f', 'tee', `[${recording}]${s.recordingPath}|[${publisher}]${s.publishUrl}`];
}
