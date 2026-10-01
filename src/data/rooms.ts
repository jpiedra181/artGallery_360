/**
 * Exhibition content and per-room scene settings.
 *
 * Text is the single source for both the visible UI and the accessible,
 * non-visual version of each room (the `scene` description is the "alt
 * text" of the 360° world). Facts come from the lending museums' records.
 */

export type RoomSlug = "wave" | "rain" | "stillness" | "moonlight";

export interface Hotspot {
	id: string;
	/** Direction in degrees: yaw 0 = initial view, positive = right. */
	yaw: number;
	pitch: number;
	title: string;
	text: string;
}

/** Real-time layers the viewer adds on top of the rendered panorama. */
export interface SceneEffects {
	/** Ripples on the water plane (mask R). height = eye height above water in metres. */
	water?: { height: number; strength: number; scale: number; speed: number; drips?: number };
	/** Falling rain streaks; angle in degrees from vertical. */
	rain?: { density: number; angle: number; speed: number };
	/** Flicker of light sources (mask B). */
	flicker?: { strength: number };
	/** Slow shimmer of the sky (mask G). */
	sky?: { shimmer: number };
	/** Final colour treatment. */
	grade?: { vignette: number; grain: number };
	/** Rocking of a boat: amplitudes in degrees, period in seconds. */
	boat?: { pitch: number; roll: number; period: number };
}

export interface Room {
	slug: RoomSlug;
	numeral: "I" | "II" | "III" | "IV";
	theme: string;
	title: string;
	/** Full catalogue title, as given by the museum. */
	catalogueTitle: string;
	artist: string;
	artistDates: string;
	date: string;
	medium: string;
	dimensions: string;
	museum: string;
	credit: string;
	accession: string;
	museumUrl: string;
	/** One sentence used on cards and as the meta description. */
	summary: string;
	/** A few short paragraphs about the painting. */
	essay: string[];
	/** Description of the 360° world for people who cannot see it. */
	scene: string;
	/** UI accent colour, tuned for contrast on the dark interface. */
	accent: string;
	view: { yaw: number; pitch: number };
	hotspots: Hotspot[];
	effects: SceneEffects;
	audio: "ocean" | "shower" | "garden" | "harbour";
}

export const site = {
	name: "Inside the Frame",
	volume: "Vol. I — Water",
	tagline: "Four paintings about water, rebuilt as places you can stand in.",
	description:
		"An interactive exhibition: step inside four public-domain masterpieces about water — Hokusai, Hiroshige, Monet and Turner — rebuilt as 360° worlds.",
	author: "Javier Piedra",
};

export const hub = {
	title: "The Flooded Gallery",
	scene:
		"A dark, square gallery whose floor lies under a sheet of still, black water. You stand on a small timber platform in the middle of the room. On each of the four walls hangs one painting under a warm spotlight, and each one is mirrored in the water below. Ahead is Hokusai's Great Wave; to the right, Hiroshige's rain-swept bridge; behind you, Monet's lily pond; to the left, Turner's moonlit harbour. Now and then a drop falls from the ceiling and rings spread across the water.",
	effects: {
		water: { height: 1.66, strength: 0.4, scale: 1.0, speed: 0.6, drips: 4 },
		grade: { vignette: 0.35, grain: 0.035 },
	} satisfies SceneEffects,
};

export const rooms: Room[] = [
	{
		slug: "wave",
		numeral: "I",
		theme: "Wave",
		title: "Under the Wave off Kanagawa",
		catalogueTitle:
			"Under the Wave off Kanagawa (Kanagawa oki nami ura), also known as The Great Wave, from the series Thirty-six Views of Mount Fuji (Fugaku sanjūrokkei)",
		artist: "Katsushika Hokusai",
		artistDates: "1760–1849",
		date: "c. 1830–32",
		medium: "Woodblock print; ink and colour on paper",
		dimensions: "25.7 × 37.9 cm",
		museum: "The Metropolitan Museum of Art, New York",
		credit: "H. O. Havemeyer Collection, Bequest of Mrs. H. O. Havemeyer, 1929",
		accession: "JP1847",
		museumUrl: "https://www.metmuseum.org/art/collection/search/45434",
		summary:
			"A wall of Prussian blue rears over three fishing boats, and Mount Fuji — the subject of the whole series — is the smallest thing in the picture.",
		essay: [
			"Hokusai was about seventy when he designed this print for his series Thirty-six Views of Mount Fuji. Every sheet in the set includes the mountain, but here it is pushed into the distance and framed by the hollow of a breaking wave, so the eye travels from the claw-like foam down to the tiny snow-capped peak.",
			"The deep blue is Prussian blue, a synthetic pigment that had recently become affordable in Japan. It was brighter and far more stable than the plant-based blues printers had used before, and it gives the whole series its depth.",
			"Three long boats carry crews bent low over their oars. The scene is a moment before impact, and the print never tells you whether they make it through.",
		],
		scene:
			"You sit in the bow of a long, narrow fishing boat, low in a trough between the swells, with the crew rowing behind you. On your left an enormous wave rises and curls overhead; its lip breaks into claw-like fingers of white foam that reach towards another boat caught in its hollow. Ahead, far away and framed beneath the curl, stands the small snow-capped cone of Mount Fuji. The sea is drawn in bands of deep and pale blue crossed by fine lines, and the sky is the colour of old paper, with soft clouds.",
		accent: "#8fb8de",
		view: { yaw: -18, pitch: 14 },
		hotspots: [
			{
				id: "claws",
				yaw: -38,
				pitch: 30,
				title: "Fingers of foam",
				text: "The crest breaks into claw-like fingers of spray. Hokusai had been drawing breaking waves for decades before he made this print.",
			},
			{
				id: "fuji",
				yaw: 9,
				pitch: 4,
				title: "Mount Fuji",
				text: "The subject of the whole series is the smallest thing in the picture. Its snowy peak echoes the shape of the small wave in front of it.",
			},
			{
				id: "boat",
				yaw: -33,
				pitch: -2,
				title: "The boats",
				text: "Long, fast boats like these carried fresh fish to the markets of Edo. Their crews crouch low over the oars as the wave breaks above them.",
			},
		],
		effects: {
			water: { height: 1.0, strength: 0.12, scale: 0.35, speed: 0.6 },
			grade: { vignette: 0.28, grain: 0.035 },
			boat: { pitch: 1.4, roll: 2.4, period: 7.5 },
		},
		audio: "ocean",
	},
	{
		slug: "rain",
		numeral: "II",
		theme: "Rain",
		title: "Sudden Shower over Shin-Ōhashi Bridge and Atake",
		catalogueTitle:
			"Sudden Shower over Shin-Ōhashi Bridge and Atake (Ōhashi Atake no yūdachi), from the series One Hundred Famous Views of Edo (Meisho Edo hyakkei)",
		artist: "Utagawa Hiroshige",
		artistDates: "1797–1858",
		date: "1857",
		medium: "Woodblock print; ink and colour on paper",
		dimensions: "34 × 24.1 cm",
		museum: "The Metropolitan Museum of Art, New York",
		credit: "Purchase, Joseph Pulitzer Bequest, 1918",
		accession: "JP643",
		museumUrl: "https://www.metmuseum.org/art/collection/search/36461",
		summary:
			"A summer downpour catches people crossing a long wooden bridge over the Sumida River, drawn as fine dark lines that fall in two directions.",
		essay: [
			"Hiroshige made this print near the end of his life for One Hundred Famous Views of Edo, his portrait of the city that is now Tokyo. The Shin-Ōhashi, or New Great Bridge, crossed the Sumida River; Atake, on the far bank, took its name from a huge government ship once moored there.",
			"The rain is cut into the woodblocks as hundreds of fine lines that fall at two slightly different angles, so the shower seems to shift as you look at it. A dark band of cloud was printed with a graded wipe of ink, a technique called bokashi.",
			"Vincent van Gogh owned Japanese prints and painted his own copy of this one in 1887, adding a border of Japanese characters around it.",
		],
		scene:
			"You stand by the railing of a long wooden bridge in a sudden summer downpour. Fine dark lines of rain slant across everything. The pale planks run on ahead of you, and people hurry across under straw hats, straw mats and umbrellas. Below, the wide grey-green river is pocked by raindrops, and a raftsman poles a log raft downstream. Across the water, a dark line of trees and roofs fades into the mist beneath a heavy band of black cloud.",
		accent: "#9fc3c0",
		view: { yaw: 0, pitch: -8 },
		hotspots: [
			{
				id: "shower",
				yaw: 25,
				pitch: 28,
				title: "Two kinds of rain",
				text: "In the print the rain is cut into the woodblocks as fine lines at two slightly different angles. Here it falls live, in the same two directions.",
			},
			{
				id: "raft",
				yaw: 43,
				pitch: -9,
				title: "The raftsman",
				text: "A lone figure poles a raft of logs downstream, ignoring the downpour that sends everyone on the bridge running.",
			},
			{
				id: "atake",
				yaw: 14,
				pitch: 2.5,
				title: "Atake",
				text: "The far bank took its name from the Atake-maru, a huge government warship once moored there. In the rain it is reduced to a dark band of trees.",
			},
		],
		effects: {
			water: { height: 10.0, strength: 0.18, scale: 1.0, speed: 0.6 },
			rain: { density: 0.9, angle: 12, speed: 1.0 },
			grade: { vignette: 0.3, grain: 0.04 },
		},
		audio: "shower",
	},
	{
		slug: "stillness",
		numeral: "III",
		theme: "Stillness",
		title: "Water Lily Pond",
		catalogueTitle: "Water Lily Pond",
		artist: "Claude Monet",
		artistDates: "1840–1926",
		date: "1900",
		medium: "Oil on canvas",
		dimensions: "89.8 × 101 cm",
		museum: "The Art Institute of Chicago",
		credit: "Mr. and Mrs. Lewis Larned Coburn Memorial Collection",
		accession: "1933.441",
		museumUrl: "https://www.artic.edu/artworks/87088/water-lily-pond",
		summary:
			"Monet's own garden at Giverny: a Japanese footbridge over a pond so crowded with lilies that the water almost disappears.",
		essay: [
			"Monet built this garden himself. After settling at Giverny, west of Paris, he bought a strip of marshy land across the road, diverted a stream to feed a pond, planted it with water lilies and crossed it with a wooden footbridge in the Japanese style.",
			"He painted the bridge many times around 1899 and 1900. In this version the pond fills almost the whole canvas: lily pads, flowers, reflections and weeping willows are built from short, thick strokes of green, rose and violet, so that surface and reflection are hard to tell apart.",
			"For the rest of his life the pond was his main subject. The later water lily paintings drop the bridge and the bank entirely and show nothing but water.",
		],
		scene:
			"You stand on a small wooden landing at the edge of a pond. Ahead, a green footbridge arches across the water, and its reflection hangs upside down beneath it. Lily pads crowd the surface, dotted with pink and white flowers. Weeping willows let their long curtains of leaves fall almost to the water, irises and tall grasses line the banks, and behind you a lawn opens between trees and flowering shrubs. Everything is softened into short strokes of paint.",
		accent: "#b6cf9a",
		view: { yaw: 0, pitch: -6 },
		hotspots: [
			{
				id: "bridge",
				yaw: 0,
				pitch: 4,
				title: "The Japanese bridge",
				text: "Monet had this footbridge built over his pond in the 1890s, inspired by the Japanese prints he collected. Painted green, it became one of his favourite subjects.",
			},
			{
				id: "lilies",
				yaw: 18,
				pitch: -28,
				title: "Water lilies",
				text: "Monet planted hardy water lilies in several colours. Over the last decades of his life he painted them again and again, until the pond filled entire walls.",
			},
			{
				id: "willows",
				yaw: -62,
				pitch: 14,
				title: "Weeping willows",
				text: "Willows at the water's edge frame the pond and double in its reflections, so it becomes hard to tell where the bank ends and the water begins.",
			},
		],
		effects: {
			water: { height: 1.74, strength: 0.3, scale: 0.9, speed: 0.35 },
			grade: { vignette: 0.28, grain: 0.03 },
		},
		audio: "garden",
	},
	{
		slug: "moonlight",
		numeral: "IV",
		theme: "Moonlight",
		title: "Keelmen Heaving in Coals by Moonlight",
		catalogueTitle: "Keelmen Heaving in Coals by Moonlight",
		artist: "Joseph Mallord William Turner",
		artistDates: "1775–1851",
		date: "1835",
		medium: "Oil on canvas",
		dimensions: "92.3 × 122.8 cm",
		museum: "National Gallery of Art, Washington",
		credit: "Widener Collection",
		accession: "1942.9.86",
		museumUrl: "https://www.nga.gov/collection/art-object-page.32483.html",
		summary:
			"Night work on the River Tyne: torch-lit figures shovel coal into tall ships while the moon opens a tunnel of light through the clouds.",
		essay: [
			"Turner painted this scene of industrial England as a companion to a sunlit view of Venice he had shown a year earlier. Both belonged to the same Manchester collector, and the pair sets the idle splendour of an old maritime city against the round-the-clock labour of a new one.",
			"On the Tyne in northeast England, keelmen ferried coal downriver in flat-bottomed boats called keels and heaved it into seagoing colliers. Turner shows them at night, small dark figures against the red flare of their torches.",
			"Most of the canvas is given to light itself. The moon sits in a funnel of luminous cloud, and its glow spills down into a pale path across the water, painted in thick, blended strokes.",
		],
		scene:
			"You sit in a small rowing boat on a broad, calm river at night. Ahead, the full moon shines through a funnel of luminous cloud and lays a pale path across the water. Tall sailing ships stand in dark silhouette on your left. To your right, colliers lie at anchor with low barges alongside, where braziers burn orange, smoke rises into the haze and the firelight trembles on the water. A buoy floats nearby, and distant lights line the shore.",
		accent: "#e2c48e",
		view: { yaw: -4, pitch: 5 },
		hotspots: [
			{
				id: "moon",
				yaw: -24,
				pitch: 27,
				title: "A tunnel of light",
				text: "Turner makes the moon the centre of a vortex of luminous cloud. Light itself, rather than the ships or the workers, is the real subject of the picture.",
			},
			{
				id: "keelmen",
				yaw: 44,
				pitch: 3,
				title: "Keelmen at work",
				text: "By the light of braziers, keelmen shovel coal from their flat-bottomed keels up into the holds of seagoing colliers, working through the night.",
			},
			{
				id: "ships",
				yaw: -46,
				pitch: 9,
				title: "Ships at anchor",
				text: "Tall sailing ships wait for their cargo. Coal from the Tyne was shipped down the coast to London and far beyond.",
			},
		],
		effects: {
			water: { height: 1.05, strength: 0.2, scale: 0.7, speed: 0.4 },
			sky: { shimmer: 0.12 },
			flicker: { strength: 0.35 },
			grade: { vignette: 0.38, grain: 0.04 },
			boat: { pitch: 0.5, roll: 0.9, period: 9 },
		},
		audio: "harbour",
	},
];

export const roomBySlug = Object.fromEntries(rooms.map((r) => [r.slug, r])) as Record<RoomSlug, Room>;

export const credits = {
	textures: [
		{ name: "Plastered Wall 04", author: "Rob Tuytel", url: "https://polyhaven.com/a/plastered_wall_04" },
		{ name: "Square Floor", author: "Rob Tuytel", url: "https://polyhaven.com/a/square_floor" },
		{ name: "Oak Wood Planks", author: "Dimitrios Savva", url: "https://polyhaven.com/a/oak_wood_planks" },
	],
};
