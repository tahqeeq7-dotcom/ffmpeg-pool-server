const express = require('express');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const https = require('https');
const { URL } = require('url');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const TMP_DIR = '/data/data/com.termux/files/home/.ffmpeg-tmp';
const FFMPEG_BIN = 'ffmpeg';
const MEM_PER_WORKER = 350;
const RESERVE_MB = 512;

let vidsToday = 0;
const todayStr = () => new Date().toISOString().substring(0, 10);
let currentDate = todayStr();

const taskQueue = [];
let activeTasks = 0;

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

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

function downloadFile(urlStr, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const parsed = new URL(urlStr);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 180000,
    };
    const req = https.get(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.unlink(destPath, () => {});
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close(); fs.unlink(destPath, () => {});
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const ct = res.headers['content-type'] || '';
      if (ct.includes('text/html')) {
        file.close(); fs.unlink(destPath, () => {});
        return reject(new Error('HTML response - check API key'));
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        const st = fs.statSync(destPath);
        if (st.size < 100) { fs.unlink(destPath, () => {}); return reject(new Error(`Too small: ${st.size}B`)); }
        resolve(destPath);
      });
    });
    req.on('error', (err) => { file.close(); try { fs.unlinkSync(destPath); } catch (_) {} reject(err); });
    req.on('timeout', () => { req.destroy(); file.close(); try { fs.unlinkSync(destPath); } catch (_) {} reject(new Error('Download timeout')); });
  });
}

function driveUrl(fileId, apiKey) {
  return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${apiKey}`;
}

function runFFmpeg(args, timeoutSecs) {
  return new Promise((resolve, reject) => {
    const child = execFile(FFMPEG_BIN, args, { timeout: timeoutSecs * 1000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) return reject(new Error(`FFmpeg timeout ${timeoutSecs}s`));
        return reject(new Error((stderr || '').substring(0, 1500)));
      }
      resolve();
    });
  });
}

async function uploadToYouTube(videoPath, thumbPath, opts) {
  const { accessToken, refreshToken, clientId, clientSecret, caption } = opts;
  const oauth = new google.auth.OAuth2(clientId, clientSecret);
  oauth.setCredentials({ access_token: accessToken, refresh_token: refreshToken || undefined });
  const youtube = google.youtube({ version: 'v3', auth: oauth });

  const lines = (caption || '').trim().split('\n');
  const title = (lines[0] || 'Untitled').substring(0, 100);
  const description = lines.slice(1).join('\n').trim();

  const upRes = await youtube.videos.insert({
    part: ['snippet', 'status'],
    notifySubscribers: false,
    requestBody: {
      snippet: { title, description, tags: ['Shorts'], defaultLanguage: 'en' },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
    },
    media: { body: fs.createReadStream(videoPath) },
  });

  const videoId = upRes.data.id;

  if (thumbPath && fs.existsSync(thumbPath)) {
    try {
      await youtube.thumbnails.set({ videoId, media: { body: fs.createReadStream(thumbPath) } });
    } catch (_) {}
  }

  return videoId;
}

async function processTask(task) {
  const { taskId, driveApiKey, contentFileId, hookFileId, outroFileId, watermarkFileId, logoFileId, logoIsVideo, youtube } = task;
  const taskDir = path.join(TMP_DIR, `task_${taskId}`);

  try {
    fs.mkdirSync(taskDir, { recursive: true });

    const downloads = [
      { key: 'content', url: driveUrl(contentFileId, driveApiKey), file: path.join(taskDir, 'content.mp4') },
    ];
    if (hookFileId) downloads.push({ key: 'hook', url: driveUrl(hookFileId, driveApiKey), file: path.join(taskDir, 'hook.mp4') });
    if (outroFileId) downloads.push({ key: 'outro', url: driveUrl(outroFileId, driveApiKey), file: path.join(taskDir, 'outro.mp4') });
    if (watermarkFileId) downloads.push({ key: 'wm', url: driveUrl(watermarkFileId, driveApiKey), file: path.join(taskDir, 'wm.mp4') });
    if (logoFileId) downloads.push({ key: 'logo', url: driveUrl(logoFileId, driveApiKey), file: path.join(taskDir, `logo.${logoIsVideo ? 'mp4' : 'png'}`) });

    for (const d of downloads) await downloadFile(d.url, d.file);

    const hasHook = hookFileId && fs.existsSync(path.join(taskDir, 'hook.mp4'));
    const hasOutro = outroFileId && fs.existsSync(path.join(taskDir, 'outro.mp4'));
    const hasWm = watermarkFileId && fs.existsSync(path.join(taskDir, 'wm.mp4'));
    const hasLogo = logoFileId && fs.existsSync(path.join(taskDir, `logo.${logoIsVideo ? 'mp4' : 'png'}`));

    const outputPath = path.join(taskDir, 'output.mp4');
    const ffmpegArgs = [];
    const filters = [];
    let concatLabels = [];
    let inputIdx = 0;

    if (hasHook) { ffmpegArgs.push('-i', path.join(taskDir, 'hook.mp4')); concatLabels.push(`[${inputIdx}:v]`); filters.push(`[${inputIdx}:v]setpts=PTS-STARTPTS[v${inputIdx}]`); inputIdx++; }
    ffmpegArgs.push('-i', path.join(taskDir, 'content.mp4')); concatLabels.push(`[${inputIdx}:v]`); filters.push(`[${inputIdx}:v]setpts=PTS-STARTPTS[v${inputIdx}]`); inputIdx++;
    if (hasOutro) { ffmpegArgs.push('-i', path.join(taskDir, 'outro.mp4')); concatLabels.push(`[${inputIdx}:v]`); filters.push(`[${inputIdx}:v]setpts=PTS-STARTPTS[v${inputIdx}]`); inputIdx++; }

    const n = concatLabels.length;
    filters.push(`${concatLabels.join('')}concat=n=${n}:v=1:a=0[base]`);

    let current = '[base]';
    if (hasWm) {
      ffmpegArgs.push('-i', path.join(taskDir, 'wm.mp4'));
      filters.push(`[${inputIdx}:v]scale=W*0.15:-1,format=rgba,colorchannelmixer=aa=0.15[wm]`);
      filters.push(`${current}[wm]overlay=W-w-15:H-h-15:shortest=1[ow]`);
      current = '[ow]';
      inputIdx++;
    }
    if (hasLogo) {
      const logoFile = path.join(taskDir, `logo.${logoIsVideo ? 'mp4' : 'png'}`);
      if (logoIsVideo) ffmpegArgs.push('-stream_loop', '-1', '-i', logoFile);
      else ffmpegArgs.push('-loop', '1', '-i', logoFile);
      filters.push(`[${inputIdx}:v]scale=min(iw*0.12\\,66):-1[logo]`);
      filters.push(`${current}[logo]overlay=W-w-10:10:shortest=1`);
      current = '[ol]';
      inputIdx++;
    }

    ffmpegArgs.push('-filter_complex', filters.join(';'));
    ffmpegArgs.push('-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-crf', '28');
    ffmpegArgs.push('-c:a', 'aac', '-y', outputPath);

    await runFFmpeg(ffmpegArgs, 300);

    const thumbPath = path.join(taskDir, 'thumb.jpg');
    try { await runFFmpeg(['-i', outputPath, '-ss', '00:00:01', '-vframes', '1', '-q:v', '2', thumbPath, '-y'], 30); } catch (_) {}

    const videoId = await uploadToYouTube(outputPath, fs.existsSync(thumbPath) ? thumbPath : null, youtube);

    try { fs.rmSync(taskDir, { recursive: true, force: true }); } catch (_) {}
    return { success: true, taskId, videoId };
  } catch (err) {
    try { fs.rmSync(taskDir, { recursive: true, force: true }); } catch (_) {}
    return { success: false, taskId, error: err.message };
  }
}

async function processQueue() {
  if (taskQueue.length === 0 || activeTasks >= getMaxWorkers()) return;
  const task = taskQueue.shift();
  activeTasks++;
  const result = await processTask(task.data);
  activeTasks--;
  resetDaily();
  if (result.success) vidsToday++;
  if (task.resolve) task.resolve(result);

  if (taskQueue.length > 0 && activeTasks < getMaxWorkers()) {
    processQueue();
  }
}

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

app.post('/process', (req, res) => {
  const { taskId } = req.body;
  if (!taskId || !req.body.contentFileId || !req.body.driveApiKey || !req.body.youtube?.accessToken) {
    return res.status(400).json({ success: false, taskId: taskId || '?', error: 'Missing required fields' });
  }

  const resolver = new Promise((resolve) => {
    taskQueue.push({ data: req.body, resolve });
    if (activeTasks < getMaxWorkers()) processQueue();
  });

  resolver.then((result) => res.json(result));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`FFmpeg pool server running on port ${PORT}`);
  console.log(`Max workers: ${getMaxWorkers()} (based on ${Math.round(os.freemem() / 1024 / 1024)}MB free RAM)`);
});

process.on('uncaughtException', (err) => console.error('Uncaught:', err.message));
