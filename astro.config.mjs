// @ts-check
import { defineConfig, fontProviders } from "astro/config";

// Canonical and Open Graph URLs must be absolute: without a site, shared links
// get no preview image. Set SITE_URL to build for another address,
// e.g. SITE_URL=https://inside-the-frame.example.com npm run build
const site = process.env.SITE_URL || "https://artgallery360.art";

// https://astro.build/config
export default defineConfig({
	site,
	trailingSlash: "ignore",
	build: {
		inlineStylesheets: "auto",
	},
	prefetch: false,
	devToolbar: { enabled: false },
	fonts: [
		// The voice of the exhibition (its name, the prologue, the titles of the rooms): the types
		// Joaquín Ibarra printed with in Madrid around 1780, in the lifetime of all four painters.
		{
			provider: fontProviders.fontsource(),
			name: "Ibarra Real Nova",
			cssVariable: "--font-display",
			weights: ["400 700"],
			styles: ["normal"],
			subsets: ["latin", "latin-ext"],
			fallbacks: ["Georgia", "serif"],
		},
		// Everything a museum would print on a label: captions, facts, controls. Titles of works in italic.
		{
			provider: fontProviders.fontsource(),
			name: "Libre Franklin",
			cssVariable: "--font-text",
			weights: ["400 700"],
			styles: ["normal", "italic"],
			subsets: ["latin", "latin-ext"],
			fallbacks: ["Arial", "sans-serif"],
		},
	],
	vite: {
		build: {
			// The viewer is a single small module; keep it as one request.
			assetsInlineLimit: 2048,
		},
	},
});
