#!/usr/bin/env python3
import csv
import json
from pathlib import Path

SRC = Path('asserts/ECDICT-master/ecdict.mini.csv')
OUT_DIR = Path('public/dictionaries/ecdict')
ENTRIES_FILE = OUT_DIR / 'entries-1.jsonl'
MANIFEST_FILE = OUT_DIR / 'manifest.json'


def clean_lines(raw: str):
    if not raw:
        return []
    raw = raw.replace('\r', '\n')
    lines = []
    for line in raw.split('\n'):
        stripped = line.strip().strip(';')
        if stripped:
            lines.append(stripped)
    return lines


def parse_pos(raw: str):
    if not raw:
        return []
    items = []
    for part in raw.split('/'):
        part = part.strip()
        if not part:
            continue
        tag = part.split(':', 1)[0].strip()
        if tag:
            items.append(tag)
    return list(dict.fromkeys(items))


def normalize_word(word: str):
    return ''.join(ch for ch in word.strip().lower() if ch.isalnum() or ch in "-'")


def main():
    if not SRC.exists():
        raise SystemExit(f'Missing source file: {SRC}')

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    entries = []
    seen = {}

    with SRC.open('r', encoding='utf-8', newline='') as f:
        reader = csv.DictReader(f)
        for row in reader:
            word = (row.get('word') or '').strip()
            if not word:
                continue

            normalized = normalize_word(word)
            if not normalized:
                continue

            entry_id = f'ecdict:{normalized}'
            if entry_id in seen:
                seen[entry_id] += 1
                entry_id = f'{entry_id}:{seen[entry_id]}'
            else:
                seen[entry_id] = 1

            translation_lines = clean_lines(row.get('translation') or '')
            definition_lines = clean_lines(row.get('definition') or '')

            if translation_lines:
                senses = translation_lines[:10]
                usage = definition_lines[:10]
            else:
                senses = definition_lines[:10]
                usage = []

            entry = {
                'entryId': entry_id,
                'headword': word,
                'headwordLower': normalized,
                'phonetic': (row.get('phonetic') or '').strip() or None,
                'posList': parse_pos(row.get('pos') or ''),
                'sensesJson': json.dumps(senses, ensure_ascii=False),
                'examplesJson': json.dumps([], ensure_ascii=False),
                'usageJson': json.dumps(usage, ensure_ascii=False),
                'audioKey': '',
            }
            entries.append(entry)

    with ENTRIES_FILE.open('w', encoding='utf-8', newline='') as f:
        for entry in entries:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')

    manifest = {
        'id': 'ecdict-mini',
        'name': 'ECDICT Mini',
        'version': '2026.03.02-ecdict-mini',
        'locale': 'en-US,zh-CN',
        'source': 'ECDICT mini from asserts/ECDICT-master/ecdict.mini.csv',
        'publishedAt': '2026-03-02',
        'entryCount': len(entries),
        'entries': [{'path': 'entries-1.jsonl'}],
        'indices': [],
    }

    MANIFEST_FILE.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    print(f'Generated {len(entries)} entries -> {ENTRIES_FILE}')
    print(f'Generated manifest -> {MANIFEST_FILE}')


if __name__ == '__main__':
    main()
