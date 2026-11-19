const profiles = new Set(['microwave']);

export class PythonLogic {
  constructor(profile, onSnapshot, onError) {
    if (typeof profile==='string'&&!profiles.has(profile)) throw Error('This Python interaction module is unavailable');
    this.worker = new Worker(new URL('./python-worker.js', import.meta.url));
    this.ready = false;
    this.pending = false;
    this.elapsed = 0;
    this.lastUpdate = 0;
    this.events = [];
    this.active = true;
    this.module = typeof profile==='object';
    this.timer=setTimeout(()=>fail('Python startup timed out'),120000);
    const fail = message => {
      this.dispose();
      onError(message);
    };
    this.worker.onmessage = ({ data }) => {
      clearTimeout(this.timer);
      if (data.error) return fail(data.error);
      if (!this.ready) this.lastUpdate = performance.now();
      this.ready = true;
      this.pending = false;
      try { if (data.snapshot) onSnapshot(data.snapshot); } catch(error) { return fail(String(error)); }
      this.flush();
    };
    this.worker.onerror = () => fail('Could not start the Python interaction module');
    this.worker.postMessage(typeof profile==='string'?{init:true,profile}:{init:true,descriptor:profile});
  }

  event(event, value) {
    if (!this.active) return;
    if(event==='input')this.events=this.events.filter(item=>item[0]!=='input');
    if(this.events.length>=64)this.events.shift();
    this.events.push([event, value]);
    this.update();
  }

  update() {
    if (!this.active || !this.ready) return;
    const now = performance.now();
    this.elapsed += now - this.lastUpdate;
    this.lastUpdate = now;
    this.flush();
  }

  flush() {
    if (!this.ready || this.pending || (!this.events.length && this.elapsed < (this.module?30:60))) return;
    this.pending = true;
    this.worker.postMessage({ events: this.events.splice(0), elapsed: this.module?Math.min(250,this.elapsed):this.elapsed });
    this.elapsed = 0;
  }

  dispose() {
    this.active = this.ready = false;
    clearTimeout(this.timer);
    this.worker.terminate();
    this.events.length = 0;
  }
}
