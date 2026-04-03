const express = require("express");
const puppeteer = require("puppeteer");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
const { PassThrough } = require("stream");
const { spawn } = require("child_process");
const os = require("os");

const app = express();

const VERSION = "2.0"; // version 2.0 logging
const ZIP_CODE = process.env.ZIP_CODE || "90210";
const WS4KP_HOST = process.env.WS4KP_HOST || "localhost";
const WS4KP_PORT = process.env.WS4KP_PORT || "8080";
const WS4KP_PERMALINK = process.env.PERMALINK || "localhost:8080";
const STREAM_PORT = process.env.STREAM_PORT || "9798";
const WS4KP_URL = `http://${WS4KP_HOST}:${WS4KP_PORT}`;
const HLS_SETUP_DELAY = 2000;
const FRAME_RATE = process.env.FRAME_RATE || 10;
const ENABLE_HDHR = process.env.ENABLE_HDHR?.toLowerCase() === "true";
const HDHR_DEVICE_ID = process.env.HDHR_DEVICE_ID || "A1B2C3D4";
const HDHR_CHANNEL_NUMBER = process.env.HDHR_CHANNEL_NUMBER || "275";
const HDHR_CHANNEL_NAME = process.env.HDHR_CHANNEL_NAME || "WeatherStar 4000";

const OUTPUT_DIR = path.join(__dirname, "output");
const AUDIO_DIR = path.join(__dirname, "music");
const LOGO_DIR = path.join(__dirname, "logo");
const HLS_FILE = path.join(OUTPUT_DIR, "stream.m3u8");

[OUTPUT_DIR, AUDIO_DIR, LOGO_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

app.use("/stream", express.static(OUTPUT_DIR));
app.use("/logo", express.static(LOGO_DIR));

let ffmpegProc = null;
let ffmpegStream = null;
let browser = null;
let page = null;
let captureInterval = null;
let isStreamReady = false;

const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper: Fisher–Yates shuffle
function shuffleArray(array) {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getContainerLimits() {
  let cpuQuotaPath = "/sys/fs/cgroup/cpu.max";
  let memLimitPath = "/sys/fs/cgroup/memory.max";
  let cpus = os.cpus().length;
  let memory = os.totalmem();
  try {
    const [quota, period] = fs
      .readFileSync(cpuQuotaPath, "utf8")
      .trim()
      .split(" ");
    if (quota !== "max")
      cpus = parseFloat((parseInt(quota) / parseInt(period)).toFixed(2));
  } catch {}
  try {
    const raw = fs.readFileSync(memLimitPath, "utf8").trim();
    if (raw !== "max") memory = parseInt(raw);
  } catch {}
  return { cpus, memoryMB: Math.round(memory / (1024 * 1024)) };
}

function createAudioInputFile() {
  const defaultMp3s = [
    "01 Weatherscan Track 26.mp3",
    "02 Weatherscan Track 3.mp3",
    "03 Tropical Breeze.mp3",
    "04 Late Nite Cafe.mp3",
    "05 Care Free.mp3",
    "06 Weatherscan Track 14.mp3",
    "07 Weatherscan Track 18.mp3",
  ];

  let files = [];
  try {
    // Read only MP3 files from AUDIO_DIR
    files = fs
      .readdirSync(AUDIO_DIR)
      .filter((file) => file.toLowerCase().endsWith(".mp3"));
    if (files.length === 0) {
      console.warn(
        "No MP3 files found in music directory; using default music list",
      );
      files = defaultMp3s;
    }
  } catch (err) {
    console.error(`Failed to read music directory: ${err.message}`);
    console.warn("Using default music list due to error");
    files = defaultMp3s;
  }

  // Shuffle if requested
  if (process.env.SHUFFLE_MUSIC?.toLowerCase() === "true") {
    files = shuffleArray(files);
    console.log("Shuffled music list based on SHUFFLE_MUSIC=true");
  }

  console.log(`Loaded ${files.length} music files`);
  const audioList = files
    .map((file) => `file '${path.join(AUDIO_DIR, file)}'`)
    .join("\n");
  fs.writeFileSync(path.join(__dirname, "audio_list.txt"), audioList);

  // Note: Update README to inform users they can add MP3 files to the 'music' folder
  // and that the default files (listed above) are used if no MP3s are found.
}

function generateXMLTV(host) {
  const now = new Date();
  const baseUrl = `http://${host}`;
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv>
<channel id="WS4000">
<display-name>WeatherStar 4000</display-name>
<icon src="${baseUrl}/logo/ws4000.png" />
</channel>`;
  for (let i = 0; i < 24; i++) {
    const startTime = new Date(now.getTime() + i * 3600 * 1000);
    const endTime = new Date(startTime.getTime() + 3600 * 1000);
    const start =
      startTime.toISOString().replace(/[-:T]/g, "").split(".")[0] + " +0000";
    const end =
      endTime.toISOString().replace(/[-:T]/g, "").split(".")[0] + " +0000";
    xml += `
<programme start="${start}" stop="${end}" channel="WS4000">
<title lang="en">Local Weather</title>
<desc lang="en">Enjoy your local weather with a touch of nostalgia.</desc>
<icon src="${baseUrl}/logo/ws4000.png" />
</programme>`;
  }
  xml += `</tv>`;
  return xml;
}

async function startBrowser() {
  if (browser) await browser.close().catch(() => {});
  browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-infobars",
      "--ignore-certificate-errors",
      "--window-size=1280,720",
    ],
    defaultViewport: null,
  });
  page = await browser.newPage();
  await page.goto(WS4KP_URL, { waitUntil: "networkidle2", timeout: 30000 });
  try {
    const zipInput = await page.waitForSelector(
      'input[placeholder="Zip or City, State"], input',
      { timeout: 5000 },
    );
    if (zipInput) {
      await zipInput.type(ZIP_CODE, { delay: 100 });
      await waitFor(1000);
      await page.keyboard.press("ArrowDown");
      await waitFor(500);
      const goButton = await page.$('button[type="submit"]');
      if (goButton) await goButton.click();
      else await zipInput.press("Enter");
      await page.waitForSelector("div.weather-display, #weather-content", {
        timeout: 30000,
      });
    }
  } catch {}
  await page.setViewport({ width: 1280, height: 720 });
}

async function startTranscoding() {
  await startBrowser();
  createAudioInputFile();
  ffmpegStream = new PassThrough();
  ffmpegProc = ffmpeg()
    .inputOptions(['-hwaccel vaapi', '-hwaccel_device /dev/dri', '-hwaccel_output_format vaapi'])
    .input(ffmpegStream)
    .inputFormat("image2pipe")
    .inputOptions([`-framerate ${FRAME_RATE}`])
    .input(path.join(__dirname, "audio_list.txt"))
    .inputOptions(["-f concat", "-safe 0", "-stream_loop -1"])
    .complexFilter([
      "[0:v]scale=1280:720:flags=fast_bilinear[v]",
      "[1:a]volume=0.5[a]",
    ])
    .outputOptions([
      "-map [v]",
      "-map [a]",
      "-c:v libx264",
      "-c:a aac",
      "-b:a 128k",
      "-preset ultrafast",
      "-tune zerolatency",
      "-pix_fmt yuv420p",
      "-b:v 1000k",
      "-maxrate 1500k",
      "-bufsize 2000k",
      `-g ${FRAME_RATE * 2}`,
      "-sc_threshold 0",
      "-threads 0",
      "-f hls",
      "-hls_time 2",
      "-hls_list_size 2",
      "-hls_flags delete_segments",
    ])
    .output(HLS_FILE)
    .on("start", () => {
      console.log(`Started FFmpeg - Version ${VERSION}`);
      setTimeout(() => (isStreamReady = true), HLS_SETUP_DELAY);
    })
    .on("error", async (err) => {
      console.error("FFmpeg error:", err);
      await stopTranscoding();
      startTranscoding();
    })
    .on("end", () => {
      ffmpegProc = null;
      ffmpegStream = null;
      isStreamReady = false;
    });

  captureInterval = setInterval(async () => {
    if (!ffmpegProc || !ffmpegStream || !page) return;
    try {
      if (page.isClosed()) {
        await startBrowser();
        return;
      }
      // Updated 16:9 capture for version 1.6
      const screenshot = await page.screenshot({
        type: "jpeg",
        clip: { x: 4, y: 50, width: 840, height: 470 }, // crop top, right, and bottom based on your measurements
      });
      ffmpegStream.write(screenshot);
    } catch (err) {
      console.warn("Capture error, retrying...", err.message);
      await startBrowser();
    }
  }, 1000 / FRAME_RATE);

  ffmpegProc.run();
}

async function stopTranscoding() {
  if (captureInterval) clearInterval(captureInterval);
  captureInterval = null;
  isStreamReady = false;
  if (ffmpegProc) ffmpegProc.kill("SIGINT");
  ffmpegProc = null;
  if (browser) await browser.close().catch(() => {});
  browser = null;
}

app.get("/playlist.m3u", (req, res) => {
  const host = req.headers.host || `localhost:${STREAM_PORT}`;
  const baseUrl = `http://${host}`;
  const m3uContent = `#EXTM3U
#EXTINF:-1 channel-id="weatherStar4000" tvg-id="weatherStar4000" tvg-channel-no="275" tvc-guide-placeholders="3600" tvc-guide-title="Local Weather" tvc-guide-description="Enjoy your local weather with a touch of nostalgia." tvc-guide-art="${baseUrl}/logo/ws4000.png" tvg-logo="${baseUrl}/logo/ws4000.png",WeatherStar 4000
${baseUrl}/stream/stream.m3u8
`;
  res.set("Content-Type", "application/x-mpegURL");
  res.send(m3uContent);
});

app.get("/guide.xml", (req, res) => {
  const host = req.headers.host || `localhost:${STREAM_PORT}`;
  res.set("Content-Type", "application/xml");
  res.send(generateXMLTV(host));
});

app.get("/health", (req, res) => {
  res.status(isStreamReady ? 200 : 503).json({ ready: isStreamReady });
});

app.get("/stream.ts", (req, res) => {
  if (!isStreamReady || !fs.existsSync(HLS_FILE)) {
    res.status(503).send("Stream not ready");
    return;
  }

  res.setHeader("Content-Type", "video/mp2t");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const tsProc = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    HLS_FILE,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-c",
    "copy",
    "-f",
    "mpegts",
    "pipe:1",
  ]);

  tsProc.stdout.pipe(res);

  tsProc.stderr.on("data", (data) => {
    const message = data.toString().trim();
    if (message) console.warn("TS stream ffmpeg:", message);
  });

  const cleanup = () => {
    if (!tsProc.killed) tsProc.kill("SIGKILL");
  };

  req.on("close", cleanup);
  res.on("close", cleanup);
  tsProc.on("error", cleanup);
  tsProc.on("close", () => {
    if (!res.writableEnded) res.end();
  });
});

if (ENABLE_HDHR) {
  console.log(`HDHR emulation enabled — Device ID: ${HDHR_DEVICE_ID}`);

  app.get("/discover.json", (req, res) => {
    const baseUrl = `http://${req.headers.host}`;
    res.json({
      FriendlyName: "ws4channels",
      Manufacturer: "Silicondust",
      ModelNumber: "HDTC-2US",
      FirmwareName: "hdhomerun3_atsc",
      FirmwareVersion: "20200101",
      TunerCount: 5,
      DeviceID: HDHR_DEVICE_ID,
      BaseURL: baseUrl,
      LineupURL: `${baseUrl}/lineup.json`,
    });
  });

  app.get("/device.xml", (req, res) => {
    const baseUrl = `http://${req.headers.host}`;
    res.set("Content-Type", "application/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <URLBase>${baseUrl}</URLBase>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
    <friendlyName>ws4channels</friendlyName>
    <manufacturer>Silicondust</manufacturer>
    <manufacturerURL>https://www.silicondust.com/</manufacturerURL>
    <modelName>HDTC-2US</modelName>
    <modelNumber>HDTC-2US</modelNumber>
    <serialNumber>${HDHR_DEVICE_ID}</serialNumber>
    <UDN>uuid:${HDHR_DEVICE_ID}-0000-0000-0000-000000000000</UDN>
  </device>
</root>`);
  });

  app.get("/lineup_status.json", (req, res) => {
    res.json({
      ScanInProgress: 0,
      ScanPossible: 1,
      Source: "Cable",
      SourceList: ["Cable"],
    });
  });

  app.get("/lineup.json", (req, res) => {
    const baseUrl = `http://${req.headers.host}`;
    res.json([
      {
        GuideNumber: HDHR_CHANNEL_NUMBER,
        GuideName: HDHR_CHANNEL_NAME,
        URL: `${baseUrl}/stream.ts`,
      },
    ]);
  });
}

const { cpus, memoryMB } = getContainerLimits();
console.log(
  `Version ${VERSION} | Running with ${cpus} CPU cores, ${memoryMB}MB RAM`,
);

app.listen(STREAM_PORT, async () => {
  console.log(`Streaming server running on port ${STREAM_PORT}`);
  await startTranscoding();
});

process.on("SIGINT", async () => {
  console.log("SIGINT received");
  await stopTranscoding();
  process.exit();
});
process.on("SIGTERM", async () => {
  console.log("SIGTERM received");
  await stopTranscoding();
  process.exit();
});
