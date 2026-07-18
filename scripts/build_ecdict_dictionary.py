#!/usr/bin/env python3
import argparse
import csv
import json
from pathlib import Path

DEFAULT_SRC = Path('asserts/ECDICT-master/ecdict.csv')
OUT_DIR = Path('public/dictionaries/ecdict')
MANIFEST_FILE = OUT_DIR / 'manifest.json'
SHARD_SIZE = 50000


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


def parse_args():
    parser = argparse.ArgumentParser(description='Build dictionary bundle from ECDICT CSV.')
    parser.add_argument(
        '--src',
        type=Path,
        default=DEFAULT_SRC,
        help='Path to ECDICT CSV source file (default: asserts/ECDICT-master/ecdict.csv)',
    )
    return parser.parse_args()


def open_shard(shard_index: int):
    shard_name = f'entries-{shard_index}.jsonl'
    shard_path = OUT_DIR / shard_name
    return shard_name, shard_path.open('w', encoding='utf-8', newline='')


def main():
    args = parse_args()
    src = args.src

    if not src.exists():
        raise SystemExit(f'Missing source file: {src}')

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    for old in OUT_DIR.glob('entries-*.jsonl'):
        old.unlink()

    seen = {}
    entry_count = 0
    shard_paths = []
    shard_index = 1
    current_shard_count = 0

    shard_name, shard_file = open_shard(shard_index)
    shard_paths.append(shard_name)

    with src.open('r', encoding='utf-8', newline='') as f:
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

            shard_file.write(json.dumps(entry, ensure_ascii=False) + '\n')
            entry_count += 1
            current_shard_count += 1

            if current_shard_count >= SHARD_SIZE:
                shard_file.close()
                shard_index += 1
                current_shard_count = 0
                shard_name, shard_file = open_shard(shard_index)
                shard_paths.append(shard_name)

    shard_file.close()

    if current_shard_count == 0 and shard_paths:
        empty_last = OUT_DIR / shard_paths[-1]
        if empty_last.exists() and empty_last.stat().st_size == 0:
            empty_last.unlink()
            shard_paths.pop()

    manifest = {
        'id': 'ecdict-full',
        'name': 'ECDICT Full',
        'version': '2026.03.02-ecdict-full',
        'locale': 'en-US,zh-CN',
        'source': f'ECDICT from {src.as_posix()}',
        'publishedAt': '2026-03-02',
        'entryCount': entry_count,
        'entries': [{'path': path} for path in shard_paths],
        'indices': [],
    }

    MANIFEST_FILE.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    print(f'Generated {entry_count} entries from {src}')
    print(f'Generated {len(shard_paths)} shard files under {OUT_DIR}')
    print(f'Generated manifest -> {MANIFEST_FILE}')


if __name__ == '__main__':
    main()
