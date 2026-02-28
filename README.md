# WordsBook

Offline-first PWA for dictionary lookup and spaced repetition on iPhone.

## Quick Start

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## Tests

```bash
npm run test
npm run test:e2e
```

## Product Notes

- First launch: install built-in dictionary from `/dictionaries/default/manifest.json`.
- Lookup order: exact -> lemma -> prefix -> fuzzy.
- Review schedule: `[0, 1, 2, 4, 7, 15, 30, 60]` days.
- Backup: export/import available in Settings.

## Deploy to iPhone

1. Deploy static files with HTTPS (Cloudflare Pages / Vercel / Netlify).
2. Open with Safari on iPhone.
3. Share -> Add to Home Screen.

Detailed implementation notes: `docs/IMPLEMENTATION.md`.
