#!/usr/bin/env node
/**
 * Stremio addon: fetches English subtitles from another subtitles addon
 * (OpenSubtitles v3 by default) and serves them translated to Hebrew
 * via Google Translate, on the fly, with disk + memory caching.
 *
 * Zero dependencies — requires Node.js 18+.
 */

console.log(`[boot] node ${process.version}, PORT env=${process.env.PORT || "(unset)"}`);
process.on("uncaughtException", (e) => {
  console.error(`[fatal] uncaught: ${e.stack || e}`);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  console.error(`[fatal] unhandled rejection: ${(e && e.stack) || e}`);
  process.exit(1);
});

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT || "7860", 10);
// Comma-separated base URLs of source subtitle addons (queried in order)
const SOURCE_ADDONS = (process.env.SOURCE_ADDONS ||
  "https://opensubtitles-v3.strem.io")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);
const TARGET_LANG = process.env.TARGET_LANG || "iw"; // Hebrew
const SOURCE_LANGS = new Set(["eng", "en"]);
const MAX_SUBS_PER_TITLE = parseInt(process.env.MAX_SUBS || "5", 10);
const BATCH_SIZE = 100; // cues per Google Translate request
const CONCURRENCY = 4; // parallel translate requests
const CACHE_DIR = path.join(__dirname, "cache");

fs.mkdirSync(CACHE_DIR, { recursive: true });
console.log(`[boot] cache dir ready at ${CACHE_DIR}`);

const MANIFEST = {
  id: "org.hebrew.autotranslate",
  version: "1.0.0",
  name: "Hebrew Auto-Translate Subtitles",
  description:
    "כתוביות בעברית בתרגום אוטומטי: מושך כתוביות באנגלית מ-OpenSubtitles ומתרגם לעברית בזמן אמת",
  logo: "https://emojiapi.dev/api/v1/israel/256.png",
  resources: ["subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
  behaviorHints: { configurable: false, configurationRequired: false },
};

/* ---------------------------- tiny utilities ---------------------------- */

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

function b64urlEncode(s) {
  return Buffer.from(s, "utf8").toString("base64url");
}

function b64urlDecode(s) {
  return Buffer.from(s, "base64url").toString("utf8");
}

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=3600",
  });
  res.end(body);
}

async function fetchText(url, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "stremio-hebrew-translate/1.0" },
      redirect: "follow",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------ SRT parsing ----------------------------- */

function parseSrt(text) {
  // Normalize line endings, strip BOM
  text = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const blocks = text.split(/\n{2,}/);
  const cues = [];
  const timeRe =
    /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) continue;
    let i = 0;
    if (/^\d+$/.test(lines[0].trim())) i = 1; // sequence number
    if (i >= lines.length) continue;
    const m = lines[i].match(timeRe);
    if (!m) continue;
    const textLines = lines.slice(i + 1);
    if (!textLines.length) continue;
    cues.push({ start: m[1], end: m[2], text: textLines.join("\n") });
  }
  return cues;
}

function buildSrt(cues) {
  // U+202B (RLE) forces right-to-left rendering so punctuation sits correctly
  return cues
    .map(
      (c, i) =>
        `${i + 1}\n${c.start} --> ${c.end}\n` +
        c.text
          .split("\n")
          .map((l) => "‫" + l)
          .join("\n")
    )
    .join("\n\n") + "\n";
}

/* ------------------------------ translation ----------------------------- */

async function translateBatch(texts) {
  const params = new URLSearchParams();
  for (const t of texts) params.append("q", t);
  const url = `https://translate.googleapis.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=${TARGET_LANG}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      body: params.toString(),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`translate HTTP ${r.status}`);
    const data = await r.json();
    // Response: ["tr1","tr2",...] or [["tr1","en"],...] depending on variant
    const out = data.map((item) => (Array.isArray(item) ? item[0] : item));
    if (out.length !== texts.length)
      throw new Error(`translate alignment mismatch (${out.length}/${texts.length})`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

async function translateBatchWithRetry(texts, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await translateBatch(texts);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, "").replace(/\{\\[^}]*\}/g, "");
}

async function translateCues(cues) {
  // One translation unit per cue; newlines inside a cue become spaces
  // (players wrap long lines automatically).
  const units = cues.map((c) =>
    stripTags(c.text).replace(/\n+/g, " ").replace(/\s+/g, " ").trim()
  );

  const batches = [];
  for (let i = 0; i < units.length; i += BATCH_SIZE)
    batches.push({ offset: i, texts: units.slice(i, i + BATCH_SIZE) });

  const results = new Array(units.length);
  let next = 0;
  async function worker() {
    while (next < batches.length) {
      const batch = batches[next++];
      const translated = await translateBatchWithRetry(batch.texts);
      translated.forEach((t, j) => (results[batch.offset + j] = t));
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker)
  );

  return cues.map((c, i) => ({
    start: c.start,
    end: c.end,
    text: results[i] || stripTags(c.text),
  }));
}

/* -------------------------------- caching ------------------------------- */

const inFlight = new Map(); // url -> Promise<string>

async function getTranslatedSrt(sourceUrl) {
  const cacheFile = path.join(CACHE_DIR, sha1(sourceUrl) + ".he.srt");
  try {
    return await fs.promises.readFile(cacheFile, "utf8");
  } catch {}

  if (inFlight.has(sourceUrl)) return inFlight.get(sourceUrl);

  const job = (async () => {
    console.log(`[translate] fetching ${sourceUrl}`);
    const original = await fetchText(sourceUrl);
    const cues = parseSrt(original);
    if (!cues.length) throw new Error("no cues parsed from source subtitle");
    console.log(`[translate] ${cues.length} cues, translating...`);
    const t0 = Date.now();
    const translated = await translateCues(cues);
    const srt = buildSrt(translated);
    console.log(`[translate] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await fs.promises.writeFile(cacheFile, srt, "utf8");
    return srt;
  })();

  inFlight.set(sourceUrl, job);
  try {
    return await job;
  } finally {
    inFlight.delete(sourceUrl);
  }
}

/* ------------------------------ source subs ----------------------------- */

async function findEnglishSubs(type, id, extra) {
  for (const base of SOURCE_ADDONS) {
    try {
      const extraPart = extra ? `/${extra}` : "";
      const url = `${base}/subtitles/${type}/${encodeURIComponent(id)}${extraPart}.json`;
      const body = await fetchText(url, 15000);
      const data = JSON.parse(body);
      const subs = (data.subtitles || []).filter((s) =>
        SOURCE_LANGS.has((s.lang || "").toLowerCase())
      );
      if (subs.length) return subs.slice(0, MAX_SUBS_PER_TITLE);
    } catch (e) {
      console.warn(`[source] ${base} failed: ${e.message}`);
    }
  }
  return [];
}

/* -------------------------------- routing ------------------------------- */

const LANDING = `<!DOCTYPE html>
<html dir="rtl" lang="he"><head><meta charset="utf-8">
<title>Hebrew Auto-Translate Subtitles</title>
<style>body{font-family:sans-serif;max-width:640px;margin:40px auto;padding:0 20px;background:#111;color:#eee}
a.btn{display:inline-block;background:#7b5bf5;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-size:18px}
code{background:#222;padding:2px 6px;border-radius:4px;direction:ltr;display:inline-block}</style></head>
<body><h1>🇮🇱 כתוביות בעברית — תרגום אוטומטי</h1>
<p>האדון מושך כתוביות באנגלית מ-OpenSubtitles ומתרגם אותן לעברית בזמן אמת.</p>
<p><a class="btn" href="stremio://HOST/manifest.json">התקן ב-Stremio</a></p>
<p>או הוסף ידנית את הכתובת: <code>http://HOST/manifest.json</code></p>
</body></html>`;

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(u.pathname);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      });
      return res.end();
    }

    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(LANDING.replace(/HOST/g, req.headers.host || `127.0.0.1:${PORT}`));
    }

    if (pathname === "/manifest.json") return json(res, MANIFEST);

    // /subtitles/:type/:id[/extra].json
    let m = pathname.match(/^\/subtitles\/([^/]+)\/([^/]+)(?:\/(.+?))?\.json$/);
    if (m) {
      const [, type, id, extra] = m;
      const host = req.headers.host || `127.0.0.1:${PORT}`;
      const proto = req.headers["x-forwarded-proto"] || "http";
      const sources = await findEnglishSubs(type, id, extra);
      const subtitles = sources.map((s, i) => ({
        id: `heb-auto-${i + 1}`,
        lang: "heb",
        url: `${proto}://${host}/translate/${b64urlEncode(s.url)}.srt`,
      }));
      console.log(`[subs] ${type}/${id} -> ${subtitles.length} translated option(s)`);
      return json(res, { subtitles });
    }

    // /translate/:b64url.srt
    m = pathname.match(/^\/translate\/([A-Za-z0-9_-]+)\.srt$/);
    if (m) {
      const sourceUrl = b64urlDecode(m[1]);
      if (!/^https?:\/\//.test(sourceUrl)) throw new Error("bad source url");
      const srt = await getTranslatedSrt(sourceUrl);
      res.writeHead(200, {
        "Content-Type": "text/srt; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=86400",
      });
      return res.end("﻿" + srt); // BOM helps some players detect UTF-8
    }

    json(res, { error: "not found" }, 404);
  } catch (e) {
    console.error(`[error] ${req.url}: ${e.message}`);
    json(res, { error: e.message }, 500);
  }
});

server.on("error", (e) => {
  console.error(`[fatal] server error: ${e.stack || e}`);
  process.exit(1);
});

console.log(`[boot] calling listen on 0.0.0.0:${PORT}...`);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Hebrew Auto-Translate addon running:`);
  console.log(`  Manifest:  http://127.0.0.1:${PORT}/manifest.json`);
  console.log(`  Landing:   http://127.0.0.1:${PORT}/`);
  console.log(`  Sources:   ${SOURCE_ADDONS.join(", ")}`);
});
