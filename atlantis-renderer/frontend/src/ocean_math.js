                                                                                           
const PRESETS = {
  deep: {height:1.1,wind:7,absorption:[.12,.035,.016],scatter:[.018,.034,.05],roughness:.075,foam:.18},
  glass: {height:.09,wind:1.8,absorption:[.075,.018,.008],scatter:[.004,.012,.017],roughness:.035,foam:.035},
  tropical: {height:.65,wind:5,absorption:[.09,.025,.011],scatter:[.012,.044,.04],roughness:.055,foam:.24},
  storm: {height:2.1,wind:13,absorption:[.17,.07,.045],scatter:[.036,.05,.052],roughness:.11,foam:.65}
};
const QUALITY = {low:{fft:64,coast:128,pixels:22,ibl:16,particles:1200},medium:{fft:128,coast:256,pixels:14,ibl:32,particles:4000},high:{fft:256,coast:512,pixels:9,ibl:64,particles:10000}};
                                                                          
const TILE_LENGTHS = [512,128,32,8];
function finite(v,lo,hi,name){if(!Number.isFinite(v)||v<lo||v>hi)throw Error(`Invalid ocean ${name}`);return v;}
                                                                             
                                                      
export const OCEAN_WHITEWATER = Object.freeze({determinant:.58,referenceDeterminant:.58,gain:3,accumulationRate:2.5,decayRate:.35,driftFactor:.04});
export const OCEAN_FOAM_RANGE = Object.freeze({offshore:.5,shore:.99});
const clamp01=v=>Math.max(0,Math.min(1,v));
                                                                              
                                                                        
export function whitecapBandPolicy(config,band,choppiness=config.choppiness){
  const severity=clamp01((config.windSpeed-7)/23);
  const unitRms=band.support?.compressionTraceRms??0,rms=unitRms*choppiness,sigma=band.significantHeight/4;
  const wavelength=unitRms>0?2*Math.PI*sigma/unitRms:0;
  const t=clamp01((wavelength-.5)/1.5);
  return {determinant:Math.min(.58-.4*severity,1-(1.85+.85*severity)*rms),gain:1/Math.max(.25,.5*rms),
    compression_rms:rms,effective_wavelength_m:wavelength,gravity_breaking_support:t*t*(3-2*t),
    crest_sigma_m:sigma,crest_sigma_start:.55+.25*severity,crest_sigma_full:1.4+.3*severity};
}
                                                                             
                                                                            
export function compressionWhitecapSource(dxx,dzz,dxz,strength=1){
  for(const [name,value] of Object.entries({dxx,dzz,dxz}))finite(value,-Number.MAX_VALUE,Number.MAX_VALUE,name);
  finite(strength,0,1,'foam strength');
  const determinant=(1+dxx)*(1+dzz)-dxz*dxz;
  finite(determinant,-Number.MAX_VALUE,Number.MAX_VALUE,'foam determinant');
  return strength*clamp01((OCEAN_WHITEWATER.determinant-determinant)*OCEAN_WHITEWATER.gain);
}
export function advanceWhitecapHistory(history,source,dt,life){
  finite(history,0,1,'foam history');finite(source,0,1,'foam source');finite(dt,0,Number.MAX_VALUE,'foam dt');
  finite(life,Number.MIN_VALUE,Number.MAX_VALUE,'foam lifetime');
  if(dt===0)return history;
                                                                     
                                                                                
  const generation=OCEAN_WHITEWATER.accumulationRate*source,rate=generation+1/life,equilibrium=generation/rate;
  return clamp01(history+(equilibrium-history)*-Math.expm1(-rate*dt));
}
                                                                         
export const OCEAN_WHITEWATER_GLSL = `
float oceanPositiveCompressionMask(float jac,float upper){
  return jac>0.&&jac<upper?1.-smoothstep(0.,upper,jac):0.;
}
float oceanFoamNoiseCorner(vec2 p,float period){
  if(period>0.)p=mod(p,period);
  return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);
}
float oceanFoamSourceNoise(vec2 p,float period){
  // Smooth amplitude noise only: no contour thresholds or domain warping.
  vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return .55+.45*mix(mix(oceanFoamNoiseCorner(i,period),oceanFoamNoiseCorner(i+vec2(1.,0.),period),f.x),
    mix(oceanFoamNoiseCorner(i+vec2(0.,1.),period),oceanFoamNoiseCorner(i+1.,period),f.x),f.y);
}
float oceanCompressionSource(float jac){return clamp((${OCEAN_WHITEWATER.determinant}-jac)*${OCEAN_WHITEWATER.gain.toFixed(1)},0.,1.);}
float oceanCompressionSource(float jac,float threshold,float gain){return clamp((threshold-jac)*gain,0.,1.);}
float oceanAdvanceFoam(float history,float source,float dt,float life,float add){
  float generation=add*source,rate=generation+1./life,equilibrium=generation/rate;
  float x=rate*dt;
  // Stable at very short timesteps, including exact dt=0 initialization.
  float integrated=x<.001?x*(1.-x*.5+x*x/6.):1.-exp(-x);
  return clamp(mix(history,equilibrium,integrated),0.,1.);
}`;
export function normalizeOceanConfig(input={}) {
                                                                              
                                                                              
                                                                      
  if(input===null||input===undefined)input={};
  const oceantype=input.oceantype??'deep',quality=input.quality??'medium';
  const p=Object.hasOwn(PRESETS,oceantype)?PRESETS[oceantype]:PRESETS.deep;
  const q=Object.hasOwn(QUALITY,quality)?QUALITY[quality]:QUALITY.medium;
  const sealevel=input.sealevel??0,stormylevel=input.stormylevel??0;
  const seed=input.seed??27;
  const direction=input.winddirection??[.86,.51];
  const magnitude=Array.isArray(direction)?Math.hypot(...direction):0;
  const winddirection=magnitude>0?direction.map(v=>v/magnitude):direction;
  const flags=Object.fromEntries(['enabled','wetness','caustics','spray','reflections'].map(k=>[k,input[k]??true]));
  const significantHeight=p.height+stormylevel*(oceantype==='glass'?3.5:6),windSpeed=p.wind+stormylevel*17;
  const choppiness=input.choppiness===undefined?1:input.choppiness;
                                                                               
                                                                                     
  const fftSize=512,lengths=TILE_LENGTHS,minimums=[lengths[1]/6,lengths[2]/6,lengths[3]/6,lengths[3]/fftSize*2.01],maximums=[lengths[0]+1,...minimums.slice(0,3)],weights=[.08,.42,.48,.02];
  const variance=weights.map(v=>significantHeight**2*v);
                                                                           
                                                                             
                                                                               
  for(let i=3;i>0;i--){const cap=i===3?.12+stormylevel*.06:.18*Math.sqrt(minimums[i]*maximums[i]);
    const excess=Math.max(0,variance[i]-cap*cap);variance[i]=Math.min(variance[i],cap*cap);
    const total=weights.slice(0,i).reduce((a,b)=>a+b,0);
    for(let j=0;j<i;j++)variance[j]+=excess*weights[j]/total;}
  const bands=Object.freeze(lengths.map((length,i)=>{
    const height=Math.sqrt(variance[i]);
    return Object.freeze({length,minWavelength:minimums[i],maxWavelength:maximums[i],significantHeight:height,
      size:fftSize,seed:seed+i*103,windSpeed,windDirection:Object.freeze(Array.isArray(winddirection)?[...winddirection]:winddirection),depth:1000,chop:choppiness,
      varianceFraction:height**2/significantHeight**2,expectedVariance:(height/4)**2});
  }));
  return Object.freeze({sealevel,stormylevel,oceantype,quality,seed,winddirection,...flags,maxDistance:input.maxDistance??20000,
    significantHeight,windSpeed,choppiness,chop:choppiness,foamStrength:Math.min(1,p.foam+stormylevel*.30),absorption:[...p.absorption],scatter:[...p.scatter],ior:1.333,roughness:p.roughness+stormylevel*.025,
    fftSize,coastSize:q.coast,screenPixels:q.pixels,iblSamples:q.ibl,particleBudget:q.particles,foamLifetime:6+stormylevel*4,gravity:9.81,
    bands});
}
                                                                                
                                                                           
export function buildOceanScreenGrid(columns=256,rows=128){
  if(!Number.isInteger(columns)||!Number.isInteger(rows)||columns<1||rows<1||columns>512||rows>512)throw Error('Invalid screen grid dimensions');
  const vertexCount=(columns+1)*(rows+1),positions=new Float32Array(vertexCount*3),normals=new Float32Array(vertexCount*3),uvs=new Float32Array(vertexCount*2),screenSpans=new Float32Array(vertexCount*2),footprints=new Float32Array(vertexCount),indices=new Uint32Array(columns*rows*6);
  for(let y=0;y<=rows;y++)for(let x=0;x<=columns;x++){const i=y*(columns+1)+x;positions.set([2*x/columns-1,2*y/rows-1,0],i*3);normals[i*3+1]=1;uvs.set([x/columns,y/rows],i*2);screenSpans.set([2/columns,2/rows],i*2);footprints[i]=.01;}
  let k=0;for(let y=0;y<rows;y++)for(let x=0;x<columns;x++){const a=y*(columns+1)+x,b=a+1,c=a+columns+1,d=c+1;indices.set([a,b,c,b,d,c],k);k+=6;}
  return {positions,normals,uvs,screenSpans,footprints,indices,vertexCount,triangleCount:columns*rows*2,leafCount:columns*rows,columns,rows};
}
export function fresnelWater(cosine,eta=1.333){
  const c=Math.max(0,Math.min(1,cosine)),sin2=(1-c*c)/(eta*eta);if(sin2>=1)return 1;
  const t=Math.sqrt(1-sin2),rs=(c-eta*t)/(c+eta*t),rp=(eta*c-t)/(eta*c+t);return .5*(rs*rs+rp*rp);
}
export function shallowCflStep(cellX,cellZ,maxDepth,maxVelocity=0,cfl=.42){
  return cfl/(Math.sqrt(9.81*Math.max(.02,maxDepth))*(1/cellX+1/cellZ)+maxVelocity/Math.min(cellX,cellZ));
}
export function sampleBed(data,shape,spacing,origin,x,z,outside=-1000){
  const fx=(x-origin[0])/spacing[0],fz=(z-origin[1])/spacing[1],[nz,nx]=shape;
  if(fx<0||fz<0||fx>nx-1||fz>nz-1)return outside;
  const i=Math.min(nx-2,Math.floor(fx)),j=Math.min(nz-2,Math.floor(fz)),u=fx-i,v=fz-j;
  return (data[j*nx+i]*(1-u)+data[j*nx+i+1]*u)*(1-v)+(data[(j+1)*nx+i]*(1-u)+data[(j+1)*nx+i+1]*u)*v;
}
                                                                         
export function sampleBedTriangles(data,shape,spacing,origin,x,z,outside=-1000){
  const fx=(x-origin[0])/spacing[0],fz=(z-origin[1])/spacing[1],[nz,nx]=shape;
  if(fx<0||fz<0||fx>nx-1||fz>nz-1)return outside;
  const i=Math.min(nx-2,Math.floor(fx)),j=Math.min(nz-2,Math.floor(fz)),u=fx-i,v=fz-j;
  const h00=data[j*nx+i],h10=data[j*nx+i+1],h01=data[(j+1)*nx+i],h11=data[(j+1)*nx+i+1];
  return u+v<=1?h00+(h10-h00)*u+(h01-h00)*v:h11+(h01-h11)*(1-u)+(h10-h11)*(1-v);
}
                                                                               
function mul4(m,p){return [0,1,2,3].map(i=>m[i]*p[0]+m[i+4]*p[1]+m[i+8]*p[2]+m[i+12]*p[3]);}
                                                                            
                                                                   
export function oceanGridNdc(x,y,inverseProjection,inverseView,sealevel,scale=1){
  const rayY=q=>inverseView[1]*q[0]+inverseView[5]*q[1]+inverseView[9]*q[2];
  const a=rayY(mul4(inverseProjection,[x*scale,0,1,1]));
  const b=rayY(mul4(inverseProjection,[0,scale,0,0]));
  if(Math.abs(b)<1e-7)return [x,y];
  const horizon=-a/b,clamp=v=>Math.max(-1,Math.min(1,v));
  const below=(sealevel-inverseView[13])*b>0;
  const lo=below?clamp(horizon-.04):-1,hi=below?1:clamp(horizon+.04);
  return [x,lo+(hi-lo)*(y*.5+.5)];
}
export function seaRayPoint(x,y,inverseProjection,inverseView,sealevel,maxDistance=20000){
  const q=mul4(inverseProjection,[x,y,1,1]);const d=mul4(inverseView,[q[0]/q[3],q[1]/q[3],q[2]/q[3],0]);
  const eye=[inverseView[12],inverseView[13],inverseView[14]],length=Math.hypot(...d.slice(0,3));
  const dir=d.slice(0,3).map(v=>v/length),distance=(sealevel-eye[1])/dir[1];
  const t=Number.isFinite(distance)&&distance>0?Math.min(distance,maxDistance):maxDistance;
  return [eye[0]+dir[0]*t,sealevel,eye[2]+dir[2]*t];
}
export function oceanProjectionScale(significantHeight,cameraHeight){return 1.12+Math.min(.65,significantHeight/Math.max(.5,Math.abs(cameraHeight))*.6);}
                                                                                  
                                                                                     
export function buildProjectedGrid({width,height,inverseProjection,inverseView,sealevel,maxDistance,significantHeight,pixelStep=14,bed=null,maxLevel=8,baseLevel=maxLevel,overscan=1}){
  const size=2**maxLevel,leaves=[],corners=new Map(),rows=new Map(),cols=new Map();
  const project=(x,y)=>seaRayPoint(x*overscan,y*overscan,inverseProjection,inverseView,sealevel,maxDistance);
  function vertex(x,y){const key=x+','+y;if(!corners.has(key)){corners.set(key,corners.size);if(!rows.has(y))rows.set(y,new Set());if(!cols.has(x))cols.set(x,new Set());rows.get(y).add(x);cols.get(x).add(y);}return corners.get(key);}
  function visit(x,y,w){
    const p=project((x+w/2)/size*2-1,(y+w/2)/size*2-1);
    const eye=[inverseView[12],inverseView[13],inverseView[14]],dist=Math.max(1,Math.hypot(p[0]-eye[0],p[1]-eye[1],p[2]-eye[2]));
    const ground=bed?bed(p[0],p[2])-sealevel:-1000;
    const projectedHeight=significantHeight*height/Math.max(1,dist),near=bed&&Math.abs(ground)<5;
    const band=Math.max(.08,significantHeight*.22);
    let intersection=bed&&Math.abs(ground)<band;
    if(bed&&near&&!intersection){
      let low=ground,high=ground;
      for(const [cx,cy] of [[x,y],[x+w,y],[x,y+w],[x+w,y+w]]){
        const q=project(cx/size*2-1,cy/size*2-1),h=bed(q[0],q[2])-sealevel;low=Math.min(low,h);high=Math.max(high,h);
      }
      intersection=low<=band&&high>=-band;
    }
    const desired=intersection?2:Math.max(4,pixelStep*(near?.65:1)/Math.sqrt(1+projectedHeight*.08));
    const minimum=intersection?1:2**Math.max(0,maxLevel-baseLevel);
    if(w>minimum&&w/size*Math.max(width,height)*overscan>desired){const h=w/2;visit(x,y,h);visit(x+h,y,h);visit(x,y+h,h);visit(x+h,y+h,h);}
    else {leaves.push([x,y,w]);vertex(x,y);vertex(x+w,y);vertex(x+w,y+w);vertex(x,y+w);}
  }
  visit(0,0,size);
  const sortedRows=new Map([...rows].map(([k,v])=>[k,[...v].sort((a,b)=>a-b)])),sortedCols=new Map([...cols].map(([k,v])=>[k,[...v].sort((a,b)=>a-b)]));
  const positions=[...corners.keys()].flatMap(k=>{const[x,y]=k.split(',').map(Number);return[x/size*2-1,y/size*2-1,0];}),indices=[];
  for(const[x,y,w]of leaves){
    const edge=[...sortedRows.get(y).filter(a=>a>=x&&a<x+w).map(a=>corners.get(a+','+y)),
      ...sortedCols.get(x+w).filter(b=>b>=y&&b<y+w).map(b=>corners.get((x+w)+','+b)),
      ...sortedRows.get(y+w).filter(a=>a>x&&a<=x+w).reverse().map(a=>corners.get(a+','+(y+w))),
      ...sortedCols.get(x).filter(b=>b>y&&b<=y+w).reverse().map(b=>corners.get(x+','+b))];
    const center=positions.length/3;positions.push((x+w/2)/size*2-1,(y+w/2)/size*2-1,0);
    for(let i=0;i<edge.length;i++)indices.push(center,edge[i],edge[(i+1)%edge.length]);
  }
                                                                             
                                                                     
  const world=positions.filter((_,i)=>i%3===0).map((_,i)=>project(positions[i*3],positions[i*3+1]));
  const footprints=new Array(world.length).fill(.01),screenSpans=new Float32Array(world.length*2);
  for(let i=0;i<indices.length;i+=3){
    const triangle=indices.slice(i,i+3);
    const spacing=Math.max(...triangle.map((a,j)=>{const b=triangle[(j+1)%3];return Math.hypot(world[a][0]-world[b][0],world[a][2]-world[b][2]);}));
    for(const index of triangle){
      footprints[index]=Math.max(footprints[index],spacing);
      for(const other of triangle){
        screenSpans[index*2]=Math.max(screenSpans[index*2],Math.abs(positions[other*3]-positions[index*3]));
        screenSpans[index*2+1]=Math.max(screenSpans[index*2+1],Math.abs(positions[other*3+1]-positions[index*3+1]));
      }
    }
  }
  const normals=new Float32Array(world.length*3),uvs=new Float32Array(world.length*2);
  for(let i=0;i<world.length;i++){normals[i*3+1]=1;uvs[i*2]=positions[i*3]*.5+.5;uvs[i*2+1]=positions[i*3+1]*.5+.5;}
  return {positions:new Float32Array(positions),normals,uvs,screenSpans,footprints:new Float32Array(footprints),indices:new Uint32Array(indices),leafCount:leaves.length,vertexCount:positions.length/3,triangleCount:indices.length/3};
}
