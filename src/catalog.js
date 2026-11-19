export async function loadCatalog() {
  const response = await fetch('./catalog.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error('Could not load the gallery catalog.');
  const catalog = await response.json();
  if (!Array.isArray(catalog)) throw new Error('Invalid gallery catalog format.');
  return catalog;
}

export function readPage(params) {
  const page = Number(params.get('page'));
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

export function galleryUrl(page = 1) {
  const url = new URL('./', location.href);
  if (page > 1) url.searchParams.set('page', page);
  return url;
}

export function workUrl(id, page = 1) {
  const url = new URL('./work.html', location.href);
  url.searchParams.set('model', id);
  if (page > 1) url.searchParams.set('page', page);
  return url;
}
