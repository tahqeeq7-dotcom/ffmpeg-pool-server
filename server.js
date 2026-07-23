const express = require('express');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const TMP_DIR = process.env.FFMPEG_TMP_DIR || '/data/data/com.termux/files/home/.ffmpeg-tmp';
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const MEM_PER_WORKER = 350;
const RESERVE_MB = 512;
const MAX_QUEUE_LENGTH = 50;
const IDEMPOTENCY_FILE = path.join(TMP_DIR, '.completed_tasks.json');

let vidsToday = 0;
const todayStr = () => new Date().toISOString().substring(0, 10);
let currentDate = todayStr();

const taskQueue = [];
let activeTasks = 0;
const progressMap = {};

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ─── Auth middleware ─────────────────────────────────────────
function authMiddleware(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const token = req.headers['x-api-key'];
  if (!token || token !== AUTH_TOKEN) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}
app.use(authMiddleware);

// ─── Idempotency (track completed taskIds to prevent dupes) ──
function loadCompletedTasks() {
  try {
    if (fs.existsSync(IDEMPOTENCY_FILE)) {
      return JSON.parse(fs.readFileSync(IDEMPOTENCY_FILE, 'utf8'));
    }
  } catch (_) {}
  return {};
}

function saveCompletedTasks(map) {
  try {
    const dir = path.dirname(IDEMPOTENCY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(IDEMPOTENCY_FILE, JSON.stringify(map));
  } catch (_) {}
}

// ─── Helpers ─────────────────────────────────────────────────
function setProgress(id, step, pct) {
  progressMap[id] = { step, progress: pct, updatedAt: Date.now() };
}

function resetDaily() {
  const d = todayStr();
  if (d !== currentDate) { vidsToday = 0; currentDate = d; }
}

function getMaxWorkers() {
  const freeMB = Math.max(0, (os.freemem() / 1024 / 1024) - RESERVE_MB);
  const byRAM = Math.max(1, Math.floor(freeMB / MEM_PER_WORKER));
  const byCPU = Math.max(1, os.cpus().length - 1);
  return Math.min(byRAM, byCPU, 6);
}

function downloadFile(urlStr, destPath, taskId, { fileId, apiKey } = {}) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const parsed = new URL(urlStr);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 300000,
    };
    let reported = 0;
    const total = parseInt(parsed.searchParams?.get('size')) || 0;
    const req = https.get(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.unlink(destPath, () => {});
        return downloadFile(res.headers.location, destPath, taskId).then(resolve).catch(reject);
      }
      // If download fails or returns HTML, attempt shortcut resolution
      if (res.statusCode !== 200 || (res.headers['content-type'] || '').includes('text/html')) {
        file.close(); fs.unlink(destPath, () => {});
        if (fileId && apiKey) {
          return resolveShortcut(fileId, apiKey).then((resolvedId) => {
            if (resolvedId !== fileId) {
              const newUrl = driveUrl(resolvedId, apiKey);
              console.log('Resolved shortcut', fileId, '->', resolvedId, 'retrying download');
              return downloadFile(newUrl, destPath, taskId).then(resolve).catch(reject);
            }
            reject(new Error(res.statusCode !== 200 ? 'HTTP ' + res.statusCode : 'HTML response'));
          }).catch(() => reject(new Error(res.statusCode !== 200 ? 'HTTP ' + res.statusCode : 'HTML response')));
        }
        return reject(new Error(res.statusCode !== 200 ? 'HTTP ' + res.statusCode : 'HTML response'));
      }
      const cl = parseInt(res.headers['content-length']) || 0;
      res.pipe(file);
      res.on('data', (chunk) => {
        reported += chunk.length;
        if (cl > 0) setProgress(taskId, 'downloading', Math.min(0.4, (reported / cl) * 0.4));
      });
      file.on('finish', () => {
        file.close();
        const st = fs.statSync(destPath);
        if (st.size < 100) { fs.unlink(destPath, () => {}); return reject(new Error('Too small: ' + st.size + 'B')); }
        resolve(destPath);
      });
    });
    req.on('error', (err) => { file.close(); try { fs.unlinkSync(destPath); } catch (_) {} reject(err); });
    req.on('timeout', () => { req.destroy(); file.close(); try { fs.unlinkSync(destPath); } catch (_) {} reject(new Error('Download timeout')); });
  });
}

function driveUrl(fileId, apiKey) {
  return 'https://drive.google.com/uc?export=download&confirm=1&id=' + fileId;
}

// Resolve a Google Drive shortcut to its target file ID.
// Makes a HEAD-like GET to check mimeType; if it's a shortcut, fetches metadata to get targetId.
function resolveShortcut(fileId, apiKey) {
  return new Promise((resolve, reject) => {
    const url = 'https://www.googleapis.com/drive/v3/files/' + fileId + '?fields=mimeType,shortcutDetails(targetId,targetMimeType)&key=' + apiKey;
    https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.mimeType === 'application/vnd.google-apps.shortcut' && data.shortcutDetails) {
            const target = data.shortcutDetails.targetId;
            const targetMime = data.shortcutDetails.targetMimeType || '';
            if (targetMime.includes('video/')) {
              console.log('Resolved shortcut', fileId, '->', target);
              return resolve(target);
            }
          }
          // Not a shortcut, or not a video shortcut — return original
          resolve(fileId);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function probeMedia(filePath) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=index,codec_type,width,height', '-of', 'json', filePath], (err, stdout) => {
      if (err) return reject(err);
      let data;
      try { data = JSON.parse(stdout); } catch (e) { return reject(e); }
      const streams = data.streams || [];
      const vStream = streams.find((s) => s.codec_type === 'video');
      const hasAudio = streams.some((s) => s.codec_type === 'audio');
      const duration = parseFloat(data.format && data.format.duration) || 0;
      if (!vStream) return reject(new Error('No video stream in ' + filePath));
      resolve({ width: vStream.width, height: vStream.height, duration, hasAudio });
    });
  });
}

function runFFmpeg(args, timeoutSecs, taskId) {
  return new Promise((resolve, reject) => {
    const child = execFile(FFMPEG_BIN, args, { timeout: timeoutSecs * 1000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) return reject(new Error('FFmpeg timeout ' + timeoutSecs + 's'));
        return reject(new Error((stderr || '').substring(0, 10000)));
      }
      resolve();
    });
    if (taskId) {
      let lastLog = Date.now();
      child.stderr?.on('data', (d) => {
        const s = d.toString();
        const m = s.match(/time=(\d+):(\d+):(\d+)/);
        if (m) {
          const secs = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
          if (secs > 0 && Date.now() - lastLog > 2000) {
            lastLog = Date.now();
            setProgress(taskId, 'processing', Math.min(0.85, 0.4 + (secs / 180) * 0.45));
          }
        }
      });
    }
  });
}

async function uploadToYouTube(videoPath, thumbPath, opts, taskId) {
  const { accessToken, refreshToken, clientId, clientSecret, caption } = opts;
  const oauth = new google.auth.OAuth2(clientId, clientSecret);
  oauth.setCredentials({ access_token: accessToken, refresh_token: refreshToken || undefined });
  const youtube = google.youtube({ version: 'v3', auth: oauth });

  setProgress(taskId, 'uploading', 0.85);
  const lines = (caption || '').trim().split('\n');
  const title = (lines[0] || 'Untitled').substring(0, 100);
  const description = lines.slice(1).join('\n').trim();

  // Detect language from caption content (simple heuristic: if description has non-ASCII chars, keep 'en' as default)
  const lang = opts.language || 'en';

  const upRes = await youtube.videos.insert({
    part: ['snippet', 'status'],
    notifySubscribers: false,
    requestBody: {
      snippet: { title, description, tags: ['Shorts'], defaultLanguage: lang },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
    },
    media: { body: fs.createReadStream(videoPath) },
  });

  setProgress(taskId, 'uploading', 0.95);
  const videoId = upRes.data.id;

  if (thumbPath && fs.existsSync(thumbPath)) {
    try {
      await youtube.thumbnails.set({ videoId, media: { body: fs.createReadStream(thumbPath) } });
    } catch (_) {}
  }

  setProgress(taskId, 'done', 1.0);
  return videoId;
}

// Generate random burst parameters for content uniqueness
function generateBurstParams(seed) {
  const rng = seedrandom(seed);
  const burstDuration = 3 + rng() * 1.5; // 3-4.5s burst window
  const burstStart = 10 + rng() * 35;    // between 10s and 45s into video
  const burstEnd = burstStart + burstDuration;
  const speedFactor = 0.94 + rng() * 0.08; // 0.94-1.02 (or 1.0 to 1.06 via division)
  const speedMode = rng() > 0.5 ? 'slow' : 'fast';
  // slow -> PTS/{speedFactor} where speedFactor >1 (e.g. 1.03 = slower)
  // fast -> PTS/{speedFactor} where speedFactor <1 (e.g. 0.97 = faster)
  // But FFmpeg setpts: PTS * factor where factor <1 speeds up, factor >1 slows down
  // We use division: PTS/{divisor} where divisor >1 speeds up, divisor <1 slows down
  const speedDivisor = speedMode === 'fast' ? (1 / (0.94 + rng() * 0.04)) : (0.98 + rng() * 0.04);
  const colorTemp = -0.08 + rng() * 0.16; // -0.08 to +0.08
  const vignetteVal = 0.05 + rng() * 0.10; // 0.05-0.15
  const pitchShift = 0.97 + rng() * 0.06; // 0.97-1.03
  const asetrateVal = Math.round(44100 * pitchShift);
  const atempoVal = +(1 / pitchShift).toFixed(4);
  return { burstStart, burstEnd, speedDivisor, colorTemp, vignetteVal, asetrateVal, atempoVal, burstDuration };
}

// Seeded random (simple mulberry32)
function seedrandom(seed) {
  let s = seed | 0;
  return function() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function processTask(task) {
  const { taskId, driveApiKey, contentFileId, hookFileId, outroFileId, watermarkFileId, watermarkIsVideo, logoFileId, logoIsVideo, youtube, skipDownload, localVideoPath, randomize, randomSeed } = task;
  const taskDir = path.join(TMP_DIR, 'task_' + taskId);

  try {
    // Check idempotency: if this taskId was already completed, skip re-processing
    const completed = loadCompletedTasks();
    if (completed[taskId]) {
      console.log('Skipping already-completed task', taskId, 'videoId:', completed[taskId]);
      return { success: true, taskId, videoId: completed[taskId] };
    }

    fs.mkdirSync(taskDir, { recursive: true });
    setProgress(taskId, 'downloading', 0);

    if (skipDownload) {
      // Upload-only mode: video already exists locally, link it into taskDir
      const contentSrc = localVideoPath || path.join(TMP_DIR, taskId, 'content.mp4');
      if (fs.existsSync(contentSrc)) {
        try { fs.linkSync(contentSrc, path.join(taskDir, 'content.mp4')); } catch (_) { fs.copyFileSync(contentSrc, path.join(taskDir, 'content.mp4')); }
        console.log('Skip-download: using local file', contentSrc);
      }
    } else {
      const downloads = [];
      downloads.push({ key: 'content', url: driveUrl(contentFileId, driveApiKey), file: path.join(taskDir, 'content.mp4'), fileId: contentFileId });
      if (hookFileId) downloads.push({ key: 'hook', url: driveUrl(hookFileId, driveApiKey), file: path.join(taskDir, 'hook.mp4'), fileId: hookFileId });
      if (outroFileId) downloads.push({ key: 'outro', url: driveUrl(outroFileId, driveApiKey), file: path.join(taskDir, 'outro.mp4'), fileId: outroFileId });
      if (watermarkFileId) {
        downloads.push({ key: 'wm', url: driveUrl(watermarkFileId, driveApiKey), file: path.join(taskDir, 'wm.' + (watermarkIsVideo ? 'mp4' : 'png')), fileId: watermarkFileId });
      }
      if (logoFileId) {
        downloads.push({ key: 'logo', url: driveUrl(logoFileId, driveApiKey), file: path.join(taskDir, 'logo.' + (logoIsVideo ? 'mp4' : 'png')), fileId: logoFileId });
      }

      for (const d of downloads) if (d.url) await downloadFile(d.url, d.file, taskId, { fileId: d.fileId, apiKey: driveApiKey });
    }

    const hasHook = hookFileId && fs.existsSync(path.join(taskDir, 'hook.mp4'));
    const hasOutro = outroFileId && fs.existsSync(path.join(taskDir, 'outro.mp4'));
    const hasWm = watermarkFileId && fs.existsSync(path.join(taskDir, 'wm.' + (watermarkIsVideo ? 'mp4' : 'png')));
    const hasLogo = logoFileId && fs.existsSync(path.join(taskDir, 'logo.' + (logoIsVideo ? 'mp4' : 'png')));

    setProgress(taskId, 'processing', 0.4);
    const outputPath = path.join(taskDir, 'output.mp4');
    const ffmpegArgs = [];
    const filters = [];
    let inputIdx = 0;

    // concat requires every input to share identical resolution + SAR. Clips coming from
    // different sources (hook/outro vs content) can differ, which is what caused
    // "Input link ... parameters do not match the corresponding output link ... parameters".
    // Normalize everything to content.mp4's own dimensions: scale-to-fit, pad to exact
    // canvas, force SAR=1.
    const contentInfo = await probeMedia(path.join(taskDir, 'content.mp4'));
    const targetW = contentInfo.width, targetH = contentInfo.height;
    const normalizeVideo = (idx) =>
      '[' + idx + ':v]scale=' + targetW + ':' + targetH + ':force_original_aspect_ratio=decrease,' +
      'pad=' + targetW + ':' + targetH + ':(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,setpts=PTS-STARTPTS[v' + idx + ']';

    // Audio must ride along with its own segment through concat too — mapping content's
    // raw audio stream directly (old behavior) ignored the hook/outro entirely, so
    // content's dialogue started at t=0 under the hook's video instead of after it.
    // Segments with no audio track (common for hook/outro stingers) get silence of
    // the correct duration so the concat filter's stream count still lines up.
    const normalizeAudio = (idx, hasAudioTrack, duration) =>
      hasAudioTrack
        ? '[' + idx + ':a]asetpts=PTS-STARTPTS[a' + idx + ']'
        : 'anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=' + duration.toFixed(3) + ',asetpts=PTS-STARTPTS[a' + idx + ']';

    const segmentLabels = []; // interleaved [vN][aN] pairs, in concat's expected order
    let totalDuration = 0;

    if (hasHook) {
      const hookInfo = await probeMedia(path.join(taskDir, 'hook.mp4'));
      ffmpegArgs.push('-i', path.join(taskDir, 'hook.mp4'));
      filters.push(normalizeVideo(inputIdx));
      filters.push(normalizeAudio(inputIdx, hookInfo.hasAudio, hookInfo.duration));
      segmentLabels.push('[v' + inputIdx + ']', '[a' + inputIdx + ']');
      totalDuration += hookInfo.duration;
      inputIdx++;
    }

    ffmpegArgs.push('-i', path.join(taskDir, 'content.mp4'));
    filters.push(normalizeVideo(inputIdx));
    filters.push(normalizeAudio(inputIdx, contentInfo.hasAudio, contentInfo.duration));
    segmentLabels.push('[v' + inputIdx + ']', '[a' + inputIdx + ']');
    totalDuration += contentInfo.duration;
    inputIdx++;

    if (hasOutro) {
      const outroInfo = await probeMedia(path.join(taskDir, 'outro.mp4'));
      ffmpegArgs.push('-i', path.join(taskDir, 'outro.mp4'));
      filters.push(normalizeVideo(inputIdx));
      filters.push(normalizeAudio(inputIdx, outroInfo.hasAudio, outroInfo.duration));
      segmentLabels.push('[v' + inputIdx + ']', '[a' + inputIdx + ']');
      totalDuration += outroInfo.duration;
      inputIdx++;
    }

    const n = segmentLabels.length / 2;
    filters.push(segmentLabels.join('') + 'concat=n=' + n + ':v=1:a=1[base][baseaudio]');
    let currentAudio = '[baseaudio]';
    let current = '[base]';
    if (hasWm) {
      ffmpegArgs.push('-loop', '1', '-i', path.join(taskDir, 'wm.' + (watermarkIsVideo ? 'mp4' : 'png')));
      filters.push('[' + inputIdx + ':v]scale=120:-1,format=rgba,colorchannelmixer=aa=0.15[wm_pre]');
      filters.push('[wm_pre]null[wm]');
      // DVD-logo bounce: true reflection off each edge (triangle wave), not a wrap/drift.
      // VX/VY are px/sec speeds; tweak to taste.
      const VX = 90, VY = 60;
      const wmX = "trunc(abs(mod(t*" + VX + "\\,2*(main_w-overlay_w))-(main_w-overlay_w)))";
      const wmY = "trunc(abs(mod(t*" + VY + "\\,2*(main_h-overlay_h))-(main_h-overlay_h)))";
      // End this filter statement BEFORE the output label (semicolon, not comma) —
      // chaining a label straight onto a bare numeric option value (e.g. "shortest=1[ow]"
      // or "shortest=1,null[ow]") is what was crashing the parser. A ';' starts a clean
      // new filterchain so there's no ambiguous trailing token.
      filters.push(current + "[wm]overlay=x='" + wmX + "':y='" + wmY + "':eval=frame:shortest=1[ow_pre]");
      filters.push('[ow_pre]null[ow]');
      current = '[ow]';
      inputIdx++;
    }
    if (hasLogo) {
      const logoFile = path.join(taskDir, 'logo.' + (logoIsVideo ? 'mp4' : 'png'));
      if (logoIsVideo) ffmpegArgs.push('-stream_loop', '-1', '-i', logoFile);
      else ffmpegArgs.push('-loop', '1', '-i', logoFile);
      filters.push('[' + inputIdx + ':v]scale=66:-1[logo_pre]');
      filters.push('[logo_pre]null[logo]');
      filters.push(current + '[logo]overlay=main_w-overlay_w-10:10:shortest=1[ol_pre]');
      filters.push('[ol_pre]null[ol]');
      current = '[ol]';
      inputIdx++;
    }

    // Random content uniqueness burst (3-4.5s window)
    if (randomize) {
      const seed = randomSeed || Math.floor(Math.random() * 999999);
      const bp = generateBurstParams(seed);
      let { burstStart, burstEnd, speedDivisor, colorTemp, vignetteVal } = bp;

      // burstStart/burstEnd are randomized independent of actual video length — clamp
      // them into the real timeline (with a small tail margin) so the trim/concat split
      // below never asks for a range past the end of a short video.
      const TAIL_MARGIN = 0.5;
      const maxEnd = Math.max(TAIL_MARGIN, totalDuration - TAIL_MARGIN);
      if (burstEnd > maxEnd) {
        burstStart = Math.max(0, burstStart - (burstEnd - maxEnd));
        burstEnd = maxEnd;
      }
      const skipBurstSplit = burstEnd - burstStart < 0.3; // video too short for a meaningful window

      const bStart = burstStart.toFixed(3);
      const bEnd = burstEnd.toFixed(3);

      // Color temp burst (colorchannelmixer works on all FFmpeg builds unlike custom eq=color_temperature)
      const cr = (1.0 + colorTemp * 1.5).toFixed(4);
      const cb = (1.0 - colorTemp * 1.5).toFixed(4);
      const tempFilter = current + 'colorchannelmixer=rr=' + cr + ':bb=' + cb + ':enable=\'between(t,' + burstStart.toFixed(1) + ',' + burstEnd.toFixed(1) + ')\'[ct_pre]';
      filters.push(tempFilter);
      filters.push('[ct_pre]null[ct]');

      // Vignette burst (PI/4 angle, variable amount)
      const vigFilter = '[ct]vignette=PI/4:' + vignetteVal.toFixed(4) + ':eval=frame:enable=\'between(t,' + burstStart.toFixed(1) + ',' + burstEnd.toFixed(1) + ')\'[vg_pre]';
      filters.push(vigFilter);
      filters.push('[vg_pre]null[vg]');

      // Text overlay (one auto-generated line from caption, centered)
      const captionLines = (youtube.caption || '').trim().split('\n');
      const textLine = (captionLines.length > 1 ? captionLines[Math.floor(Math.random() * captionLines.length)] : captionLines[0] || '✨').substring(0, 50);
      // Escape single quotes in text for FFmpeg drawtext
      const safeText = textLine.replace(/'/g, "'\\\\\\''").replace(/"/g, '\\"');
      const txtFilter = '[vg]drawtext=text=\'' + safeText + '\':x=(w-text_w)/2:y=h*0.4:fontsize=28:fontcolor=white:shadowcolor=black:shadowx=2:shadowy=2:enable=\'between(t,' + burstStart.toFixed(1) + ',' + burstEnd.toFixed(1) + ')\'[tx_pre]';
      filters.push(txtFilter);
      filters.push('[tx_pre]null[tx]');

      if (skipBurstSplit) {
        // Video too short for a meaningful speed-change window — keep color/vignette/
        // text (still gated by enable=between above) but don't retime anything.
        current = '[tx]';
      } else {
        // Speed change, WINDOWED: eq/vignette/drawtext above use enable= to gate per-frame,
        // but setpts/atempo are timing remaps — they can't be turned on/off per frame the
        // same way. To actually confine the speed shift to just the burst window (instead
        // of retiming the whole clip), split video+audio into pre/burst/post segments,
        // only retime the burst segment, then concat back together. Times above (eq/
        // vignette/drawtext) are evaluated BEFORE this split, against the original
        // timeline, so their windows still line up correctly with burstStart/burstEnd.
        filters.push('[tx]split=3[vsA][vsB][vsC]');
        filters.push('[vsA]trim=start=0:end=' + bStart + ',setpts=PTS-STARTPTS[vpre]');
        filters.push('[vsB]trim=start=' + bStart + ':end=' + bEnd + ',setpts=(PTS-STARTPTS)/' + speedDivisor.toFixed(4) + '[vburst]');
        filters.push('[vsC]trim=start=' + bEnd + ',setpts=PTS-STARTPTS[vpost]');
        filters.push('[vpre][vburst][vpost]concat=n=3:v=1:a=0[vout]');
        current = '[vout]';

        // Audio pitch shift (imperceptible ±3%, breaks audio fingerprint), same windowing.
        filters.push(currentAudio + 'asplit=3[asA][asB][asC]');
        filters.push('[asA]atrim=start=0:end=' + bStart + ',asetpts=PTS-STARTPTS[apre]');
        filters.push('[asB]atrim=start=' + bStart + ':end=' + bEnd + ',asetrate=' + bp.asetrateVal + ',atempo=' + bp.atempoVal + ',asetpts=PTS-STARTPTS[aburst]');
        filters.push('[asC]atrim=start=' + bEnd + ',asetpts=PTS-STARTPTS[apost]');
        filters.push('[apre][aburst][apost]concat=n=3:v=0:a=1[aout]');
        currentAudio = '[aout]';
      }
    }

    ffmpegArgs.push('-filter_complex', filters.join(';'));
    ffmpegArgs.push('-map', '[' + current.replace('[', '').replace(']', '') + ']');
    ffmpegArgs.push('-map', '[' + currentAudio.replace('[', '').replace(']', '') + ']');
    ffmpegArgs.push('-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-crf', '28');
    ffmpegArgs.push('-c:a', 'aac', '-y', outputPath);

    await runFFmpeg(ffmpegArgs, 600, taskId);

    setProgress(taskId, 'processing', 0.85);
    const thumbPath = path.join(taskDir, 'thumb.jpg');
    const thumbSec = randomize ? (2 + Math.floor(Math.random() * 5)).toString().padStart(2, '0') : '01';
    try { await runFFmpeg(['-i', outputPath, '-ss', '00:00:' + thumbSec, '-vframes', '1', '-q:v', '2', thumbPath, '-y'], 30); } catch (_) {}

    const videoId = await uploadToYouTube(outputPath, fs.existsSync(thumbPath) ? thumbPath : null, youtube, taskId);

    // Record completed task for idempotency BEFORE returning success
    completed[taskId] = videoId;
    saveCompletedTasks(completed);

    try { fs.rmSync(taskDir, { recursive: true, force: true }); } catch (_) {}
    setProgress(taskId, 'done', 1.0);
    return { success: true, taskId, videoId };
  } catch (err) {
    try { fs.rmSync(taskDir, { recursive: true, force: true }); } catch (_) {}
    setProgress(taskId, 'error', 0);
    return { success: false, taskId, error: err.message };
  }
}

async function processQueue() {
  if (taskQueue.length === 0) return;
  if (activeTasks >= getMaxWorkers()) return;
  const task = taskQueue.shift();
  activeTasks++;
  try {
    const result = await processTask(task.data);
    if (result.success) vidsToday++;
    if (task.resolve) task.resolve(result);
  } catch (err) {
    console.error('processTask catastrophic error:', err);
    if (task.resolve) task.resolve({ success: false, taskId: task.data.taskId, error: 'Internal error: ' + err.message });
  } finally {
    activeTasks--;
    resetDaily();
  }

  if (taskQueue.length > 0 && activeTasks < getMaxWorkers()) {
    setImmediate(() => processQueue());
  }

  setTimeout(() => { try { delete progressMap[task.data.taskId]; } catch (_) {} }, 30000);
}

// ─── HTTP Endpoints ──────────────────────────────────────────
app.get('/health', (req, res) => {
  resetDaily();
  res.json({
    status: 'ok',
    freeRamMB: Math.round(os.freemem() / 1024 / 1024),
    totalRamMB: Math.round(os.totalmem() / 1024 / 1024),
    maxWorkers: getMaxWorkers(),
    activeWorkers: activeTasks,
    queueLength: taskQueue.length,
    vidsToday,
  });
});

app.get('/status/:taskId', (req, res) => {
  const p = progressMap[req.params.taskId];
  if (!p) return res.json({ step: 'unknown', progress: 0 });
  res.json(p);
});

app.post('/process', (req, res) => {
  const { taskId, skipDownload } = req.body;
  if (!taskId || !req.body.youtube?.accessToken) {
    return res.status(400).json({ success: false, taskId: taskId || '?', error: 'Missing required fields: taskId and youtube.accessToken are required' });
  }
  if (!skipDownload && (!req.body.contentFileId || !req.body.driveApiKey)) {
    return res.status(400).json({ success: false, taskId: taskId || '?', error: 'Missing contentFileId and driveApiKey (or set skipDownload=true for upload-only)' });
  }

  // Reject if queue is full
  if (taskQueue.length >= MAX_QUEUE_LENGTH) {
    return res.status(429).json({ success: false, taskId, error: 'Server queue full (max ' + MAX_QUEUE_LENGTH + '). Try again later.' });
  }

  const resolver = new Promise((resolve) => {
    taskQueue.push({ data: req.body, resolve });
    if (activeTasks < getMaxWorkers()) processQueue();
  });

  resolver.then((result) => res.json(result));
});

// ─── Graceful shutdown ───────────────────────────────────────
let shuttingDown = false;

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Received ' + signal + '. Draining active tasks...');

  const waitForDrain = setInterval(() => {
    if (activeTasks === 0 && taskQueue.length === 0) {
      clearInterval(waitForDrain);
      console.log('All tasks complete. Exiting.');
      process.exit(0);
    }
    console.log('Waiting... active:', activeTasks, 'queued:', taskQueue.length);
  }, 2000);

  // Force exit after 30 seconds regardless
  setTimeout(() => {
    console.log('Force exit after timeout.');
    process.exit(1);
  }, 30000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => console.error('Uncaught:', err.message));
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));

// ─── Start server ────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('FFmpeg pool server running on port ' + PORT);
  console.log('Auth: ' + (AUTH_TOKEN ? 'enabled' : 'DISABLED (set AUTH_TOKEN env var)'));
  console.log('Max workers: ' + getMaxWorkers() + ' (based on ' + Math.round(os.freemem() / 1024 / 1024) + 'MB free RAM)');
  console.log('Max queue: ' + MAX_QUEUE_LENGTH);
});
