// build.mjs: turns each recorded segment (frames + narration marks) into an MP4 with its voice-over, then joins them.
// Usage: node build.mjs <output.mp4>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { OUT } from './kit.mjs';

const FF = process.env.FFMPEG ?? 'ffmpeg';
const ff = (args) => execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
const SEG = path.join(OUT, 'seg');
const AUD = path.join(OUT, 'audio');
const target = process.argv[2] ?? path.join(OUT, 'walkthrough.mp4');

const parts = [];
for (const name of fs.readdirSync(SEG).sort()) {
  const dir = path.join(SEG, name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const fr = meta.frames;
  const start = fr[0][1];
  const lines = fr.map(([f, t], i) => `file '${f}'\nduration ${(((fr[i + 1]?.[1] ?? meta.t1) - t)).toFixed(4)}`);
  lines.push(`file '${fr[fr.length - 1][0]}'`); // concat demuxer needs the last file repeated
  fs.writeFileSync(path.join(dir, 'list.txt'), lines.join('\n') + '\n');
  const dur = meta.t1 - start;

  const inputs = ['-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt')];
  const marks = meta.marks.filter(([id]) => fs.existsSync(path.join(AUD, id + '.wav')));
  marks.forEach(([id]) => inputs.push('-i', path.join(AUD, id + '.wav')));
  inputs.push('-f', 'lavfi', '-t', dur.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo');
  const a = marks.map(([, t], i) => `[${i + 1}:a]aresample=48000,pan=stereo|c0=c0|c1=c0,adelay=${Math.max(0, Math.round((t - start) * 1000))}:all=1[a${i}]`);
  const mixIn = marks.map((_, i) => `[a${i}]`).join('') + `[${marks.length + 1}:a]`;
  const filter = [
    `[0:v]fps=30,scale=1920:1080:flags=lanczos:in_range=pc:out_range=tv,format=yuv420p,fade=t=in:st=0:d=0.35,fade=t=out:st=${(dur - 0.35).toFixed(3)}:d=0.35[v]`,
    ...a,
    `${mixIn}amix=inputs=${marks.length + 1}:normalize=0:duration=longest,atrim=0:${dur.toFixed(3)},afade=t=out:st=${(dur - 0.3).toFixed(3)}:d=0.3[aout]`,
  ].join(';');
  const out = path.join(OUT, `part-${name}.mp4`);
  ff([...inputs, '-filter_complex', filter, '-map', '[v]', '-map', '[aout]', '-t', dur.toFixed(3),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-r', '30', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', out]);
  console.log(name, dur.toFixed(1) + 's', marks.length, 'lines');
  parts.push(out);
}
fs.writeFileSync(path.join(OUT, 'parts.txt'), parts.map((p) => `file '${p}'`).join('\n') + '\n');
ff(['-f', 'concat', '-safe', '0', '-i', path.join(OUT, 'parts.txt'), '-c', 'copy', '-movflags', '+faststart', target]);
console.log('wrote', target);
