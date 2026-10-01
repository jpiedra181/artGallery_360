/**
 * Panorama loading: choose a resolution tier and format for this device,
 * stream the download with progress, decode off the main thread.
 */

export type Tier = "2k" | "4k" | "8k";

export interface SceneAssets {
	tiers: Partial<Record<Tier, { avif?: string; webp?: string; bytes?: number }>>;
	mask?: string;
}

let avifSupport: Promise<boolean> | null = null;

/** Decode a 1×1 AVIF to find out whether this browser can use the format. */
export function supportsAvif(): Promise<boolean> {
	avifSupport ??= (async () => {
		try {
			// 1×1 AVIF produced by sharp
			const data =
				"AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAAA5waXRtAAAAAAABAAAAImlsb2MAAAAAREAAAQABAAAAAAD6AAEAAAAAAAAAFwAAACNpaW5mAAAAAAABAAAAFWluZmUCAAAAAAEAAGF2MDEAAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgSACAAAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwgICAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAAfbWRhdBIACgc4AAYQENBpMgoYAAAAQAX172To";
			const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
			const bmp = await createImageBitmap(new Blob([bytes], { type: "image/avif" }));
			const ok = bmp.width === 1;
			bmp.close();
			return ok;
		} catch {
			return false;
		}
	})();
	return avifSupport;
}

interface NetworkInformation {
	saveData?: boolean;
	effectiveType?: string;
}

/** Pick the panorama resolution for this screen, GPU and connection. */
export function chooseTier(maxTextureSize: number): Tier {
	const nav = navigator as Navigator & { connection?: NetworkInformation; deviceMemory?: number };
	const conn = nav.connection;
	const slow = conn?.saveData || /(^|-)2g$|^3g$/.test(conn?.effectiveType ?? "");
	const memory = nav.deviceMemory ?? 8;
	if (slow || memory <= 2 || maxTextureSize < 4096) return "2k";
	// Pixels needed across a 100° view: the 4k panorama gives ~1140 px per 100°.
	const px = Math.max(screen.width, screen.height) * Math.min(window.devicePixelRatio || 1, 2);
	const coarse = matchMedia("(pointer: coarse)").matches;
	if (!coarse && px >= 2400 && maxTextureSize >= 8192 && memory >= 8) return "8k";
	return "4k";
}

export function resolveUrl(scene: SceneAssets, tier: Tier, avif: boolean): string {
	const order: Tier[] = tier === "8k" ? ["8k", "4k", "2k"] : tier === "4k" ? ["4k", "2k", "8k"] : ["2k", "4k"];
	for (const t of order) {
		const v = scene.tiers[t];
		if (!v) continue;
		const url = (avif && v.avif) || v.webp || v.avif;
		if (url) return url;
	}
	throw new Error("no panorama variant available");
}

const inflight = new Map<string, Promise<Blob>>();

/** Download with progress. Repeated calls share one request. */
export function fetchBlob(url: string, onProgress?: (fraction: number) => void, priority: RequestPriority = "high"): Promise<Blob> {
	const existing = inflight.get(url);
	if (existing) return existing;
	const p = (async () => {
		const res = await fetch(url, { priority } as RequestInit);
		if (!res.ok) throw new Error(`${res.status} ${url}`);
		const total = Number(res.headers.get("content-length")) || 0;
		if (!res.body || !total || !onProgress) {
			const blob = await res.blob();
			onProgress?.(1);
			return blob;
		}
		const reader = res.body.getReader();
		const chunks: BlobPart[] = [];
		let received = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			received += value.byteLength;
			onProgress(Math.min(received / total, 1));
		}
		return new Blob(chunks, { type: res.headers.get("content-type") ?? "" });
	})();
	inflight.set(url, p);
	p.catch(() => inflight.delete(url));
	return p;
}

/** Warm the HTTP cache without decoding (used for likely next scenes). */
export function prefetch(url: string) {
	fetchBlob(url, undefined, "low").catch(() => {});
}

export async function decode(blob: Blob): Promise<ImageBitmap> {
	return createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none", imageOrientation: "from-image" });
}
