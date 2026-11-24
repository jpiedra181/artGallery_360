import type { APIRoute } from "astro";
import { rooms } from "../data/rooms";

/** Every page of the site, for search engines. */
export const GET: APIRoute = ({ site }) => {
	const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");
	const paths = ["", ...rooms.map((r) => `${r.slug}/`), "making-of/", "about/"];
	const urls = paths.map((p) => `\t<url><loc>${new URL(`${base}${p}`, site).href}</loc></url>`).join("\n");
	return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, {
		headers: { "Content-Type": "application/xml; charset=utf-8" },
	});
};
