import {createWaveBand} from '../src/ocean_spectrum.js';

                                                                             
                                                                               
export function lakeWaveBand(basin,fetch,config) {
  if(!Number.isFinite(fetch)||fetch<=0||!Number.isFinite(basin.mean_depth_m)||basin.mean_depth_m<=0)throw Error('Invalid lake fetch/depth');
  const u=config.wind_speed_m_s,g=9.81,depth=basin.mean_depth_m;
  const hs=u===0?0:Math.min(.283*u*u/g*Math.tanh(.0125*(g*fetch/(u*u))**.42),.35*depth);
  const peak=u===0?1:22*(u*fetch/g**2)**(-1/3),peakLength=2*Math.PI*g/(peak*peak);
  const length=Math.min(Math.max(8,peakLength*8),Math.max(8,fetch*2));
  return createWaveBand({size:128,length,minWavelength:2*length/128,maxWavelength:length,
    significantHeight:hs,windSpeed:u,windDirection:config.wind_direction,seed:config.seed,
    depth,fetch_m:fetch,chop:0});
}
