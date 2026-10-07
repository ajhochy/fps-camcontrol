export type SyntheticFormat = { width: number; height: number; fps: string; delayFrames: number; seconds: number };
export function frameRate(fps: string): number {
  if (!['25/1', '30000/1001', '30/1', '60000/1001', '60/1'].includes(fps)) throw new Error('Unsupported production rate');
  const [num, den] = fps.split('/').map(Number); return num / den;
}
export function syntheticEncodeArgs(format: SyntheticFormat): string[] {
  const { width, height, fps, delayFrames, seconds } = format;
  const rate = frameRate(fps);
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 4096 && n % 2 === 0)
    || !Number.isInteger(delayFrames) || delayFrames < 0 || delayFrames > 15 || !Number.isFinite(seconds) || seconds <= 0) throw new Error('Invalid synthetic format');
  return ['-hide_banner', '-nostdin', '-v', 'warning', '-re', '-f', 'lavfi', '-i',
    `color=c=black:s=${width}x${height}:r=${fps},drawbox=color=white:t=fill:enable='lt(mod(t,2),${1 / rate})'`,
    '-re', '-f', 'lavfi', '-i', `aevalsrc=if(lt(mod(t\\,2)\\,0.005)\\,0.8*sin(2*PI*1000*t)\\,0)|if(lt(mod(t\\,2)\\,0.005)\\,0.8*sin(2*PI*1000*t)\\,0):s=48000`,
    '-t', String(seconds), '-vf', `setpts=PTS+${delayFrames}/(${fps})/TB`, '-fps_mode', 'passthrough',
    '-c:v', 'h264_videotoolbox', '-allow_sw', '0', '-pix_fmt', 'yuv420p', '-bf', '0', '-g', String(Math.round(rate * 2)),
    '-force_key_frames', 'expr:gte(t,n_forced*2)', '-b:v', '2500k', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k',
    '-max_muxing_queue_size', '128', '-max_interleave_delta', '1000000', '-muxrate', '4000000', '-mpegts_flags', '+resend_headers+pat_pmt_at_frames', '-f', 'mpegts', 'pipe:1'];
}
export function remuxArgs(target: string, kind: 'mp4' | 'flv'): string[] {
  return ['-hide_banner', '-nostdin', '-v', 'warning', '-copyts', '-start_at_zero', '-probesize', '1048576', '-analyzeduration', '2000000',
    '-f', 'mpegts', '-i', 'pipe:0', '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-avoid_negative_ts', 'make_non_negative', '-max_muxing_queue_size', '128', '-max_interleave_delta', '1000000',
    ...(kind === 'mp4' ? ['-flush_packets', '1', '-movflags', '+frag_keyframe+hybrid_fragmented'] : ['-flvflags', 'no_duration_filesize', '-rw_timeout', '5000000']), '-f', kind, '-y', target];
}
export function rtmpUrl(): string {
  const port = Number(process.env.BROADCAST_TEST_RTMP_PORT || '19350');
  if (!Number.isInteger(port) || port < 19350 || port > 19359) throw new Error('BROADCAST_TEST_RTMP_PORT must be 19350–19359');
  return `rtmp://127.0.0.1:${port}/live/s1`;
}
