                                                                                
                                                                                 
export class FoamPagePool {
 constructor(layout,{capacity=9,pixelsPerCell=2}={}){
  if(!Number.isInteger(capacity)||capacity<1||capacity>9)throw Error('Foam pool needs 1–9 pages');
  this.layout=layout;this.capacity=capacity;this.pixelsPerCell=pixelsPerCell;
  this.lookup=new Map(layout.tiles.map(t=>[t.key,t]));this.slots=Array(capacity).fill(null);this.revisions=0;
 }
 update({position,forward,fov,height,seaLevel=0}){
  if(![...position,...forward,fov,height,seaLevel].every(Number.isFinite)||height<=0)throw Error('Foam LOD needs a finite camera');
  const l=this.layout,m=l.tileMetres,scale=2*Math.tan(fov*Math.PI/360)/height*this.pixelsPerCell;
  let distance=forward[1]<-1e-5?(seaLevel-position[1])/forward[1]:0;
  distance=Math.max(0,Math.min(1200,distance));const center=[position[0]+forward[0]*distance,position[2]+forward[2]*distance];
  const tx=Math.floor((center[0]-l.origin[0])/m),tz=Math.floor((center[1]-l.origin[1])/m),desired=[];
  for(let z=tz-1;z<=tz+1;z++)for(let x=tx-1;x<=tx+1;x++){
   const tile=this.lookup.get(z*l.shape[0]+x);if(!tile||tile.x!==x||tile.z!==z)continue;
   const dx=Math.max(tile.origin[0]-position[0],0,position[0]-tile.origin[0]-m),dz=Math.max(tile.origin[1]-position[2],0,position[2]-tile.origin[1]-m);
   const projectedCell=Math.hypot(dx,dz,position[1]-seaLevel)*scale,old=this.slots.find(s=>s?.key===tile.key);
                                                                         
   const fineThreshold=old?.cell===.25?.30:.25,midThreshold=old?.cell===.5?.60:.5;
   const cell=projectedCell<=fineThreshold?.25:projectedCell<=midThreshold?.5:1;
   if(cell<1)desired.push({...tile,cell,cells:m/cell});
  }
  desired.sort((a,b)=>Math.hypot(a.origin[0]+m/2-center[0],a.origin[1]+m/2-center[1])-Math.hypot(b.origin[0]+m/2-center[0],b.origin[1]+m/2-center[1]));
  const selected=desired.slice(0,this.capacity),old=this.slots,next=Array(this.capacity).fill(null);
  for(let i=0;i<old.length;i++)if(old[i]&&selected.some(s=>s.key===old[i].key))next[i]={...selected.find(s=>s.key===old[i].key),slot:i};
  for(const tile of selected)if(!next.some(s=>s?.key===tile.key)){const slot=next.indexOf(null);next[slot]={...tile,slot};}
  const changed=next.some((s,i)=>s?.key!==old[i]?.key||s?.cell!==old[i]?.cell);
  if(!changed)return null;
  const oldOrigins=new Float32Array(this.capacity*4),origins=new Float32Array(this.capacity*4),index=new Uint32Array(l.shape[0]*l.shape[1]);
  const selectedKeys=new Set(selected.map(t=>t.key));
  for(let i=0;i<this.capacity;i++){
   if(old[i])oldOrigins.set([...old[i].origin,old[i].cells,old[i].id+1],i*4);
   if(next[i]){
    const t=next[i],seed=old[i]?.key!==t.key||old[i]?.cell!==t.cell;
                                                                             
                                                                            
    const exterior=(t.x===0||!selectedKeys.has(t.key-1)?1:0)|(t.x===l.shape[0]-1||!selectedKeys.has(t.key+1)?2:0)|(!selectedKeys.has(t.key-l.shape[0])?4:0)|(!selectedKeys.has(t.key+l.shape[0])?8:0);
    origins.set([...t.origin,t.cells,(seed?1:0)+2*exterior],i*4);index[t.key]=i+1;
   }
  }
  this.slots=next;this.revisions++;return {oldOrigins,origins,index,old,slots:next,center};
 }
 metadata(){return {capacity:this.capacity,resident:this.slots.filter(Boolean).length,levels_m:[.25,.5,1],pixels_per_cell:this.pixelsPerCell,revisions:this.revisions,pages:this.slots.filter(Boolean).map(s=>({world_key:s.key,slot:s.slot,cell_m:s.cell,origin:s.origin})),allocation:'bounded reusable GPU pool; visual-distance selection with hysteresis',history:'retained slots untouched; evicted/resized history area-restricted to coarse, new/resized pages prolonged from coarse'};}
}
