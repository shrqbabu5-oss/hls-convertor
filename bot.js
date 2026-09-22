const { Telegraf, Markup } = require("telegraf");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

require("dotenv").config();

/*
=========================================================
MOVIE PIPELINE BOT
=========================================================
Flow:
1. Ask Movie Name
2. Ask direct Video URL
3. FFmpeg -> movies/<movie-name>/<jobId>/
4. Save jobs.json ONLY after FFmpeg completes
5. Inline buttons for list/details/HF push/delete
6. HF upload -> movie/<movie-name>/<jobId>/
7. Verify remote files
8. Delete local movie folder ONLY after verified HF upload
=========================================================
*/

const CONFIG = {
  botToken: process.env.BOT_TOKEN,
  botName: process.env.BOT_NAME || "Movie Processor",
  adminId: process.env.ADMIN_ID || "",

  moviesDir: path.resolve(
    __dirname,
    process.env.MOVIES_DIR || "./movies"
  ),

  jobsFile: path.resolve(
    __dirname,
    process.env.JOBS_FILE || "./jobs.json"
  ),

  ffmpeg: {
    path: process.env.FFMPEG_PATH || "ffmpeg",
    hlsTime: Number(process.env.HLS_TIME || 6),
  },

  huggingface: {
    token: process.env.HF_TOKEN || "",
    repoId: process.env.HF_REPO_ID || "",
    repoType: process.env.HF_REPO_TYPE || "dataset",
  },
};

if (!CONFIG.botToken) {
  throw new Error("BOT_TOKEN is missing in .env");
}

fs.mkdirSync(CONFIG.moviesDir, { recursive: true });

let jobs = {};
const sessions = new Map();

/* =====================================================
   HELPERS
===================================================== */

function createMovieId() {
  return crypto.randomBytes(8).toString("hex");
}

function sanitizeMovieName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 100) || "movie";
}

function isValidUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let i = 0;

  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }

  return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function getRepo() {
  return {
    type: CONFIG.huggingface.repoType,
    name: CONFIG.huggingface.repoId,
  };
}

function getRemotePrefix(job) {
  return `movie/${job.movieName}/${job.id}`;
}

function getHFBaseUrl(job) {
  const type = CONFIG.huggingface.repoType;
  const prefix = getRemotePrefix(job);

  if (type === "dataset") {
    return `https://huggingface.co/datasets/${CONFIG.huggingface.repoId}/tree/main/${prefix}`;
  }

  if (type === "space") {
    return `https://huggingface.co/spaces/${CONFIG.huggingface.repoId}/tree/main/${prefix}`;
  }

  return `https://huggingface.co/${CONFIG.huggingface.repoId}/tree/main/${prefix}`;
}

async function getMovieStats(movieDir) {
  let segmentCount = 0;
  let totalBytes = 0;
  let playlistExists = false;
  let fileCount = 0;

  let files = [];

  try {
    files = await fsp.readdir(movieDir);
  } catch {
    return {
      segmentCount: 0,
      totalBytes: 0,
      playlistExists: false,
      fileCount: 0,
    };
  }

  for (const file of files) {
    const filePath = path.join(movieDir, file);

    try {
      const stat = await fsp.stat(filePath);

      if (!stat.isFile()) continue;

      fileCount++;

      if (file === "index.m3u8") {
        playlistExists = true;
      }

      if (file.endsWith(".ts")) {
        segmentCount++;
        totalBytes += stat.size;
      }
    } catch {
      // Ignore files disappearing during FFmpeg.
    }
  }

  return {
    segmentCount,
    totalBytes,
    playlistExists,
    fileCount,
  };
}

async function refreshJobStats(job) {
  const stats = await getMovieStats(job.movieDir);

  job.files.segmentCount = stats.segmentCount;
  job.files.totalBytes = stats.totalBytes;
  job.files.playlistExists = stats.playlistExists;
  job.files.fileCount = stats.fileCount;

  return stats;
}

async function saveJobs() {
  const tempFile = `${CONFIG.jobsFile}.tmp`;

  await fsp.writeFile(
    tempFile,
    JSON.stringify(jobs, null, 2),
    "utf8"
  );

  await fsp.rename(tempFile, CONFIG.jobsFile);
}

async function loadJobs() {
  try {
    const raw = await fsp.readFile(CONFIG.jobsFile, "utf8");
    jobs = JSON.parse(raw);

    for (const job of Object.values(jobs)) {
      if (!job.huggingface) {
        job.huggingface = {
          status: "pending",
          uploaded: 0,
          failed: 0,
          verified: false,
          remoteFiles: 0,
          error: null,
          startedAt: null,
          completedAt: null,
          remoteUrl: null,
          localDeleted: false,
        };
      }

      if (!job.files) {
        job.files = {
          segmentCount: 0,
          totalBytes: 0,
          playlistExists: false,
          fileCount: 0,
        };
      }

      if (!job.files.fileCount) {
        job.files.fileCount =
          Number(job.files.segmentCount || 0) +
          (job.files.playlistExists ? 1 : 0);
      }
    }

    console.log(
      `📄 Loaded ${Object.keys(jobs).length} jobs from jobs.json`
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      jobs = {};
      console.log("📄 jobs.json not found. It will be created after FFmpeg.");
      return;
    }

    throw error;
  }
}

function isAllowed(ctx) {
  if (!CONFIG.adminId) return true;
  return String(ctx.from?.id) === String(CONFIG.adminId);
}

async function ensureAllowed(ctx) {
  if (isAllowed(ctx)) return true;

  await ctx.reply("⛔ You are not authorized to use this bot.");
  return false;
}

function jobKeyboard(job) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("📊 Status", `status:${job.id}`),
      Markup.button.callback("☁️ HF Status", `hfstatus:${job.id}`),
    ],
    [
      Markup.button.callback("📤 Push to HF", `push:${job.id}`),
      Markup.button.callback("🗑 Delete Local", `delete:${job.id}`),
    ],
    [
      Markup.button.callback("🔎 Details", `details:${job.id}`),
    ],
  ]);
}

function homeKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🎬 New Movie", "newmovie"),
      Markup.button.callback("📚 Movies", "movies"),
    ],
    [
      Markup.button.callback("🔎 Find Job", "findjob"),
      Markup.button.callback("❓ Help", "help"),
    ],
  ]);
}

function movieStatusText(job) {
  return [
    "🎬 MOVIE STATUS",
    "",
    `🎞 Movie: ${job.movieName}`,
    `🆔 Job ID: ${job.id}`,
    "",
    `📊 Status: ${job.status}`,
    `⚙️ FFmpeg: ${job.ffmpeg?.status || "unknown"}`,
    `🎞 Segments: ${job.files?.segmentCount || 0}`,
    `📁 Files: ${job.files?.fileCount || 0}`,
    `💾 Size: ${formatBytes(job.files?.totalBytes || 0)}`,
    `📋 Playlist: ${job.files?.playlistExists ? "✅" : "❌"}`,
    "",
    `☁️ HF: ${job.huggingface?.status || "pending"}`,
    `📤 Uploaded: ${job.huggingface?.uploaded || 0}/${job.huggingface?.total || 0}`,
    `❌ Failed: ${job.huggingface?.failed || 0}`,
    `🔍 Verified: ${job.huggingface?.verified ? "✅" : "❌"}`,
    `🗑 Local: ${job.huggingface?.localDeleted ? "Deleted" : "Present"}`,
  ].join("\n");
}

function jobDetailsText(job) {
  return [
    "🎬 MOVIE DETAILS",
    "",
    `🎞 Movie: ${job.movieName}`,
    `🆔 Job ID: ${job.id}`,
    "",
    `📊 Status: ${job.status}`,
    `🔗 Source: ${job.sourceUrl}`,
    "",
    `📁 Local: ${job.movieDir}`,
    `🎞 Segments: ${job.files?.segmentCount || 0}`,
    `📁 Files: ${job.files?.fileCount || 0}`,
    `💾 Size: ${formatBytes(job.files?.totalBytes || 0)}`,
    `📋 Playlist: ${job.files?.playlistExists ? "✅" : "❌"}`,
    "",
    `☁️ HF Status: ${job.huggingface?.status || "pending"}`,
    `📤 Uploaded: ${job.huggingface?.uploaded || 0}/${job.huggingface?.total || 0}`,
    `❌ Failed: ${job.huggingface?.failed || 0}`,
    `🔍 Verified: ${job.huggingface?.verified ? "✅" : "❌"}`,
    `🗑 Local Deleted: ${job.huggingface?.localDeleted ? "✅" : "❌"}`,
    job.huggingface?.remoteUrl
      ? `\n☁️ ${job.huggingface.remoteUrl}`
      : "",
    job.huggingface?.error
      ? `\n❗ Error: ${job.huggingface.error}`
      : "",
  ].join("\n");
}

async function safeEdit(ctx, text, extra = {}) {
  try {
    await ctx.editMessageText(text, extra);
  } catch (error) {
    // Telegram throws when content is unchanged.
    if (!String(error.message).toLowerCase().includes("message is not modified")) {
      throw error;
    }
  }
}

/* =====================================================
   JOB CREATION
===================================================== */

async function createJob(movieName, sourceUrl) {
  const id = createMovieId();
  const safeMovieName = sanitizeMovieName(movieName);

  const movieDir = path.join(
  CONFIG.moviesDir,
  safeMovieName,
  id
);

  await fsp.mkdir(movieDir, { recursive: true });

  const job = {
    id,
    movieName: safeMovieName,
    displayMovieName: movieName.trim(),
    sourceUrl,

    status: "queued",

    createdAt: new Date().toISOString(),
    completedAt: null,

    movieDir,

    ffmpeg: {
      status: "pending",
      pid: null,
      error: null,
    },

    files: {
      segmentCount: 0,
      totalBytes: 0,
      playlistExists: false,
      fileCount: 0,
    },

    huggingface: {
      status: "pending",
      uploaded: 0,
      failed: 0,
      total: 0,
      verified: false,
      remoteFiles: 0,
      error: null,
      startedAt: null,
      completedAt: null,
      remoteUrl: null,
      localDeleted: false,
    },
  };

  jobs[id] = job;

  // IMPORTANT:
  // jobs.json is NOT written here.
  // It is written only after FFmpeg completes/fails.
  return job;
}

/* =====================================================
   FFMPEG
===================================================== */

function startFFmpeg(job) {
  return new Promise((resolve, reject) => {
    const outputDir = job.movieDir;

    const playlist = path.join(
      outputDir,
      "index.m3u8"
    );

    const segmentPattern = path.join(
      outputDir,
      "segment_%05d.ts"
    );

    const args = [
      "-hide_banner",
      "-y",

      "-i",
      job.sourceUrl,

      "-map",
      "0:v:0",

      "-map",
      "0:a:0?",

      "-c:v",
      "copy",

      "-c:a",
      "aac",

      "-b:a",
      "128k",

      "-fflags",
      "+genpts",

      "-avoid_negative_ts",
      "make_zero",

      "-f",
      "hls",

      "-hls_time",
      String(CONFIG.ffmpeg.hlsTime),

      "-hls_playlist_type",
      "event",

      "-hls_flags",
      "independent_segments",

      "-hls_segment_filename",
      segmentPattern,

      playlist,
    ];

    console.log("");
    console.log("=================================");
    console.log(`🎬 FFmpeg starting: ${job.id}`);
    console.log(`🎞 Movie: ${job.movieName}`);
    console.log(`🔗 URL: ${job.sourceUrl}`);
    console.log(`📁 Output: ${outputDir}`);
    console.log("=================================");
    console.log("");

    const ffmpeg = spawn(
      CONFIG.ffmpeg.path,
      args,
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    job.ffmpeg.status = "processing";
    job.ffmpeg.pid = ffmpeg.pid;
    job.status = "processing";

    ffmpeg.stdout.on("data", data => {
      process.stdout.write(`[FFmpeg] ${data}`);
    });

    ffmpeg.stderr.on("data", async data => {
      process.stderr.write(`[FFmpeg] ${data}`);

      try {
        await refreshJobStats(job);
      } catch {
        // Ignore temporary stats errors.
      }
    });

    let settled = false;

    ffmpeg.on("error", async error => {
      if (settled) return;
      settled = true;

      job.status = "failed";
      job.ffmpeg.status = "failed";
      job.ffmpeg.pid = null;
      job.ffmpeg.error = error.message;

      try {
        await refreshJobStats(job);
        await saveJobs();
      } catch (saveError) {
        console.error("❌ Could not save failed job:", saveError);
      }

      reject(error);
    });

    ffmpeg.on("close", async code => {
      if (settled) return;
      settled = true;

      try {
        await refreshJobStats(job);

        job.ffmpeg.pid = null;

        if (code === 0) {
          job.status = "ffmpeg_completed";
          job.ffmpeg.status = "completed";
          job.completedAt = new Date().toISOString();

          // jobs.json is created/updated HERE.
          await saveJobs();

          console.log("");
          console.log("=================================");
          console.log(`✅ FFmpeg completed: ${job.id}`);
          console.log(`🎞 Movie: ${job.movieName}`);
          console.log(`🎞 Segments: ${job.files.segmentCount}`);
          console.log(`📁 Files: ${job.files.fileCount}`);
          console.log(`💾 Bytes: ${job.files.totalBytes}`);
          console.log(
            `📋 Playlist: ${job.files.playlistExists ? "YES" : "NO"}`
          );
          console.log("=================================");
          console.log("");

          resolve(job);
        } else {
          job.status = "failed";
          job.ffmpeg.status = "failed";
          job.ffmpeg.error = `FFmpeg exited with code ${code}`;

          await saveJobs();

          reject(
            new Error(`FFmpeg exited with code ${code}`)
          );
        }
      } catch (error) {
        reject(error);
      }
    });
  });
}

/* =====================================================
   HUGGING FACE
===================================================== */

async function getHF() {
  if (!CONFIG.huggingface.token) {
    throw new Error("HF_TOKEN is missing in .env");
  }

  if (!CONFIG.huggingface.repoId) {
    throw new Error("HF_REPO_ID is missing in .env");
  }

  // @huggingface/hub is ESM, so use dynamic import in this CommonJS bot.
  return import("@huggingface/hub");
}

async function collectLocalFiles(dir) {
  const result = [];

  async function walk(currentDir, relativeDir = "") {
    const entries = await fsp.readdir(currentDir, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = relativeDir
        ? path.join(relativeDir, entry.name)
        : entry.name;

      if (entry.isDirectory()) {
        await walk(fullPath, relativePath);
      } else if (entry.isFile()) {
        result.push({
          fullPath,
          relativePath: relativePath.split(path.sep).join("/"),
        });
      }
    }
  }

  await walk(dir);
  return result;
}

async function verifyHFUpload(job) {
  const hf = await getHF();

  const remotePrefix = getRemotePrefix(job);

  let remoteFiles = 0;
  const expected = Number(job.huggingface.total || job.files.fileCount || 0);

  for await (const item of hf.listFiles({
    repo: getRepo(),
    accessToken: CONFIG.huggingface.token,
    path: remotePrefix,
    recursive: true,
  })) {
    if (item.type === "file") {
      remoteFiles++;
    }
  }

  job.huggingface.remoteFiles = remoteFiles;
  job.huggingface.verified =
    expected > 0 && remoteFiles >= expected;

  return job.huggingface.verified;
}

async function deleteLocalMovie(job) {
  if (!job.movieDir) return;

  try {
    await fsp.rm(job.movieDir, {
      recursive: true,
      force: true,
    });

    // Remove empty movie-name parent too.
    const parentDir = path.dirname(job.movieDir);

    try {
      const remaining = await fsp.readdir(parentDir);
      if (!remaining.length) {
        await fsp.rmdir(parentDir);
      }
    } catch {
      // Parent may already be gone.
    }

    job.huggingface.localDeleted = true;
  } catch (error) {
    job.huggingface.localDeleted = false;
    throw error;
  }
}

async function pushToHuggingFace(job, onProgress) {
  if (job.status !== "ffmpeg_completed" && job.status !== "hf_failed") {
    throw new Error(
      `FFmpeg is not ready. Current status: ${job.status}`
    );
  }

  if (job.huggingface.status === "uploading") {
    throw new Error("Hugging Face upload is already running.");
  }

  await refreshJobStats(job);

  if (!job.files.playlistExists || job.files.segmentCount <= 0) {
    throw new Error("HLS files are incomplete.");
  }

  const hf = await getHF();
  const files = await collectLocalFiles(job.movieDir);

  if (!files.length) {
    throw new Error("No local files found to upload.");
  }

  const remotePrefix = getRemotePrefix(job);

  job.huggingface.status = "uploading";
  job.huggingface.total = files.length;
  job.huggingface.uploaded = 0;
  job.huggingface.failed = 0;
  job.huggingface.verified = false;
  job.huggingface.remoteFiles = 0;
  job.huggingface.error = null;
  job.huggingface.startedAt = new Date().toISOString();

  await saveJobs();

  onProgress?.(job);

  const uploadEntries = files.map(file => ({
    path: `${remotePrefix}/${file.relativePath}`,
    content: require("url").pathToFileURL(file.fullPath),
  }));

  try {
    /*
      uploadFilesWithProgress is used when available.
      We still fall back to uploadFiles so the pipeline works
      if the installed hub package does not expose the progress helper.
    */
    if (typeof hf.uploadFilesWithProgress === "function") {
      for await (const event of await hf.uploadFilesWithProgress({
        repo: getRepo(),
        accessToken: CONFIG.huggingface.token,
        files: uploadEntries,
      })) {
        // The exact progress event shape may evolve between hub versions.
        const possibleCounts = [
          event?.uploaded,
          event?.uploadedFiles,
          event?.completed,
          event?.done,
        ];

        const count = possibleCounts.find(
          value => Number.isFinite(Number(value))
        );

        if (count !== undefined) {
          job.huggingface.uploaded = Math.min(
            files.length,
            Number(count)
          );
        }

        onProgress?.(job);
      }
    } else {
      await hf.uploadFiles({
        repo: getRepo(),
        accessToken: CONFIG.huggingface.token,
        files: uploadEntries,
      });

      job.huggingface.uploaded = files.length;
      onProgress?.(job);
    }

    // Upload API returned successfully.
    job.huggingface.uploaded = files.length;
    job.huggingface.status = "verifying";

    await saveJobs();
    onProgress?.(job);

    const verified = await verifyHFUpload(job);

    if (!verified) {
      throw new Error(
        `HF verification failed. Expected ${files.length} files, found ${job.huggingface.remoteFiles}.`
      );
    }

    job.huggingface.status = "uploaded";
    job.huggingface.completedAt = new Date().toISOString();
    job.huggingface.remoteUrl = getHFBaseUrl(job);
    job.huggingface.error = null;

    await deleteLocalMovie(job);

    await saveJobs();

    onProgress?.(job);

    return job;
  } catch (error) {
    job.huggingface.status = "failed";
    job.huggingface.failed = Math.max(
      1,
      Number(job.huggingface.total || 1) -
      Number(job.huggingface.uploaded || 0)
    );
    job.huggingface.error = error.message;

    await saveJobs();

    onProgress?.(job);

    throw error;
  }
}

/* =====================================================
   SEND / EDIT JOB CARD
===================================================== */

async function sendJobCard(ctx, job) {
  await refreshJobStats(job);

  return ctx.reply(
    [
      "🎬 MOVIE",
      "",
      `🎞 ${job.movieName}`,
      `🆔 ${job.id}`,
      `📊 ${job.status}`,
      `🎞 Segments: ${job.files.segmentCount}`,
      `💾 ${formatBytes(job.files.totalBytes)}`,
      "",
      `☁️ HF: ${job.huggingface.status}`,
    ].join("\n"),
    jobKeyboard(job)
  );
}

async function showJobStatus(ctx, job) {
  await refreshJobStats(job);

  if (job.status === "ffmpeg_completed" || job.status === "hf_failed") {
    // Keep persistent stats up to date.
    await saveJobs();
  }

  return safeEdit(
    ctx,
    movieStatusText(job),
    jobKeyboard(job)
  );
}

/* =====================================================
   START / HELP
===================================================== */

bot.start(async ctx => {
  if (!(await ensureAllowed(ctx))) return;

  sessions.delete(ctx.from.id);

  await ctx.reply(
    [
      `🎬 ${CONFIG.botName}`,
      "",
      "Movie processing pipeline ready.",
      "",
      "🎞 New Movie → Movie Name → Video URL",
      "⚙️ FFmpeg → HLS",
      "☁️ Push → Hugging Face",
      "🔍 Verify → Local delete",
    ].join("\n"),
    homeKeyboard()
  );
});

bot.help(async ctx => {
  if (!(await ensureAllowed(ctx))) return;

  await ctx.reply(
    [
      "📖 MOVIE PIPELINE",
      "",
      "🎬 New Movie — create a new FFmpeg job",
      "📚 Movies — show saved jobs",
      "🔎 Find Job — search by Job ID",
      "📊 Status — FFmpeg/HF/local status",
      "📤 Push to HF — upload HLS folder",
      "🗑 Delete Local — delete local folder",
      "",
      "jobs.json is written after FFmpeg finishes.",
    ].join("\n"),
    homeKeyboard()
  );
});

/* =====================================================
   NEW MOVIE
===================================================== */

bot.action("newmovie", async ctx => {
  if (!(await ensureAllowed(ctx))) return;

  await ctx.answerCbQuery();

  sessions.set(ctx.from.id, {
    step: "movie_name",
  });

  await ctx.reply(
    [
      "🎬 NEW MOVIE",
      "",
      "Movie name bhejo.",
      "",
      "Example:",
      "Pushpa 2",
    ].join("\n")
  );
});

/* =====================================================
   MOVIES LIST
===================================================== */

async function sendMoviesList(ctx, edit = false) {
  const list = Object.values(jobs)
    .sort(
      (a, b) =>
        new Date(b.createdAt || 0) -
        new Date(a.createdAt || 0)
    );

  if (!list.length) {
    const text = [
      "📚 MOVIES",
      "",
      "Koi completed/saved job nahi hai.",
    ].join("\n");

    if (edit) {
      return safeEdit(ctx, text, homeKeyboard());
    }

    return ctx.reply(text, homeKeyboard());
  }

  if (edit) {
    await safeEdit(
      ctx,
      `📚 MOVIES\n\nTotal: ${list.length}\n\nMovie select karein:`,
      Markup.inlineKeyboard(
        list.slice(0, 30).map(job => [
          Markup.button.callback(
            `🎬 ${job.movieName} • ${job.id.slice(0, 8)}`,
            `details:${job.id}`
          ),
        ]).concat([
          [
            Markup.button.callback("🔎 Find Job", "findjob"),
            Markup.button.callback("🏠 Home", "home"),
          ],
        ])
      )
    );
    return;
  }

  await ctx.reply(
    `📚 MOVIES\n\nTotal: ${list.length}\n\nMovie select karein:`,
    Markup.inlineKeyboard(
      list.slice(0, 30).map(job => [
        Markup.button.callback(
          `🎬 ${job.movieName} • ${job.id.slice(0, 8)}`,
          `details:${job.id}`
        ),
      ]).concat([
        [
          Markup.button.callback("🔎 Find Job", "findjob"),
          Markup.button.callback("🏠 Home", "home"),
        ],
      ])
    )
  );
}

bot.action("movies", async ctx => {
  if (!(await ensureAllowed(ctx))) return;

  await ctx.answerCbQuery();
  await sendMoviesList(ctx, true);
});

/* =====================================================
   FIND JOB
===================================================== */

bot.action("findjob", async ctx => {
  if (!(await ensureAllowed(ctx))) return;

  await ctx.answerCbQuery();

  sessions.set(ctx.from.id, {
    step: "job_id",
  });

  await ctx.reply(
    [
      "🔎 FIND JOB",
      "",
      "Job ID bhejo.",
      "",
      "Example:",
      "68cc81460a3a8e27",
    ].join("\n"),
    Markup.inlineKeyboard([
      [Markup.button.callback("🏠 Home", "home")],
    ])
  );
});

/* =====================================================
   HOME
===================================================== */

bot.action("home", async ctx => {
  if (!(await ensureAllowed(ctx))) return;

  await ctx.answerCbQuery();

  sessions.delete(ctx.from.id);

  await safeEdit(
    ctx,
    [
      `🎬 ${CONFIG.botName}`,
      "",
      "Choose an action:",
    ].join("\n"),
    homeKeyboard()
  );
});

/* =====================================================
   HELP INLINE
===================================================== */

bot.action("help", async ctx => {
  if (!(await ensureAllowed(ctx))) return;

  await ctx.answerCbQuery();

  await safeEdit(
    ctx,
    [
      "📖 MOVIE PIPELINE",
      "",
      "🎬 New Movie — Movie Name + URL",
      "📚 Movies — saved jobs",
      "🔎 Find Job — search by ID",
      "📊 Status — full status",
      "📤 Push — upload to HF",
      "☁️ HF Status — remote upload status",
      "🗑 Delete Local — remove local files",
    ].join("\n"),
    homeKeyboard()
  );
});

/* =====================================================
   JOB DETAILS
===================================================== */

bot.action(/^details:(.+)$/, async ctx => {
  if (!(await ensureAllowed(ctx))) return;

  await ctx.answerCbQuery();

  const id = ctx.match[1];
  const job = jobs[id];

  if (!job) {
    return safeEdit(
      ctx,
      "❌ Job not found.",
      homeKeyboard()
    );
  }

  await refreshJobStats(job);

  return safeEdit(
    ctx,
    jobDetailsText(job),
    jobKeyboard(job)
  );
});

/* =====================================================
   JOB STATUS
===================================================== */

bot.action(/^status:(.+)$/, async ctx => {
  if (!(await ensureAllowed(ctx))) return;

  await ctx.answerCbQuery();

  const job = jobs[ctx.match[1]];

  if (!job) {
    return safeEdit(ctx, "❌ Job not found.", homeKeyboard());
  }

  return showJobStatus(ctx, job);
});

/* =====================================================
   HF STATUS
===================================================== */

bot.action(/^hfstatus:(.+)$/, async ctx => {
  if (!(await ensureAllowed(ctx))) return;

  await ctx.answerCbQuery();

  const job = jobs[ctx.match[1]];

  if (!job) {
    return safeEdit(ctx, "❌ Job not found.", homeKeyboard());
  }

  const text = [
    "☁️ HUGGING FACE STATUS",
    "",
    `🎞 Movie: ${job.movieName}`,
    `🆔 ${job.id}`,
    "",
    `📊 Status: ${job.huggingface.status}`,
    `📤 Uploaded: ${job.huggingface.uploaded}/${job.huggingface.total}`,
    `❌ Failed: ${job.huggingface.failed}`,
    `🔍 Verified: ${job.huggingface.verified ? "✅" : "❌"}`,
    `📡 Remote files: ${job.huggingface.remoteFiles}`,
    `🗑 Local deleted: ${job.huggingface.localDeleted ? "✅" : "❌"}`,
    job.huggingface.remoteUrl
      ? `\n🔗 ${job.huggingface.remoteUrl}`
      : "",
    job.huggingface.error
      ? `\n❗ ${job.huggingface.error}`
      : "",
  ].join("\n");

  return safeEdit(
    ctx,
    text,
    Markup.inlineKeyboard([
      [
        Markup.button.callback("🔄 Refresh", `hfstatus:${job.id}`),
        Markup.button.callback("📊 Details", `details:${job.id}`),
      ],
      [
        Markup.button.callback("🏠 Home", "home"),
      ],
    ])
  );
});

/* =====================================================
   PUSH TO HF
===================================================== */

const activeHFUploads = new Set();

bot.action(/^push:(.+)$/, async ctx => {
  if (!(await ensureAllowed(ctx))) return;

  await ctx.answerCbQuery();

  const job = jobs[ctx.match[1]];

  if (!job) {
    return safeEdit(ctx, "❌ Job not found.", homeKeyboard());
  }

  if (activeHFUploads.has(job.id)) {
    return safeEdit(
      ctx,
      "⏳ Hugging Face upload already running.",
      jobKeyboard(job)
    );
  }

  if (
    job.status !== "ffmpeg_completed" &&
    job.status !== "hf_failed"
  ) {
    return safeEdit(
      ctx,
      [
        "⏳ NOT READY",
        "",
        `🎞 Movie: ${job.movieName}`,
        `🆔 ${job.id}`,
        "",
        `FFmpeg status: ${job.ffmpeg.status}`,
        `Job status: ${job.status}`,
        "",
        "FFmpeg complete hone ke baad Push available hoga.",
      ].join("\n"),
      jobKeyboard(job)
    );
  }

  if (job.huggingface.localDeleted) {
    return safeEdit(
      ctx,
      "✅ Local files already deleted after successful HF verification.",
      jobKeyboard(job)
    );
  }

  activeHFUploads.add(job.id);

  let lastUpdate = 0;

  try {
    await safeEdit(
      ctx,
      [
        "📤 HUGGING FACE UPLOAD",
        "",
        `🎞 Movie: ${job.movieName}`,
        `🆔 ${job.id}`,
        "",
        "⏳ Preparing files...",
      ].join("\n"),
      jobKeyboard(job)
    );

    await pushToHuggingFace(job, async currentJob => {
      const now = Date.now();

      // Avoid Telegram edit flood.
      if (now - lastUpdate < 1500) return;
      lastUpdate = now;

      try {
        await safeEdit(
          ctx,
          [
            "📤 HUGGING FACE UPLOAD",
            "",
            `🎞 Movie: ${currentJob.movieName}`,
            `🆔 ${currentJob.id}`,
            "",
            `☁️ Status: ${currentJob.huggingface.status}`,
            `📤 Uploaded: ${currentJob.huggingface.uploaded}/${currentJob.huggingface.total}`,
            `❌ Failed: ${currentJob.huggingface.failed}`,
            `🔍 Verified: ${currentJob.huggingface.verified ? "✅" : "⏳"}`,
            `🗑 Local: ${currentJob.huggingface.localDeleted ? "Deleted ✅" : "Present"}`,
          ].join("\n          "),
          jobKeyboard(currentJob)
        );
      } catch (error) {
        console.error("❌ HF progress edit failed:", error.message);
      }
    });

    await safeEdit(
      ctx,
      [
        "✅ HUGGING FACE UPLOAD COMPLETED",
        "",
        `🎞 Movie: ${job.movieName}`,
        `🆔 ${job.id}`,
        "",
        `📤 Uploaded: ${job.huggingface.uploaded}/${job.huggingface.total}`,
        `📡 Remote: ${job.huggingface.remoteFiles}`,
        "🔍 Verified: ✅",
        "🗑 Local files: DELETED ✅",
        "",
        `☁️ ${job.huggingface.remoteUrl || getHFBaseUrl(job)}`,
      ].join("\n"),
      jobKeyboard(job)
    );
  } catch (error) {
    console.error(`❌ HF upload failed: ${job.id}`, error);

    await safeEdit(
      ctx,
      [
        "❌ HUGGING FACE UPLOAD FAILED",
        "",
        `🎞 Movie: ${job.movieName}`,
        `🆔 ${job.id}`,
        "",
        `📤 Uploaded: ${job.huggingface.uploaded}/${job.huggingface.total}`,
        `❌ Failed: ${job.huggingface.failed}`,
        "",
        `Error: ${error.message}`,
        "",
        "Local files were NOT deleted.",
      ].join("\n"),
      jobKeyboard(job)
    );
  } finally {
    activeHFUploads.delete(job.id);
  }
});

/* =====================================================
   DELETE LOCAL
===================================================== */

bot.action(/^delete:(.+)$/, async ctx => {
  if (!(await ensureAllowed(ctx))) return;

  await ctx.answerCbQuery();

  const job = jobs[ctx.match[1]];

  if (!job) {
    return safeEdit(ctx, "❌ Job not found.", homeKeyboard());
  }

  if (job.huggingface.status !== "uploaded" || !job.huggingface.verified) {
    return safeEdit(
      ctx,
      [
        "⛔ LOCAL DELETE BLOCKED",
        "",
        `🎞 Movie: ${job.movieName}`,
        `🆔 ${job.id}`,
        "",
        "Safety rule:",
        "Local files sirf successful HF upload + verification ke baad delete honge.",
        "",
        `☁️ HF: ${job.huggingface.status}`,
        `🔍 Verified: ${job.huggingface.verified ? "✅" : "❌"}`,
      ].join("\n"),
      jobKeyboard(job)
    );
  }

  if (job.huggingface.localDeleted) {
    return safeEdit(
      ctx,
      "✅ Local files already deleted.",
      jobKeyboard(job)
    );
  }

  try {
    await deleteLocalMovie(job);
    await saveJobs();

    await safeEdit(
      ctx,
      [
        "🗑 LOCAL FILES DELETED",
        "",
        `🎞 Movie: ${job.movieName}`,
        `🆔 ${job.id}`,
        "",
        "☁️ HF verified: ✅",
        "🗑 Local: deleted ✅",
      ].join("\n"),
      jobKeyboard(job)
    );
  } catch (error) {
    await safeEdit(
      ctx,
      [
        "❌ DELETE FAILED",
        "",
        `Error: ${error.message}`,
      ].join("\n"),
      jobKeyboard(job)
    );
  }
});

/* =====================================================
   TEXT INPUT FLOW
===================================================== */

bot.on("text", async ctx => {
  if (!(await ensureAllowed(ctx))) return;

  const text = ctx.message.text.trim();

  if (text.startsWith("/")) {
    return;
  }

  const session = sessions.get(ctx.from.id);

  if (!session) {
    return ctx.reply(
      "👇 Menu se action select karo.",
      homeKeyboard()
    );
  }

  /* -----------------------------------------------
     MOVIE NAME
  ------------------------------------------------ */

  if (session.step === "movie_name") {
    if (text.length < 1 || text.length > 150) {
      return ctx.reply(
        "❌ Movie name 1–150 characters ka hona chahiye."
      );
    }

    session.movieName = text;
    session.step = "video_url";

    sessions.set(ctx.from.id, session);

    return ctx.reply(
      [
        "🎬 Movie Name:",
        session.movieName,
        "",
        "🔗 Ab direct video URL bhejo.",
        "",
        "Example:",
        "https://example.com/movie.mp4",
      ].join("\n")
    );
  }

  /* -----------------------------------------------
     VIDEO URL
  ------------------------------------------------ */

  if (session.step === "video_url") {
    if (!isValidUrl(text)) {
      return ctx.reply(
        [
          "❌ Invalid URL.",
          "",
          "Valid http/https direct video URL bhejo.",
        ].join("\n")
      );
    }

    const movieName = session.movieName;

    sessions.delete(ctx.from.id);

    try {
      const job = await createJob(
        movieName,
        text
      );

      await ctx.reply(
        [
          "🚀 MOVIE JOB CREATED",
          "",
          `🎞 Movie: ${job.movieName}`,
          `🆔 Job ID: ${job.id}`,
          "",
          "🔗 Source URL received",
          `📁 ${job.movieDir}`,
          "",
          "⚙️ FFmpeg: starting...",
          "☁️ Hugging Face: pending",
        ].join("\n"),
        jobKeyboard(job)
      );

      console.log(`🎬 Job created: ${job.id}`);

      // Run FFmpeg in background.
      startFFmpeg(job)
        .then(async finishedJob => {
          console.log(
            `✅ FFmpeg completed: ${finishedJob.id}`
          );

          try {
            await ctx.reply(
              [
                "✅ FFMPEG COMPLETED",
                "",
                `🎞 Movie: ${finishedJob.movieName}`,
                `🆔 ${finishedJob.id}`,
                "",
                `🎞 Segments: ${finishedJob.files.segmentCount}`,
                `📁 Files: ${finishedJob.files.fileCount}`,
                `💾 Size: ${formatBytes(finishedJob.files.totalBytes)}`,
                `📋 Playlist: ${
                  finishedJob.files.playlistExists ? "✅" : "❌"
                }`,
                "",
                "☁️ Hugging Face: pending",
                "",
                "📤 Push to HF button se upload start karo.",
              ].join("\n"),
              jobKeyboard(finishedJob)
            );
          } catch (telegramError) {
            console.error(
              "❌ Telegram reply failed:",
              telegramError.message
            );
          }
        })
        .catch(async error => {
          console.error(
            `❌ FFmpeg failed: ${job.id}`,
            error
          );

          try {
            await ctx.reply(
              [
                "❌ FFMPEG FAILED",
                "",
                `🎞 Movie: ${job.movieName}`,
                `🆔 ${job.id}`,
                "",
                `Error: ${error.message}`,
              ].join("\n"),
              jobKeyboard(job)
            );
          } catch (telegramError) {
            console.error(
              "❌ Telegram reply failed:",
              telegramError.message
            );
          }
        });

      return;
    } catch (error) {
      console.error("❌ Job creation failed:", error);

      return ctx.reply(
        `❌ Job failed:\n${error.message}`,
        homeKeyboard()
      );
    }
  }

  /* -----------------------------------------------
     FIND JOB BY ID
  ------------------------------------------------ */

  if (session.step === "job_id") {
    const id = text;

    sessions.delete(ctx.from.id);

    const job = jobs[id];

    if (!job) {
      return ctx.reply(
        [
          "❌ JOB NOT FOUND",
          "",
          `ID: ${id}`,
        ].join("\n"),
        homeKeyboard()
      );
    }

    await refreshJobStats(job);

    return ctx.reply(
      jobDetailsText(job),
      jobKeyboard(job)
    );
  }

  sessions.delete(ctx.from.id);

  return ctx.reply(
    "👇 Menu se action select karo.",
    homeKeyboard()
  );
});

/* =====================================================
   ERROR HANDLER
===================================================== */

bot.catch((error, ctx) => {
  console.error(
    `❌ Bot error for ${ctx?.updateType || "unknown"}:`,
    error
  );
});

/* =====================================================
   START
===================================================== */

async function main() {
  console.log("=================================");
  console.log("🎬 Movie Pipeline Bot");
  console.log("=================================");
  console.log(`📁 Movies: ${CONFIG.moviesDir}`);
  console.log(`📄 Jobs: ${CONFIG.jobsFile}`);
  console.log(`⚙️ FFmpeg: ${CONFIG.ffmpeg.path}`);
  console.log(`⏱ HLS Time: ${CONFIG.ffmpeg.hlsTime}s`);
  console.log(
    `☁️ HF Repo: ${CONFIG.huggingface.repoId || "NOT SET"}`
  );
  console.log(
    `☁️ HF Type: ${CONFIG.huggingface.repoType}`
  );

  await loadJobs();
  await bot.launch();

  console.log("🤖 Bot started.");
}

/* =====================================================
   SHUTDOWN
===================================================== */

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

main().catch(error => {
  console.error("❌ Fatal:", error);
  process.exit(1);
});
