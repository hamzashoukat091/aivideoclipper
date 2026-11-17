import { onEachFrame } from "./media";

/**
 * Keeps the 9:16 render and the 16:9 source in sync for one clip (UI_SPEC 5.6): render time t ↔ source time
 * cut_in + t. The master is the render when it plays, else the source, else a virtual rAF clock (so the crop
 * overlay and timeline still work when no media can load). The slave is corrected when it drifts > 120 ms.
 */
export interface ClockState {
  t: number; // clip time, seconds
  sourceT: number; // source media time of the frame on screen in the source player
  playing: boolean;
  loop: boolean;
  rate: number;
  muted: boolean;
  master: "render" | "source" | "virtual";
  /** sourceT is a presented frame's mediaTime from the source <video> (else a computed, continuous time). */
  sourceLive: boolean;
}

const DRIFT = 0.12;

export class ClipClock {
  private render: HTMLVideoElement | null = null;
  private source: HTMLVideoElement | null = null;
  private renderOk = false;
  private sourceOk = false;
  private stopRender: (() => void) | null = null;
  private stopSource: (() => void) | null = null;
  private raf = 0;
  private lastTick = 0;
  private listeners = new Set<() => void>();
  /** Optional play range [a, b] in clip time (editor: play the trimmed part only). */
  private range: [number, number] | null = null;
  /** Optional held-frame map: clip time -> source time to show frozen (edge shots), or null. */
  private hold: ((t: number) => number | null) | null = null;
  state: ClockState;

  constructor(
    private cutIn: number,
    private dur: number,
    private fps: number,
  ) {
    this.state = { t: 0, sourceT: cutIn, playing: false, loop: true, rate: 1, muted: false, master: "virtual", sourceLive: false };
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  getSnapshot = () => this.state;

  private set(patch: Partial<ClockState>) {
    const next = { ...this.state, ...patch };
    const s = this.state;
    if (next.t === s.t && next.sourceT === s.sourceT && next.playing === s.playing && next.loop === s.loop && next.rate === s.rate && next.muted === s.muted && next.master === s.master && next.sourceLive === s.sourceLive) return;
    this.state = next;
    this.listeners.forEach((l) => l());
  }

  get duration() {
    return this.dur;
  }

  private masterKind(): ClockState["master"] {
    if (this.render && this.renderOk) return "render";
    if (this.source && this.sourceOk) return "source";
    return "virtual";
  }

  private applyAudio() {
    const m = this.masterKind();
    if (this.render) this.render.muted = this.state.muted || m !== "render";
    if (this.source) this.source.muted = this.state.muted || m !== "source";
  }

  setRender(v: HTMLVideoElement | null, ok: boolean) {
    if (v !== this.render) {
      this.stopRender?.();
      this.stopRender = null;
      this.render = v;
      if (v) {
        const stop = onEachFrame(v, (mt) => this.onRenderFrame(mt));
        const ended = () => this.onEnded("render");
        v.addEventListener("ended", ended);
        this.stopRender = () => {
          stop();
          v.removeEventListener("ended", ended);
        };
      }
    }
    this.renderOk = !!v && ok;
    this.reconfigure();
  }

  setSource(v: HTMLVideoElement | null, ok: boolean) {
    if (v !== this.source) {
      this.stopSource?.();
      this.stopSource = null;
      this.source = v;
      if (v) {
        const stop = onEachFrame(v, (mt) => this.onSourceFrame(mt));
        const ended = () => this.onEnded("source");
        v.addEventListener("ended", ended);
        this.stopSource = () => {
          stop();
          v.removeEventListener("ended", ended);
        };
      }
    }
    this.sourceOk = !!v && ok;
    this.reconfigure();
  }

  private reconfigure() {
    const master = this.masterKind();
    const wasPlaying = this.state.playing;
    this.set({ master, sourceLive: this.sourceOk });
    this.applyAudio();
    [this.render, this.source].forEach((v) => {
      if (v) v.playbackRate = this.state.rate;
    });
    this.seek(this.state.t);
    if (wasPlaying) this.play();
  }

  private onEnded(which: "render" | "source") {
    if (this.masterKind() !== which || !this.state.playing) return;
    if (this.state.loop) {
      this.seek(0);
      this.play();
    } else {
      this.pause();
    }
  }

  private onRenderFrame(mt: number) {
    if (this.masterKind() !== "render") return;
    this.advanceTo(mt);
  }

  private heldAt(t: number): number | null {
    return this.hold ? this.hold(t) : null;
  }

  private onSourceFrame(mt: number) {
    if (this.masterKind() !== "source" || this.heldAt(this.state.t) !== null) {
      // slave, or source master parked on a held frame: the source time is not the clock
      this.set({ sourceT: mt });
      return;
    }
    this.advanceTo(mt - this.cutIn, mt);
    if (this.state.playing && this.heldAt(this.state.t) !== null) this.startSourceHold();
  }

  /** Source master entering a held-frame shot: park the source on the held frame and run the clock on rAF. */
  private startSourceHold() {
    const h = this.heldAt(this.state.t);
    if (h === null || !this.source) return;
    this.source.pause();
    if (Math.abs(this.source.currentTime - h) > 0.5 / this.fps) this.source.currentTime = h;
    cancelAnimationFrame(this.raf);
    this.lastTick = performance.now();
    const tick = (now: number) => {
      if (!this.state.playing || this.masterKind() !== "source") return;
      const dt = ((now - this.lastTick) / 1000) * this.state.rate;
      this.lastTick = now;
      const next = this.state.t + dt;
      if (this.heldAt(next) === null) {
        // held shot over: resume real playback where the clock is
        this.set({ t: Math.min(this.dur, next) });
        if (this.source) {
          this.source.currentTime = this.cutIn + this.state.t;
          void this.source.play().catch(() => this.pause());
        }
        return;
      }
      this.advanceTo(next, h);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private bounds(): [number, number] {
    return this.range ?? [0, this.dur];
  }

  setRange(r: [number, number] | null) {
    this.range = r ? [Math.max(0, r[0]), Math.min(this.dur, r[1])] : null;
  }

  setHold(fn: ((t: number) => number | null) | null) {
    this.hold = fn;
    this.syncHeld();
  }

  /** Render master + held shot: keep the source paused on the held frame. Returns true when holding. */
  private syncHeld(): boolean {
    if (!this.hold || this.masterKind() !== "render" || !this.source || !this.sourceOk) return false;
    const h = this.hold(this.state.t);
    if (h === null) return false;
    if (!this.source.paused) this.source.pause();
    if (Math.abs(this.source.currentTime - h) > 0.5 / this.fps) this.source.currentTime = h;
    return true;
  }

  private advanceTo(t: number, sourceT?: number) {
    const [lo, hi] = this.bounds();
    if (this.state.playing && t >= hi - 0.5 / this.fps) {
      if (this.state.loop) {
        this.seek(lo);
        return;
      }
      this.pause();
      this.seek(hi - 0.5 / this.fps);
      return;
    }
    const clamped = Math.max(0, Math.min(this.dur, t));
    const patch: Partial<ClockState> = { t: clamped };
    if (sourceT !== undefined) patch.sourceT = sourceT;
    else if (!(this.source && this.sourceOk)) patch.sourceT = this.cutIn + clamped;
    this.set(patch);
    this.correctSlave();
  }

  private correctSlave() {
    if (this.syncHeld()) return;
    if (!this.state.playing) return;
    const m = this.masterKind();
    if (m === "render" && this.source && this.sourceOk) {
      const want = this.cutIn + this.state.t;
      if (Math.abs(this.source.currentTime - want) > DRIFT) this.source.currentTime = want;
      if (this.source.paused) void this.source.play().catch(() => undefined);
    } else if (m === "source" && this.render && this.renderOk) {
      const want = this.state.t;
      if (Math.abs(this.render.currentTime - want) > DRIFT) this.render.currentTime = want;
    }
  }

  play() {
    const [lo, hi] = this.bounds();
    if (this.state.t >= hi - 1 / this.fps || this.state.t < lo - 1e-3) this.seek(lo);
    this.set({ playing: true });
    const m = this.masterKind();
    if (m === "source" && this.heldAt(this.state.t) !== null) {
      this.startSourceHold();
      return;
    }
    const parkSource = m === "source" && this.heldAt(this.state.t) !== null;
    const vids = [this.renderOk ? this.render : null, this.sourceOk && !parkSource ? this.source : null].filter((v): v is HTMLVideoElement => !!v);
    vids.forEach((v) => {
      v.playbackRate = this.state.rate;
      void v.play().catch(() => {
        // Autoplay with sound can be blocked: retry muted, keep the UI consistent.
        if (!v.muted) {
          v.muted = true;
          void v.play().catch(() => this.pause());
        } else this.pause();
      });
    });
    if (m === "virtual") {
      cancelAnimationFrame(this.raf);
      this.lastTick = performance.now();
      const tick = (now: number) => {
        if (!this.state.playing || this.masterKind() !== "virtual") return;
        const dt = ((now - this.lastTick) / 1000) * this.state.rate;
        this.lastTick = now;
        this.advanceTo(this.state.t + dt);
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }
  }

  pause() {
    cancelAnimationFrame(this.raf);
    this.render?.pause();
    this.source?.pause();
    this.set({ playing: false });
    // Snap both players to the exact same instant.
    this.seek(this.state.t);
  }

  toggle() {
    if (this.state.playing) this.pause();
    else this.play();
  }

  seek(t: number) {
    const c = Math.max(0, Math.min(this.dur, Number.isFinite(t) ? t : 0));
    if (this.render && this.renderOk && Math.abs(this.render.currentTime - c) > 1e-3) this.render.currentTime = c;
    const held = this.masterKind() !== "virtual" ? this.heldAt(c) : null;
    const srcWant = held ?? this.cutIn + c;
    if (this.source && this.sourceOk && Math.abs(this.source.currentTime - srcWant) > 1e-3) this.source.currentTime = srcWant;
    this.set({ t: c, sourceT: this.sourceOk ? this.state.sourceT : srcWant });
    if (this.state.playing && this.masterKind() === "source" && held !== null) this.startSourceHold();
  }

  /** Step whole frames; lands in the middle of the target frame so decoders show exactly that frame. */
  step(frames: number) {
    if (this.state.playing) this.pause();
    const f = Math.floor(this.state.t * this.fps + 1e-6) + frames;
    const maxF = Math.max(0, Math.floor(this.dur * this.fps) - 1);
    const target = (Math.max(0, Math.min(maxF, f)) + 0.5) / this.fps;
    this.seek(target);
  }

  setLoop(loop: boolean) {
    this.set({ loop });
  }

  setRate(rate: number) {
    [this.render, this.source].forEach((v) => {
      if (v) v.playbackRate = rate;
    });
    this.set({ rate });
  }

  setMuted(muted: boolean) {
    this.set({ muted });
    this.applyAudio();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.stopRender?.();
    this.stopSource?.();
    this.stopRender = null;
    this.stopSource = null;
    this.render?.pause();
    this.source?.pause();
    this.render = null;
    this.source = null;
    this.renderOk = false;
    this.sourceOk = false;
    this.state = { ...this.state, playing: false };
  }
}
