import {Texture,ShaderModule} from '../../vendor/tidewater/src/engine/webgpu.js';

function radicalInverse(bits) {
  bits=((bits<<16)|(bits>>>16))>>>0;
  bits=(((bits&0x55555555)<<1)|((bits&0xaaaaaaaa)>>>1))>>>0;
  bits=(((bits&0x33333333)<<2)|((bits&0xcccccccc)>>>2))>>>0;
  bits=(((bits&0x0f0f0f0f)<<4)|((bits&0xf0f0f0f0)>>>4))>>>0;
  bits=(((bits&0x00ff00ff)<<8)|((bits&0xff00ff00)>>>8))>>>0;
  return bits/4294967296;
}
const fifth=x=>{const t=Math.max(0,Math.min(1,1-x));return t*t*t*t*t;};
                                                                               
                                                                               
                                                                          
                                                                                      
export function buildPrincipledDFG({size=64,samples=512}={}) {
  if(!Number.isInteger(size)||size<2||size>256||!Number.isInteger(samples)||samples<16||samples>4096)throw Error('Invalid Principled DFG integration dimensions');
  const out=new Float32Array(size*size*4),sequence=Array.from({length:samples},(_,i)=>[(i+.5)/samples,radicalInverse(i)]);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++) {
    const nv=(x+.5)/size,rough=(y+.5)/size,vx=Math.sqrt(1-nv*nv),alpha=Math.max(.001,rough*rough),a2=alpha*alpha;
    const visV=1/(nv+Math.sqrt(a2+(1-a2)*nv*nv));let A=0,B=0,sheen=0,diffuse=0;
    for(const [u,v] of sequence) {
      const phi=2*Math.PI*v,c=Math.cos(phi),s=Math.sin(phi);
      const hz=Math.sqrt((1-u)/(1+(a2-1)*u)),hr=Math.sqrt(Math.max(0,1-hz*hz)),hx=hr*c;
      const vh=vx*hx+nv*hz,lz=2*vh*hz-nv;
      if(vh>0&&lz>0) {
        const visL=1/(lz+Math.sqrt(a2+(1-a2)*lz*lz)),weight=visV*visL*lz*4*vh/Math.max(hz,1e-9),fc=fifth(vh);
        A+=(1-fc)*weight;B+=fc*weight;
      }
      const nl=Math.sqrt(1-u),lr=Math.sqrt(u),lx=lr*c,ly=lr*s;
      const hlen=Math.hypot(lx+vx,ly,nl+nv),lh=(1+lx*vx+nl*nv)/hlen;
      sheen+=Math.PI*fifth(lh);
      let t=lx*vx; if(t>0)t/=Math.max(nl,nv,1e-20);
      diffuse+=Math.PI/(Math.PI+((3*Math.PI-4)/6)*rough)*(1+rough*t);
    }
    out.set([A/samples,B/samples,sheen/samples,diffuse/samples],(y*size+x)*4);
  }
  return out;
}
export function floatToHalf(value) {
  if(!Number.isFinite(value)||value<0)throw Error('Invalid nonnegative DFG value');
  if(value===0)return 0;
  if(value<2**-14)return Math.min(1023,Math.round(value/2**-24));
  let exponent=Math.floor(Math.log2(value)),mantissa=Math.round((value/2**exponent-1)*1024);
  if(mantissa===1024){exponent++;mantissa=0;}
  return exponent>15?0x7bff:((exponent+15)<<10)|mantissa;
}
class PrincipledDFGTexture extends Texture {
  constructor(){super({width:64,height:64,format:'rgba16float',label:'APS Disney DFG (512 samples)',usage:['sample','copyDst']});}
  getGPU(){if(!this.gpu&&!this.pendingData)this.pendingData=Uint16Array.from(buildPrincipledDFG(),floatToHalf);return super.getGPU();}
}
export const principledDFGTexture=new PrincipledDFGTexture();
export const principledDFGModule=new ShaderModule({name:'aps-principled-preintegrated-dfg',bindings:{apsPrincipledDFGTexture:{texture:principledDFGTexture}},code:          `
fn apsPrincipledDFG(nv: f32, roughness: f32) -> vec4f {
  let uv=clamp(vec2f(nv,roughness),vec2f(0.5/64.0),vec2f(1.0-0.5/64.0));
  return textureSampleLevel(apsPrincipledDFGTexture,smpLinearClamp,uv,0.0);
}
`});
