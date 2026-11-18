import {Material} from '../../vendor/tidewater/src/engine/render/Material.js';
import {ShaderModule} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {lightingModule} from '../../vendor/tidewater/src/engine/render/wgsl/lighting.js';
import {translateTerrainGLSL} from './terrain_glsl.js';
import {terrainDisneyGLSL} from './terrain_disney.js';
import {principledLightingModule} from './principled_wgsl.js';
import {terrainBRDFWGSL} from './terrain_brdf.js';
import {receiverShadowModule} from './receiver_shadow.js';
import {landscapeSurfaceWGSL} from './landscape_pbr.js';
import {groundcoverSurfaceWGSL} from './groundcover.js';
import {terrainMossCoverWGSL} from './terrain_moss_cover.js';
import {rockMacroWGSL} from './rock_macro.js';
import {createRockSurfaceWGSL,rockSurfaceConfig} from './rock_surface_recipe.js';
import {vertexWGSL as surfaceVertexWGSL} from './terrain_surface.js';

const dryReceiver = new ShaderModule({name: 'aps-dry-terrain-receiver', code:
  `fn terrainReceiverWetness(xz:vec2f)->f32{return 0.0;}
fn terrainReceiverFoam(P:vec3f,footprint:f32)->vec2f{return vec2f(0);}
fn terrainReceiverSandColor(P:vec3f,footprint:f32,color:vec3f)->vec3f{return color;}
fn terrainReceiverShadeColor(P:vec3f,footprint:f32,color:vec3f)->vec3f{return color;}
fn terrainReceiverShallowDepthColor(P:vec3f)->vec3f{return vec3f(0.12);}
struct OceanReceiverMaterial{baseColor:vec3f,roughness:f32,clearcoat:f32,clearcoatGloss:f32};
fn oceanApplyReceiverMaterial(P:vec3f,footprint:f32,color:vec3f,rough:f32,coat:f32,gloss:f32)->OceanReceiverMaterial{return OceanReceiverMaterial(color,rough,coat,gloss);}`});

export const terrainVertexWGSL =           `
let skirt = v.position.y;
let q = vec2i(min(v.apsPatch.xy + v.position.xz * (v.apsPatch.z / 64.0), terrainParams.shape - 1.0));
v.normal = terrainGridNormal(q);
v.position = vec3f(f32(q.x) * terrainParams.spacing.x, terrainGridHeight(q) - skirt * v.apsPatch.w, f32(q.y) * terrainParams.spacing.y);
v.uv = vec2f(q) / (terrainParams.shape - 1.0);
o.terrainSkirt = skirt;
`;

                                                                              
                                                                           
                                                                           
export const terrainLightingWGSL =           `
fn apsTerrainTint(c: vec3f) -> vec3f {
  let lum = dot(c, vec3f(0.3, 0.6, 0.1)); return select(vec3f(1.0), c / max(lum, 1e-6), lum > 1e-6);
}
fn apsTerrainEnvironment(m: apsT_PrincipledMaterial, V: vec3f) -> vec3f {
  let nv = dot(m.normal, V); if (nv <= 1e-6) { return vec3f(0.0); }
  let metal = clamp(m.metallic, 0.0, 1.0); let rough = clamp(m.roughness, 0.0, 1.0);
  let base = clamp(m.baseColor, vec3f(0.0), vec3f(1.0)); let tint = apsTerrainTint(base);
  let f0 = clamp(mix(0.08 * clamp(m.specular, 0.0, 1.0) * mix(vec3f(1.0), tint, clamp(m.specularTint, 0.0, 1.0)), base, metal), vec3f(0.0), vec3f(1.0));
  let dfg = apsTerrainDFG(nv, rough);
  let specAlbedo = clamp(f0 * dfg.r + vec3f(dfg.g), vec3f(0.0), vec3f(1.0));
  var N = m.normal;
  // Same bent-reflection approximation as disney_ibl.glsl (the environment
  // convolution is isotropic; direct anisotropic Smith/GTR2 is exact).
  let axis = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(N.y) < 0.98);
  let X = normalize(cross(axis, N)); let Y = cross(N, X); let planeV = V - Y * dot(Y, V);
  if (dot(planeV, planeV) > 1e-8) { N = normalize(mix(N, normalize(planeV), clamp(m.anisotropy, 0.0, 1.0) * rough)); }
  var result = hookEnvSpecular(reflect(-V, N), rough) * specAlbedo;
  let sheen = clamp(clamp(m.sheen, 0.0, 1.0) * dfg.b * mix(vec3f(1.0), tint, clamp(m.sheenTint, 0.0, 1.0)), vec3f(0.0), vec3f(1.0));
  let diffuseColor = mix(base, clamp(m.subsurfaceColor, vec3f(0.0), vec3f(1.0)), clamp(m.subsurface, 0.0, 1.0) * clamp(m.subsurfaceColorWeight, 0.0, 1.0));
  let diffuseAlbedo = (1.0 - metal) * (vec3f(1.0) - specAlbedo) * (diffuseColor * (vec3f(1.0) - sheen) + sheen);
  result += hookEnvDiffuse(m.normal) * diffuseAlbedo;
  let coatRough = sqrt(mix(0.1, 0.001, clamp(m.clearcoatGloss, 0.0, 1.0)));
  let coatDFG = apsTerrainDFG(nv, coatRough);
  let coat = 0.25 * clamp(m.clearcoat, 0.0, 1.0) * clamp(0.04 * coatDFG.r + coatDFG.g, 0.0, 1.0);
  return (result * (1.0 - coat) + hookEnvSpecular(reflect(-V, m.normal), coatRough) * coat) * m.occlusion;
}
fn apsTerrainShade(input: apsT_PrincipledMaterial, s: Surface, P: vec3f, geomN: vec3f, V: vec3f, pixel: vec2f) -> vec3f {
  var m=input;m.normal=apsConsistentNormal(m.normal,geomN,V,frame.sunDir);
  lightDPdx = dpdx(P); lightDPdy = dpdy(P);
  var direct = vec3f(0.0);
  if (dot(m.normal, frame.sunDir) > 0.0) {
    let nativeP=apsTerrainNativePosition(P);
    let shadowN=apsTerrainWorldNormal(terrainRenderNormalAt(nativeP.xz));
    let receiverP=apsTerrainWorldPosition(terrainShadowReceiver(nativeP));
    let shadowP = hookShadowPosition(receiverP, shadowN, pixel);
    let visibility = apsReceiverSunShadow(P,sunShadowTerrain(shadowP,shadowN,apsTerrainWorldNormal(terrainRenderPlaneNormalAt(nativeP.xz)),pixel,max(.025,.1*min(terrainParams.spacing.x,terrainParams.spacing.y))));
    direct = apsT_principledDirect(m, V, frame.sunDir) * frame.sunColor * hookDirectModulation(P, m.normal) * visibility;
  }
  var local=vec3f(0);
  var localMask=apsMeshLocalLightMask(P);while(localMask!=0u){let i=firstTrailingBit(localMask);localMask=localMask & (localMask-1u);let light=apsMeshLocalLight(i,P,m.normal,pixel);if(all(light.radiance==vec3f(0))){continue;}var lm=input;lm.normal=apsConsistentNormal(lm.normal,geomN,V,light.direction);local+=apsT_principledDirect(lm,V,light.direction)*light.radiance;}
  let ambient = apsTerrainEnvironment(m, V) + hookBounce(P, m.normal) * m.baseColor * (1.0 - m.metallic) * m.occlusion;
  return direct + local + ambient * hookAmbientModulation(P, m.normal) + m.emission;
}
`;

export function compileTerrainMaterialLibrary(library) {
  if (!library.includes('PrincipledMaterial apsTerrainMaterial(MaterialContext terrainCtx)')) throw Error('Unsupported saved terrain material library');
                                                                                 
                                                                              
  const wetAnchor = 'living=clamp(living*(1.-.18*litter),0.,.94);';
  if (!library.includes('wet=mix(wet,coastal.g,coastal.r*influence);') || !library.includes(wetAnchor)) throw Error('Saved terrain wetness/classification contract missing');
                                                                            
                                                                            
                                                                         
  const context = 'struct MaterialContext { vec3 position; vec3 normal; vec3 worldPosition; };\n';
  const sandAnchor='float sand=smoothstep(.25,.72,ctx.b)*smoothstep(.004,.045,looseDepth);';
  if(!library.includes(sandAnchor))throw Error('Saved coastal sediment classification contract missing');
                                                                             
                                                                               
  library=library.replace(sandAnchor,'float sand=smoothstep(.25,.72,ctx.b);');
  const sandColor='vec3 sandBase=mix(toLinear(PCG_COLOR_SAND_0),toLinear(PCG_COLOR_SAND_1),clamp(.5+.3*regional.x+sandD.pigment,0.,1.));';
  const sandPigment='sandBase*=1.+PCG_SAND_PIGMENT_CONTRAST*(sandGrain.x-.5+.4*sandFine.x);';
  const sandWet='sandBase*=1.-PCG_SAND_WET_DARKENING*wet;';
  const gradient='vec3 grad=gradientScreen(P,N,d);grad-=N*dot(N,grad);';
  for(const anchor of [sandColor,sandPigment,sandWet,gradient])if(!library.includes(anchor))throw Error('Saved shoreline sand color/relief contract missing');
  library=library.replace(sandColor,'vec3 sandBase=mix(toLinear(PCG_COLOR_SAND_0),toLinear(PCG_COLOR_SAND_1),.5);')
    .replace(sandPigment,'').replace(sandWet,'')
    .replace(gradient,`vec3 sandGrad=PCG_RELIEF_RIPPLE*rippleMask*gradientScreen(P,N,ripple)+gradientScreen(P,N,PCG_RELIEF_SAND_GRAIN*(sandGrain.y-.40)+PCG_RELIEF_SAND_FINE*sandFine.x+sandD.height);
    vec3 grad=mix(gradientScreen(P,N,d),sandGrad,weights.z*(1.-mud)*(1.-living));grad-=N*dot(N,grad);`);
                                                                          
                                                                         
  for(const [base,role] of [['rockBase','ROCK'],['soilBase','SOIL'],['mudBase','MUD'],['liveBase','LIVING']]){
    const wetPigment=`${base}*=1.-PCG_${role}_WET_DARKENING*wet;`;
    if(!library.includes(wetPigment))throw Error('Saved terrain pigment wetness contract missing: '+role);
    library=library.replace(wetPigment,'');
  }
  const code=translateTerrainGLSL(terrainDisneyGLSL + '\n' + context + library)
    .replaceAll('frame.cameraPos','apsTerrainNativePosition(frame.cameraPos)');
  const baseAssignment='m.baseColor = base;';
  if(!code.includes(baseAssignment))throw Error('Translated terrain baseColor contract missing');
                                                                          
                                                                                
                                                                          
                                                                            
                                                                    
  for(const anchor of ['var weights: vec3f =','var mud: f32 =','var living: f32 =','var litter: f32 ='])
    if(!code.includes(anchor))throw Error('Translated exposed rock mask contract missing: '+anchor);
  if(!code.includes('const apsT_PCG_DETAIL_DISTANCE_GAIN: f32 ='))throw Error('Translated terrain detail-distance gain missing');
                                                                            
                                                                             
  return 'var<private> apsTerrainSandCoverage: f32;\nvar<private> apsTerrainTileWeights:vec4f;\nvar<private> apsTerrainLitter:f32;\nvar<private> apsTerrainGravel:f32;\nvar<private> apsTerrainRockMacroMask:f32;\n'+code.replace(baseAssignment,'apsTerrainSandCoverage = weights.z * (1.0 - mud) * (1.0 - living);\napsTerrainTileWeights=vec4f(weights*(1.0-mud),mud);apsTerrainLitter=litter;apsTerrainGravel=clamp(hist.a*thickCover,0.0,0.65)*weights.y*(1.0-mud);\napsTerrainRockMacroMask=clamp(weights.x*(1.0-mud)*(1.0-living)*(1.0-litter),0.0,1.0);\n'+baseAssignment);
}

export function createTerrainMaterial({library, terrainModule, fields, dfg, receiverModule = dryReceiver, landscape = null, groundcover = null, variation = null, grassPBR = null, rockSurface = null, rockLayers = null, satMap = null, surfaceReconstruction = null}) {
  const curved=surfaceReconstruction?.mode==='cubic';
  if(rockSurface!==null)rockSurface=rockSurfaceConfig(rockSurface);
  if(rockSurface?.schema==='aps-rock-lygia/1'&&rockSurface.debug!=='pbr')throw Error('LYGIA channel diagnostics require the mesh material fixture');
  const code = compileTerrainMaterialLibrary(library);
  const dependencies = [terrainModule, lightingModule, principledLightingModule, receiverModule,receiverShadowModule,landscape?.module,grassPBR?.module,groundcover?.surfaceModule,variation?.module,rockLayers?.module,satMap?.module].filter(Boolean);
  const recipe = new ShaderModule({name: 'aps-saved-terrain-material', deps: dependencies,
    bindings: {...Object.fromEntries(Object.entries(fields).map(([k, texture]) => [k, {texture}])), terrainDFG: {texture: dfg, sampleType: 'unfilterable-float'}},
    code: code + '\n' + rockMacroWGSL + '\n' + (rockSurface?createRockSurfaceWGSL(rockSurface):'') + '\n' + terrainMossCoverWGSL(satMap?.mossMoisture??undefined) + '\n' + terrainBRDFWGSL + '\n' + terrainLightingWGSL + '\nvar<private> apsTerrainCurrent: apsT_PrincipledMaterial;'});
  const material = new Material({name: 'Native DEM / metric Disney terrain', modules: [recipe],
                                                                             
                                                                              
    lit: false, attributes: {apsPatch: 'vec4f',...(curved?{apsSeam:'vec4f'}:{})}, varyings: {terrainSkirt: 'f32'},
    vertex: curved?surfaceVertexWGSL():terrainVertexWGSL, shadow: 'return in.vs.terrainSkirt <= 0.001;',
    surface:           `
var ctx: apsT_MaterialContext;
ctx.worldPosition = apsTerrainNativePosition(in.P);
ctx.position = ctx.worldPosition - vec3f(terrainParams.origin.x, 0.0, terrainParams.origin.y);
ctx.normal = apsTerrainNativeNormal(in.N);
${satMap?`// This explicit appearance experiment consumes source SatMap/TextureBase.
// Do not run the old procedural soil cells, litter facets or painted meso relief.
apsTerrainCurrent=apsT_principledMaterialDefaults(normalize(in.N));
apsTerrainCurrent.roughness=.82;apsTerrainCurrent.occlusion=1.;
apsTerrainSandCoverage=0.;apsTerrainRockMacroMask=smoothstep(-.25,.25,ctx.worldPosition.y);
apsTerrainTileWeights=vec4f(apsTerrainRockMacroMask,0,0,0);apsTerrainLitter=0.;apsTerrainGravel=0.;`:'apsTerrainCurrent = apsT_apsTerrainMaterial(ctx);apsTerrainCurrent.normal=apsTerrainWorldNormal(apsTerrainCurrent.normal);'}
${landscape ? landscape.surface : ''}
// One shared medium-scale field drives RGB and normal over scanned rock PBR.
// Grass and explicit cover compose afterwards, retaining their real coverage.
let rockMacroMask=apsTerrainRockMacroMask*(1.-apsTerrainSandCoverage);
${satMap?'':`
let rockMacro=apsRockMacroSample(ctx.normal,ctx.worldPosition,apsT_PCG_DETAIL_DISTANCE_GAIN);
apsTerrainCurrent.baseColor=apsRockMacroColor(apsTerrainCurrent.baseColor,rockMacro.value,rockMacroMask,apsT_toLinear(apsT_PCG_COLOR_ROCK_0),apsT_toLinear(apsT_PCG_COLOR_ROCK_1));
apsTerrainCurrent.normal=apsTerrainWorldNormal(apsRockMacroApplyNormal(apsTerrainNativeNormal(apsTerrainCurrent.normal),rockMacro.gradient,rockMacroMask));`}
${rockSurface?`let rockSurface=apsRockSurfaceSample(ctx.worldPosition);
let rockSurfaceMask=rockMacroMask*APS_ROCK_STRENGTH;
${satMap?`let sourceAppearance=apsTerrainAppearance(ctx.worldPosition,dpdx(ctx.worldPosition),dpdy(ctx.worldPosition));
apsTerrainCurrent.baseColor=sourceAppearance.rgb;
// TextureBase is a scalar appearance prior, not a semantic material-ID map.
${satMap.mossMoisture?`let mossFootprint=max(length(dpdx(ctx.worldPosition)),length(dpdy(ctx.worldPosition)));
// Drainage banks OR deep geometry AO pockets admit growth; TextureBase refines
// local detail. Noise changes patch coverage inside this candidate habitat.
let moisturePrior=apsTerrainMossGuidance(ctx.worldPosition,dpdx(ctx.worldPosition),dpdy(ctx.worldPosition)).r;
let rockCover=apsTerrainMoistureMoss(ctx.worldPosition,mossFootprint,moisturePrior,rockSurface.masks);`:`var rockCover=rockSurface.masks;rockCover.y*=mix(.35,1.,sourceAppearance.a);rockCover.z*=mix(1.,.6,sourceAppearance.a);rockCover.x=max(0.,1.-rockCover.y-rockCover.z);`}
let nearAppearance=1.-smoothstep(.08,.85,max(length(dpdx(ctx.worldPosition)),length(dpdy(ctx.worldPosition))));
let rockRegionalTint=sourceAppearance.rgb*clamp(rockSurface.rockTint/max(APS_ROCK_STONE_BASE,vec3f(.01)),vec3f(.4),vec3f(1.4));`:''}
${rockLayers?`let rockPBR=apsRockPBR(ctx.worldPosition,ctx.normal,dpdx(ctx.worldPosition),dpdy(ctx.worldPosition),${satMap?'rockCover':'rockSurface.masks'},${satMap?'rockRegionalTint':'rockSurface.rockTint'});
let rockDetailWeight=rockSurfaceMask${satMap&&!satMap.mossMoisture?'*nearAppearance':''};
apsTerrainCurrent.baseColor=mix(apsTerrainCurrent.baseColor,rockPBR.color*(1.-.65*rockSurface.fracture),rockDetailWeight);
apsTerrainCurrent.roughness=mix(apsTerrainCurrent.roughness,clamp(rockPBR.roughness+.10*rockSurface.fracture,.04,1.),rockDetailWeight);
apsTerrainCurrent.occlusion=mix(apsTerrainCurrent.occlusion,rockPBR.ao,rockDetailWeight);
apsTerrainCurrent.normal=apsTerrainWorldNormal(normalize(mix(apsTerrainNativeNormal(apsTerrainCurrent.normal),rockPBR.normal,rockDetailWeight)));
apsTerrainCurrent.normal=apsTerrainWorldNormal(apsRockSurfaceNormal(apsTerrainNativeNormal(apsTerrainCurrent.normal),ctx.normal,ctx.worldPosition,rockSurface.height,rockDetailWeight));`:`
apsTerrainCurrent.baseColor=mix(apsTerrainCurrent.baseColor,rockSurface.color,rockSurfaceMask);
apsTerrainCurrent.roughness=mix(apsTerrainCurrent.roughness,rockSurface.roughness,rockSurfaceMask);
apsTerrainCurrent.normal=apsTerrainWorldNormal(apsRockSurfaceNormal(apsTerrainNativeNormal(apsTerrainCurrent.normal),ctx.normal,ctx.worldPosition,rockSurface.height,rockSurfaceMask));`}`:''}
if(terrainParams.mode==17){apsTerrainCurrent.emission=apsTerrainCurrent.baseColor;}
if(terrainParams.mode==14){apsTerrainCurrent.emission=apsTerrainCurrent.normal*.5+.5;}
${grassPBR ? grassPBR.surface : ''}
${groundcover ? groundcover.detailSurface : ''}
${variation ? variation.surface : ''}
${groundcover ? groundcover.coverSurface : ''}
let receiverFootprint=max(length(dpdx(in.P)),length(dpdy(in.P)));
let wetMaterial=oceanApplyReceiverMaterial(in.P,receiverFootprint,apsTerrainCurrent.baseColor,apsTerrainCurrent.roughness,apsTerrainCurrent.clearcoat,apsTerrainCurrent.clearcoatGloss);
apsTerrainCurrent.baseColor=mix(wetMaterial.baseColor,terrainReceiverSandColor(in.P,receiverFootprint,apsTerrainCurrent.baseColor),apsTerrainSandCoverage);apsTerrainCurrent.roughness=wetMaterial.roughness;
apsTerrainCurrent.clearcoat=wetMaterial.clearcoat;apsTerrainCurrent.clearcoatGloss=wetMaterial.clearcoatGloss;
apsTerrainCurrent.normal=apsConsistentNormal(apsTerrainCurrent.normal,in.N,in.V,frame.sunDir);
let m = apsTerrainCurrent;
s.albedo = m.baseColor; s.normal = m.normal; s.roughness = m.roughness;
s.metalness = m.metallic; s.ao = m.occlusion; s.emissive = m.emission;
s.specularIntensity = 2.0 * m.specular; s.clearcoat = m.clearcoat;
s.clearcoatRoughness = sqrt(mix(0.1, 0.001, m.clearcoatGloss)); s.clearcoatNormal = m.normal;
s.sheenColor = m.sheen * mix(vec3f(1.0), apsTerrainTint(m.baseColor), m.sheenTint);
`, output:           `
if (terrainParams.mode == 37) {r.color=vec4f(terrainReceiverShallowDepthColor(in.P),1.0);}
else if (terrainParams.mode == 36) {
 let P=in.P;let nativeP=apsTerrainNativePosition(P);let receiverP=apsTerrainWorldPosition(terrainShadowReceiver(nativeP));
 r.color=vec4f(vec3f(sunShadowTerrain(receiverP,apsTerrainWorldNormal(terrainRenderNormalAt(nativeP.xz)),apsTerrainWorldNormal(terrainRenderPlaneNormalAt(nativeP.xz)),in.pixel,max(.025,.1*min(terrainParams.spacing.x,terrainParams.spacing.y)))),1.0);
}
else if (terrainParams.mode != 0) { r.color = vec4f(apsTerrainCurrent.emission, s.alpha); }
else {
 let footprint=max(0.001,max(length(dpdx(in.P)),length(dpdy(in.P))));
 var shadingMaterial=apsTerrainCurrent;
 shadingMaterial.baseColor=terrainReceiverShadeColor(in.P,footprint,apsTerrainCurrent.baseColor);
 var radiance=apsTerrainShade(shadingMaterial,s,in.P,in.N,in.V,in.pixel);
 let foam=terrainReceiverFoam(in.P,footprint);
 if(foam.x>1e-6){
  // A single foam layer on the beach, independent of wet/dry sheet visibility.
  var fm=apsTerrainCurrent;var N=apsTerrainWorldNormal(terrainNormalAt(apsTerrainNativePosition(in.P).xz));
  let pdx=dpdx(in.P);let pdy=dpdy(in.P);let r1=cross(pdy,N);let r2=cross(N,pdx);let det=dot(pdx,r1);
  if(abs(det)>1e-6){N=normalize(N-(dpdx(foam.y)*r1+dpdy(foam.y)*r2)/det);}
  fm.normal=N;fm.baseColor=vec3f(0.98);fm.roughness=0.78;fm.specular=0.5;
  fm.metallic=0.0;fm.specularTint=0.0;fm.anisotropy=0.0;fm.subsurface=0.0;fm.sheen=0.0;fm.clearcoat=0.0;fm.emission=vec3f(0.0);
  radiance=mix(radiance,apsTerrainShade(fm,s,in.P,in.N,in.V,in.pixel),clamp(foam.x,0.0,1.0));
 }
 r.color=vec4f(radiance,s.alpha);
}
`});
  return {material, recipe, setReceiver(module = dryReceiver) {
    if (module?.isShaderModule && /\bfn\s+oceanWetness\s*\(/.test(module.code)) {
      module = new ShaderModule({name: 'aps-ocean-wetness-adapter', deps: [module], code:
        'fn terrainReceiverWetness(xz: vec2f) -> f32 { return oceanWetness(xz); }'});
    }
    if (!module?.isShaderModule || !/\bfn\s+terrainReceiverWetness\s*\(/.test(module.code)) throw Error('Expected ShaderModule fn terrainReceiverWetness(xz: vec2f) -> f32 or oceanWetness(xz: vec2f) -> f32');
    if(!/\bfn\s+terrainReceiverFoam\s*\(/.test(module.code))module=new ShaderModule({name:'aps-receiver-no-residue',deps:[module],code:'fn terrainReceiverFoam(P:vec3f,footprint:f32)->vec2f{return vec2f(0);}'});
    if(!/\bfn\s+oceanApplyReceiverMaterial\s*\(/.test(module.code))module=new ShaderModule({name:'aps-legacy-wet-material',deps:[module],code:`
struct OceanReceiverMaterial{baseColor:vec3f,roughness:f32,clearcoat:f32,clearcoatGloss:f32};
fn oceanApplyReceiverMaterial(P:vec3f,footprint:f32,color:vec3f,rough:f32,coat:f32,gloss:f32)->OceanReceiverMaterial{
 let wet=clamp(terrainReceiverWetness(P.xz),0.0,1.0);return OceanReceiverMaterial(color,mix(rough,max(0.065,rough*0.42),wet),max(coat,wet*0.45),mix(gloss,max(gloss,0.7),wet));}
`});
    if(!/\bfn\s+terrainReceiverSandColor\s*\(/.test(module.code))module=new ShaderModule({name:'aps-receiver-sand-color',deps:[module],code:'fn terrainReceiverSandColor(P:vec3f,footprint:f32,color:vec3f)->vec3f{return color;}'});
    if(!/\bfn\s+terrainReceiverShadeColor\s*\(/.test(module.code))module=new ShaderModule({name:'aps-receiver-shade-color',deps:[module],code:'fn terrainReceiverShadeColor(P:vec3f,footprint:f32,color:vec3f)->vec3f{return color;}'});
    if(!/\bfn\s+terrainReceiverShallowDepthColor\s*\(/.test(module.code))module=new ShaderModule({name:'aps-receiver-no-depth-view',deps:[module],code:'fn terrainReceiverShallowDepthColor(P:vec3f)->vec3f{return vec3f(0.12);}'});
                                                                             
                                                                         
    recipe.deps = [terrainModule, lightingModule, principledLightingModule, module,receiverShadowModule,landscape?.module,grassPBR?.module,groundcover?.surfaceModule,variation?.module,rockLayers?.module,satMap?.module].filter(Boolean); material.needsUpdate = true;
  }};
}
