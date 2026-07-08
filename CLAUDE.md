# HebAi — Stremio Hebrew Auto-Translate Subtitles Addon

Stremio addon that fetches English subtitles from a source addon (OpenSubtitles v3 by default) and serves them machine-translated to Hebrew via the free Google Translate endpoint.

## Architecture

- Single-file, zero-dependency Node.js server ([server.js](server.js)), requires Node 18+ (built-in `fetch`).
- Endpoints:
  - `GET /manifest.json` — Stremio addon manifest (resource: `subtitles`, types: movie/series, idPrefixes: `tt`).
  - `GET /subtitles/:type/:id[/extra].json` — queries source addons, filters English subs, returns `heb` entries whose URLs point back at `/translate/...`.
  - `GET /translate/:base64url.srt` — downloads the English SRT, parses cues, translates in batches of 100 (4 concurrent requests) via `translate.googleapis.com/translate_a/t?client=dict-chrome-ex`, prepends U+202B RLE marks for RTL punctuation, returns SRT with UTF-8 BOM.
- Caching: translated SRTs are written to `cache/` keyed by SHA-1 of source URL; in-flight dedup via a Map.

## Running

```bash
node server.js        # port 7860, override with PORT env var
```

Config via env vars: `PORT`, `SOURCE_ADDONS` (comma-separated addon base URLs), `MAX_SUBS`, `TARGET_LANG` (default `iw`).

Install in Stremio: `http://127.0.0.1:7860/manifest.json` (works on Desktop/Android; Stremio Web requires HTTPS).

## Deployment

- Production: Render free tier at `https://hebai.onrender.com` (manifest: `/manifest.json`), deploys from GitHub `zeevonm/hebai` `main` branch via [render.yaml](render.yaml). Free instance sleeps after 15 min idle (~1 min cold start).
- A Hugging Face Space (`zeevonm/HebAi`) was tried first but got permanently stuck in APP_STARTING with no hardware allocated — abandoned, safe to delete.

## Notes

- Google Translate free endpoint returns an aligned JSON array for multiple `q` params — alignment is verified and mismatches throw + retry.
- `cache/` is generated data; safe to delete.
