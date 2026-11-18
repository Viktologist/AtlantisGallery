                                                                               
                                                                               
export function buildVegetationBlocks(bounds,cellSize=16){
 if(!(cellSize>0&&Number.isFinite(cellSize))||bounds.length%8)throw Error('Invalid vegetation block input');
 const cells=new Map();
 for(let id=0;id<bounds.length/8;id++){
  const at=id*8,key=[0,1,2].map(k=>Math.floor(bounds[at+k]/cellSize)).join(',');
  let ids=cells.get(key);if(!ids)cells.set(key,ids=[]);ids.push(id);
 }
 const batches=[];for(const ids of cells.values())for(let i=0;i<ids.length;i+=64)batches.push(ids.slice(i,i+64));
 const data=new Uint32Array(batches.length*72),f=new Float32Array(data.buffer);
 batches.forEach((ids,block)=>{
  const at=block*72;data[at+3]=ids.length;data.set(ids,at+8);
  for(let k=0;k<3;k++){
   let lo=Infinity,hi=-Infinity;for(const id of ids){lo=Math.min(lo,bounds[id*8+k]-bounds[id*8+4+k]);hi=Math.max(hi,bounds[id*8+k]+bounds[id*8+4+k]);}
   f[at+k]=(lo+hi)*.5;
                                                                 
   f[at+4+k]=Math.max(f[at+k]-lo,hi-f[at+k])+Math.max(1,Math.abs(lo),Math.abs(hi))*2e-6;
  }
 });
 return {data,count:batches.length,cellSize};
}
