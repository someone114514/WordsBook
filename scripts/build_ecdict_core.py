#!/usr/bin/env python3
"""Build the small, first-use ECDICT bundle used before optional full data."""
import csv
import gzip
import hashlib
import json
from pathlib import Path

SRC = Path('asserts/ECDICT-master/ecdict.csv')
OUT = Path('public/dictionaries/ecdict-core')
CORE_SIZE = 27_861


def lines(raw: str):
    return [part.strip().strip(';') for part in (raw or '').replace('\r', '\n').split('\n') if part.strip().strip(';')]


def number(raw: str, fallback=10**9):
    try:
        value = int(raw or 0)
        return value if value > 0 else fallback
    except ValueError:
        return fallback


def normalized(word: str):
    return ''.join(char for char in word.strip().lower() if char.isalnum() or char in "-'")


def priority(row):
    rank = min(number(row.get('frq')), number(row.get('bnc')))
    boost = min(number(row.get('collins'), 0), 5) * 3500
    boost += 9000 if (row.get('oxford') or '').strip() else 0
    boost += 3500 if (row.get('tag') or '').strip() else 0
    return (rank - boost, len((row.get('word') or '').strip()), (row.get('word') or '').lower())


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with SRC.open('r', encoding='utf-8', newline='') as handle:
        candidates = [row for row in csv.DictReader(handle) if normalized(row.get('word') or '')]
    candidates.sort(key=priority)
    selected = candidates[:CORE_SIZE]
    path = OUT / 'entries-1.jsonl'
    seen = set()
    count = 0
    with path.open('w', encoding='utf-8', newline='') as output:
        for row in selected:
            word = (row.get('word') or '').strip()
            key = normalized(word)
            if key in seen:
                continue
            seen.add(key)
            translations = lines(row.get('translation') or '')
            definitions = lines(row.get('definition') or '')
            entry = {
                'entryId': f'ecdict-core:{key}', 'headword': word, 'headwordLower': key,
                'phonetic': (row.get('phonetic') or '').strip() or None,
                'posList': list(dict.fromkeys(part.split(':', 1)[0].strip() for part in (row.get('pos') or '').split('/') if part.strip())),
                'sensesJson': json.dumps((translations or definitions)[:10], ensure_ascii=False),
                'examplesJson': '[]', 'usageJson': json.dumps((definitions if translations else [])[:10], ensure_ascii=False), 'audioKey': '',
            }
            output.write(json.dumps(entry, ensure_ascii=False) + '\n')
            count += 1
    content_sha = hashlib.sha256(path.read_bytes()).hexdigest()
    gzip_path = OUT / 'entries-1.jsonl.gz'
    with path.open('rb') as source, gzip.open(gzip_path, 'wb', compresslevel=9) as compressed:
        compressed.write(source.read())
    manifest = {
        'id': 'ecdict-core', 'name': 'ECDICT 高频核心', 'version': '2026.07.13-core-27861',
        'locale': 'en-US,zh-CN', 'source': 'ECDICT frequency-ranked core', 'publishedAt': '2026-07-13',
        'entryCount': count, 'entries': [{'path': gzip_path.name, 'size': gzip_path.stat().st_size, 'sha256': content_sha}], 'indices': [],
    }
    (OUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Generated {count} core entries')


if __name__ == '__main__':
    main()
