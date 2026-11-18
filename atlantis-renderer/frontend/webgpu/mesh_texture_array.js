                                                                               
                                                                                 
import {Texture,formatInfo,generateMipmaps} from '../../vendor/tidewater/src/engine/webgpu.js';

export const TEXTURE_ARRAY_SCHEMA='aps-glb-texture-arrays/1';
export const DEFAULT_MAX_ARRAY_LAYERS=256;
const RGBA8=new Set(['rgba8unorm','rgba8unorm-srgb']);

const positive=value=>Number.isInteger(value)&&value>0;
const colorSpaces=new Set(['srgb','linear']);

export function textureMipCount(width,height,mips=true) {
  if(!positive(width)||!positive(height))throw Error('Texture array dimensions must be positive integers');
  if(mips===false||mips===0)return 1;
  const max=Math.floor(Math.log2(Math.max(width,height)))+1;
  if(mips===true)return max;
  if(!positive(mips)||mips>max)throw Error(`Invalid texture mip count ${mips}`);
  return mips;
}

export function textureColorFormat(colorSpace) {
  if(colorSpace==='srgb')return 'rgba8unorm-srgb';
  if(colorSpace==='linear')return 'rgba8unorm';
  throw Error(`Unsupported texture color space ${colorSpace}`);
}

export function textureArrayLayerLimit(limits) {
  const value=limits?.maxTextureArrayLayers;
  if(value===undefined)return DEFAULT_MAX_ARRAY_LAYERS;
  if(!positive(value))throw Error(`Invalid device maxTextureArrayLayers ${value}`);
  return value;
}

function normalizeLayer(entry,index) {
  if(!entry||typeof entry!=='object')throw Error(`Invalid texture array entry ${index}`);
  const {width,height}=entry;
  if(!positive(width)||!positive(height))throw Error(`Texture array entry ${entry.key??index} has invalid dimensions`);
  if(!colorSpaces.has(entry.colorSpace))throw Error(`Texture array entry ${entry.key??index} has invalid colorSpace`);
  const format=entry.format??textureColorFormat(entry.colorSpace);
  if(!RGBA8.has(format))throw Error(`Texture array entry ${entry.key??index} has unsupported format ${format}`);
  if(textureColorFormat(entry.colorSpace)!==format)throw Error(`Texture array entry ${entry.key??index} format/colorSpace disagree`);
  const mipCount=textureMipCount(width,height,entry.mips??entry.mipCount??true);
  if(entry.mipCount!==undefined&&entry.mipCount!==mipCount)throw Error(`Texture array entry ${entry.key??index} mipCount mismatch`);
  return {...entry,format,mipCount};
}

function normalizeEntry(entry,index) {
  const normalized=normalizeLayer(entry,index),{key,imageIndex}=normalized;
  if(typeof key!=='string'||!key)throw Error(`Texture array entry ${index} needs a stable key`);
  if(!Number.isInteger(imageIndex)||imageIndex<0)throw Error(`Texture array entry ${key} needs imageIndex`);
  return normalized;
}

export function textureArrayKey(entry) {
  const e=normalizeEntry(entry,0);
  return `${e.width}x${e.height}|${e.format}|${e.colorSpace}|${e.mipCount}`;
}

function safeToken(value) {
  const token=String(value??'').replace(/[^A-Za-z0-9]+/g,'_');
  if(!token)throw Error('Empty texture array token');
  return token;
}

export function textureArrayBindingName(array) {
  return `apsMeshArray_${safeToken(array.bank)}_${safeToken(array.format)}_${array.width}x${array.height}_m${array.mipCount}_c${array.chunk}`;
}

                                                                              
                                                                           
                                 
export function planTextureArrays(entries,{maxLayers=DEFAULT_MAX_ARRAY_LAYERS,minLayers=2,bank='b00'}={}){
  if(!Array.isArray(entries))throw Error('Texture array entries must be an array');
  if(!positive(maxLayers))throw Error(`Invalid texture array layer limit ${maxLayers}`);
  if(!positive(minLayers))throw Error(`Invalid texture array minimum ${minLayers}`);
  const bankToken=safeToken(bank);
  const groups=new Map(),seen=new Set();
  entries.forEach((raw,index)=>{
    const entry=normalizeEntry(raw,index);
    if(seen.has(entry.key))throw Error(`Duplicate texture array entry ${entry.key}`);
    seen.add(entry.key);
    const key=textureArrayKey(entry);
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(entry);
  });
  const arrays=[],twoDimensional=[],bindings=new Map();
  let chunk=0;
  for(const key of [...groups.keys()].sort()) {
    const group=groups.get(key).sort((a,b)=>a.key.localeCompare(b.key));
    for(let start=0;start<group.length;start+=maxLayers) {
      const layerEntries=group.slice(start,start+maxLayers);
      if(maxLayers>1&&layerEntries.length>=minLayers) {
        const first=layerEntries[0],array={
          schema:'aps-texture-array/1',bank:bankToken,chunk,
          width:first.width,height:first.height,format:first.format,colorSpace:first.colorSpace,mipCount:first.mipCount,
          layers:layerEntries.map((entry,layer)=>({...entry,layer})),
        };
        array.arrayName=textureArrayBindingName(array);
        for(const entry of array.layers)bindings.set(entry.key,{...entry,array:true,arrayName:array.arrayName,arrayIndex:arrays.length,arrayLayer:entry.layer});
        arrays.push(array);chunk++;
        continue;
      }
      for(const entry of layerEntries) {
        const reason=maxLayers===1?'device-array-layers-1':start>0?'short-tail':layerEntries.length<minLayers?'singleton':'short-tail';
        twoDimensional.push({...entry,reason});
        bindings.set(entry.key,{...entry,array:false,arrayName:null,arrayIndex:null,arrayLayer:null});
      }
    }
  }
  const counts={arrays:arrays.length,array_layers:arrays.reduce((sum,array)=>sum+array.layers.length,0),textures_2d:twoDimensional.length,bindings:arrays.length+twoDimensional.length,images:entries.length};
  return {schema:'aps-texture-array-plan/1',bank:bankToken,maxLayers,minLayers,arrays,twoDimensional,bindings,counts};
}

export function mergeTextureLayers(layers) {
  if(!Array.isArray(layers)||!layers.length)throw Error('Texture array merge needs at least one layer');
  const first=normalizeLayer(layers[0],0),bytes=formatInfo(first.format).bytes;
  if(bytes!==4)throw Error(`Texture array merge supports rgba8 only, got ${first.format}`);
  const expected=first.width*first.height*bytes;
  const output=new Uint8Array(expected*layers.length);
  layers.forEach((raw,index)=>{
    const layer=normalizeLayer(raw,index);
    if(layer.width!==first.width||layer.height!==first.height||layer.format!==first.format||layer.colorSpace!==first.colorSpace||layer.mipCount!==first.mipCount)throw Error('Texture array layer metadata mismatch');
    const data=layer.data;
    if(!ArrayBuffer.isView(data)||data.byteLength!==expected)throw Error(`Texture array layer ${index} has ${data?.byteLength??'(missing)'} bytes, expected ${expected}`);
    output.set(new Uint8Array(data.buffer,data.byteOffset,data.byteLength),index*expected);
  });
  return output;
}

                                                                                
                                                                              
                                                        
export class MeshTextureArray extends Texture {
  constructor({layers=[],...options}={}) {
    if(!Array.isArray(layers)||!layers.length)throw Error('MeshTextureArray needs at least one layer');
    super({...options,dimension:'2d-array',depth:layers.length});
    const bytes=formatInfo(this.format).bytes,expected=this.width*this.height*bytes;
    this.pendingLayers=layers.map((layer,index)=>{
      const id=layer.layer??index;
      if(!Number.isInteger(id)||id<0||id>=this.depth)throw Error(`Invalid array layer ${id}`);
      const data=layer.data;
      if(!ArrayBuffer.isView(data)||data.byteLength!==expected)throw Error(`Array layer ${id} has ${data?.byteLength??'(missing)'} bytes, expected ${expected}`);
      return {layer:id,data};
    });
    this.userData={...(this.userData??{}),schema:TEXTURE_ARRAY_SCHEMA,kind:'gltf-texture-2d-array',layers:this.depth};
  }

  getGPU() {
    const fresh=!this.gpu,result=super.getGPU();
    if(fresh) {
      for(const {layer,data} of this.pendingLayers??[])super.upload(data,{mip:0,layer,layers:1});
      this.pendingLayers=null;
      if(this.mipLevelCount>1)generateMipmaps(this);
    }
    return result;
  }
}
