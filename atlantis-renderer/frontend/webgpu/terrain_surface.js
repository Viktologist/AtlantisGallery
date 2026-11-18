                                                                                            
export const SURFACE_SHADOW_SUBDIVISIONS=Object.freeze([8,4,2,1]);
export function terrainSurfaceOptions(value){
 if(value===false)return {mode:'native',minWidth:8,pixelStep:6};
 if(value===undefined||value===true)value={};
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('surface_reconstruction must be false or an options object');
 for(const k of Object.keys(value))if(!['mode','min_patch_cells','pixel_step'].includes(k))throw Error('Unknown surface_reconstruction option: '+k);
 const mode=value.mode??'cubic',minWidth=value.min_patch_cells??8,pixelStep=value.pixel_step??6;
 if(!['native','cubic'].includes(mode)||!Number.isInteger(minWidth)||minWidth<1||minWidth>64||(minWidth&(minWidth-1))||!Number.isFinite(pixelStep)||pixelStep<1||pixelStep>16)throw Error('Invalid surface_reconstruction options');
 return {mode,minWidth,pixelStep};
}
export const curveKernelWGSL=          `
fn apsSurfaceSlope(a:f32,b:f32)->f32{
 if(a*b<=0.){return 0.;}return 2.*a*b/(a+b);
}
fn apsSurfaceSlopeDx(a:f32,b:f32,ax:f32,bx:f32)->f32{
 if(a*b<=0.){return 0.;}let s=a+b;return 2.*(b*b*ax+a*a*bx)/(s*s);
}
fn apsSurfaceRow(v:vec4f,t:f32)->vec2f{
 let m0=apsSurfaceSlope(v.y-v.x,v.z-v.y);let m1=apsSurfaceSlope(v.z-v.y,v.w-v.z);
 let t2=t*t;let t3=t2*t;
 let value=(2.*t3-3.*t2+1.)*v.y+(t3-2.*t2+t)*m0+(-2.*t3+3.*t2)*v.z+(t3-t2)*m1;
 let derivative=(6.*t2-6.*t)*v.y+(3.*t2-4.*t+1.)*m0+(-6.*t2+6.*t)*v.z+(3.*t2-2.*t)*m1;
 return vec2f(value,derivative);
}
// Separable slope-limited Hermite, interpolating all native nodes. Each 1D
// segment is bounded by its endpoints; the 2D height remains in the cell's
// four-corner range. Derivatives include the X-dependence of the Z slopes.
fn apsSurfaceCubic(grid:vec2f)->vec3f{
 let p=clamp(grid,vec2f(0),terrainParams.shape-1.);let q=min(vec2i(floor(p)),vec2i(terrainParams.shape)-2);let t=p-vec2f(q);
 var rows:array<vec2f,4>;
 for(var j=0;j<4;j++){
  let z=q.y+j-1;
  rows[j]=apsSurfaceRow(vec4f(terrainGridHeight(vec2i(q.x-1,z)),terrainGridHeight(vec2i(q.x,z)),terrainGridHeight(vec2i(q.x+1,z)),terrainGridHeight(vec2i(q.x+2,z))),t.x);
 }
 let v=vec4f(rows[0].x,rows[1].x,rows[2].x,rows[3].x);let dx=vec4f(rows[0].y,rows[1].y,rows[2].y,rows[3].y);
 let result=apsSurfaceRow(v,t.y);let ty=t.y;let t2=ty*ty;let t3=t2*ty;
 let m0x=apsSurfaceSlopeDx(v.y-v.x,v.z-v.y,dx.y-dx.x,dx.z-dx.y);
 let m1x=apsSurfaceSlopeDx(v.z-v.y,v.w-v.z,dx.z-dx.y,dx.w-dx.z);
 let derivativeX=(2.*t3-3.*t2+1.)*dx.y+(t3-2.*t2+ty)*m0x+(-2.*t3+3.*t2)*dx.z+(t3-t2)*m1x;
 return vec3f(result.x,derivativeX,result.y);
}
fn apsSurfaceReceiverNormal(xz:vec2f)->vec3f{
 let jet=apsSurfaceCubic((xz-terrainParams.origin)/terrainParams.spacing);
 return normalize(vec3f(-jet.y/terrainParams.spacing.x,1.,-jet.z/terrainParams.spacing.y));
}
`;
export function surfaceWGSL(mode){
 if(mode==='native')return `
fn terrainRenderNormalAt(xz:vec2f)->vec3f{return terrainNormalAt(xz);}
fn terrainRenderPlaneNormalAt(xz:vec2f)->vec3f{return terrainTriangleNormalAt(xz);}
fn terrainShadowReceiver(P:vec3f)->vec3f{return vec3f(P.x,terrainHeightAt(P.xz),P.z);}`;
 if(mode!=='cubic')throw Error('Unknown terrain surface interpolation');
 return curveKernelWGSL+`
fn apsSurfaceDisplay(q:vec2f)->vec3f{return apsSurfaceCubic(q);}
fn terrainRenderNormalAt(xz:vec2f)->vec3f{return apsSurfaceReceiverNormal(xz);}
fn terrainRenderPlaneNormalAt(xz:vec2f)->vec3f{return apsSurfaceReceiverNormal(xz);}
fn terrainShadowReceiver(P:vec3f)->vec3f{return P;}`;
}
                                                                       
                                                                                 
export function surfaceCasterWGSL(){return 'fn apsCasterGridHeight(q:vec2i)->f32{return textureLoad(terrainHeight,clamp(q,vec2i(0),vec2i(terrainParams.shape)-1),0).r;}'+curveKernelWGSL.replaceAll('apsSurface','apsCasterSurface').replaceAll('terrainGridHeight','apsCasterGridHeight')+'\nfn apsCasterSurfaceDisplay(q:vec2f)->vec3f{return apsCasterSurfaceCubic(q);}';}
export function vertexWGSL(){return           `
let local=v.position.xz;
let q=min(v.apsPatch.xy+local*(v.apsPatch.z/64.),terrainParams.shape-1.);
var jet=apsSurfaceDisplay(q);
// Fine edge vertices land on the coarser neighbor's actual polyline. No skirts.
var seam=0.;var axis=0;
if(local.x==0.&&v.apsSeam.x>0.){seam=v.apsSeam.x;axis=1;}
if(local.x==64.&&v.apsSeam.y>0.){seam=v.apsSeam.y;axis=1;}
if(local.y==0.&&v.apsSeam.z>0.){seam=v.apsSeam.z;axis=0;}
if(local.y==64.&&v.apsSeam.w>0.){seam=v.apsSeam.w;axis=0;}
if(seam>0.){
 var a=q;var b=q;a[axis]=floor(q[axis]/seam)*seam;b[axis]=min(a[axis]+seam,terrainParams.shape[axis]-1.);
 let f=(q[axis]-a[axis])/max(b[axis]-a[axis],1e-8);jet=mix(apsSurfaceDisplay(a),apsSurfaceDisplay(b),f);
}
v.normal=normalize(vec3f(-jet.y/terrainParams.spacing.x,1.,-jet.z/terrainParams.spacing.y));
v.position=vec3f(q.x*terrainParams.spacing.x,jet.x,q.y*terrainParams.spacing.y);
v.uv=q/(terrainParams.shape-1.);o.terrainSkirt=0.;
`;}
export const shadowVertexWGSL=          `
let q=min(v.apsPatch.xy+v.position.xz*(v.apsPatch.z/64.),terrainParams.shape-1.);
let jet=apsSurfaceDisplay(q);
v.position=vec3f(q.x*terrainParams.spacing.x,jet.x,q.y*terrainParams.spacing.y);
v.normal=normalize(vec3f(-jet.y/terrainParams.spacing.x,1.,-jet.z/terrainParams.spacing.y));
`;
