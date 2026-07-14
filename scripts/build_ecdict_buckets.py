#!/usr/bin/env python3
"""Split the existing full ECDICT JSONL bundle into independently cacheable gzip prefix buckets."""
import gzip
import hashlib
import json
from pathlib import Path

SOURCE = Path('public/dictionaries/ecdict')
OUT = Path('public/dictionaries/ecdict-buckets')


def bucket_key(word: str):
    first = (word or '_').lower()[:1]
    return first if first.isascii() and first.isalnum() else '_'


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob('bucket-*.jsonl.gz'):
        old.unlink()
    handles = {}
    counts = {}
    try:
        for source in sorted(SOURCE.glob('entries-*.jsonl')):
            with source.open('r', encoding='utf-8') as rows:
                for line in rows:
                    if not line.strip():
                        continue
                    entry = json.loads(line)
                    key = bucket_key(entry.get('headwordLower') or entry.get('headword') or '')
                    if key not in handles:
                        handles[key] = gzip.open(OUT / f'bucket-{ord(key):02x}.jsonl.gz', 'wt', encoding='utf-8', compresslevel=9)
                        counts[key] = 0
                    handles[key].write(line)
                    counts[key] += 1
    finally:
        for handle in handles.values():
            handle.close()
    buckets = []
    for key in sorted(counts):
        path = OUT / f'bucket-{ord(key):02x}.jsonl.gz'
        with gzip.open(path, 'rb') as decoded:
            content_sha256 = hashlib.sha256(decoded.read()).hexdigest()
        buckets.append({
            'prefix': key,
            'path': path.name,
            'count': counts[key],
            'size': path.stat().st_size,
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'contentSha256': content_sha256,
        })
    manifest = {'id': 'ecdict-full-buckets', 'version': '2026.07.13-gzip-prefix-v1', 'entryCount': sum(counts.values()), 'buckets': buckets}
    (OUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Generated {len(buckets)} buckets with {manifest["entryCount"]} entries')


if __name__ == '__main__':
    main()
