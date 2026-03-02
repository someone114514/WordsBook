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

- First launch: install mixed dictionaries, now including ECDICT full generated from `asserts/ECDICT-master/ecdict.csv`.
- Lookup order: exact -> lemma -> prefix -> fuzzy.
- Review schedule: `[0, 1, 2, 4, 7, 15, 30, 60]` days.
- Backup: export/import available in Settings.

## Dictionary Source

- Build ECDICT manifest/jsonl from local `asserts` folder:

```bash
npm run dict:build
```

## Deploy to iPhone

1. Deploy static files with HTTPS (Cloudflare Pages / Vercel / Netlify).
2. Open with Safari on iPhone.
3. Share -> Add to Home Screen.

Detailed notes:

- Implementation: `docs/IMPLEMENTATION.md`
- GitHub Pages + mobile packaging: `docs/DEPLOY_GITHUB_MOBILE.md`
