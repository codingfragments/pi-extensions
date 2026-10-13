/**
 * S1 naive mux: audio laid from t=0, video scaled to the output size, the
 * shorter stream padded (video: clone last frame; audio: silence). S4 replaces
 * this with the audio-led, event-anchored editor (D11).
 */

import { ffmpeg, ffprobe } from "../media/ffmpeg.ts";

export interface MuxPlan {
  videoDuration: number;
  audioDuration: number;
  total: number;
  padVideo: number;
  padAudio: number;
}

export function planMux(videoDuration: number, audioDuration: number): MuxPlan {
  const total = Math.max(videoDuration, audioDuration);
  return {
    videoDuration,
    audioDuration,
    total,
    padVideo: +Math.max(0, audioDuration - videoDuration).toFixed(3),
    padAudio: +Math.max(0, videoDuration - audioDuration).toFixed(3),
  };
}

export function muxArgs(
  video: string,
  audio: string,
  out: string,
  plan: MuxPlan,
  size: { width: number; height: number },
): string[] {
  const vf = [`scale=${size.width}:${size.height}:flags=lanczos`, "setsar=1"];
  if (plan.padVideo > 0) vf.push(`tpad=stop_mode=clone:stop_duration=${plan.padVideo}`);
  const af = plan.padAudio > 0 ? `apad=pad_dur=${plan.padAudio}` : "anull";
  return [
    "-i",
    video,
    "-i",
    audio,
    "-filter_complex",
    `[0:v]${vf.join(",")}[v];[1:a]${af},aresample=48000[a]`,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-t",
    plan.total.toFixed(3),
    "-movflags",
    "+faststart",
    out,
  ];
}

export async function naiveMux(
  video: string,
  audio: string,
  out: string,
  size: { width: number; height: number },
): Promise<MuxPlan & { ms: number }> {
  const [v, a] = await Promise.all([ffprobe(video), ffprobe(audio)]);
  const plan = planMux(v.duration, a.duration);
  const { ms } = await ffmpeg(muxArgs(video, audio, out, plan, size));
  return { ...plan, ms };
}
