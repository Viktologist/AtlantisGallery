                                                                         
                                                                             
                                                                                 
export const CLOUD_WEATHER_PERIOD=10000;
export const CLOUD_FINE_SCALE=440;
const wrap=(x,period=1)=>((x%period)+period)%period;
const rotate=v=>[
 .54403737*v[0]-.73685072*v[1]-.40134070*v[2],
 .77122213*v[0]+.25072219*v[1]+.58511093*v[2],
 -.33051439*v[0]-.62784504*v[1]+.70467783*v[2],
];
export function cloudAdvection(time){
 if(!Number.isFinite(time))throw new TypeError('Cloud time must be finite');
 const x=time*14,z=time*4;
 return {
  shape:[wrap((.8*x-.6*z)*.0000755),wrap((.6*x+.8*z)*.0000755),0,0],
  billows:[...rotate([x/2200,0,z/2200]).map(v=>wrap(v)),0],
  fine:[...rotate([x*1.17/CLOUD_FINE_SCALE,0,z*1.17/CLOUD_FINE_SCALE]).map(v=>wrap(v)),0],
  weather:[x*.7/6000,z*.7/6000,x/6000,z/6000].map(v=>wrap(v,CLOUD_WEATHER_PERIOD)),
 };
}
