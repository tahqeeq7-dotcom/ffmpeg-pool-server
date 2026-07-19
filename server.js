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
const progressMap = {};

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

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

function downloadFile(urlStr, destPath, taskId) {
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
      if (res.statusCode !== 200) {
        file.close(); fs.unlink(destPath, () => {});
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const ct = res.headers['content-type'] || '';
      if (ct.includes('text/html')) {
        file.close(); fs.unlink(destPath, () => {});
        return reject(new Error('HTML response - check API key'));
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
  return 'https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media&key=' + apiKey;
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

  const upRes = await youtube.videos.insert({
    part: ['snippet', 'status'],
    notifySubscribers: false,
    requestBody: {
      snippet: { title, description, tags: ['Shorts'], defaultLanguage: 'en' },
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

async function processTask(task) {
  const { taskId, driveApiKey, contentFileId, hookFileId, outroFileId, watermarkFileId, logoFileId, logoIsVideo, youtube } = task;
  const taskDir = path.join(TMP_DIR, 'task_' + taskId);

  try {
    fs.mkdirSync(taskDir, { recursive: true });
    setProgress(taskId, 'downloading', 0);

    const downloads = [];
    downloads.push({ key: 'content', url: driveUrl(contentFileId, driveApiKey), file: path.join(taskDir, 'content.mp4') });
    if (hookFileId) downloads.push({ key: 'hook', url: driveUrl(hookFileId, driveApiKey), file: path.join(taskDir, 'hook.mp4') });
    if (outroFileId) downloads.push({ key: 'outro', url: driveUrl(outroFileId, driveApiKey), file: path.join(taskDir, 'outro.mp4') });
    if (watermarkFileId) {
      downloads.push({ key: 'wm', url: driveUrl(watermarkFileId, driveApiKey), file: path.join(taskDir, 'wm.mp4') });
    }
    if (logoFileId) {
      downloads.push({ key: 'logo', url: driveUrl(logoFileId, driveApiKey), file: path.join(taskDir, 'logo.' + (logoIsVideo ? 'mp4' : 'png')) });
    }

    for (const d of downloads) if (d.url) await downloadFile(d.url, d.file, taskId);

    const hasHook = hookFileId && fs.existsSync(path.join(taskDir, 'hook.mp4'));
    const hasOutro = outroFileId && fs.existsSync(path.join(taskDir, 'outro.mp4'));
    const hasWm = watermarkFileId && fs.existsSync(path.join(taskDir, 'wm.mp4'));
    const hasLogo = logoFileId && fs.existsSync(path.join(taskDir, 'logo.' + (logoIsVideo ? 'mp4' : 'png')));

    setProgress(taskId, 'processing', 0.4);
    const outputPath = path.join(taskDir, 'output.mp4');
    const ffmpegArgs = [];
    const filters = [];
    const concatLabels = [];
    let inputIdx = 0;

    if (hasHook) { ffmpegArgs.push('-i', path.join(taskDir, 'hook.mp4')); concatLabels.push('[v' + inputIdx + ']'); filters.push('[' + inputIdx + ':v]setpts=PTS-STARTPTS[v' + inputIdx + ']'); inputIdx++; }
    ffmpegArgs.push('-i', path.join(taskDir, 'content.mp4')); concatLabels.push('[v' + inputIdx + ']'); filters.push('[' + inputIdx + ':v]setpts=PTS-STARTPTS[v' + inputIdx + ']'); inputIdx++;
    if (hasOutro) { ffmpegArgs.push('-i', path.join(taskDir, 'outro.mp4')); concatLabels.push('[v' + inputIdx + ']'); filters.push('[' + inputIdx + ':v]setpts=PTS-STARTPTS[v' + inputIdx + ']'); inputIdx++; }

    const n = concatLabels.length;
    filters.push(concatLabels.join('') + 'concat=n=' + n + ':v=1:a=0[base]');

    let current = '[base]';
    if (hasWm) {
      ffmpegArgs.push('-i', path.join(taskDir, 'wm.mp4'));
      filters.push('[' + inputIdx + ':v]scale=iw*0.15:-1,format=rgba,colorchannelmixer=aa=0.15[wm]');
      filters.push(current + '[wm]overlay=main_w-overlay_w-15:main_h-overlay_h-15:shortest=1[ow]');
      current = '[ow]';
      inputIdx++;
    }
    if (hasLogo) {
      const logoFile = path.join(taskDir, 'logo.' + (logoIsVideo ? 'mp4' : 'png'));
      if (logoIsVideo) ffmpegArgs.push('-stream_loop', '-1', '-i', logoFile);
      else ffmpegArgs.push('-loop', '1', '-i', logoFile);
      filters.push('[' + inputIdx + ':v]scale=min(iw*0.12\\,66):-1[logo]');
      filters.push(current + '[logo]overlay=main_w-overlay_w-10:10:shortest=1');
      current = '[ol]';
      inputIdx++;
    }

    ffmpegArgs.push('-filter_complex', filters.join(';'));
    ffmpegArgs.push('-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-crf', '28');
    ffmpegArgs.push('-c:a', 'aac', '-y', outputPath);

    await runFFmpeg(ffmpegArgs, 600, taskId);

    setProgress(taskId, 'processing', 0.85);
    const thumbPath = path.join(taskDir, 'thumb.jpg');
    try { await runFFmpeg(['-i', outputPath, '-ss', '00:00:01', '-vframes', '1', '-q:v', '2', thumbPath, '-y'], 30); } catch (_) {}

    const videoId = await uploadToYouTube(outputPath, fs.existsSync(thumbPath) ? thumbPath : null, youtube, taskId);

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

  setTimeout(() => { try { delete progressMap[task.data.taskId]; } catch (_) {} }, 30000);
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

app.get('/status/:taskId', (req, res) => {
  const p = progressMap[req.params.taskId];
  if (!p) return res.json({ step: 'unknown', progress: 0 });
  res.json(p);
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
  console.log('FFmpeg pool server running on port ' + PORT);
  console.log('Max workers: ' + getMaxWorkers() + ' (based on ' + Math.round(os.freemem() / 1024 / 1024) + 'MB free RAM)');
});

process.on('uncaughtException', (err) => console.error('Uncaught:', err.message));
