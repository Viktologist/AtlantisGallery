import {parseGLB} from '../../vendor/tidewater/src/engine/loaders/GLTF.js';
import {BufferGeometry,BufferAttribute,Matrix4,Vector3,Quaternion} from '../../vendor/tidewater/src/engine/index.js';

const SUPPORTED=new Set(['EXT_mesh_gpu_instancing','KHR_texture_transform','KHR_mesh_quantization','KHR_materials_unlit','KHR_materials_emissive_strength','KHR_materials_clearcoat']);
export function inspectGLB(buffer) {
  const dv=new DataView(buffer);
  if(buffer.byteLength<20||dv.getUint32(0,true)!==0x46546c67||dv.getUint32(4,true)!==2||dv.getUint32(8,true)!==buffer.byteLength)throw Error('Expected complete GLB 2');
  const chunks=[]; let json;
  for(let o=12;o<buffer.byteLength;) {
    if(o+8>buffer.byteLength)throw Error('Truncated GLB chunk header');
    const length=dv.getUint32(o,true),type=dv.getUint32(o+4,true);
    if(length%4||o+8+length>buffer.byteLength)throw Error('Truncated or unaligned GLB chunk');
    const bytes=new Uint8Array(buffer,o+8,length); chunks.push({type,bytes});
    if(type===0x4e4f534a) { if(json)throw Error('Duplicate GLB JSON'); json=JSON.parse(new TextDecoder().decode(bytes)); }
    o+=8+length;
  }
  if(!json||json.asset?.version!=='2.0')throw Error('Missing glTF 2 JSON');
  if(chunks.filter(c=>c.type===0x004e4942).length>1)throw Error('Duplicate GLB BIN');
  return {json,chunks};
}
function packGLB(json,chunks) {
  const encoded=new TextEncoder().encode(JSON.stringify(json)); const size=(encoded.length+3)&~3;
  const other=chunks.filter(c=>c.type!==0x4e4f534a);
  const buffer=new ArrayBuffer(20+size+other.reduce((n,c)=>n+8+c.bytes.length,0)),v=new DataView(buffer);
  v.setUint32(0,0x46546c67,true);v.setUint32(4,2,true);v.setUint32(8,buffer.byteLength,true);
  v.setUint32(12,size,true);v.setUint32(16,0x4e4f534a,true);
  new Uint8Array(buffer,20,size).fill(32);new Uint8Array(buffer,20,encoded.length).set(encoded);
  let o=20+size;for(const c of other){v.setUint32(o,c.bytes.length,true);v.setUint32(o+4,c.type,true);new Uint8Array(buffer,o+8,c.bytes.length).set(c.bytes);o+=8+c.bytes.length;}
  return buffer;
}
function validate(json) {
  for(const name of json.extensionsRequired??[])if(!SUPPORTED.has(name))throw Error(`Unsupported required glTF extension ${name}`);
  for(const image of json.images??[])if(image.uri!==undefined&&!/^(data:|blob:)/.test(image.uri))throw Error('External glTF image URI is unsupported');
  if((json.buffers??[]).some((b,i)=>i!==0||b.uri!==undefined))throw Error('External glTF buffers are unsupported');
  for(const a of json.accessors??[]) {
    if(!['SCALAR','VEC2','VEC3','VEC4','MAT2','MAT3','MAT4'].includes(a.type)||![5120,5121,5122,5123,5125,5126].includes(a.componentType)||!Number.isInteger(a.count)||a.count<0)throw Error('Invalid/unsupported glTF accessor');
    const bytes={5120:1,5121:1,5122:2,5123:2,5125:4,5126:4}[a.componentType];
    if(a.bufferView!==undefined) {
      const bv=json.bufferViews?.[a.bufferView]; const element=accessorLayout(a.type,bytes).size; const stride=bv?.byteStride??element;
      if(!bv||bv.buffer!==0||stride<element||stride%bytes||(a.byteOffset??0)<0||(a.count&&((a.byteOffset??0)+(a.count-1)*stride+element)>bv.byteLength))throw Error('Invalid glTF accessor bounds/stride');
    }
  }
  for(const mesh of json.meshes??[])for(const p of mesh.primitives??[]) {
    if(!p.attributes||p.attributes.POSITION===undefined)throw Error('Missing POSITION');
    if(!Number.isInteger(p.mode??4)||(p.mode??4)<0||(p.mode??4)>6)throw Error('Invalid primitive mode');
    for(const semantic of Object.keys(p.attributes))if(!/^(POSITION|NORMAL|TANGENT|COLOR_[01]|JOINTS_0|WEIGHTS_0|TEXCOORD_[0-3]|_[A-Za-z0-9_]+)$/.test(semantic))throw Error(`Unsupported glTF vertex semantic ${semantic}`);
  }
  for(const n of json.nodes??[]) {
    if(n.matrix&&[n.translation,n.rotation,n.scale].some(x=>x!==undefined))throw Error('glTF node cannot combine matrix and TRS');
    for(const [field,size] of [['matrix',16],['translation',3],['rotation',4],['scale',3]])if(n[field]&&(!Array.isArray(n[field])||n[field].length!==size||!n[field].every(Number.isFinite)))throw Error(`Invalid node ${field}`);
    if(n.matrix&&(n.matrix[3]!==0||n.matrix[7]!==0||n.matrix[11]!==0||n.matrix[15]!==1))throw Error('Non-affine node matrix');
    const attrs=n.extensions?.EXT_mesh_gpu_instancing?.attributes;
    if(attrs) {
      if(n.mesh===undefined||!Object.keys(attrs).length)throw Error('Invalid EXT_mesh_gpu_instancing node');
      let count;
      for(const [name,index] of Object.entries(attrs)) {
        if(!['TRANSLATION','ROTATION','SCALE'].includes(name)&&!name.startsWith('_'))throw Error(`Unsupported instance semantic ${name}`);
        const a=json.accessors?.[index];
        if(!a||a.count<=0||count!==undefined&&a.count!==count)throw Error('Mismatched instance accessor counts');
        if(['TRANSLATION','SCALE'].includes(name)&&a.type!=='VEC3'||name==='ROTATION'&&a.type!=='VEC4')throw Error(`Invalid instance ${name}`);
        count=a.count;
      }
    }
  }
}
                                                              
const WIDTHS={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT2:4,MAT3:9,MAT4:16};
const ARRAYS={5120:Int8Array,5121:Uint8Array,5122:Int16Array,5123:Uint16Array,5125:Uint32Array,5126:Float32Array};
function accessorLayout(type,bytes) {
  const n=WIDTHS[type],columns=/^MAT([234])$/.exec(type),dim=columns?Number(columns[1]):0;
  const columnStride=dim?Math.ceil(dim*bytes/4)*4:0;
  return {size:dim?dim*columnStride:n*bytes,offsets:Array.from({length:n},(_,i)=>dim?Math.floor(i/dim)*columnStride+(i%dim)*bytes:i*bytes)};
}
export function readMeshAccessor(json,bin,index) {
  const a=json.accessors?.[index],Arr=ARRAYS[a?.componentType],width=WIDTHS[a?.type];
  if(!a||!Arr||!width)throw Error('Invalid accessor reference');
  const out=new Arr(a.count*width),size=Arr.BYTES_PER_ELEMENT;
  const read=(view,offset,count,n,ct,stride,type)=>{
    const bv=json.bufferViews?.[view],A=ARRAYS[ct],bytes=A?.BYTES_PER_ELEMENT;
    const layout=type?accessorLayout(type,bytes):{size:n*bytes,offsets:Array.from({length:n},(_,i)=>i*bytes)};
    stride??=bv?.byteStride??layout.size;
    if(!bv||!A||!Number.isInteger(offset)||offset<0||!Number.isInteger(count)||count<0||stride<layout.size||stride%bytes||offset%bytes||count&&offset+(count-1)*stride+layout.size>bv.byteLength)throw Error('Invalid accessor/sparse bounds');
    const dv=new DataView(bin.buffer,bin.byteOffset+(bv.byteOffset??0),bv.byteLength);
    const getters={5120:'getInt8',5121:'getUint8',5122:'getInt16',5123:'getUint16',5125:'getUint32',5126:'getFloat32'};
    const result=new A(count*n);
    for(let i=0;i<count;i++)for(let c=0;c<n;c++)result[i*n+c]=dv[getters[ct]](offset+i*stride+layout.offsets[c],true);
    return result;
  };
  if(a.bufferView!==undefined)out.set(read(a.bufferView,a.byteOffset??0,a.count,width,a.componentType,undefined,a.type));
  if(a.sparse) {
    const sp=a.sparse;
    if(!Number.isInteger(sp.count)||sp.count<1||sp.count>a.count||![5121,5123,5125].includes(sp.indices?.componentType)||!sp.values)throw Error('Invalid sparse accessor');
    const indices=read(sp.indices.bufferView,sp.indices.byteOffset??0,sp.count,1,sp.indices.componentType,ARRAYS[sp.indices.componentType].BYTES_PER_ELEMENT);
    const values=read(sp.values.bufferView,sp.values.byteOffset??0,sp.count,width,a.componentType,accessorLayout(a.type,size).size,a.type);
    for(let i=0;i<sp.count;i++) {
      if(indices[i]>=a.count||i&&indices[i]<=indices[i-1])throw Error('Invalid sparse accessor indices');
      out.set(values.subarray(i*width,(i+1)*width),indices[i]*width);
    }
  }
  return {array:out,itemSize:width,componentType:a.componentType,normalized:!!a.normalized};
}
export function parseMeshGLB(buffer) {
  const {json,chunks}=inspectGLB(buffer);validate(json);
  const bin=chunks.find(c=>c.type===0x004e4942)?.bytes;
  for(const bv of json.bufferViews??[])if(!bin||bv.buffer!==0||!Number.isInteger(bv.byteLength)||bv.byteLength<0||(bv.byteOffset??0)<0||(bv.byteOffset??0)+bv.byteLength>bin.length)throw Error('Invalid GLB bufferView bounds');
  const read=i=>readMeshAccessor(json,bin,i);
                                                                                   
  const copy=structuredClone(json);copy.extensionsRequired=[];copy.meshes=[];copy.skins=[];copy.animations=[];
  const parsed=parseGLB(packGLB(copy,chunks));parsed.json=json;
  parsed.meshes=(json.meshes??[]).map(mesh=>(mesh.primitives??[]).map(p=>({
    attributes:Object.fromEntries(Object.entries(p.attributes).map(([k,i])=>[k,read(i)])),
    targets:(p.targets??[]).map(t=>Object.fromEntries(Object.entries(t).map(([k,i])=>[k,read(i)]))),
    indices:p.indices===undefined?null:read(p.indices).array,material:p.material,mode:p.mode??4,
  })));
  parsed.instances=new Map();
  for(let i=0;i<(json.nodes??[]).length;i++) {
    const attrs=json.nodes[i].extensions?.EXT_mesh_gpu_instancing?.attributes;
    if(attrs)parsed.instances.set(i,Object.fromEntries(Object.entries(attrs).map(([k,index])=>[k,read(index)])));
  }
  parsed.animations=json.animations??[];                                    
  parsed.readAccessor=read;parsed.nativeBuffer=buffer;parsed.nativeBin=bin;
  return parsed;
}
export function floatAttribute(attribute) {
  if(attribute.array instanceof Float32Array)return attribute.array;
  const scales={5120:127,5121:255,5122:32767,5123:65535,5125:4294967295};
  const scale=attribute.normalized?1/scales[attribute.componentType]:1;
  return Float32Array.from(attribute.array,v=>attribute.normalized?Math.max(-1,v*scale):v);
}
export function instanceMatrices(attributes) {
  const a=Object.values(attributes)[0],count=a.array.length/a.itemSize;
  const T=attributes.TRANSLATION&&floatAttribute(attributes.TRANSLATION),R=attributes.ROTATION&&floatAttribute(attributes.ROTATION),S=attributes.SCALE&&floatAttribute(attributes.SCALE);
  const t=new Vector3(),q=new Quaternion(),s=new Vector3(),m=new Matrix4(),out=new Float32Array(count*16);
  for(let i=0;i<count;i++) {
    t.fromArray(T??[0,0,0],T?i*3:0);q.fromArray(R??[0,0,0,1],R?i*4:0);s.fromArray(S??[1,1,1],S?i*3:0);
    if(![t.x,t.y,t.z,q.x,q.y,q.z,q.w,s.x,s.y,s.z].every(Number.isFinite)||Math.abs(q.lengthSq()-1)>1e-3)throw Error('Invalid instance TRS/quaternion');
    m.compose(t,q,s);m.toArray(out,i*16);
  }
  return out;
}
export function primitiveGeometry(primitive) {
  const geometry=new BufferGeometry();
  try {
    const names={POSITION:'position',NORMAL:'normal',TANGENT:'tangent',COLOR_0:'color',COLOR_1:'color1',TEXCOORD_0:'uv',TEXCOORD_1:'uv1',TEXCOORD_2:'uv2',TEXCOORD_3:'uv3'};
    const count=primitive.attributes.POSITION.array.length/3;
    for(const [key,a] of Object.entries(primitive.attributes)) {
      if(!names[key])continue;
      const size={POSITION:3,NORMAL:3,TANGENT:4,COLOR_0:a.itemSize,COLOR_1:a.itemSize,TEXCOORD_0:2,TEXCOORD_1:2,TEXCOORD_2:2,TEXCOORD_3:2}[key];
      if(a.itemSize!==size||a.array.length/a.itemSize!==count||key.startsWith('COLOR_')&&![3,4].includes(a.itemSize))throw Error(`Invalid ${key} shape`);
      const array=floatAttribute(a);if(!array.every(Number.isFinite))throw Error(`Nonfinite ${key}`);
      geometry.setAttribute(names[key],new BufferAttribute(array,a.itemSize));
    }
    const native=primitive.indices; const mode=primitive.mode;
    if(native&&(!(native instanceof Uint8Array||native instanceof Uint16Array||native instanceof Uint32Array)||!native.every(i=>i<count)))throw Error('Invalid glTF indices');
    const sequence=native??Uint32Array.from({length:count},(_,i)=>i);let indices=native;
    let topology=mode===0?'point-list':mode<=3?'line-list':'triangle-list';
    if(mode===2||mode===3){const out=[];for(let i=1;i<sequence.length;i++)out.push(sequence[i-1],sequence[i]);if(mode===2&&sequence.length>1)out.push(sequence.at(-1),sequence[0]);indices=new Uint32Array(out);}
    if(mode===5||mode===6){const out=[];for(let i=2;i<sequence.length;i++)mode===6?out.push(sequence[0],sequence[i-1],sequence[i]):i%2?out.push(sequence[i-1],sequence[i-2],sequence[i]):out.push(sequence[i-2],sequence[i-1],sequence[i]);indices=new Uint32Array(out);}
    if(mode===4&&sequence.length%3||mode===1&&sequence.length%2)throw Error('Incomplete glTF primitive');
    if(indices)geometry.setIndex(new BufferAttribute(indices instanceof Uint8Array?new Uint16Array(indices):indices,1));
    geometry.userData={nativeAttributes:primitive.attributes,nativeIndices:native,nativeMode:mode};
    geometry.computeBoundingBox();geometry.computeBoundingSphere();
    return {geometry,topology,triangles:topology==='triangle-list'?(indices?.length??count)/3:0};
  } catch(e){geometry.dispose();throw e;}
}
