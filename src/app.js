import { galleryUrl, loadCatalog, readPage, workUrl } from './catalog.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const loading = $('loading');
const controls = $('controls');
const status = $('status');
const fileInput = $('file');
const shareButton = $('share');
const actionIds = ['frame', 'recolor', 'restore'];
controls.addEventListener('motionerror', event => { status.textContent = event.detail; });

$('back').href = galleryUrl(readPage(params));

function showDetails(item) {
  $('title').textContent = item.title;
  $('creator').textContent = item.creator || 'Anonymous Creator';
  $('description').textContent = item.description || '';
  $('about-work').hidden = !item.description;
  document.title = `${item.title} · Atlantis Gallery`;

  const downloads = $('downloads');
  downloads.replaceChildren();
  for (const file of item.downloads || []) {
    const link = document.createElement('a');
    link.className = 'download';
    link.href = file.url;
    link.download = '';
    link.textContent = file.label;
    downloads.append(link);
  }
  if (!downloads.children.length) downloads.textContent = 'No downloads are available for this work.';
}

async function loadInteraction(url) {
  if (!url) return {};
  const response = await fetch(url);
  if (!response.ok) throw new Error('Could not load the interaction file.');
  return response.json();
}

function setupViewer(viewer) {
  for (const id of actionIds) $(id).addEventListener('click', () => viewer[id]());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    const url = URL.createObjectURL(file);
    fileInput.disabled = true;
    loading.hidden = false;
    loading.textContent = 'Loading local model…';
    try {
      const result = await viewer.load(url, {}, file.name);
      showDetails({ title: file.name, creator: 'Local Preview' });
      shareButton.hidden = true;
      $('share-status').hidden = true;
      setModelActions(result);
    } catch (error) {
      status.textContent = 'Could not open the local model. Select a valid USD or glTF file.';
      console.error(error);
    } finally {
      URL.revokeObjectURL(url);
      loading.hidden = true;
      fileInput.disabled = false;
      fileInput.value = '';
    }
  });

}

function setModelActions(result) {
  $('frame').disabled = false;
  $('recolor').disabled = result.meshes === 0;
  $('restore').disabled = result.meshes === 0;
  $('interaction-panel').hidden = !controls.children.length;
  status.textContent = result.errors.join(' · ');
}

async function showWork() {
  const id = params.get('model');
  const item = id && (await loadCatalog()).find(entry => entry.id === id);
  if (!item) {
    $('work-status').textContent = 'This work could not be found. Return to the gallery to browse other works.';
    return;
  }
  showDetails(item);
  $('work-status').hidden = true;
  $('work').hidden = false;

  // Sharing and download links remain available if the 3D renderer cannot start.
  shareButton.addEventListener('click', async () => {
    const url = workUrl(item.id).href;
    const message = $('share-status');
    try {
      await navigator.clipboard.writeText(url);
      message.textContent = 'Link copied.';
    } catch {
      message.textContent = url;
    }
    message.hidden = false;
  });

  try {
    const { GalleryViewer } = await import('./viewer.js');
    const viewer = new GalleryViewer($('stage'), controls);
    await viewer.init();
    setupViewer(viewer);
    loading.textContent = 'Loading model…';
    let spec = {};
    let interactionWarning;
    try {
      spec = await loadInteraction(item.interaction);
    } catch (error) {
      interactionWarning = 'Could not load the model controls.';
      console.error(error);
    }
    try {
      const result = await viewer.load(item.model, spec);
      setModelActions(result);
      const issues = [interactionWarning, ...result.errors].filter(Boolean);
      status.textContent = issues.join(' · ');
    } finally {
      fileInput.disabled = false;
    }
  } catch (error) {
    status.textContent = 'Could not load the 3D preview.';
    console.error(error);
  } finally {
    loading.hidden = true;
  }
}

try {
  await showWork();
} catch (error) {
  $('work-status').textContent = 'Could not load this work. Refresh to try again.';
  console.error(error);
}
