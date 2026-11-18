                                                                               
export function landscapePageLayout(manifest) {
 const c=manifest.streaming;
 if(c?.schema!=='aps-landscape-paging/1'||!Number.isInteger(c.page_size)||c.page_size<8||c.page_size>256||(c.page_size&(c.page_size-1))||!Number.isInteger(c.border)||c.border<1||c.border>4||!Number.isInteger(c.cache_pages)||c.cache_pages<8||c.cache_pages>80||!Number.isInteger(c.fade_frames)||c.fade_frames<4||c.fade_frames>120||!Number.isInteger(c.feedback_stride)||c.feedback_stride<1||c.feedback_stride>32||!Number.isInteger(c.feedback_interval)||c.feedback_interval<1||c.feedback_interval>60||!Number.isInteger(c.max_inflight)||c.max_inflight<1||c.max_inflight>8)throw Error('Invalid landscape paging configuration');
 const pages=[],stacks=[];let tableLayers=0,tableWidth=1,tableHeight=1;
 for(const [stackIndex,name] of ['macro_fields','world_mips'].entries()){
  const stack=manifest[name],levels=[];
  if(!stack?.paged||stack.format!=='rgba16float'||stack.layers!==3||!Array.isArray(stack.levels)||!stack.levels.length)throw Error('Invalid paged landscape stack');
  let w=stack.levels[0].width,h=stack.levels[0].height;
  if(![w,h].every(v=>Number.isInteger(v)&&v>0&&v<=65536)||stack.levels.length!==Math.floor(Math.log2(Math.max(w,h)))+1)throw Error('Invalid virtual landscape pyramid');
  let tail=-1;
  for(const [mip,row] of stack.levels.entries()){
   const cols=Math.ceil(w/c.page_size),rows=Math.ceil(h/c.page_size);
   if(row.width!==w||row.height!==h||JSON.stringify(row.page_grid)!==JSON.stringify([cols,rows])||!Array.isArray(row.pages)||row.pages.length!==cols*rows)throw Error('Virtual page grid mismatch');
   if(Math.max(w,h)<=c.page_size&&tail<0)tail=mip;
   const level={width:w,height:h,cols,rows,offset:pages.length,tableLayer:tableLayers++,mip,stackIndex};
   tableWidth=Math.max(tableWidth,cols);tableHeight=Math.max(tableHeight,rows);
   for(const [index,rowPage] of row.pages.entries()){
    if(rowPage.x!==index%cols||rowPage.y!==Math.floor(index/cols)||rowPage.bytes!==3*(c.page_size+2*c.border)**2*8)throw Error('Virtual page metadata mismatch');
    pages.push({...rowPage,id:pages.length,mip,stackIndex,pinned:tail>=0,level});
   }
   levels.push(level);w=Math.max(1,w>>1);h=Math.max(1,h>>1);
  }
  if(tail!==stack.tail_first_level)throw Error('Virtual mip tail mismatch');
  stacks.push({name,levels,tail});
 }
 const pinned=pages.filter(p=>p.pinned);
 if(pages.length>1_000_000||pinned.length+2>c.cache_pages||c.page_count!==pages.length||c.pinned_tail_pages!==pinned.length)throw Error('Virtual page budget/tail mismatch');
 return {config:c,pages,stacks,pinned,tableWidth,tableHeight,tableLayers,
  cacheBytes:c.cache_pages*3*(c.page_size+2*c.border)**2*8,tableBytes:tableWidth*tableHeight*tableLayers*16,feedbackBytes:pages.length*4};
}

export function parentPageIds(layout,id){
 const p=layout.pages[id],next=layout.stacks[p.stackIndex].levels[p.mip+1];
 if(!next)return [id];
 const size=layout.config.page_size,l=p.level;
 const x0=Math.floor(p.x*size/l.width*next.width/size),y0=Math.floor(p.y*size/l.height*next.height/size);
 const x1=Math.min(next.cols-1,Math.floor((Math.min((p.x+1)*size,l.width)/l.width*next.width-1e-7)/size));
 const y1=Math.min(next.rows-1,Math.floor((Math.min((p.y+1)*size,l.height)/l.height*next.height-1e-7)/size));
 const result=[];for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)result.push(next.offset+y*next.cols+x);return result;
}

export function boundedPageDemand(layout,counts){
 let wanted=new Map();counts.forEach((count,id)=>{if(count>0&&layout.pages[id]&&!layout.pages[id].pinned)wanted.set(id,count);});
 const budget=layout.config.cache_pages-layout.pinned.length;
 let bias=0;
 while(wanted.size>budget){
  const parents=new Map();for(const [id,count]of wanted)for(const parent of parentPageIds(layout,id))if(!layout.pages[parent].pinned)parents.set(parent,(parents.get(parent)||0)+count);
  wanted=parents;if(++bias>24)throw Error('Virtual demand failed to converge');
 }
 return {bias,requests:[...wanted].sort((a,b)=>b[1]-a[1]||a[0]-b[0]).map(([id,count])=>({id,count}))};
}

export class LandscapePageCache {
 constructor(layout,onChange=()=>{}){this.layout=layout;this.onChange=onChange;this.slots=Array(layout.config.cache_pages).fill(null);this.resident=new Map();this.wanted=new Set();this.frame=1;this.evictions=0;this.bias=0;}
 fade(entry,frame=this.frame){if(entry.page.pinned)return 1;return Math.min(1,Math.max(0,(frame-entry.born)/this.layout.config.fade_frames))*(entry.retire?Math.max(0,1-(frame-entry.retire)/this.layout.config.fade_frames):1);}
 demand(counts){const plan=boundedPageDemand(this.layout,counts);this.bias=plan.bias;this.wanted=new Set(plan.requests.map(p=>p.id));for(const [id,entry]of this.resident){if(counts[id])entry.used=this.frame;if(this.wanted.has(id)&&entry.retire){const f=this.fade(entry);entry.born=this.frame-Math.round(f*this.layout.config.fade_frames);entry.retire=0;this.onChange(entry.page,entry);}}return plan.requests;}
 advance(frame){this.frame=frame;for(const [id,entry]of this.resident)if(entry.retire&&frame-entry.retire>=this.layout.config.fade_frames){this.onChange(entry.page,null);this.slots[entry.slot]=null;this.resident.delete(id);this.evictions++;}}
 claim(id){if(this.resident.has(id))return this.resident.get(id);const slot=this.slots.indexOf(null);if(slot<0){const candidates=[...this.resident.values()].filter(e=>!e.page.pinned&&!this.wanted.has(e.page.id)&&!e.retire).sort((a,b)=>a.used-b.used||a.page.id-b.page.id);const old=candidates[0];if(old){old.retire=this.frame;this.onChange(old.page,old);}return null;}
  const entry={slot,page:this.layout.pages[id],born:this.frame,retire:0,used:this.frame};this.slots[slot]=entry;this.resident.set(id,entry);return entry;}
 publish(entry){this.onChange(entry.page,entry);}
}
