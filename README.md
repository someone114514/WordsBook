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
- Review schedule: FSRS with Again / Hard / Good / Easy grading; only the first valid unprompted grade per word/day updates long-term memory.
- Learning flow: rolling 8–12 word units combine due-word probing, short reading, new/relearn cards, transfer practice, and delayed retries.
- Study lists: lookup collection and study membership are independent; TXT/CSV/TSV imports are supported.
- Context reading: DeepSeek can generate resumable graded passages, with verified local dictionary examples as a non-blocking offline fallback.
- Personalization: after 400 effective daily-first grades, the official FSRS optimizer can train locally and only activates parameters that beat defaults on a holdout set.
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

- GitHub Pages + mobile packaging: `docs/DEPLOY_GITHUB_MOBILE.md`
