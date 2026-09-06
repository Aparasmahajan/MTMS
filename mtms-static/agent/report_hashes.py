#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Report content hashes of the deployed NEI package to MTMS.

Runs on each environment (repo checkout, lab, preprod, prod) and posts one report.
The tracker compares; this only measures.

WRITTEN FOR PYTHON 2.6+ AND PYTHON 3. That is not a style choice:

  * The servers run Python 2. No f-strings, no `pathlib`, no dict comprehensions on 2.6.
  * `str()` on a non-ASCII value raises on py2 and has already aborted a postcheck in
    production. Every path below is handled as bytes and only decoded for display.
  * Only the standard library is available. There is no pip on these hosts.

Design notes worth keeping:

  * IDENTITY IS THE CONTENT HASH, NEVER THE PATH. The same script has been found at five
    paths with five different contents. Paths are reported as metadata only.
  * `.packinglist` IS THE SOURCE OF TRUTH FOR WHAT DEPLOYS. A file present in the repo
    and absent from that list never reaches a server, however correct it is — so this
    reports `in_packinglist` per file rather than guessing from the filesystem.
  * FILES ARE STREAMED, NEVER READ WHOLE. A config dump is ~415 KB and a comparison
    report ~6 MB; and the inline transport ceiling elsewhere in this system is ~96 KB.
    Hashing in 64 KB blocks keeps this safe on a constrained host.
  * NO FILE CONTENT IS EVER SENT. `mds.rc.add` holds plaintext CMM_PASSWORD,
    M2MPASSWORD and REPO_PASSWORD. This posts hashes and sizes and nothing else.

Usage:

    python report_hashes.py \\
        --url https://mtms.internal \\
        --environment prod \\
        --root /data/cloud-user/om/install/sas/bin/macro_server/java \\
        --token "$DRIFT_INGEST_TOKEN" \\
        --project CR_AUTOMATION

    python report_hashes.py --root . --environment repo --dry-run
"""

import hashlib
import json
import optparse
import os
import socket
import sys

try:                       # py2
    from urllib2 import Request, urlopen, HTTPError, URLError
except ImportError:        # py3
    from urllib.request import Request, urlopen
    from urllib.error import HTTPError, URLError


BLOCK_SIZE = 64 * 1024

# Which deliverable column a file belongs to, decided by where it sits in the package and
# what it is. Order matters: the first match wins.
#
# These keys are the project's deliverable columns. They are configuration in MTMS, so if
# a project renames or adds one, this table is what needs updating — the agent is the only
# place that knows how a file on disk maps to a column.
RULES = [
    # (column_key, layer, match on the package-relative path, lowercased)
    ('filecr', 'java',   lambda p: p.endswith('.jar')),
    ('clicr',  'python', lambda p: '/script/python/' in p and p.endswith('.py')),
    ('valid',  'yaml',   lambda p: p.endswith('validation.yaml')),
    ('exec',   'yaml',   lambda p: p.endswith('execution.yaml')),
    ('bst',    'yaml',   lambda p: '/templates/yaml/' in p and 'bst' in p),
    ('json',   'config', lambda p: '/jsontemplate/' in p),
    ('html',   'config', lambda p: '/templates/html/' in p),
    ('lookup', 'config', lambda p: p.endswith('.properties')),
]

# Never hashed, never named in a report. Secrets live here.
EXCLUDED = ('mds.rc', 'mds.rc.add', 'nemo_parameters.properties')


def classify(relative_path):
    """Return (column_key, layer) or (None, None) if MTMS does not track this file."""
    lowered = relative_path.replace(os.sep, '/').lower()
    for column_key, layer, matches in RULES:
        if matches(lowered):
            return column_key, layer
    return None, None


def sha256_of(path):
    """Stream the file in blocks. Never read a 6 MB report into memory on a live host."""
    digest = hashlib.sha256()
    handle = open(path, 'rb')
    try:
        while True:
            block = handle.read(BLOCK_SIZE)
            if not block:
                break
            digest.update(block)
    finally:
        handle.close()
    return digest.hexdigest()


def read_packinglist(root):
    """Package-relative paths that actually deploy.

    Returns None when there is no `.packinglist`, which is the normal case for a repo
    checkout. None means "unknown", and is reported as such rather than as False.
    """
    candidates = [
        os.path.join(root, '.packinglist'),
        os.path.join(root, 'bin', '.packinglist'),
        os.path.join(root, 'target', 'bin', '.packinglist'),
    ]
    for candidate in candidates:
        if not os.path.exists(candidate):
            continue
        listed = set()
        handle = open(candidate, 'rb')
        try:
            for raw in handle:
                line = raw.decode('utf-8', 'replace').strip()
                if not line or line.startswith('#'):
                    continue
                # Lines are whitespace-separated; the source path is the first field.
                parts = line.split()
                if parts:
                    listed.add(parts[0].lstrip('./').replace('\\', '/'))
        finally:
            handle.close()
        return listed
    return None


def iso(timestamp):
    """UTC, via `time.gmtime`.

    Not `datetime.utcfromtimestamp`: that is deprecated on modern Python 3 and would
    print a warning into the report on a developer machine, and `datetime.UTC` does not
    exist on Python 2. `time.gmtime` behaves identically on both.
    """
    import time
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(timestamp))


def source_for(jar_path, root):
    """Newest mtime under src/, so a jar older than its source can be spotted.

    A stale `NodeDefinition.class` once cost a day: SnakeYAML binds against the compiled
    bean, so the source being right did not help. MTMS raises this as a warning, but only
    if the agent reports both timestamps.
    """
    source_root = os.path.join(root, 'src')
    if not os.path.isdir(source_root):
        return None
    newest = 0
    for directory, _unused, files in os.walk(source_root):
        for name in files:
            if not name.endswith('.java'):
                continue
            try:
                newest = max(newest, os.path.getmtime(os.path.join(directory, name)))
            except OSError:
                pass
    return iso(newest) if newest else None


def collect(root, verbose=False):
    entries = []
    listed = read_packinglist(root)

    for directory, _unused, files in os.walk(root):
        for name in files:
            if name in EXCLUDED:
                continue
            absolute = os.path.join(directory, name)
            relative = os.path.relpath(absolute, root).replace(os.sep, '/')

            column_key, layer = classify(relative)
            if column_key is None:
                continue

            try:
                entry = {
                    'column_key': column_key,
                    'layer': layer,
                    'path': relative,
                    'content_hash': sha256_of(absolute),
                    'size_bytes': os.path.getsize(absolute),
                }
            except (IOError, OSError):
                sys.stderr.write('skipped unreadable file: %s\n' % relative)
                continue

            if listed is not None:
                entry['in_packinglist'] = relative in listed

            if layer == 'java':
                entry['built_at'] = iso(os.path.getmtime(absolute))
                source = source_for(root, root)
                if source:
                    entry['source_modified_at'] = source

            if verbose:
                sys.stderr.write('%s  %s  %s\n' % (entry['content_hash'][:12], column_key, relative))
            entries.append(entry)

    return entries


def post(url, token, payload):
    body = json.dumps(payload).encode('utf-8')
    request = Request(url.rstrip('/') + '/api/v1/drift/reports', body)
    request.add_header('Content-Type', 'application/json')
    if token:
        request.add_header('Authorization', 'Bearer ' + token)
    # py2's Request has no method argument; a body implies POST.
    handle = urlopen(request, timeout=60)
    try:
        return handle.read().decode('utf-8', 'replace')
    finally:
        handle.close()


def main(argv):
    parser = optparse.OptionParser()  # not argparse: absent on py2.6
    parser.add_option('--url', help='MTMS base URL, e.g. https://mtms.internal')
    parser.add_option('--environment', help='repo | lab | preprod | prod')
    parser.add_option('--root', default='.', help='package root to walk')
    parser.add_option('--token', default=os.environ.get('DRIFT_INGEST_TOKEN', ''))
    parser.add_option('--project', default='', help='project key, e.g. CR_AUTOMATION')
    parser.add_option('--agent', default='', help='defaults to mtms-agent/<hostname>')
    parser.add_option('--dry-run', action='store_true', default=False)
    parser.add_option('--verbose', action='store_true', default=False)
    options, _unused = parser.parse_args(argv[1:])

    if options.environment not in ('repo', 'lab', 'preprod', 'prod'):
        parser.error('--environment must be one of repo, lab, preprod, prod')

    root = os.path.abspath(options.root)
    if not os.path.isdir(root):
        parser.error('--root is not a directory: %s' % root)

    entries = collect(root, options.verbose)
    payload = {
        'environment': options.environment,
        'agent': options.agent or ('mtms-agent/' + socket.gethostname()),
        'entries': entries,
    }
    if options.project:
        payload['project_key'] = options.project

    if options.dry_run or not options.url:
        sys.stdout.write(json.dumps(payload, indent=2, sort_keys=True))
        sys.stdout.write('\n')
        sys.stderr.write('%d file(s) hashed; not posted\n' % len(entries))
        return 0

    try:
        sys.stdout.write(post(options.url, options.token, payload))
        sys.stdout.write('\n')
    except HTTPError:
        error = sys.exc_info()[1]
        sys.stderr.write('MTMS rejected the report: %s\n' % error.read().decode('utf-8', 'replace'))
        return 1
    except (URLError, socket.error):
        sys.stderr.write('could not reach MTMS: %s\n' % sys.exc_info()[1])
        return 1

    sys.stderr.write('%d file(s) reported from %s\n' % (len(entries), options.environment))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
