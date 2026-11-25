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
	/** After the bus: what an act of the room does to its level, apart from coming and going. */
	hush: GainNode;
	/** The fires of the harbour blazing up. */
	blaze?: GainNode;
	stop: () => void;
}

/** One setting of the volume has to do for every room: measured (integrated loudness, as heard), the rooms come within 1.5 dB of -24 LUFS and the gallery stands a little quieter. */
const LEVEL: Record<SoundId, number> = { hub: 2.6, ocean: 0.75, shower: 1.05, garden: 8, harbour: 3 };

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** On a phone a burst a few milliseconds long is placed well enough without a head-shaped filter, which costs a convolution each. */
const lightPanning = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export class Soundscape {
	private ctx: AudioContext | null = null;
	private master!: GainNode;
	private dry!: GainNode;
	private wet!: GainNode;
	private reverb!: ConvolverNode;
	private buffers!: { white: AudioBuffer; pink: AudioBuffer; brown: AudioBuffer };
	private made: Promise<void> = Promise.resolve();
	private running: Running | null = null;
	private scene: SoundId = "hub";
	enabled = false;

	/** Must be called from a user gesture the first time (autoplay policy). */
	async enable() {
		// an iPhone with its ring switch on silent mutes the page unless it says it plays like a player
		const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
		if (session) session.type = "playback";
		if (!this.ctx) this.create();
		const ctx = this.ctx!;
		// resumed inside the tap that asked for it, before anything is awaited
		const resumed = ctx.state !== "running" ? ctx.resume() : Promise.resolve();
		await this.made;
		await resumed;
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

	/** Nothing is scheduled while the context stands still: it would all sound at once when it runs again. */
	private get live() {
		return !!this.ctx && this.enabled && this.ctx.state === "running";
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
		if (!this.live || this.running?.id !== "hub") return;
		this.plip(this.running.bus, x, y, z, rand(1100, 1700), 0.3 * loudness, 0.65);
	}

	/**
	 * Passing through a canvas. Going in: the drop lands, then a rush of
	 * water opens out and falls away. Coming out: the rush gathers and
	 * closes, and a last drop marks the surface. Heard in the head, not in
	 * the scene: it belongs to neither room.
	 */
	passage(direction: "in" | "out", seconds: number) {
		const ctx = this.ctx;
		if (!ctx || !this.enabled) return;
		const t = ctx.currentTime + 0.02;
		const out = this.gain(1);
		out.connect(this.dry);
		const send = this.gain(0.5);
		out.connect(send).connect(this.reverb);
		const into = direction === "in";

		// the rush: band-passed noise sweeping open (in) or shut (out)
		const n = ctx.createBufferSource();
		n.buffer = this.buffers.pink;
		n.loop = true;
		const bp = this.filter("bandpass", 300, 0.7);
		const [f0, f1, f2] = into ? [260, 2200, 420] : [520, 1500, 180];
		const peak = into ? 0.28 : 0.72;
		bp.frequency.setValueAtTime(f0, t);
		bp.frequency.exponentialRampToValueAtTime(f1, t + seconds * peak);
		bp.frequency.exponentialRampToValueAtTime(f2, t + seconds);
		const env = ctx.createGain();
		env.gain.setValueAtTime(0.0001, t);
		env.gain.exponentialRampToValueAtTime(0.22, t + seconds * peak);
		env.gain.exponentialRampToValueAtTime(0.0001, t + seconds + 0.4);
		n.connect(bp).connect(env).connect(out);
		n.start(t, rand(0, 3.5));
		n.stop(t + seconds + 0.5);

		// the body of the water: a low note falling away (in) or rising (out)
		const o = ctx.createOscillator();
		o.type = "sine";
		const [n0, n1] = into ? [92, 44] : [46, 70];
		o.frequency.setValueAtTime(n0, t);
		o.frequency.exponentialRampToValueAtTime(n1, t + seconds * 0.8);
		const body = ctx.createGain();
		body.gain.setValueAtTime(0.0001, t);
		body.gain.exponentialRampToValueAtTime(0.2, t + (into ? 0.05 : seconds * 0.6));
		body.gain.exponentialRampToValueAtTime(0.0001, t + seconds * 0.95);
		o.connect(body).connect(out);
		o.start(t);
		o.stop(t + seconds);

		// the drop
		const when = into ? 0 : seconds * 0.82;
		window.setTimeout(() => {
			if (this.enabled) this.plip(out, 0, 0, 1.2, into ? 520 : 880, into ? 0.4 : 0.22, 0.6);
		}, when * 1000);
	}

	// ── the gallery keeps a note for every room that has been entered ──
	private chordWas = "";
	private chord: { gain: GainNode; stop: () => void }[] = [];
	/** D, A, E and F sharp: open while there are few, and a chord once all four sound. */
	private static readonly NOTES = [73.42, 110, 164.81, 184.99];

	/** Which of the four notes sound in the gallery (0..1 each). Heard in the head, very low. */
	setChord(levels: ArrayLike<number>) {
		const ctx = this.ctx;
		if (!ctx || !this.enabled) return;
		const here = this.running?.id === "hub";
		// called on every frame: only a change is worth an event
		const wanted = Array.from(levels, (v) => (here ? Math.round(v * 50) / 50 : 0));
		const key = wanted.join();
		if (key === this.chordWas && (here || !this.chord.length)) return;
		this.chordWas = key;
		if (here && wanted.some((v) => v > 0) && !this.chord.length) {
			this.chord = Soundscape.NOTES.map((f, i) => {
				const gain = this.gain(0);
				const tone = this.filter("lowpass", 900, 0.3);
				const parts = [1, 2, 3].map((h) => {
					const o = ctx.createOscillator();
					o.type = "sine";
					o.frequency.value = f * h * (1 + 0.0009 * (h - 2));
					const g = this.gain(0.5 / (h * h));
					o.connect(g).connect(tone);
					o.start();
					return o;
				});
				// each breathes at its own pace
				const breath = this.gain(0.8);
				const lfo = this.lfo(breath.gain, 0.78, 0.2, 0.047 + i * 0.013);
				tone.connect(breath).connect(gain);
				gain.connect(this.dry);
				const send = this.gain(0.8);
				gain.connect(send).connect(this.reverb);
				return {
					gain,
					stop: () => {
						for (const o of [...parts, lfo]) o.stop();
						gain.disconnect();
					},
				};
			});
		}
		this.chord.forEach((c, i) => c.gain.gain.setTargetAtTime(0.07 * (wanted[i] ?? 0), ctx.currentTime, here ? 1.6 : 0.5));
		if (!here) {
			for (const c of this.chord) window.setTimeout(c.stop, 3000);
			this.chord = [];
		}
	}

	/** A step of wooden geta on the boards of the bridge (bearing and height in radians, metres away). */
	step(yaw: number, pitch: number, dist: number) {
		const ctx = this.ctx;
		if (!ctx || !this.live || this.running?.id !== "shower") return;
		const d = Math.min(dist, 14);
		const pos: [number, number, number] = [Math.sin(yaw) * Math.cos(pitch) * d, Math.sin(pitch) * d, Math.cos(yaw) * Math.cos(pitch) * d];
		const t = ctx.currentTime + 0.01;
		const level = 0.5 / (1 + dist * 0.05);
		// two blocks of wood on planks: a knock with a little body under it
		this.tick(this.running.bus, t, pos, rand(900, 1300), 5, level, 0.045);
		this.tick(this.running.bus, t + 0.004, pos, rand(260, 340), 4, level * 0.9, 0.07);
	}

	/** A shovel biting into coal, and the coal landing (bearing in degrees). */
	shovel(yawDeg: number) {
		const ctx = this.ctx;
		if (!ctx || !this.live || this.running?.id !== "harbour") return;
		const t = ctx.currentTime + 0.02;
		const pos = this.polar(yawDeg, rand(8, 11), 0.5);
		for (let i = 0; i < 9; i++) this.tick(this.running.bus, t + i * 0.018 + rand(0, 0.012), pos, rand(1400, 3400), rand(0.8, 1.6), 0.09, rand(0.02, 0.05));
		const far = this.polar(yawDeg + 5, 12, 2);
		for (let i = 0; i < 7; i++) this.tick(this.running.bus, t + 1.0 + rand(0, 0.22), far, rand(220, 620), rand(1.5, 3), 0.17, rand(0.03, 0.08));
	}

	/** How still the pond lies (0..1): the leaves and the lapping sink away, and leave the room to itself. */
	setCalm(calm: number) {
		const ctx = this.ctx;
		if (!ctx || !this.enabled || this.running?.id !== "garden") return;
		this.running.hush.gain.setTargetAtTime(1 - 0.72 * calm, ctx.currentTime, 0.4);
	}

	/** How high the fires of the harbour blaze (-1..1). */
	setFire(level: number) {
		const ctx = this.ctx;
		if (!ctx || !this.enabled || this.running?.id !== "harbour") return;
		this.running.blaze?.gain.setTargetAtTime(0.16 * Math.max(0, level), ctx.currentTime, 0.3);
	}

	/** A ship's bell across the water: struck twice. */
	private bell(bus: AudioNode, pos: [number, number, number]) {
		const ctx = this.ctx!;
		const out = this.panner(...pos, 4);
		out.connect(bus);
		for (const [i, level] of [0.05, 0.035].entries()) {
			const t = ctx.currentTime + 0.05 + i * 0.62;
			// the partials of a small bronze bell, the high ones gone first
			for (const [ratio, part, ring] of [[1, 1, 3.4], [2.01, 0.6, 2.2], [2.42, 0.5, 1.7], [3.01, 0.32, 1.1], [4.2, 0.2, 0.6]] as const) {
				const o = ctx.createOscillator();
				o.frequency.value = 622 * ratio;
				const env = ctx.createGain();
				env.gain.setValueAtTime(0, t);
				env.gain.linearRampToValueAtTime(level * part, t + 0.003);
				env.gain.exponentialRampToValueAtTime(0.00005, t + ring);
				o.connect(env).connect(out);
				o.start(t);
				o.stop(t + ring + 0.05);
			}
		}
	}

	/** The lip of a wave drawing itself up: a low roar that grows (bearing in degrees). */
	gather(yawDeg: number, seconds: number) {
		if (!this.ctx || !this.enabled || this.running?.id !== "ocean") return;
		this.swell(this.running.bus, this.polar(yawDeg, 9, 6), "brown", 180, 900, 1.1, seconds, 1.6);
	}

	/** The wave breaking: the weight of it, then the water running out to both sides. */
	breaker(yawDeg: number) {
		const ctx = this.ctx;
		if (!ctx || !this.enabled || this.running?.id !== "ocean") return;
		const { bus } = this.running;
		const t = ctx.currentTime + 0.02;
		const o = ctx.createOscillator();
		o.type = "sine";
		o.frequency.setValueAtTime(78, t);
		o.frequency.exponentialRampToValueAtTime(30, t + 1.4);
		const env = ctx.createGain();
		env.gain.setValueAtTime(0.0001, t);
		env.gain.exponentialRampToValueAtTime(0.5, t + 0.07);
		env.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
		o.connect(env).connect(this.panner(...this.polar(yawDeg, 8, 0), 6)).connect(bus);
		o.start(t);
		o.stop(t + 1.9);
		this.swell(bus, this.polar(yawDeg, 8, 1), "pink", 5200, 420, 1.5, 0.16, 5.5);
		this.swell(bus, this.polar(yawDeg - 45, 9, 0), "pink", 3400, 300, 0.8, 0.9, 6);
		this.swell(bus, this.polar(yawDeg + 40, 9, 0), "pink", 3800, 320, 0.8, 1.2, 6);
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
		// some 20 seconds of noise to compute: one piece between frames, so that the way in does not stall on it
		this.made = (async () => {
			const between = () => new Promise<void>((r) => ("requestIdleCallback" in window ? requestIdleCallback(() => r(), { timeout: 120 }) : setTimeout(r, 16)));
			const made: Partial<Record<"white" | "pink" | "brown", AudioBuffer>> = {};
			for (const kind of ["white", "pink", "brown"] as const) {
				await between();
				made[kind] = this.noise(kind);
			}
			this.buffers = made as Soundscape["buffers"];
			await between();
			this.reverb.buffer = this.impulse(3.2, 2.6);
		})();
		ctx.listener.positionX?.setValueAtTime(0, 0);
		// a phone call or another app takes the sound away; the next touch brings it back
		const wake = () => {
			if (this.enabled && !document.hidden && ctx.state !== "running") ctx.resume().catch(() => {});
		};
		window.addEventListener("pointerdown", wake, { capture: true, passive: true });
		window.addEventListener("keydown", wake, { capture: true });
	}

	private noise(kind: "white" | "pink" | "brown") {
		const ctx = this.ctx!;
		const length = ctx.sampleRate * 4;
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
		s.start(this.ctx!.currentTime, rand(0, 3.5));
		return s;
	}

	private panner(x: number, y: number, z: number, ref = 2, brief = false) {
		const p = this.ctx!.createPanner();
		p.panningModel = brief && lightPanning ? "equalpower" : "HRTF";
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
		filters: AudioNode[],
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
		n.start(t, rand(0, 3.5));
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
		n.connect(bp).connect(env).connect(this.panner(...pos, 1.5, true)).connect(bus);
		n.start(when, rand(0, 3.5));
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
		n.start(t, rand(0, 3.5));
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
		const hush = this.gain(1);
		bus.connect(hush).connect(this.dry);
		bus.gain.linearRampToValueAtTime(LEVEL[id], t + 2.5);
		const sends = this.gain(0);
		hush.connect(sends).connect(this.reverb);
		let blaze: GainNode | undefined;

		const sources: AudioScheduledSourceNode[] = [];
		const timers: number[] = [];
		const every = (fn: () => void, min: number, max: number) => {
			const loop = () => {
				if (this.live) fn();
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
			// the sheet of rain: no higher than rain on wood and water goes, and it comes in gusts
			const sheet = this.filter("lowpass", 7000, 0.5);
			const s = this.bed(bus, "white", [this.filter("highpass", 900), sheet], 0.1);
			sources.push(s.src, this.lfo(s.gain.gain, 0.1, 0.035, 0.043), this.lfo(sheet.frequency, 6400, 1600, 0.067));
			const body = this.bed(bus, "pink", [this.filter("lowpass", 900)], 0.14);
			sources.push(body.src, this.lfo(body.gain.gain, 0.14, 0.04, 0.031));
			const river = this.filter("lowpass", 380, 0.6);
			const r = this.bed(bus, "brown", [river], 0.16, [0, -6, 4]);
			sources.push(r.src, this.lfo(r.gain.gain, 0.16, 0.04, 0.11));
			// patter of drops on the bridge, hats and the river
			const patter = window.setInterval(() => {
				if (!this.live) return;
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
				const leaves = this.bed(bus, "pink", [bp], 0.09, this.polar(yaw, 6, 3));
				sources.push(leaves.src, this.lfo(leaves.gain.gain, 0.08, 0.05, rand(0.05, 0.09)), this.lfo(bp.frequency, 2600, 900, 0.031));
			}
			// water against the bank, never twice alike: two slow swells that drift in and out of step
			const lap = this.filter("bandpass", 420, 0.9);
			const swing = this.gain(0.5);
			const l = this.bed(bus, "brown", [lap, swing], 0.06, [0, -1.4, 1.5]);
			sources.push(l.src, this.lfo(l.gain.gain, 0.05, 0.025, 0.23), this.lfo(swing.gain, 0.5, 0.3, 0.37), this.lfo(lap.frequency, 420, 90, 0.13));
			every(() => {
				const [x, , z] = this.polar(rand(-80, 80), rand(2, 7));
				this.plip(bus, x, -1.4, z, rand(420, 700), 0.07, 0.15);
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
			const roar = this.bed(bus, "brown", [roarLp], 0.09, this.polar(48, 9, 0.5));
			sources.push(roar.src, this.lfo(roar.gain.gain, 0.09, 0.04, 1.7), this.lfo(roarLp.frequency, 380, 140, 0.9));
			const up = this.bed(bus, "brown", [this.filter("lowpass", 620, 0.6)], 0, this.polar(42, 8, 1));
			blaze = up.gain;
			sources.push(up.src);
			every(() => this.bell(bus, this.polar(rand(-50, -25), 26, 3)), 24, 48);
			const wind = this.filter("bandpass", 500, 0.5);
			const w = this.bed(bus, "pink", [wind], 0.03);
			sources.push(w.src, this.lfo(w.gain.gain, 0.03, 0.02, 0.029));
			const crackle = window.setInterval(() => {
				if (!this.live) return;
				const now = ctx.currentTime;
				const n = Math.random() < 0.3 ? 4 : 2;
				for (let i = 0; i < n; i++) {
					this.tick(bus, now + Math.random() * 0.25, this.polar(rand(30, 72), rand(7, 11), rand(0, 1.5)), rand(1500, 5200), rand(1, 3), rand(0.03, 0.12), rand(0.003, 0.02));
				}
			}, 240);
			timers.push(crackle);
		}

		this.running = {
			id,
			bus,
			hush,
			blaze,
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
				hush.disconnect();
				sends.disconnect();
			},
		};
	}
}
