/**
 * Procedural, spatial soundscapes — no audio files are downloaded.
 *
 * Every world is built from filtered noise and short synthesised events,
 * placed around the listener with HRTF panners so sounds stay anchored to
 * the scene as you turn your head. World coordinates match the renderer
 * (x right, y up, z forward); Web Audio's forward is -z, so z is flipped.
 */

export type SoundId = "hub" | "ocean" | "shower" | "garden" | "harbour";

interface Running {
	id: SoundId;
	bus: GainNode;
	stop: () => void;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class Soundscape {
	private ctx: AudioContext | null = null;
	private master!: GainNode;
	private dry!: GainNode;
	private wet!: GainNode;
	private reverb!: ConvolverNode;
	private buffers!: { white: AudioBuffer; pink: AudioBuffer; brown: AudioBuffer };
	private running: Running | null = null;
	private scene: SoundId = "hub";
	enabled = false;

	/** Must be called from a user gesture the first time (autoplay policy). */
	async enable() {
		if (!this.ctx) this.create();
		const ctx = this.ctx!;
		if (ctx.state !== "running") await ctx.resume();
		this.enabled = true;
		const t = ctx.currentTime;
		this.master.gain.cancelScheduledValues(t);
		this.master.gain.setValueAtTime(this.master.gain.value, t);
		this.master.gain.linearRampToValueAtTime(0.85, t + 1.6);
		if (!this.running || this.running.id !== this.scene) this.start(this.scene);
	}

	disable() {
		this.enabled = false;
		const ctx = this.ctx;
		if (!ctx) return;
		const t = ctx.currentTime;
		this.master.gain.cancelScheduledValues(t);
		this.master.gain.setValueAtTime(this.master.gain.value, t);
		this.master.gain.linearRampToValueAtTime(0, t + 0.5);
		window.setTimeout(() => {
			if (!this.enabled) ctx.suspend();
		}, 700);
	}

	/** Pause audio processing while the page is hidden. */
	setPageVisible(visible: boolean) {
		if (!this.ctx || !this.enabled) return;
		if (visible) this.ctx.resume();
		else this.ctx.suspend();
	}

	setScene(id: SoundId) {
		this.scene = id;
		if (!this.ctx || !this.enabled) return;
		if (this.running?.id === id) return;
		this.start(id);
	}

	setListener(yaw: number, pitch: number) {
		const ctx = this.ctx;
		if (!ctx || !this.enabled) return;
		const l = ctx.listener;
		const fx = Math.sin(yaw) * Math.cos(pitch);
		const fy = Math.sin(pitch);
		const fz = -Math.cos(yaw) * Math.cos(pitch);
		const ux = -Math.sin(yaw) * Math.sin(pitch);
		const uy = Math.cos(pitch);
		const uz = Math.cos(yaw) * Math.sin(pitch);
		if (l.forwardX) {
			const t = ctx.currentTime;
			l.forwardX.setTargetAtTime(fx, t, 0.03);
			l.forwardY.setTargetAtTime(fy, t, 0.03);
			l.forwardZ.setTargetAtTime(fz, t, 0.03);
			l.upX.setTargetAtTime(ux, t, 0.03);
			l.upY.setTargetAtTime(uy, t, 0.03);
			l.upZ.setTargetAtTime(uz, t, 0.03);
		} else {
			l.setOrientation(fx, fy, fz, ux, uy, uz);
		}
	}

	/** A single drop falling into water at a world position (hub). */
	drip(x: number, y: number, z: number, loudness = 1) {
		if (!this.ctx || !this.enabled || this.running?.id !== "hub") return;
		this.plip(this.running.bus, x, y, z, rand(1100, 1700), 0.3 * loudness, 0.65);
	}

	// ─── Setup ─────────────────────────────────────────────────────────────

	private create() {
		const ctx = new AudioContext({ latencyHint: "playback" });
		this.ctx = ctx;
		const comp = ctx.createDynamicsCompressor();
		comp.threshold.value = -16;
		comp.knee.value = 12;
		comp.ratio.value = 3;
		comp.attack.value = 0.01;
		comp.release.value = 0.4;
		this.master = ctx.createGain();
		this.master.gain.value = 0;
		this.master.connect(comp).connect(ctx.destination);
		this.dry = ctx.createGain();
		this.dry.connect(this.master);
		this.reverb = ctx.createConvolver();
		this.wet = ctx.createGain();
		this.wet.gain.value = 0.35;
		this.reverb.connect(this.wet).connect(this.master);
		this.buffers = {
			white: this.noise("white"),
			pink: this.noise("pink"),
			brown: this.noise("brown"),
		};
		this.reverb.buffer = this.impulse(3.2, 2.6);
		ctx.listener.positionX?.setValueAtTime(0, 0);
	}

	private noise(kind: "white" | "pink" | "brown") {
		const ctx = this.ctx!;
		const length = ctx.sampleRate * 6;
		const buf = ctx.createBuffer(2, length, ctx.sampleRate);
		for (let ch = 0; ch < 2; ch++) {
			const d = buf.getChannelData(ch);
			let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
			for (let i = 0; i < length; i++) {
				const w = Math.random() * 2 - 1;
				if (kind === "white") d[i] = w * 0.5;
				else if (kind === "pink") {
					// Paul Kellet's refined pink filter
					b0 = 0.99886 * b0 + w * 0.0555179;
					b1 = 0.99332 * b1 + w * 0.0750759;
					b2 = 0.969 * b2 + w * 0.153852;
					b3 = 0.8665 * b3 + w * 0.3104856;
					b4 = 0.55 * b4 + w * 0.5329522;
					b5 = -0.7616 * b5 - w * 0.016898;
					d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
					b6 = w * 0.115926;
				} else {
					last = (last + 0.02 * w) / 1.02;
					d[i] = last * 3.5;
				}
			}
			// crossfade the loop point so the buffer repeats without a click
			const fade = Math.floor(ctx.sampleRate * 0.05);
			for (let i = 0; i < fade; i++) {
				const t = i / fade;
				d[i] = d[i] * t + d[length - fade + i] * (1 - t);
			}
		}
		return buf;
	}

	/** Synthetic room impulse response: decaying stereo noise. */
	private impulse(seconds: number, decay: number) {
		const ctx = this.ctx!;
		const length = Math.floor(ctx.sampleRate * seconds);
		const buf = ctx.createBuffer(2, length, ctx.sampleRate);
		for (let ch = 0; ch < 2; ch++) {
			const d = buf.getChannelData(ch);
			for (let i = 0; i < length; i++) {
				const t = i / length;
				d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (i < ctx.sampleRate * 0.012 ? i / (ctx.sampleRate * 0.012) : 1);
			}
		}
		return buf;
	}

	// ─── Building blocks ───────────────────────────────────────────────────

	private source(kind: "white" | "pink" | "brown") {
		const s = this.ctx!.createBufferSource();
		s.buffer = this.buffers[kind];
		s.loop = true;
		s.start(this.ctx!.currentTime, rand(0, 5));
		return s;
	}

	private panner(x: number, y: number, z: number, ref = 2) {
		const p = this.ctx!.createPanner();
		p.panningModel = "HRTF";
		p.distanceModel = "inverse";
		p.refDistance = ref;
		p.rolloffFactor = 0.8;
		p.maxDistance = 200;
		p.positionX.value = x;
		p.positionY.value = y;
		p.positionZ.value = -z;
		return p;
	}

	private filter(type: BiquadFilterType, freq: number, q = 0.7) {
		const f = this.ctx!.createBiquadFilter();
		f.type = type;
		f.frequency.value = freq;
		f.Q.value = q;
		return f;
	}

	private gain(value: number) {
		const g = this.ctx!.createGain();
		g.gain.value = value;
		return g;
	}

	/** Slow random modulation: an LFO whose rate wanders. */
	private lfo(target: AudioParam, centre: number, depth: number, rate: number) {
		const ctx = this.ctx!;
		const o = ctx.createOscillator();
		o.frequency.value = rate;
		const g = ctx.createGain();
		g.gain.value = depth;
		target.value = centre;
		o.connect(g).connect(target);
		o.start();
		return o;
	}

	/** A continuous noise bed: source → filters → gain → (panner) → bus. */
	private bed(
		bus: AudioNode,
		kind: "white" | "pink" | "brown",
		filters: BiquadFilterNode[],
		level: number,
		pos?: [number, number, number],
	) {
		const src = this.source(kind);
		let node: AudioNode = src;
		for (const f of filters) node = node.connect(f);
		const g = this.gain(level);
		node = node.connect(g);
		if (pos) node.connect(this.panner(...pos)).connect(bus);
		else node.connect(bus);
		return { src, gain: g };
	}

	/** Water drop: a sine "bloop" rising in pitch plus a tiny click. */
	private plip(bus: AudioNode, x: number, y: number, z: number, freq: number, level: number, reverbSend: number) {
		const ctx = this.ctx!;
		const t = ctx.currentTime + 0.01;
		const pan = this.panner(x, y, z, 1.5);
		const out = this.gain(1);
		out.connect(pan).connect(bus);
		const send = this.gain(reverbSend);
		pan.connect(send).connect(this.reverb);

		const o = ctx.createOscillator();
		o.type = "sine";
		o.frequency.setValueAtTime(freq, t);
		o.frequency.exponentialRampToValueAtTime(freq * 1.9, t + 0.07);
		const env = ctx.createGain();
		env.gain.setValueAtTime(0, t);
		env.gain.linearRampToValueAtTime(level, t + 0.004);
		env.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
		o.connect(env).connect(out);
		o.start(t);
		o.stop(t + 0.2);

		const n = ctx.createBufferSource();
		n.buffer = this.buffers.white;
		const bp = this.filter("bandpass", rand(2500, 4200), 1.2);
		const ne = ctx.createGain();
		ne.gain.setValueAtTime(level * 0.5, t);
		ne.gain.exponentialRampToValueAtTime(0.0001, t + 0.015);
		n.connect(bp).connect(ne).connect(out);
		n.start(t, rand(0, 5));
		n.stop(t + 0.03);
	}

	/** Short filtered noise burst (raindrop patter, fire pops). */
	private tick(bus: AudioNode, when: number, pos: [number, number, number], freq: number, q: number, level: number, length: number) {
		const ctx = this.ctx!;
		const n = ctx.createBufferSource();
		n.buffer = this.buffers.white;
		const bp = this.filter("bandpass", freq, q);
		const env = ctx.createGain();
		env.gain.setValueAtTime(0, when);
		env.gain.linearRampToValueAtTime(level, when + 0.001);
		env.gain.exponentialRampToValueAtTime(0.0001, when + length);
		n.connect(bp).connect(env).connect(this.panner(...pos, 1.5)).connect(bus);
		n.start(when, rand(0, 5));
		n.stop(when + length + 0.02);
	}

	/** A long swelling noise event (breaking wave, thunder). */
	private swell(
		bus: AudioNode,
		pos: [number, number, number],
		kind: "pink" | "brown",
		fromHz: number,
		toHz: number,
		level: number,
		attack: number,
		release: number,
	) {
		const ctx = this.ctx!;
		const t = ctx.currentTime + 0.05;
		const n = ctx.createBufferSource();
		n.buffer = this.buffers[kind];
		const lp = this.filter("lowpass", fromHz, 0.5);
		lp.frequency.setValueAtTime(fromHz, t);
		lp.frequency.exponentialRampToValueAtTime(toHz, t + attack + release);
		const env = ctx.createGain();
		env.gain.setValueAtTime(0.0001, t);
		env.gain.exponentialRampToValueAtTime(level, t + attack);
		env.gain.exponentialRampToValueAtTime(0.0001, t + attack + release);
		n.connect(lp).connect(env).connect(this.panner(...pos, 6)).connect(bus);
		n.start(t, rand(0, 4));
		n.stop(t + attack + release + 0.1);
	}

	private polar(yawDeg: number, dist: number, y = 0): [number, number, number] {
		const a = (yawDeg * Math.PI) / 180;
		return [Math.sin(a) * dist, y, Math.cos(a) * dist];
	}

	// ─── Scenes ────────────────────────────────────────────────────────────

	private start(id: SoundId) {
		const ctx = this.ctx!;
		const t = ctx.currentTime;
		if (this.running) {
			const old = this.running;
			old.bus.gain.cancelScheduledValues(t);
			old.bus.gain.setValueAtTime(old.bus.gain.value, t);
			old.bus.gain.linearRampToValueAtTime(0, t + 2.2);
			window.setTimeout(() => old.stop(), 2400);
		}
		const bus = this.gain(0);
		bus.connect(this.dry);
		bus.gain.linearRampToValueAtTime(1, t + 2.5);
		const sends = this.gain(0);
		bus.connect(sends).connect(this.reverb);

		const sources: AudioScheduledSourceNode[] = [];
		const timers: number[] = [];
		const every = (fn: () => void, min: number, max: number) => {
			const loop = () => {
				fn();
				timers.push(window.setTimeout(loop, rand(min, max) * 1000));
			};
			timers.push(window.setTimeout(loop, rand(min, max) * 1000));
		};

		if (id === "hub") {
			sends.gain.value = 0.25;
			// low room tone
			sources.push(this.bed(bus, "brown", [this.filter("lowpass", 160)], 0.07).src);
		}

		if (id === "ocean") {
			sends.gain.value = 0.08;
			for (const [yaw, rate] of [[0, 0.071], [130, 0.053], [-120, 0.089]] as const) {
				const lp = this.filter("lowpass", 600, 0.4);
				const b = this.bed(bus, "brown", [lp], 0.35, this.polar(yaw, 8, -1));
				sources.push(b.src, this.lfo(lp.frequency, 650, 380, rate), this.lfo(b.gain.gain, 0.32, 0.18, rate));
			}
			const hiss = this.filter("highpass", 1400, 0.5);
			const h = this.bed(bus, "pink", [hiss, this.filter("lowpass", 6000)], 0.06);
			sources.push(h.src, this.lfo(h.gain.gain, 0.05, 0.035, 0.071));
			const wind = this.filter("bandpass", 650, 0.6);
			const w = this.bed(bus, "white", [wind], 0.045);
			sources.push(w.src, this.lfo(wind.frequency, 650, 260, 0.037), this.lfo(w.gain.gain, 0.045, 0.025, 0.023));
			every(() => this.swell(bus, this.polar(rand(-35, 35), 12, 2), "pink", 2600, 380, 0.5, 0.6, 3.4), 7, 13);
		}

		if (id === "shower") {
			sends.gain.value = 0.12;
			sources.push(this.bed(bus, "white", [this.filter("highpass", 900), this.filter("peaking", 4800, 0.6)], 0.11).src);
			sources.push(this.bed(bus, "pink", [this.filter("lowpass", 900)], 0.12).src);
			const river = this.filter("lowpass", 380, 0.6);
			const r = this.bed(bus, "brown", [river], 0.16, [0, -6, 4]);
			sources.push(r.src, this.lfo(r.gain.gain, 0.16, 0.04, 0.11));
			// patter of drops on the bridge, hats and the river
			const patter = window.setInterval(() => {
				const now = ctx.currentTime;
				for (let i = 0; i < 9; i++) {
					const near = Math.random() < 0.55;
					const pos = this.polar(rand(0, 360), near ? rand(0.6, 2.5) : rand(4, 14), near ? rand(-1.6, 0.2) : -4);
					this.tick(bus, now + 0.1 + Math.random() * 0.25, pos, rand(2200, 6500), rand(0.8, 2.2), near ? rand(0.03, 0.09) : rand(0.015, 0.04), rand(0.004, 0.012));
				}
			}, 250);
			timers.push(patter);
			every(() => this.swell(bus, this.polar(rand(0, 360), 60, 20), "brown", 260, 60, 0.45, 1.6, 6), 22, 40);
		}

		if (id === "garden") {
			sends.gain.value = 0.1;
			for (const yaw of [-70, 80]) {
				const bp = this.filter("bandpass", 2600, 0.45);
				const leaves = this.bed(bus, "pink", [bp], 0.06, this.polar(yaw, 6, 3));
				sources.push(leaves.src, this.lfo(leaves.gain.gain, 0.05, 0.04, rand(0.05, 0.09)), this.lfo(bp.frequency, 2600, 900, 0.031));
			}
			const lap = this.filter("bandpass", 420, 0.9);
			const l = this.bed(bus, "brown", [lap], 0.08, [0, -1.4, 1.5]);
			sources.push(l.src, this.lfo(l.gain.gain, 0.07, 0.05, 0.6));
			every(() => {
				const [x, , z] = this.polar(rand(-80, 80), rand(2, 7));
				this.plip(bus, x, -1.4, z, rand(420, 700), 0.18, 0.15);
			}, 3.5, 9);
		}

		if (id === "harbour") {
			sends.gain.value = 0.18;
			for (const [yaw, rate] of [[-60, 0.7], [70, 0.55], [0, 0.42]] as const) {
				const bp = this.filter("bandpass", 320, 1.1);
				const lap = this.bed(bus, "brown", [bp], 0.1, this.polar(yaw, 4, -1));
				sources.push(lap.src, this.lfo(lap.gain.gain, 0.08, 0.06, rate));
			}
			const roarLp = this.filter("lowpass", 380, 0.5);
			const roar = this.bed(bus, "brown", [roarLp], 0.09, this.polar(62, 9, 0.5));
			sources.push(roar.src, this.lfo(roar.gain.gain, 0.09, 0.04, 1.7), this.lfo(roarLp.frequency, 380, 140, 0.9));
			const wind = this.filter("bandpass", 500, 0.5);
			const w = this.bed(bus, "pink", [wind], 0.03);
			sources.push(w.src, this.lfo(w.gain.gain, 0.03, 0.02, 0.029));
			const crackle = window.setInterval(() => {
				const now = ctx.currentTime;
				const n = Math.random() < 0.3 ? 4 : 2;
				for (let i = 0; i < n; i++) {
					this.tick(bus, now + Math.random() * 0.25, this.polar(rand(50, 75), rand(7, 11), rand(0, 1.5)), rand(1500, 5200), rand(1, 3), rand(0.03, 0.12), rand(0.003, 0.02));
				}
			}, 240);
			timers.push(crackle);
		}

		this.running = {
			id,
			bus,
			stop: () => {
				for (const tm of timers) {
					window.clearTimeout(tm);
					window.clearInterval(tm);
				}
				for (const s of sources) {
					try {
						s.stop();
					} catch {
						/* already stopped */
					}
				}
				bus.disconnect();
			},
		};
	}
}
