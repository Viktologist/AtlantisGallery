                                                                        
export function readFloat32Npy(buffer) {
  const bytes=new Uint8Array(buffer),view=new DataView(buffer);
  if(bytes[0]!==147||String.fromCharCode(...bytes.slice(1,6))!=='NUMPY')throw Error('Expected NPY heightfield');
  const major=bytes[6],offset=major===1?10:12;
  if(![1,2,3].includes(major))throw Error('Unsupported NPY version');
  const length=major===1?view.getUint16(8,true):view.getUint32(8,true);
  const header=new TextDecoder().decode(bytes.slice(offset,offset+length));
  const match=header.match(/['"]shape['"]\s*:\s*\((\d+),\s*(\d+)\s*,?\)/);
  if(!match||!header.match(/['"]descr['"]\s*:\s*['"]<f4['"]/)||!header.match(/['"]fortran_order['"]\s*:\s*False/))throw Error('Expected native C-order little-endian float32 2D NPY');
  const shape=[Number(match[1]),Number(match[2])],start=offset+length;
  if(buffer.byteLength-start!==shape[0]*shape[1]*4)throw Error('Heightfield byte count mismatch');
  const data=new Float32Array(buffer,start);
  for(const value of data)if(!Number.isFinite(value))throw Error('Nonfinite native elevation');
  return {data,shape};
}

                                                                             
                                                                            
export function selectHeightfieldPatches(shape,spacing,eye,range,focal,pixelStep=2) {
  const rows=[],[nz,nx]=shape,[dx,dz]=spacing;
  function visit(x,z,width){
    if(x>=nx-1||z>=nz-1)return;
    const minX=x*dx,minZ=z*dz,maxX=Math.min(x+width,nx-1)*dx,maxZ=Math.min(z+width,nz-1)*dz;
    const distance=Math.max(Math.min(dx,dz),Math.hypot(Math.max(minX-eye[0],0,eye[0]-maxX),Math.max(range[0]-eye[1],0,eye[1]-range[1]),Math.max(minZ-eye[2],0,eye[2]-maxZ)));
    const step=width*Math.max(dx,dz)/64;
    if(width>64&&step*focal/distance>pixelStep){const half=width/2;visit(x,z,half);visit(x+half,z,half);visit(x,z+half,half);visit(x+half,z+half,half);}
    else rows.push([x,z,width,width===64?0:step*4]);
  }
  visit(0,0,Math.max(64,2**Math.ceil(Math.log2(Math.max(nx,nz)-1))));
  return rows;
}
