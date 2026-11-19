"""Publish immutable previews and downloads in a creator-owned resource repository."""

import hashlib
import json
from pathlib import Path
import shutil
import time
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

from .package_asset import read_json, write_json


MARKER = '.atlantis-gallery.json'


def hosting_urls(login, plan):
    repository = f"{login}/{plan['storage']['repository_name']}"
    tag = 'gallery-' + plan['approval_digest']
    return {
        'repository': repository,
        'repository_url': 'https://github.com/' + repository,
        'preview_base_url': f"https://{login.lower()}.github.io/{plan['storage']['repository_name']}/{tag}/",
        'download_urls': {
            item['file']: f"https://github.com/{repository}/releases/download/{tag}/{item['file']}"
            for item in plan['metadata']['downloads']
        },
        'tag': tag,
    }


def ensure_pages(github, repository):
    path = f'/repos/{repository}/pages'
    pages = github.request(path, missing=True)
    if pages is None:
        return github.request(path, {'source': {'branch': 'main', 'path': '/'}}, method='POST')
    if pages.get('cname') or pages.get('build_type', 'legacy') != 'legacy' or pages.get('source') != {'branch': 'main', 'path': '/'}:
        raise ValueError('The resource repository needs its original GitHub Pages domain and main/root branch source.')
    return pages


def verify_preview(hosting, plan, attempts=6, delay=5):
    """Verify anonymous browser access, CORS and exact preview bytes before indexing."""
    origin = 'https://zhxx1987.github.io'
    base = hosting['preview_base_url']
    same_origin = urlparse(base).netloc.lower() == urlparse(origin).netloc.lower()

    def fetch(path, expected=None):
        request = Request(base + quote(path, safe='/'), headers={'Origin': origin, 'User-Agent': 'Atlantis-Gallery-Publisher'})
        with urlopen(request, timeout=30) as response:
            if response.geturl() != request.full_url:
                raise ValueError('The preview URL redirected. Verify the resource repository Pages configuration.')
            if not same_origin and response.headers.get('Access-Control-Allow-Origin') not in {'*', origin}:
                raise ValueError('The preview host does not allow Gallery browser requests (CORS).')
            if expected is None:
                return json.load(response)
            digest = hashlib.sha256()
            size = 0
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                size += len(chunk)
            if size != expected['bytes'] or digest.hexdigest() != expected['sha256']:
                raise ValueError('The published preview differs from the approved file: ' + path)

    for attempt in range(attempts):
        try:
            manifest = fetch('publication.json')
            if manifest.get('approval_digest') != plan['approval_digest']:
                raise ValueError('The preview publication marker differs from the approved package.')
            break
        except (OSError, ValueError):
            if attempt + 1 == attempts:
                raise RuntimeError('Creator assets were uploaded, but Pages is not ready. Retry the same approved upload; Gallery was not changed.') from None
            time.sleep(delay)
    for item in plan['files']:
        if item['destination'] == 'creator-pages':
            fetch(item['file'], item)


def publish_creator_assets(github, plan, package, temp, git):
    hosting = hosting_urls(github.login, plan)
    repository = hosting['repository']
    path = '/repos/' + repository
    info = github.request(path, missing=True)
    if info is None:
        info = github.request('/user/repos', {
            'name': plan['storage']['repository_name'],
            'description': 'Model preview and downloads for Atlantis Gallery',
            'private': False,
            'auto_init': False,
        })
    if info.get('owner', {}).get('login', '').lower() != github.login.lower() or info.get('private') or info.get('fork'):
        raise ValueError('Resource uploads require a public, standalone repository owned by the signed-in creator.')
    if info.get('size', 0) and info.get('default_branch') != 'main':
        raise ValueError('The resource repository must keep its main default branch.')

    checkout = temp / 'creator-assets'
    url = hosting['repository_url'] + '.git'
    git('clone', '--quiet', '--depth', '1', url, str(checkout))
    marker = {'schema': 'atlantis-gallery-resource-repository/1', 'creator': github.login.lower(), 'slug': plan['metadata']['slug']}
    marker_file = checkout / MARKER
    heads = git('branch', '--list', cwd=checkout)
    if marker_file.exists():
        if read_json(marker_file) != marker:
            raise ValueError('The resource repository belongs to another Gallery asset.')
    elif heads:
        raise ValueError('The resource repository name is already in use. Choose a new asset slug; existing files were not changed.')
    else:
        git('checkout', '--quiet', '-b', 'main', cwd=checkout)
        write_json(marker_file, marker)
        (checkout / '.nojekyll').write_text('', encoding='utf-8')
        (checkout / 'index.html').write_text(
            '<!doctype html><html lang="en"><meta charset="utf-8"><title>Atlantis Model Resources</title>'
            '<h1>Atlantis Model Resources</h1><p>Previews and downloads for Atlantis Gallery.</p></html>\n', encoding='utf-8')

    # Preserve the approved bytes on Windows, including Python and JSON text.
    (checkout / '.gitattributes').write_bytes(b'* -text\n')

    version = checkout / hosting['tag']
    preview_files = [item for item in plan['files'] if item['destination'] == 'creator-pages']
    if version.exists():
        publication = read_json(version / 'publication.json')
        if publication.get('approval_digest') != plan['approval_digest']:
            raise ValueError('This immutable preview version has different publication metadata.')
        for item in preview_files:
            source = version / item['file']
            if not source.is_file():
                raise ValueError('This immutable preview version is missing: ' + item['file'])
            with source.open('rb') as stream:
                checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
            if checksum != item['sha256']:
                raise ValueError('This immutable preview version has different bytes: ' + item['file'])
    else:
        for item in preview_files:
            dest = version / item['file']
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(package / item['file'], dest)
        write_json(version / 'publication.json', {
            'schema': 'atlantis-gallery-publication/1', 'approval_digest': plan['approval_digest'],
            'files': preview_files,
        })

    git('add', '--', MARKER, '.gitattributes', '.nojekyll', 'index.html', hosting['tag'], cwd=checkout)
    if git('status', '--porcelain', cwd=checkout):
        git('-c', f'user.name={github.login}', '-c', f'user.email={github.email}',
            'commit', '--quiet', '-m', 'Publish approved Gallery preview', cwd=checkout)
        git('-c', f'credential.https://github.com.username={github.login}', 'push', url, 'HEAD:refs/heads/main', cwd=checkout)
    revision = git('rev-parse', 'HEAD', cwd=checkout)
    ensure_pages(github, repository)

    release_path = path + '/releases/tags/' + hosting['tag']
    release = github.request(release_path, missing=True)
    marker_text = 'Approved package SHA-256: ' + plan['approval_digest']
    if release is None:
        release = github.request(path + '/releases', {
            'tag_name': hosting['tag'], 'target_commitish': revision,
            'name': plan['metadata']['title'], 'body': marker_text,
            'draft': True, 'prerelease': False,
        })
    if marker_text not in release.get('body', ''):
        raise ValueError('The release tag is already in use by another package.')
    assets = {item['name']: item for item in github.request(path + f"/releases/{release['id']}/assets?per_page=100")}
    for item in plan['files']:
        if item['destination'] != 'creator-releases':
            continue
        existing = assets.get(item['file'])
        label = 'sha256:' + item['sha256']
        if existing:
            if existing.get('state') != 'uploaded' or existing.get('size') != item['bytes'] or (existing.get('digest') or existing.get('label')) != label:
                raise ValueError('An existing release asset differs from the approved file: ' + item['file'])
            continue
        uploaded = github.upload_release_asset(repository, release['id'], package / item['file'], label)
        if uploaded.get('state') != 'uploaded' or uploaded.get('size') != item['bytes'] or (uploaded.get('digest') or uploaded.get('label')) != label:
            raise ValueError('Release upload verification failed: ' + item['file'])
    if release.get('draft'):
        github.request(path + f"/releases/{release['id']}", {'draft': False}, method='PATCH')
    verify_preview(hosting, plan)
    return hosting
