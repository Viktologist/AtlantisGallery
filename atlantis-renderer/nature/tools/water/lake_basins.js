                                                                               
                                                                           
                                                                            
class MinHeap {
  constructor(levels){this.levels=levels;this.a=new Uint32Array(4096);this.n=0;}
  less(i,j){return this.levels[i]<this.levels[j]||this.levels[i]===this.levels[j]&&i<j;}
  push(v){if(this.n===this.a.length){const b=new Uint32Array(this.n*2);b.set(this.a);this.a=b;}let i=this.n++;while(i){const p=(i-1)>>1;if(!this.less(v,this.a[p]))break;this.a[i]=this.a[p];i=p;}this.a[i]=v;}
  pop(){const v=this.a[0],last=this.a[--this.n];let i=0;while(2*i+1<this.n){let c=2*i+1;if(c+1<this.n&&this.less(this.a[c+1],this.a[c]))c++;if(!this.less(this.a[c],last))break;this.a[i]=this.a[c];i=c;}if(this.n)this.a[i]=last;return v;}
}
export function lakeOptions(value={}) {
  if(value===false)return null;
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('lakes must be false or an options object');
  const defaults={min_area_m2:10000,min_depth_m:1,wind_speed_m_s:4,wind_direction:[1,0],seed:1979};
  for(const k of Object.keys(value))if(!Object.hasOwn(defaults,k))throw Error('Unknown lake option: '+k);
  const o={...defaults,...value};
  for(const k of ['min_area_m2','min_depth_m'])if(!Number.isFinite(o[k])||o[k]<=0)throw Error('Invalid lake '+k);
  if(!Number.isFinite(o.wind_speed_m_s)||o.wind_speed_m_s<0||o.wind_speed_m_s>60)throw Error('Invalid lake wind');
  if(!Array.isArray(o.wind_direction)||o.wind_direction.length!==2||!o.wind_direction.every(Number.isFinite)||!Math.hypot(...o.wind_direction))throw Error('Invalid lake wind direction');
  if(!Number.isInteger(o.seed)||o.seed<0||o.seed>0xffffffff)throw Error('Invalid lake seed');
  const norm=Math.hypot(...o.wind_direction);o.wind_direction=o.wind_direction.map(v=>v/norm);return o;
}
export function inferLakeBasins(native,options={}, {seed_indices}={}) {
  const config=lakeOptions(options);if(!config)return {basins:[],config,method:'disabled'};
  const {data,shape,spacing}=native,[nz,nx]=shape,[dx,dz]=spacing,n=nx*nz;
  const seeds=seed_indices===undefined?null:new Set(seed_indices.map(([z,x])=>{if(!Number.isInteger(z)||!Number.isInteger(x)||z<0||x<0||z>=nz||x>=nx)throw Error('Invalid inland lake seed');return z*nx+x;}));
  if(!(data instanceof Float32Array)||data.length!==n||nx<2||nz<2||![dx,dz].every(v=>Number.isFinite(v)&&v>0)||!data.every(Number.isFinite))throw Error('Lakes require a finite native metric DEM');
  const levels=data.slice(),seen=new Uint8Array(n),fifo=new Uint32Array(n),heap=new MinHeap(levels);
  const edge=i=>{if(!seen[i]){seen[i]=1;heap.push(i);}};
  for(let x=0;x<nx;x++){edge(x);edge((nz-1)*nx+x);}for(let z=1;z<nz-1;z++){edge(z*nx);edge(z*nx+nx-1);}
                                                                           
                                                                         
  const offsets=[[-1,0],[1,0],[0,-1],[0,1],[1,-1],[-1,1]];
  let head=0,tail=0;
  while(heap.n||head<tail){
    const i=head<tail?fifo[head++]:heap.pop(),z=Math.floor(i/nx),x=i-z*nx,h=levels[i];
    for(const [ox,oz] of offsets){const xx=x+ox,zz=z+oz;if(xx<0||zz<0||xx>=nx||zz>=nz)continue;const j=zz*nx+xx;if(seen[j])continue;seen[j]=1;
      if(data[j]<=h){levels[j]=h;fifo[tail++]=j;}else heap.push(j);
    }
    if(head===tail){head=tail=0;}
  }
  seen.fill(0);const basins=[];
  for(let start=0;start<n;start++){
    if(seen[start]||levels[start]-data[start]<=1e-5)continue;
    head=0;tail=1;fifo[0]=start;seen[start]=1;let depth=0,sum=0,x0=nx,z0=nz,x1=0,z1=0,selected=false;
    const level=levels[start];
    while(head<tail){const i=fifo[head++],z=Math.floor(i/nx),x=i-z*nx,d=level-data[i];if(seeds?.has(i))selected=true;depth=Math.max(depth,d);sum+=d;x0=Math.min(x0,x);x1=Math.max(x1,x);z0=Math.min(z0,z);z1=Math.max(z1,z);
      for(const [ox,oz] of offsets){const xx=x+ox,zz=z+oz;if(xx<0||zz<0||xx>=nx||zz>=nz)continue;const j=zz*nx+xx;
        if(!seen[j]&&levels[j]===level&&levels[j]-data[j]>1e-5){seen[j]=1;fifo[tail++]=j;}}
    }
    if(seeds?!selected:tail*dx*dz<config.min_area_m2||depth<config.min_depth_m)continue;
    basins.push({id:'lake-'+start,level_m:level,area_m2:tail*dx*dz,max_depth_m:depth,mean_depth_m:sum/tail,bounds_rc:[z0,x0,z1,x1],cells:fifo.slice(0,tail)});
  }
  basins.sort((a,b)=>b.area_m2-a.area_m2);
  return {basins,config,method:'native-triangle Priority-Flood; saturated to lowest spill; immutable DEM'};
}

                                                                           
                                                                            
export function lakeSurfaceGeometry(native,basin) {
  const {data,shape,spacing}=native,nx=shape[1],[dx,dz]=spacing,level=basin.level_m;
  const cells=new Set(basin.cells),positions=[],depths=[],indices=[],vertices=new Map();
  const vertex=(key,x,z,depth)=>{if(vertices.has(key))return vertices.get(key);const i=depths.length;vertices.set(key,i);positions.push(x*dx,level,z*dz);depths.push(depth);return i;};
  const point=i=>({i,x:i%nx,z:Math.floor(i/nx),h:data[i],mask:cells.has(i)?1:0});
  const add=p=>vertex(p.key??'v'+p.i,p.x,p.z,Math.max(0,level-p.h));
  const clip=ids=>{
    if(!ids.some(i=>cells.has(i)))return;
    let out=ids.map(point);
    for(const [field,limit,above] of [...(basin.mask_constrained?[['mask',.5,true]]:[]),['h',level,false]]){
      const poly=out;out=[];
      for(let k=0;k<poly.length;k++){const a=poly[k],b=poly[(k+1)%poly.length],ai=above?a[field]>=limit:a[field]<limit,bi=above?b[field]>=limit:b[field]<limit;
        if(ai)out.push(a);if(ai!==bi){const t=(limit-a[field])/(b[field]-a[field]),p={x:a.x+t*(b.x-a.x),z:a.z+t*(b.z-a.z),h:a.h+t*(b.h-a.h),mask:a.mask+t*(b.mask-a.mask)};p[field]=limit;p.key='p'+p.x.toPrecision(14)+':'+p.z.toPrecision(14);out.push(p);}}
    }
    for(let k=1;k+1<out.length;k++)if(Math.abs((out[k].x-out[0].x)*(out[k+1].z-out[0].z)-(out[k].z-out[0].z)*(out[k+1].x-out[0].x))>1e-16)indices.push(add(out[0]),add(out[k]),add(out[k+1]));
  };
  const [z0,x0,z1,x1]=basin.bounds_rc;
  for(let z=Math.max(0,z0-1);z<=Math.min(shape[0]-2,z1);z++)for(let x=Math.max(0,x0-1);x<=Math.min(nx-2,x1);x++){
    const a=z*nx+x;clip([a,a+nx,a+1]);clip([a+1,a+nx,a+nx+1]);
  }
                                                                        
  const direction=basin.wind_direction??[1,0],step=Math.min(dx,dz)*.5;let fetch=0;
  const stride=Math.max(1,Math.floor(basin.cells.length/128));
  for(let k=0;k<basin.cells.length;k+=stride){const i=basin.cells[k],sx=(i%nx)*dx,sz=Math.floor(i/nx)*dz;let distance=0;
    for(let t=step;t<Math.hypot((x1-x0+2)*dx,(z1-z0+2)*dz);t+=step){const x=Math.round((sx-t*direction[0])/dx),z=Math.round((sz-t*direction[1])/dz);if(x<0||z<0||x>=nx||z>=shape[0]||!cells.has(z*nx+x))break;distance=t;}
    fetch=Math.max(fetch,distance);
  }
  return {positions:new Float32Array(positions),depths:new Float32Array(depths),indices:new Uint32Array(indices),fetch_m:Math.max(step,fetch)};
}

export function lakeWaterQuery(native,basins){
  const {data,shape,spacing,origin}=native,[nz,nx]=shape;
  const rows=basins.map(b=>({...b,members:new Set(b.cells)}));
  return (x,z)=>{
    const gx=(x-origin[0])/spacing[0],gz=(z-origin[1])/spacing[1],ix=Math.floor(gx),iz=Math.floor(gz);
    if(ix<0||iz<0||ix>=nx-1||iz>=nz-1)return null;
    const u=gx-ix,v=gz-iz,a=iz*nx+ix,ids=u+v<=1?[a,a+1,a+nx]:[a+nx+1,a+nx,a+1];
    const bed=u+v<=1?data[a]*(1-u-v)+data[a+1]*u+data[a+nx]*v:data[a+nx+1]*(u+v-1)+data[a+1]*(1-v)+data[a+nx]*(1-u);
    for(const b of rows)if(bed<b.level_m&&ids.some(i=>b.members.has(i))){
      const weights=u+v<=1?[1-u-v,u,v]:[u+v-1,1-u,1-v];
      if(!b.mask_constrained||ids.reduce((s,i,k)=>s+(b.members.has(i)?weights[k]:0),0)>=.5)return b.level_m;
    }
    return null;
  };
}

export function excludeLakeGrassCells(field,native,basins,waterAt){
  if(!field||!basins.length)return field;
  const data=field.data.slice(),nx=native.shape[1],width=field.shape[1],candidates=new Set();let excluded=0;
  for(const b of basins)for(const i of b.cells){const x=i%nx,z=Math.floor(i/nx);for(const [ox,oz]of [[0,0],[-1,0],[0,-1],[-1,-1]])if(x+ox>=0&&z+oz>=0&&x+ox<width&&z+oz<field.shape[0])candidates.add((z+oz)*width+x+ox);}
  for(const i of candidates)if(data[i]){const x=field.origin[0]+(i%width+.5)*field.spacing[0],z=field.origin[1]+(Math.floor(i/width)+.5)*field.spacing[1];if(waterAt(x,z)!==null){data[i]=0;excluded++;}}
  return {...field,data,lake_exclusion:{method:'derived wet CELL-centre mask; original seed and poses unchanged',excluded_cells:excluded,source_field_sha256:field.manifest.field.sha256}};
}

                                                                              
                                                                              
export function basinsFromLakeMask(native,mask,options={}){
  const config=lakeOptions(options),{data,shape,spacing}=native,[nz,nx]=shape,n=nx*nz;
  if(!(mask?.data instanceof Uint8Array)||mask.data.length!==n||!mask.data.every(v=>v===0||v===1||v===255))throw Error('Inland lake mask requires native-grid binary uint8 nodes');
  if(!config){if(mask.data.some(Boolean))throw Error('Declared inland lake mask cannot be silently disabled');return {basins:[],config,method:'empty inland mask'};}
  if(!(data instanceof Float32Array)||data.length!==n||!data.every(Number.isFinite))throw Error('Inland mask requires finite native DEM');
  if(mask.water_level_m!==undefined&&!Number.isFinite(mask.water_level_m))throw Error('Invalid inland mask water level');
  const records=new Map();
  for(const row of mask.regions??[]){const seed=row.seed_index;if(!Array.isArray(seed)||seed.length!==2||!seed.every(Number.isInteger)||seed[0]<0||seed[1]<0||seed[0]>=nz||seed[1]>=nx||!Number.isFinite(row.water_level_m))throw Error('Invalid inland mask region');
    const i=seed[0]*nx+seed[1];if(!mask.data[i]||records.has(i))throw Error('Inland region seed missing from mask or duplicated');records.set(i,row.water_level_m);}
  const visited=new Uint8Array(n),queue=new Uint32Array(n),basins=[],offsets=[[-1,0],[1,0],[0,-1],[0,1],[1,-1],[-1,1]];
  let marked=0;
  for(let start=0;start<n;start++){
    if(!mask.data[start]||visited[start])continue;
    let head=0,tail=1,x0=nx,x1=0,z0=nz,z1=0,min=Infinity,max=-Infinity,sum=0,spill=Infinity,open=false;const levels=new Set();queue[0]=start;visited[start]=1;
    while(head<tail){const i=queue[head++],z=Math.floor(i/nx),x=i%nx,h=data[i];marked++;min=Math.min(min,h);max=Math.max(max,h);sum+=h;x0=Math.min(x0,x);x1=Math.max(x1,x);z0=Math.min(z0,z);z1=Math.max(z1,z);if(records.has(i))levels.add(records.get(i));
      for(const [ox,oz]of offsets){const xx=x+ox,zz=z+oz;if(xx<0||zz<0||xx>=nx||zz>=nz){open=true;continue;}const j=zz*nx+xx;
        if(!mask.data[j]){spill=Math.min(spill,data[j]);continue;}if(!visited[j]){visited[j]=1;queue[tail++]=j;}}
    }
    if(levels.size>1)throw Error('One connected inland mask cannot have conflicting water levels');
    const specified=levels.size?[...levels][0]:mask.water_level_m,level=specified??spill;
    if(specified===undefined&&open)throw Error('Inland mask reaches DEM edge; explicit water level required');
    if(!Number.isFinite(level)||level<max-1e-6||level<=min)throw Error('Inland mask has no consistent horizontal water plane; provide a valid region water level');
    basins.push({id:'lake-mask-'+start,level_m:level,water_level_source:specified===undefined?'lowest unmasked native neighbour':'declared mask region',area_m2:tail*spacing[0]*spacing[1],max_depth_m:level-min,mean_depth_m:level-sum/tail,bounds_rc:[z0,x0,z1,x1],cells:queue.slice(0,tail),mask_constrained:true});
  }
  return {basins,config,method:'authoritative inland mask connected components; all components constructed',mask:{source:mask.source??'explicit',sha256:mask.sha256??null,marked_nodes:marked,components:basins.length}};
}

                                                                                
                                                                              
                                                                             
export function lakeMaskFromSeeds(native,records){
  const seeds=records.map(r=>r.seed_index),r=inferLakeBasins(native,{}, {seed_indices:seeds}),data=new Uint8Array(native.data.length),regions=[];
  const found=new Set();
  for(const b of r.basins){for(const i of b.cells)data[i]=1;
    for(const seed of seeds){const i=seed[0]*native.shape[1]+seed[1];if(b.cells.includes(i)){found.add(i);regions.push({seed_index:seed,water_level_m:b.level_m});}}}
  if(found.size!==new Set(seeds.map(([z,x])=>z*native.shape[1]+x)).size)throw Error('Declared inland lake seed no longer belongs to a closed basin in current DEM');
  return {data,regions,source:'current native DEM mask from declared inland lake seeds'};
}
