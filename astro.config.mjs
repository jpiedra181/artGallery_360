// @ts-check
import { defineConfig, fontProviders } from "astro/config";

// Set SITE_URL when deploying so canonical and Open Graph URLs are absolute,
// e.g. SITE_URL=https://inside-the-frame.example.com npm run build
const site = process.env.SITE_URL || undefined;

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
		{
			provider: fontProviders.fontsource(),
			name: "Instrument Serif",
			cssVariable: "--font-display",
			weights: [400],
			styles: ["normal", "italic"],
			subsets: ["latin", "latin-ext"],
			fallbacks: ["Georgia", "serif"],
		},
		{
			provider: fontProviders.fontsource(),
			name: "Instrument Sans",
			cssVariable: "--font-text",
			weights: ["400 600"],
			styles: ["normal"],
			subsets: ["latin", "latin-ext"],
			fallbacks: ["system-ui", "sans-serif"],
		},
	],
	vite: {
		build: {
			// The viewer is a single small module; keep it as one request.
			assetsInlineLimit: 2048,
		},
	},
});
