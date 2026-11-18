"""Build a Gallery submission from an explicit list of local files."""

import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
from urllib.parse import quote
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


MODEL_TYPES = {'.usd', '.usda', '.usdc', '.usdz', '.glb', '.gltf'}
IMAGE_TYPES = {'.png', '.jpg', '.jpeg', '.webp'}
DEPENDENCY_TYPES = MODEL_TYPES | IMAGE_TYPES | {'.bin', '.ktx2', '.exr', '.hdr'}
MAX_FILE = 100 * 1024 * 1024
SCHEMA = 'atlantis-gallery-submission/1'


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def write_json(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


def validate_slug(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', value) or len(value) > 60:
        raise ValueError('slug must use lowercase letters, digits and single hyphens, up to 60 characters.')
    return value


def relative_file(root, name, extensions=None):
    if not isinstance(name, str) or not name or '\\' in name or ':' in name:
        raise ValueError('Use file paths relative to the manifest, with forward slashes.')
    path = PurePosixPath(name)
    if path.as_posix() != name or path.is_absolute() or any(part.startswith('.') for part in path.parts):
        raise ValueError(f'Invalid relative file path: {name}')
    if extensions and path.suffix.lower() not in extensions:
        raise ValueError(f'Unsupported file type: {name}')
    absolute = root.joinpath(*path.parts).resolve()
    if not absolute.is_relative_to(root) or not absolute.is_file():
        raise ValueError(f'File must exist inside the export folder: {name}')
    return absolute


def files_field(data, key):
    value = data.get(key, [])
    if not isinstance(value, list) or not all(isinstance(name, str) and name for name in value):
        raise ValueError(f'{key} must be an array of relative file paths.')
    return value


def zip_files(path, sources):
    with ZipFile(path, 'w', compression=ZIP_DEFLATED) as archive:
        for name, source in sorted(sources.items()):
            member = ZipInfo(name)
            member.compress_type = ZIP_DEFLATED
            with source.open('rb') as reader, archive.open(member, 'w', force_zip64=True) as writer:
                shutil.copyfileobj(reader, writer)


def stage_package(manifest, output):
    manifest = Path(manifest).resolve(strict=True)
    data = read_json(manifest)
    if not isinstance(data, dict) or data.get('schema') != SCHEMA:
        raise ValueError(f'The manifest must use schema {SCHEMA}.')
    root = manifest.parent
    slug = validate_slug(data.get('slug'))
    metadata = {'slug': slug}
    for key in ('title', 'creator', 'description'):
        value = data.get(key, '')
        if not isinstance(value, str) or (key != 'description' and not value.strip()):
            raise ValueError(f'{key} must be text. A title and creator are required.')
        if value.strip():
            metadata[key] = value.strip()

    model = data.get('model')
    preview = {model: relative_file(root, model, MODEL_TYPES)}
    for name in files_field(data, 'previewFiles'):
        preview[name] = relative_file(root, name, DEPENDENCY_TYPES)
    model_archive = preview | {
        name: relative_file(root, name)
        for name in files_field(data, 'modelFiles') + files_field(data, 'motionFiles')
    }
    sources = {name: relative_file(root, name) for name in files_field(data, 'sourceFiles')}
    if not sources:
        raise ValueError('List the final modeling code for all parts in sourceFiles.')
    thumbnail = relative_file(root, data.get('thumbnail'), IMAGE_TYPES)
    interaction = None
    if data.get('interaction'):
        interaction = relative_file(root, data['interaction'], {'.json'})
        spec = read_json(interaction)
        if not isinstance(spec, dict) or spec.get('schema') not in {
            'atlantis-gallery-interactions/1', 'atlantis-gallery-interactions/2',
        }:
            raise ValueError('Use a supported Gallery interaction schema.')
        logic = spec.get('logic')
        if logic is not None and (not isinstance(logic, dict) or logic.get('profile') != 'microwave'):
            raise ValueError('Use declarative actions or a Python profile already supported by Gallery.')
        model_archive[data['interaction']] = interaction
    work_order = None
    if data.get('workOrder'):
        work_order = relative_file(root, data['workOrder'], {'.json'})
        if not isinstance(read_json(work_order), (dict, list)):
            raise ValueError('workOrder must be a JSON object or array.')

    output.mkdir(parents=True)
    for name, source in preview.items():
        dest = output / 'preview' / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, dest)
    # Archive the same preview bytes that will be uploaded to the viewer.
    model_archive.update({name: output / 'preview' / name for name in preview})
    thumbnail_name = 'preview' + thumbnail.suffix.lower()
    shutil.copyfile(thumbnail, output / thumbnail_name)
    zip_files(output / 'model.zip', model_archive)
    zip_files(output / 'modeling-code.zip', sources)
    metadata.update(model='preview/' + quote(model), thumbnail=thumbnail_name)
    metadata['downloads'] = [
        {'label': 'Download Model and Motion Files', 'file': 'model.zip'},
        {'label': 'Download Modeling Code', 'file': 'modeling-code.zip'},
    ]
    if interaction:
        shutil.copyfile(interaction, output / 'interaction.json')
        metadata['interaction'] = 'interaction.json'
    if work_order:
        shutil.copyfile(work_order, output / 'work-order.json')
        metadata['downloads'].append({'label': 'Download Work Order', 'file': 'work-order.json'})

    digest = hashlib.sha256(json.dumps(metadata, sort_keys=True).encode())
    public_files = []
    for path in sorted(output.rglob('*')):
        if not path.is_file():
            continue
        name = path.relative_to(output).as_posix()
        size = path.stat().st_size
        if size >= MAX_FILE:
            raise ValueError(f'{name} exceeds the GitHub file limit for this upload.')
        with path.open('rb') as stream:
            checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
        public_files.append({'file': name, 'bytes': size, 'sha256': checksum})
    digest.update(json.dumps(public_files, sort_keys=True).encode())
    return {
        'metadata': metadata,
        'files': public_files,
        'model_archive_contents': sorted(model_archive),
        'code_archive_contents': sorted(sources),
        'work_order_included': work_order is not None,
        'approval_digest': digest.hexdigest(),
    }


def add_to_catalog(checkout, asset_id, package, plan):
    catalog_file = checkout / 'catalog.json'
    catalog = read_json(catalog_file)
    base = f'./models/{asset_id}/'
    entry = {'id': asset_id, **plan['metadata']}
    del entry['slug']
    for field in ('model', 'thumbnail', 'interaction'):
        if field in entry:
            entry[field] = base + entry[field]
    entry['downloads'] = [
        {'label': item['label'], 'url': base + item['file']} for item in entry['downloads']
    ]

    existing = next((item for item in catalog if item['id'] == asset_id), None)
    destination = checkout / 'models' / asset_id
    if existing or destination.exists():
        if existing == entry and all(
            (destination / item['file']).is_file()
            and hashlib.sha256((destination / item['file']).read_bytes()).hexdigest() == item['sha256']
            for item in plan['files']
        ):
            return False
        raise ValueError(f'{asset_id} already exists. Pick a new slug to submit a new work.')

    shutil.copytree(package, destination)
    catalog.insert(0, entry)
    write_json(catalog_file, catalog)
    return True
