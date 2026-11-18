import {ShaderModule,UniformBlock} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {validateVariationRecipe,variationFractal} from './surface_variation_inputs.js';

const f=v=>Number(v).toPrecision(10);
export function surfaceVariationWGSL(m){
 const r=validateVariationRecipe(m.recipe);
 const spectrum=variationFractal(r);
 const bands=r.layers.map((b,i)=>`{
  let probability=clamp(control[${i}],0.,1.);let permit=hard[${i}];
  let bp=vec2f(warped.x+.37*P.y,warped.y+.61*P.y)/${f(b.wavelength_m)};
  let bx=vec2f(warpedDX.x+.37*dx.y,warpedDX.y+.61*dx.y)/${f(b.wavelength_m)};
  let by=vec2f(warpedDY.x+.37*dy.y,warpedDY.y+.61*dy.y)/${f(b.wavelength_m)};
  if(permit>.5&&probability>0.&&probability<1.&&max(length(bx),length(by))<1.){
   let domain=svDomain(bp,bx,by,${r.seed+i*107+17}u,${f(spectrum.layer_warp)});
   let noise=svFbm(domain.p,domain.dx,domain.dy,${r.seed+i*107+407}u,${b.octaves},${f(spectrum.gain)});
   let n=clamp(.5+(noise.x-.5)*1.6,0.,1.);
   // Symmetric positive/negative patches approximately preserve local colour.
   let threshold=1.-probability;
   let dn=1.6*max(abs(dot(noise.yz,domain.dx)),abs(dot(noise.yz,domain.dy)));
   let edge=sqrt(${f(b.edge*b.edge)}+dn*dn*.5);
   let lobes=smoothstep(threshold-edge,threshold+edge,n)-smoothstep(threshold-edge,threshold+edge,1.-n);
   // Keep fractal modulation INSIDE colonies; binary flat interiors look painted.
   let pattern=.5*lobes*(.25+1.5*abs(n-.5))+.2*(n-.5)*4.*probability*(1.-probability);
   delta+=vec3f(${b.color_delta_linear.map(f).join(',')})*pattern;
   rough+=${f(b.roughness_delta)}*pattern;
  }
 }`).join('\n');
 return           `
fn svHash(p:vec3i,seed:u32)->f32{
 var h=(bitcast<u32>(p.x)*1597334677u)^(bitcast<u32>(p.y)*3812015801u)^(bitcast<u32>(p.z)*2798796415u)^seed;
 h=(h^(h>>16u))*2246822519u;h=(h^(h>>13u))*3266489917u;h=h^(h>>16u);
 return f32(h>>8u)/16777215.;
}
fn svNoiseGradient(p:vec2f,seed:u32)->vec3f{
 let cell=vec2i(floor(p));let t=fract(p);let s=t*t*t*(t*(t*6.-15.)+10.);let ds=30.*t*t*(t-1.)*(t-1.);
 var result=vec3f(0);
 for(var y=0;y<2;y++){for(var x=0;x<2;x++){
  let w=vec2f(select(1.-s.x,s.x,x==1),select(1.-s.y,s.y,y==1));
  let dw=ds*vec2f(select(-1.,1.,x==1),select(-1.,1.,y==1));
  result+=svHash(vec3i(cell+vec2i(x,y),0),seed)*vec3f(w.x*w.y,dw.x*w.y,w.x*dw.y);
 }}return result;
}
// Each octave is filtered independently, retaining all resolvable lower bands.
// Normalisation includes unresolved bands; they converge to their mean .5.
fn svFbm(p:vec2f,dx:vec2f,dy:vec2f,seed:u32,octaves:i32,gain:f32)->vec3f{
 let R=mat2x2f(.8,.6,-.6,.8)*${f(spectrum.lacunarity)};
 let norm=(1.-pow(gain,f32(octaves)))/(1.-gain);
 var q=p;var J=mat2x2f(1.,0.,0.,1.);var amp=1.;var value=0.;var grad=vec2f(0);
 for(var i=0;i<octaves;i++){
  let fp=max(length(J*dx),length(J*dy));let visible=1.-smoothstep(.16,.5,fp);
  if(visible<=0.){break;}
  let a=svNoiseGradient(q,seed+u32(i)*37u);
  value+=amp*visible*(a.x-.5);grad+=amp*visible*(transpose(J)*a.yz);
  q=R*q+vec2f(5.7,13.1);J=R*J;amp*=gain;
 }
 return vec3f(.5+value/norm,grad/norm);
}
struct SVDomain{p:vec2f,dx:vec2f,dy:vec2f};
fn svDomain(p:vec2f,dx:vec2f,dy:vec2f,seed:u32,strength:f32)->SVDomain{
 var d=SVDomain(p,dx,dy);let a=2.*strength/${f(spectrum.warp_passes)};
 for(var iteration=0;iteration<${spectrum.warp_passes};iteration++){
  let sx=seed+u32(iteration)*977u;
  let x=svFbm(d.p,d.dx,d.dy,sx,${spectrum.warp_octaves},${f(spectrum.warp_gain)});
  let y=svFbm(d.p+vec2f(7.3,19.8),d.dx,d.dy,sx+911u,${spectrum.warp_octaves},${f(spectrum.warp_gain)});
  let oldX=d.dx;let oldY=d.dy;
  d.p+=a*(vec2f(x.x,y.x)-.5);
  d.dx+=a*vec2f(dot(x.yz,oldX),dot(y.yz,oldX));
  d.dy+=a*vec2f(dot(x.yz,oldY),dot(y.yz,oldY));
 }return d;
}
fn svCell(index:vec2i,layer:i32)->vec4f{
 let dims=vec2i(textureDimensions(svCells));return textureLoad(svCells,clamp(index,vec2i(0),dims-vec2i(1)),layer,0);
}
fn svSmooth(grid:vec2f,layer:i32)->vec4f{
 let q=grid-.5;let c=vec2i(floor(q));let t=fract(q);let s=t*t*t*(t*(t*6.-15.)+10.);
 return mix(mix(svCell(c,layer),svCell(c+vec2i(1,0),layer),s.x),mix(svCell(c+vec2i(0,1),layer),svCell(c+vec2i(1,1),layer),s.x),s.y);
}
struct SVState{color:vec3f,roughness:f32};
fn svApply(P:vec3f,dx:vec3f,dy:vec3f,current:vec3f,currentR:f32)->SVState{
 let spacing=vec2f(${m.spacing_xz_m.map(f).join(',')});let extent=vec2f(${m.extent_xz_m.map(f).join(',')});
 let local=P.xz-vec2f(${m.origin_xz_m.map(f).join(',')});let grid=local/spacing;
 let rho=max(length(dx.xz/spacing),length(dy.xz/spacing));
 let fade=1.-smoothstep(${r.transition_footprint_cells.map(f).join(',')},rho);
 let lod=max(0.,log2(max(rho,1e-8)));let uv=local/extent;
 let coarse=textureSampleLevel(svCells,smpLinearClamp,uv,0,lod);
 let hardCell=svCell(vec2i(floor(grid)),0);
 if(svParams.strength<=0.){return SVState(current,currentR);}
 if(fade<=0.){return SVState(mix(current,coarse.rgb,svParams.strength),currentR);}
 if(hardCell.a<.5){return SVState(mix(current,coarse.rgb,(1.-fade)*svParams.strength),currentR);}
 let anchor=local/(spacing*${f(r.warp_wavelength_cells)});
 let ax=dx.xz/(spacing*${f(r.warp_wavelength_cells)});let ay=dy.xz/(spacing*${f(r.warp_wavelength_cells)});
 let domain=svDomain(anchor,ax,ay,${r.seed}u,${f(r.warp_amplitude_cells/r.warp_wavelength_cells)});
 let warped=domain.p*spacing*${f(r.warp_wavelength_cells)};
 let warpedDX=domain.dx*spacing*${f(r.warp_wavelength_cells)};
 let warpedDY=domain.dy*spacing*${f(r.warp_wavelength_cells)};
 let original=svSmooth(grid,0);let sampled=svSmooth(warped/spacing,0);
 let control=svSmooth(warped/spacing,1);let hard=svCell(vec2i(floor(grid)),2);
 var delta=sampled.rgb-original.rgb;var rough=0.;
 ${bands}
 // Smooth odd headroom limiter: dark scans must not turn into black cut-outs
 // or bright complementary paint merely because their mean reflectance is low.
 let cap=.65*max(vec3f(0),min(current,vec3f(1)-current));
 delta=cap*delta*inverseSqrt(delta*delta+cap*cap+vec3f(1e-12));
 let near=clamp(current+delta,vec3f(0),vec3f(1));
 let resolved=mix(coarse.rgb,near,fade);
 return SVState(mix(current,resolved,svParams.strength),clamp(currentR+rough*fade*svParams.strength,.04,1.));
}
`;
}

export const surfaceVariationSurfaceWGSL=`
let svP=apsTerrainNativePosition(in.P);
let sv=svApply(svP,dpdx(svP),dpdy(svP),apsTerrainCurrent.baseColor,apsTerrainCurrent.roughness);
apsTerrainCurrent.baseColor=sv.color;apsTerrainCurrent.roughness=sv.roughness;
if(terrainParams.mode==17){apsTerrainCurrent.emission=sv.color;}
if(terrainParams.mode==15){apsTerrainCurrent.emission=vec3f(sv.roughness);}
`;

export function createSurfaceVariation(input,texture){
 if(!input)return null;
 const m=input.manifest,first=m.texture.levels[0],layers=Number.isInteger(m.texture.layers)&&m.texture.layers>0?m.texture.layers:3;
 const map=texture({label:'native cell colour / variation priors',width:first.width,height:first.height,depth:layers,dimension:'2d-array',format:'rgba16float',mips:input.levels.length});
 map.getGPU();input.levels.forEach((v,mip)=>map.upload(v,{mip,layers}));map.apsPrefilteredLandscape=true;
 const params=new UniformBlock('APSSurfaceVariation',{strength:['f32',1]});
 const module=new ShaderModule({name:'aps-subcell-colour-variation',bindings:{svCells:{texture:map}},uniforms:params,uniformName:'svParams',code:surfaceVariationWGSL(m)});
 return {module,surface:surfaceVariationSurfaceWGSL,
  setStrength(v){if(!Number.isFinite(v)||v<0||v>1)throw Error('Variation strength must be [0,1]');params.set('strength',v);},
  metadata:()=>({schema:m.schema,recipe:m.recipe,fractal:variationFractal(m.recipe),filter:'per-octave footprint / nested warp Jacobian / edge coverage',strength:params.fields.strength.value,resident_bytes:input.residentBytes,subcell_baked_pixels:0,approximation:m.approximation}),
  dispose(){params.buffer?.destroy();}};
}
