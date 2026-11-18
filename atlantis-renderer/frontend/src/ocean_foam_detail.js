                                                                             
                                                                              
                                                                           
                                                                            
                                                                             
                                                                           
                                                                           
                                                                             
const fract=x=>x-Math.floor(x),smooth=x=>x*x*(3-2*x);
const hash=(x,y)=>fract(Math.sin(x*127.1+y*311.7)*43758.5453);
const wrap=(x,n)=>(x%n+n)%n;
function noise(x,y,period){const ix=Math.floor(x),iy=Math.floor(y),u=smooth(fract(x)),v=smooth(fract(y));
  const h=(a,b)=>hash(wrap(a,period),wrap(b,period));
  return (h(ix,iy)*(1-u)+h(ix+1,iy)*u)*(1-v)+(h(ix,iy+1)*(1-u)+h(ix+1,iy+1)*u)*v;}
function bubbles(x,y,cells,seed){let solid=0,hole=0;const ix=Math.floor(x*cells),iy=Math.floor(y*cells);
  for(let z=-1;z<=1;z++)for(let k=-1;k<=1;k++){
    const a=ix+k,b=iy+z,h=hash(wrap(a,cells)+seed,wrap(b,cells));
    const cx=a+.15+.7*h,cy=b+.15+.7*hash(wrap(a,cells),wrap(b,cells)+seed+29);
    const radius=.2+.34*hash(wrap(a,cells)+17,wrap(b,cells)+seed),d=Math.hypot(x*cells-cx,y*cells-cy)/radius;
    solid=Math.max(solid,Math.exp(-d*d*1.5));
    if(h>.68)hole=Math.max(hole,1-smooth(Math.max(0,Math.min(1,(d-.52)/.35))));
  }return [solid,hole];}
function strandDistance(x,y,cells){
  const ix=Math.floor(x*cells),iy=Math.floor(y*cells);let first=Infinity,second=Infinity;
  for(let z=-1;z<=1;z++)for(let k=-1;k<=1;k++){
    const a=ix+k,b=iy+z,cx=a+.15+.7*hash(wrap(a,cells)+71,wrap(b,cells)),cy=b+.15+.7*hash(wrap(a,cells),wrap(b,cells)+97);
    const d=Math.hypot(x*cells-cx,y*cells-cy);
    if(d<first){second=first;first=d;}else second=Math.min(second,d);
  }
  return .5*(second-first);
}
function coarseFilm(x,y){
  const cells=5,ix=Math.floor(x*cells),iy=Math.floor(y*cells);let body=0;
  for(let z=-1;z<=1;z++)for(let k=-1;k<=1;k++){
    const a=ix+k,b=iy+z,ha=wrap(a,cells),hb=wrap(b,cells);
    const cx=a+.12+.76*hash(ha+193,hb),cy=b+.12+.76*hash(ha,hb+227);
                                                                           
    const radius=.42+.38*hash(ha+269,hb+13),aspect=.7+.65*hash(ha+53,hb+281);
    const dx=(x*cells-cx)*aspect,dy=(y*cells-cy)/aspect;
    body=Math.max(body,Math.exp(-(dx*dx+dy*dy)/(radius*radius)*1.25));
  }
                                                                        
                                                                         
  return (1-body)**4;
}
export function createFoamDetail(size){
  const n=size*size,raw=new Float64Array(n),data=new Float32Array(n*4);
  for(let j=0;j<size;j++)for(let i=0;i<size;i++){
    const x=(i+.5)/size,y=(j+.5)/size,k=j*size+i;
    const wx=(noise(x*4,y*4,4)-.5)*.07,wy=(noise(x*4+19,y*4+7,4)-.5)*.07;
    const qx=x+wx,qy=y+wy,large=bubbles(qx,qy,13,13),small=bubbles(qx,qy,37,47);
                                                                       
                                                                            
    const edge=strandDistance(qx,qy,7),contour=Math.abs(noise(qx*6,qy*6,6)-.5);
    raw[k]=1-Math.min(edge*2.2,contour*1.8)+.035*noise(qx*16,qy*16,16);
    data[4*k+1]=(1-small[1])*(1-large[1]);data[4*k+2]=small[0];data[4*k+3]=coarseFilm(qx,qy);
  }
                                                                           
                                                                             
                                                                       
  const order=Array.from({length:n},(_,i)=>i).sort((a,b)=>raw[a]-raw[b]);
  order.forEach((k,i)=>data[4*k]=(i+.5)/n);
  return {size,data,period:.5,macroPeriod:2,macroCells:5,meanPorosity:data.reduce((s,v,i)=>s+(i%4===1?v:0),0)/n};
}
