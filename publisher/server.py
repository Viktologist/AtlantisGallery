"""Local MCP publisher for the public Atlantis Gallery on GitHub Pages."""

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from uuid import uuid4

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import StrictBool

from package_asset import add_to_catalog, stage_package


OWNER = 'zhxx1987'
REPO = f'{OWNER}/AtlantisGallery'
PAGES = f'https://{OWNER}.github.io/AtlantisGallery/'
API = 'https://api.github.com'
MAIN = 'main'
mcp = FastMCP('Atlantis Gallery')


def git(*args, cwd=None, stdin=None):
    env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GCM_INTERACTIVE': 'Never'}
    proxy = env.get('HTTPS_PROXY') or env.get('https_proxy')
    config = ['-c', f'http.proxy={proxy}'] if proxy else []
    result = subprocess.run(
        ['git', *config, *args], cwd=cwd, env=env, input=stdin, encoding='utf-8',
        errors='replace', capture_output=True, timeout=240, check=False,
    )
    if result.returncode:
        if args[0] == 'credential':
            raise ValueError('Sign in to Git Credential Manager using git credential-manager github login.')
        raise RuntimeError(f'Git {args[0]} failed. {result.stderr.strip()}')
    return result.stdout.strip()


class GitHub:
    def __init__(self):
        credential = git('credential', 'fill', stdin='protocol=https\nhost=github.com\n\n')
        token = dict(line.split('=', 1) for line in credential.splitlines() if '=' in line).get('password')
        if not token:
            raise ValueError('Sign in to Git Credential Manager using git credential-manager github login.')
        self.token = token
        user = self.request('/user')
        self.login = user['login']
        if not re.fullmatch(r'[A-Za-z0-9-]+', self.login):
            raise ValueError('Could not verify the GitHub account.')
        self.email = f"{user['id']}+{self.login}@users.noreply.github.com"

    def request(self, path, payload=None, missing=False):
        headers = {
            'Authorization': 'Bearer ' + self.token,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'Atlantis-Gallery-Publisher',
        }
        request = Request(API + path, headers=headers, data=None if payload is None else json.dumps(payload).encode())
        try:
            with urlopen(request, timeout=30) as response:
                return json.load(response)
        except HTTPError as error:
            if missing and error.code == 404:
                return None
            message = json.load(error).get('message', error.reason)
            raise RuntimeError(f'GitHub returned HTTP {error.code}. {message}') from None

    def fork(self):
        path = f'/repos/{self.login}/AtlantisGallery'
        fork = self.request(path, missing=True)
        if fork is None:
            self.request(f'/repos/{REPO}/forks', {'default_branch_only': True})
            for _ in range(15):
                time.sleep(2)
                fork = self.request(path, missing=True)
                if fork and fork.get('parent'):
                    break
        if not fork or fork.get('parent', {}).get('full_name', '').lower() != REPO.lower():
            raise ValueError('The GitHub account needs a ready fork of AtlantisGallery under its original repository name.')
        return f'https://github.com/{self.login}/AtlantisGallery.git'

    def submit(self, plan, package, temp):
        owner = self.login.lower() == OWNER
        slug = plan['metadata']['slug']
        asset_id = slug if owner else f'{self.login.lower()}-{slug}'
        work_url = PAGES + 'work.html?model=' + asset_id
        checkout = temp / 'gallery'
        upstream = f'https://github.com/{REPO}.git'
        git('clone', '--quiet', '--depth', '1', '--branch', MAIN, upstream, str(checkout))
        if not add_to_catalog(checkout, asset_id, package, plan):
            return {'status': 'already_published', 'id': asset_id, 'gallery_url': work_url}

        branch_prefix = f"gallery/{asset_id}-{plan['approval_digest'][:12]}-"
        if not owner:
            fork = self.fork()
            params = urlencode({'state': 'open', 'head': self.login, 'base': MAIN, 'per_page': 100})
            active = self.request(f'/repos/{REPO}/pulls?{params}')
            for pull in active:
                if pull['head']['ref'].startswith(branch_prefix) and pull['head']['repo']['full_name'].lower() == f'{self.login}/AtlantisGallery'.lower():
                    return {'status': 'submitted', 'id': asset_id, 'pull_request_url': pull['html_url'],
                            'gallery_url_after_merge': work_url}

        title = plan['metadata']['title']
        git('add', '--', 'catalog.json', f'models/{asset_id}', cwd=checkout)
        git('-c', f'user.name={self.login}', '-c', f'user.email={self.email}',
            'commit', '--quiet', '-m', f'Add Gallery work: {title}', cwd=checkout)
        branch = MAIN if owner else branch_prefix + uuid4().hex[:8]
        git('-c', f'credential.https://github.com.username={self.login}', 'push',
            upstream if owner else fork, f'HEAD:refs/heads/{branch}', cwd=checkout)
        if owner:
            revision = git('rev-parse', 'HEAD', cwd=checkout)
            return {'status': 'published_pending_pages', 'id': asset_id, 'gallery_url': work_url,
                    'revision': revision}

        pull = self.request(f'/repos/{REPO}/pulls', {
            'title': f'Add Gallery work: {title}',
            'head': f'{self.login}:{branch}',
            'base': MAIN,
            'body': f'Public Gallery submission.\n\nAsset ID: `{asset_id}`.\n\nPreview after merge: {work_url}',
        })
        return {'status': 'submitted', 'id': asset_id, 'pull_request_url': pull['html_url'],
                'gallery_url_after_merge': work_url}


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False))
def prepare_gallery_upload(manifest_path: str) -> dict[str, Any]:
    """Validate a local submission.json and list every file and archive member that would be public.

    Show the creator this plan and ask for explicit public-upload approval. Keep the approval_digest
    for publish_gallery_asset. This tool uses local files and does not contact GitHub.
    """
    with tempfile.TemporaryDirectory(prefix='atlantis-gallery-') as folder:
        return stage_package(manifest_path, Path(folder) / 'package')


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=True))
def publish_gallery_asset(manifest_path: str, approval_digest: str, confirm_public: StrictBool = False) -> dict[str, Any]:
    """Upload the approved Gallery package using the creator's GitHub login.

    Set confirm_public only after the creator approves the exact plan from prepare_gallery_upload.
    The Gallery owner publishes to Pages; contributors get a pull request and a prospective work URL.
    """
    if not confirm_public:
        raise ValueError('Explicit approval to upload these files to public GitHub is required.')
    with tempfile.TemporaryDirectory(prefix='atlantis-gallery-') as folder:
        temp = Path(folder)
        package = temp / 'package'
        plan = stage_package(manifest_path, package)
        if approval_digest != plan['approval_digest']:
            raise ValueError('The files or metadata changed. Prepare the upload and review the new plan.')
        return GitHub().submit(plan, package, temp)


if __name__ == '__main__':
    mcp.run(transport='stdio')
