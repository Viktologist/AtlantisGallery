                                                    
  
                                                                           
                                                                                
                                                                            
                                                      
  
                                                                               
                                                                         
                                                                          
                                                                                
  
                                                                            
                                                                               
                                                                              
                                                                
import {inspectGLB} from './mesh_gltf.js';

export const NATIVE_IMPORT_SCHEMA = 'aps-native-mesh-import/1';
export const NATIVE_NORMALS_SCHEMA = 'aps-native-mesh-normals/1';
export const PREPARE_ENDPOINT = '/__mesh-normals/prepare';
export const CAPABILITY_ENDPOINT = '/__mesh-normals/capability';

const capabilityCache = new Map();
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export class MeshNormalImportError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'MeshNormalImportError';
    this.code = code;
    this.detail = detail;
  }
}

export function clearNativeImportCapabilityCache() {
  capabilityCache.clear();
}

function fail(code, message, detail = null) {
  throw new MeshNormalImportError(code, message, detail);
}

async function digest(buffer) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)),
    value => value.toString(16).padStart(2, '0')).join('');
}

function importOrigin(url) {
  if (!['http:', 'https:'].includes(url.protocol)) {
    fail('NORMAL_IMPORT_SOURCE_UNSUPPORTED',
      `Native normal preparation requires a same-origin HTTP(S) GLB source, not ${url.protocol}`);
  }
  const location = globalThis.location;
  if (!location || !['http:', 'https:'].includes(location.protocol)) {
    fail('NORMAL_IMPORT_SERVER_UNAVAILABLE',
      'Native model import requires the same-origin scene server; file:// pages cannot persist normals');
  }
  if (location.origin !== url.origin) {
    fail('NORMAL_IMPORT_CROSS_ORIGIN',
      `Model ${url.origin} is not the viewer origin ${location.origin}; refusing unprepared cross-origin import`);
  }
                                                                          
                                                                              
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    fail('NORMAL_IMPORT_SOURCE_UNSUPPORTED',
      `Native normal preparation requires a loopback HTTP or same-origin HTTPS model host, not ${url.hostname}`);
  }
  return url.origin;
}

async function capability(origin, signal) {
  if (capabilityCache.has(origin)) return capabilityCache.get(origin);
  let response;
  try {
    response = await fetch(new URL(CAPABILITY_ENDPOINT, origin),
      {signal, cache: 'no-store', credentials: 'same-origin'});
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    fail('NORMAL_IMPORT_SERVER_UNAVAILABLE',
      'Owned loopback normal-preparation server is unavailable', String(error));
  }
  if (!response.ok) {
    fail('NORMAL_IMPORT_SERVER_UNAVAILABLE',
      `Owned loopback server does not advertise native normal preparation (HTTP ${response.status})`);
  }
  const document = await response.json().catch(() => null);
  if (!document || document.schema !== NATIVE_IMPORT_SCHEMA
      || document.endpoint !== PREPARE_ENDPOINT || document.method !== 'PUT'
      || !(document.version >= 1)) {
    fail('NORMAL_IMPORT_SERVER_INCOMPATIBLE',
      'Loopback normal-preparation capability schema/endpoint is incompatible', document);
  }
  capabilityCache.set(origin, document);
  return document;
}

function validateReceipt(json, receipt) {
  const embedded = json?.extras?.aps_native_normals;
  if (!embedded || embedded.schema !== NATIVE_NORMALS_SCHEMA) {
    fail('NORMAL_IMPORT_RECEIPT_MISSING',
      'Fetched model has no embedded native normal-preparation receipt');
  }
  if (receipt) {
    for (const key of ['schema', 'algorithm_version', 'content_sha256', 'bin_sha256', 'source_sha256']) {
      if (embedded[key] !== receipt[key]) {
        fail('NORMAL_IMPORT_RECEIPT_MISMATCH',
          `Fetched model receipt field ${key} differs from the server response`);
      }
    }
  }
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      if ((primitive.mode ?? 4) !== 4) continue;
      const attributes = primitive.attributes ?? {};
      if (attributes.POSITION === undefined || attributes.NORMAL === undefined) {
        fail('NORMAL_IMPORT_RECEIPT_INVALID',
          'Prepared triangle primitive is missing POSITION/NORMAL');
      }
      if (attributes.TANGENT !== undefined) {
        fail('NORMAL_IMPORT_RECEIPT_INVALID',
          'Prepared triangle primitive retains a stale TANGENT');
      }
      const count = json.accessors?.[attributes.POSITION]?.count;
      if (!Number.isInteger(count)) fail('NORMAL_IMPORT_RECEIPT_INVALID', 'Invalid prepared POSITION');
      for (const [name, index] of Object.entries(attributes)) {
        if (json.accessors?.[index]?.count !== count) {
          fail('NORMAL_IMPORT_RECEIPT_INVALID',
            `Prepared attribute ${name} count differs from POSITION`);
        }
      }
    }
  }
}

async function inMemoryTestSource(absolute, assetFile) {
  if (typeof globalThis.window !== 'undefined' || typeof document !== 'undefined') {
    fail('NORMAL_IMPORT_TEST_HOOK_IN_BROWSER',
      'globalThis.__assetFile is a test seam and is refused in a browser page');
  }
  const buffer = await assetFile(absolute);
  if (!(buffer instanceof ArrayBuffer)) {
    fail('NORMAL_IMPORT_SOURCE_INVALID', 'Test asset hook did not return an ArrayBuffer');
  }
  return {
    buffer,
    url: absolute,
    fetchUrl: absolute,
    metadata: {
      schema: NATIVE_IMPORT_SCHEMA,
      status: 'test-in-memory-unpersisted',
      persisted: false,
      source_url: absolute,
      output_sha256: await digest(buffer),
      warning: 'Node test-only in-memory source; production pages must use the loopback normal-preparation server',
    },
  };
}

export async function prepareNativeImport(absolute, signal, {assetFile = globalThis.__assetFile} = {}) {
  const url = new URL(absolute, globalThis.location?.href ?? 'http://127.0.0.1/');
  if (typeof assetFile === 'function') return inMemoryTestSource(absolute, assetFile);
  const origin = importOrigin(url);
  const advert = await capability(origin, signal);
  if (signal?.aborted) throw signal.reason ?? new DOMException('Import aborted', 'AbortError');
  const requestPath = url.pathname + url.search;
  let response;
  try {
    response = await fetch(new URL(PREPARE_ENDPOINT, origin), {
      method: 'PUT',
      signal,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({url: requestPath}),
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    fail('NORMAL_IMPORT_SERVER_UNAVAILABLE',
      'Loopback normal-preparation request failed', String(error));
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result || result.schema !== NATIVE_IMPORT_SCHEMA) {
    const code = result?.error?.code ?? `NORMAL_IMPORT_HTTP_${response.status}`;
    const message = result?.error?.message ?? `Normal preparation failed (HTTP ${response.status})`;
    fail(code, message, result);
  }
  if (result.error) {
    fail(result.error.code ?? 'NORMAL_IMPORT_SERVER_REJECTED',
      result.error.message ?? 'Normal preparation was rejected', result);
  }
  if (!['normal_prepared', 'already_prepared'].includes(result.status)
      || !/^[0-9a-f]{64}$/.test(result.output_sha256 ?? '')) {
    fail('NORMAL_IMPORT_SERVER_RESPONSE', 'Normal-preparation server response is incomplete', result);
  }
                                                                               
                                                                     
  const fetchUrl = new URL(url.href);
  fetchUrl.searchParams.set('aps_normal_import', result.output_sha256.slice(0, 20));
  let model;
  try {
    model = await fetch(fetchUrl.href, {signal, cache: 'no-store', credentials: 'include'});
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    fail('NORMAL_IMPORT_FETCH_FAILED', 'Cannot fetch normal-prepared model', String(error));
  }
  if (!model.ok) fail('NORMAL_IMPORT_FETCH_FAILED',
    `Cannot fetch normal-prepared model (HTTP ${model.status})`);
  const buffer = await model.arrayBuffer();
  const outputSHA = await digest(buffer);
  if (outputSHA !== result.output_sha256) {
    fail('NORMAL_IMPORT_HASH_MISMATCH',
      'Fetched model bytes do not match the validated normal-prepared receipt; refusing to render stale content',
      {expected: result.output_sha256, actual: outputSHA});
  }
  let inspected;
  try {
    inspected = inspectGLB(buffer);
  } catch (error) {
    fail('NORMAL_IMPORT_RECEIPT_INVALID', 'Prepared model is not a complete GLB', String(error));
  }
  validateReceipt(inspected.json, result.receipt);
  return {
    buffer,
    url: absolute,
    fetchUrl: fetchUrl.href,
    metadata: {
      schema: NATIVE_IMPORT_SCHEMA,
      server_version: advert.version,
      status: result.status,
      persisted: true,
      source_url: absolute,
      fetch_url: fetchUrl.href,
      canonical: result.canonical,
      source_sha256: result.source_sha256,
      input_sha256: result.input_sha256,
      output_sha256: result.output_sha256,
      content_sha256: result.content_sha256,
      bin_sha256: result.bin_sha256,
      input_bytes: result.input_bytes,
      output_bytes: result.output_bytes,
      rewritten: !!result.rewritten,
      algorithm: result.algorithm,
      audit: result.audit,
      receipt: result.receipt,
      capability: {schema: advert.schema, version: advert.version,
        endpoint: advert.endpoint, method: advert.method,
        allowed_roots: advert.allowed_roots},
    },
  };
}
