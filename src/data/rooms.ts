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
	/** Soften the line behind the viewer where the panorama's edges meet (smooth skies only: it costs a little sharpness there). */
	seam?: boolean;
	/** Final colour treatment. */
	grade?: { vignette: number; grain: number };
	/** Rocking of a boat: amplitudes in degrees, period in seconds. */
	boat?: { pitch: number; roll: number; period: number };
	/**
	 * Parallax from the scene's depth map. amount scales how far the eye
	 * moves; curve below 1 lets distant things take part (1 is true to the
	 * geometry, where only what is close moves).
	 */
	depth?: { amount: number; curve: number };
}

/**
 * The camera move on arriving in a scene. It starts `yaw` and `pitch` degrees
 * off the opening view and `dolly` metres short of it, and settles over
 * `seconds`.
 */
export interface Entrance {
	yaw: number;
	pitch: number;
	dolly: number;
	seconds: number;
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
	/** The pigment that blooms through the canvas on the way into this room; its swatch is printed on the room's label. */
	pigment: string;
	view: { yaw: number; pitch: number; zoom?: number };
	entrance: Entrance;
	hotspots: Hotspot[];
	/** What the visitor can set going in the room, and the words for it. */
	act?: { run: string; stop: string; hint: string; caught: string };
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

/** Shown once, over the dark water, before the gallery comes into view. */
export const prologue = ["Four painters stopped the water.", "Step inside, and it moves again."];

/** Shown in the gallery once all four rooms have been visited. */
export const finale = {
	/** Read one at a time over the water; with each of the first four, in the order of the rooms, its pigment spreads. */
	lines: [
		"A wave about to fall.",
		"Rain in mid-air.",
		"A pond holding its breath.",
		"A river under the moon.",
		"Each was stopped once, by a painter.",
		"Each moved again while you were inside it.",
	],
	title: "You have stood in all four.",
};

export const hub = {
	title: "The Flooded Gallery",
	scene:
		"A dark, many-sided gallery whose floor lies under a sheet of still, black water. You stand on a small timber platform in the middle of the room. Four paintings hang side by side on the walls in front of you, each under a warm spotlight and each mirrored in the water below. From left to right: Hokusai's Great Wave, Hiroshige's rain-swept bridge, Monet's lily pond and Turner's moonlit harbour. Behind you a plank walk leads back to a tall doorway with pale daylight in it. Now and then a drop falls from the ceiling and rings spread across the water. Each room you visit leaves its pigment in the water under its painting.",
	effects: {
		water: { height: 1.66, strength: 0.4, scale: 1.0, speed: 0.6, drips: 4 },
		grade: { vignette: 0.35, grain: 0.035 },
		depth: { amount: 1, curve: 1 },
	} satisfies SceneEffects,
	/** All four paintings in view. */
	view: { yaw: 1, pitch: -4, zoom: 1.05 },
	/** First steps into the gallery: up from the reflection in the water to the painting. */
	entrance: { yaw: 0, pitch: -17, dolly: 0.7, seconds: 5 } satisfies Entrance,
	/** The same after the prologue, which is read looking down at the water. */
	opening: { yaw: 0, pitch: -40, dolly: 0.9, seconds: 6.5 } satisfies Entrance,
	/** The dark of the gallery, which closes in on a painting when you leave it. */
	pigment: "#07090c",
	/** Coming back out of a painting: a step away from it. */
	returning: { yaw: 0, pitch: 0, dolly: -0.45, seconds: 3.5 } satisfies Entrance,
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
			"You sit in the bow of a long, narrow fishing boat, low in a trough between the swells, with the crew rowing in pairs behind you, bent double over their oars. On your left an enormous wave rises, its back white, its hollow deep blue streaked with paler water; its lip breaks into claw-like fingers of foam that hang overhead, and another boat lies caught underneath it. In front of it a smaller wave lifts a white peak. Ahead, far away and framed beneath the curl, stands the small snow-capped cone of Mount Fuji, and a third boat climbs the swell that closes the view on your right. Nothing moves but the light on the water, until you let time run: then the lip comes down, the wave breaks in a mass of foam, sinks, and rises again to where Hokusai stopped it.",
		// Prussian blue
		pigment: "#1c3f73",
		view: { yaw: -18, pitch: 14 },
		// from the bow and Fuji, up to the wave about to break
		entrance: { yaw: 16, pitch: -15, dolly: 0.9, seconds: 5.5 },
		hotspots: [
			{
				id: "claws",
				yaw: -3,
				pitch: 31,
				title: "Fingers of foam",
				text: "The crest breaks into claw-like fingers of spray. Hokusai had been drawing breaking waves for decades before he made this print.",
			},
			{
				id: "fuji",
				yaw: 9,
				pitch: 11,
				title: "Mount Fuji",
				text: "The subject of the whole series is the smallest thing in the picture. Its snowy peak echoes the shape of the near wave on your left.",
			},
			{
				id: "boat",
				yaw: -42,
				pitch: 6,
				title: "The boats",
				text: "Long, fast boats like these carried fresh fish to the markets of Edo. Their crews crouch low over the oars as the wave breaks above them.",
			},
		],
		act: {
			run: "Let time run",
			stop: "Stop time",
			hint: "Press and hold: time runs. Let go: it stops.",
			caught: "Here. This is the instant Hokusai chose.",
		},
		effects: {
			water: { height: 1.0, strength: 0.12, scale: 0.35, speed: 0.6 },
			grade: { vignette: 0.28, grain: 0.035 },
			boat: { pitch: 1.4, roll: 2.4, period: 7.5 },
			depth: { amount: 0.45, curve: 0.6 },
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
			"You stand on the open platform of a fire watch, high over the near bank, in a sudden summer downpour. Fine dark lines of rain slant across everything, in two directions. Below you a long yellow bridge on a maze of grey piles crosses from the left up to the right, and people are caught on it in mid-stride: two women under dark umbrellas, a man holding down a round straw hat, two sharing one umbrella, one with a straw mat over his head. The river is turquoise, wiped to deep blue underneath the bridge; a raftsman poles a long raft across it. The far bank is a single dark silhouette with a few pale roofs, under a ragged band of black cloud. Behind you the roofs of the town run back in rows. Whoever you look at starts to run.",
		// the blue-green of the river
		pigment: "#2c727c",
		view: { yaw: -5, pitch: -18, zoom: 0.76 },
		// down out of the cloud, to the bridge
		entrance: { yaw: -8, pitch: 24, dolly: 0.8, seconds: 6 },
		hotspots: [
			{
				id: "shower",
				yaw: 14,
				pitch: 3,
				title: "Two kinds of rain",
				text: "In the print the rain is cut into the woodblocks as fine lines at two slightly different angles. Here it falls live, in the same two directions.",
			},
			{
				id: "raft",
				yaw: -18,
				pitch: -13.5,
				title: "The raftsman",
				text: "A lone figure poles a raft of logs downstream, ignoring the downpour that sends everyone on the bridge running.",
			},
			{
				id: "atake",
				yaw: 4,
				pitch: -2,
				title: "Atake",
				text: "The far bank took its name from the Atake-maru, a huge government warship once moored there. In the rain it is reduced to a dark band of trees.",
			},
		],
		act: {
			run: "Let them run",
			stop: "Stop them",
			hint: "Look at someone and they run. Press and hold: everyone does.",
			caught: "",
		},
		effects: {
			water: { height: 22, strength: 0.16, scale: 0.4, speed: 0.6 },
			rain: { density: 0.9, angle: 4, speed: 1.0 },
			grade: { vignette: 0.3, grain: 0.04 },
			depth: { amount: 0.16, curve: 1 },
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
			"You stand on a small wooden landing at the edge of a pond. There is no sky: dark foliage, russet and green, closes overhead and all round. Just ahead a footbridge, blue-green and almost black in its own shade, arches from one side of the view to the other. Turquoise and violet pads crowd the water in front of it, with russet water between them; beyond the bridge lies a band of pale blossom. Yellow-green streamers of willow hang through the dark, a pale flowering tree leans in on the right, and reeds hook over from the bank on the left. Behind you a path of reddish earth curves between beds of flowers. Everything is made of separate strokes of paint.",
		// viridian, the green of the bridge
		pigment: "#2c6b55",
		view: { yaw: 3, pitch: -2 },
		// across the lilies, up to the bridge
		entrance: { yaw: 10, pitch: -16, dolly: 1.0, seconds: 6 },
		hotspots: [
			{
				id: "bridge",
				yaw: 17,
				pitch: 15,
				title: "The Japanese bridge",
				text: "Monet had this footbridge built over his pond in the 1890s, inspired by the Japanese prints he collected. Painted green, it became one of his favourite subjects.",
			},
			{
				id: "lilies",
				yaw: 12,
				pitch: -25,
				title: "Water lilies",
				text: "Monet planted hardy water lilies in several colours. Over the last decades of his life he painted them again and again, until the pond filled entire walls.",
			},
			{
				id: "willows",
				yaw: -5,
				pitch: 24,
				title: "Weeping willows",
				text: "Willows at the water's edge frame the pond and double in its reflections, so it becomes hard to tell where the bank ends and the water begins.",
			},
		],
		act: {
			run: "Hold your breath",
			stop: "Breathe",
			hint: "Keep still, and the water clears.",
			caught: "",
		},
		effects: {
			water: { height: 1.75, strength: 0.19, scale: 0.8, speed: 0.32 },
			grade: { vignette: 0.28, grain: 0.03 },
			depth: { amount: 1, curve: 0.7 },
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
			"You sit in a small rowing boat on a broad, calm river, on a night that is nowhere near dark. Ahead and a little to the left a full moon hangs high in a tunnel of cream and blue cloud, and its light falls in a pale column to the water and runs over it to your bow. On the left a tall ship under grey sails passes close, with others fading into blue haze behind it; a buoy and a cask float nearby. On the right colliers crowd together in brown smoke, and by the glare of braziers keelmen heave coal up out of their low boats; the firelight lies in long streaks on the river. A man sits on a raft of timber between you and them. Behind you the river opens under a deep blue sky, with ships at anchor like ghosts. Everything is made of strokes of paint, most of them read off the canvas itself.",
		// the white gold around the moon
		pigment: "#f2d596",
		view: { yaw: 0, pitch: 4 },
		// from the firelight on the water, round to the moon
		entrance: { yaw: 14, pitch: -10, dolly: 0.8, seconds: 6 },
		hotspots: [
			{
				id: "moon",
				yaw: -10,
				pitch: 26.5,
				title: "A tunnel of light",
				text: "Turner makes the moon the centre of a vortex of luminous cloud. Light itself, rather than the ships or the workers, is the real subject of the picture.",
			},
			{
				id: "keelmen",
				yaw: 37,
				pitch: 3.5,
				title: "Keelmen at work",
				text: "By the light of braziers, keelmen shovel coal from their flat-bottomed keels up into the holds of seagoing colliers, working through the night.",
			},
			{
				id: "ships",
				yaw: -37,
				pitch: 13,
				title: "Ships at anchor",
				text: "Tall sailing ships wait for their cargo. Coal from the Tyne was shipped down the coast to London and far beyond.",
			},
		],
		act: {
			run: "Let them work",
			stop: "Let them rest",
			hint: "Look at the fires, then at the moon.",
			caught: "",
		},
		effects: {
			water: { height: 1.5, strength: 0.16, scale: 0.7, speed: 0.4 },
			sky: { shimmer: 0.12 },
			seam: true,
			flicker: { strength: 0.35 },
			grade: { vignette: 0.32, grain: 0.035 },
			boat: { pitch: 0.5, roll: 0.9, period: 9 },
			depth: { amount: 0.6, curve: 0.6 },
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
