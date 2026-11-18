const profiles = new Set(['microwave']);

export class PythonLogic {
  constructor(profile, onSnapshot, onError) {
    if (!profiles.has(profile)) throw Error('This Python interaction module is unavailable');
    this.worker = new Worker(new URL('./python-worker.js', import.meta.url));
    this.ready = false;
    this.pending = false;
    this.elapsed = 0;
    this.lastUpdate = 0;
    this.events = [];
    this.active = true;
    const fail = message => {
      this.dispose();
      onError(message);
    };
    this.worker.onmessage = ({ data }) => {
      if (data.error) return fail(data.error);
      if (!this.ready) this.lastUpdate = performance.now();
      this.ready = true;
      this.pending = false;
      if (data.snapshot) onSnapshot(data.snapshot);
      this.flush();
    };
    this.worker.onerror = () => fail('Could not start the Python interaction module');
    this.worker.postMessage({ profile });
  }

  event(event, value) {
    if (!this.active || this.events.length >= 64) return;
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
    if (!this.ready || this.pending || (!this.events.length && this.elapsed < 60)) return;
    this.pending = true;
    this.worker.postMessage({ events: this.events.splice(0), elapsed: this.elapsed });
    this.elapsed = 0;
  }

  dispose() {
    this.active = this.ready = false;
    this.worker.terminate();
    this.events.length = 0;
  }
}
