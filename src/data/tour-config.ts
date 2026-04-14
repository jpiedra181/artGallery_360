/**
 * ═══════════════════════════════════════════════════════════════
 *  CONFIGURACIÓN DEL TOUR VIRTUAL — GALERÍA SERENA
 * ═══════════════════════════════════════════════════════════════
 *
 *  Este es el ÚNICO archivo que necesitas editar para personalizar
 *  tu tour virtual. Aquí defines:
 *
 *    • Branding (nombre, logo, contacto)
 *    • Plano de la galería
 *    • Salas (nodos panorámicos)
 *    • Enlaces entre salas
 *    • Hotspots de información y lightbox
 *
 *  Tras editar, ejecuta `npm run build` para regenerar el tour.
 * ═══════════════════════════════════════════════════════════════
 */

export interface MarkerInfo {
  id: string;
  type: "info";
  position: { yaw: string; pitch: string };
  tooltip: string;
  title: string;
  description: string;
}

export interface MarkerLightbox {
  id: string;
  type: "lightbox";
  position: { yaw: string; pitch: string };
  tooltip: string;
  lightboxSrc: string;
  lightboxCaption: string;
}

export type TourMarker = MarkerInfo | MarkerLightbox;

export interface NodeLink {
  nodeId: string;
  position: { yaw: string; pitch: string };
  label: string;
}

export interface TourNode {
  id: string;
  name: string;
  panorama: string;
  thumbnail: string;
  floorplanPosition: { left: string; top: string };
  links: NodeLink[];
  markers: TourMarker[];
}

export interface TourConfig {
  brand: {
    name: string;
    logo: string;
    tagline: string;
    contact: {
      phone: string;
      email: string;
      website: string;
    };
  };
  floorplan: {
    image: string;
    position: string;
  };
  nodes: TourNode[];
}

export const tourConfig: TourConfig = {
  // ─── Branding ────────────────────────────────────────────────
  brand: {
    name: "Galería Serena",
    logo: "/images/logo.svg",
    tagline: "Exposición permanente",
    contact: {
      phone: "+34 921 000 000",
      email: "info@galeriaserena.es",
      website: "https://galeriaserena.es",
    },
  },

  // ─── Plano de la galería ─────────────────────────────────────
  floorplan: {
    image: "/images/floorplan.svg",
    position: "bottom-left",
  },

  // ─── Nodos (salas panorámicas) ───────────────────────────────
  nodes: [
    // ── Sala de Esculturas ──────────────────────────────────────
    {
      id: "sala-esculturas",
      name: "Sala de Esculturas",
      panorama: "/images/panoramas/sculpture_exhibition_4k.jpg",
      thumbnail: "/images/thumbnails/sculpture_exhibition_4k.jpg",
      floorplanPosition: { left: "27%", top: "50%" },
      links: [
        {
          nodeId: "sala-pinturas",
          position: { yaw: "120deg", pitch: "-5deg" },
          label: "Sala de Pinturas →",
        },
      ],
      markers: [
        {
          id: "escultura-1",
          type: "info",
          position: { yaw: "45deg", pitch: "-3deg" },
          tooltip: "Venus de Milo — Réplica",
          title: "Venus de Milo",
          description:
            "<p>Réplica fiel de la célebre escultura griega del siglo II a.C., tallada en mármol de Carrara por artesanos italianos siguiendo las técnicas clásicas de esculpido.</p><p><strong>Artista:</strong> Alexandros de Antioquía (original, c. 130-100 a.C.)</p><p><strong>Material:</strong> Mármol de Carrara</p><p><strong>Dimensiones:</strong> 204 × 36 × 65 cm</p><p><strong>Procedencia:</strong> Taller Borghese, Roma</p>",
        },
        {
          id: "escultura-2",
          type: "lightbox",
          position: { yaw: "-30deg", pitch: "0deg" },
          tooltip: "El Pensador — Detalle",
          lightboxSrc: "/images/obras/pensador-detalle.jpg",
          lightboxCaption:
            "Auguste Rodin — El Pensador, 1904. Bronce patinado, 180 × 98 × 145 cm. Detalle del rostro y mano derecha.",
        },
        {
          id: "escultura-3",
          type: "info",
          position: { yaw: "160deg", pitch: "5deg" },
          tooltip: "Forma Emergente III",
          title: "Forma Emergente III",
          description:
            "<p>Escultura abstracta en acero corten que explora la tensión entre lo orgánico y lo industrial. La superficie oxidada contrasta con los cortes geométricos interiores pulidos a espejo.</p><p><strong>Artista:</strong> Eduardo Chillida (homenaje)</p><p><strong>Año:</strong> 2023</p><p><strong>Material:</strong> Acero corten y acero inoxidable</p><p><strong>Dimensiones:</strong> 95 × 60 × 45 cm</p><p><strong>Peso:</strong> 120 kg</p>",
        },
        {
          id: "escultura-4",
          type: "lightbox",
          position: { yaw: "-120deg", pitch: "-2deg" },
          tooltip: "Equilibrio Suspendido — Ver en detalle",
          lightboxSrc: "/images/obras/equilibrio-suspendido.jpg",
          lightboxCaption:
            "Laura Fernández — Equilibrio Suspendido, 2024. Bronce y cable de acero, 150 × 40 × 40 cm. Pieza cinética que rota con las corrientes de aire.",
        },
        {
          id: "escultura-5",
          type: "info",
          position: { yaw: "85deg", pitch: "8deg" },
          tooltip: "Fragmento Clásico #12",
          title: "Fragmento Clásico #12",
          description:
            "<p>Serie de torsos fragmentados que dialogan con la tradición escultórica grecorromana. Cada pieza presenta deliberadamente roturas y ausencias que invitan a la reflexión sobre la memoria y el paso del tiempo.</p><p><strong>Artista:</strong> Igor Mitoraj</p><p><strong>Año:</strong> 2019</p><p><strong>Material:</strong> Resina y polvo de mármol</p><p><strong>Dimensiones:</strong> 78 × 35 × 28 cm</p>",
        },
      ],
    },

    // ── Sala de Pinturas ────────────────────────────────────────
    {
      id: "sala-pinturas",
      name: "Sala de Pinturas",
      panorama: "/images/panoramas/artist_workshop_4k.jpg",
      thumbnail: "/images/thumbnails/artist_workshop_4k.jpg",
      floorplanPosition: { left: "73%", top: "50%" },
      links: [
        {
          nodeId: "sala-esculturas",
          position: { yaw: "-60deg", pitch: "-5deg" },
          label: "← Sala de Esculturas",
        },
      ],
      markers: [
        {
          id: "pintura-1",
          type: "info",
          position: { yaw: "20deg", pitch: "5deg" },
          tooltip: "Abstracción Geométrica #7",
          title: "Abstracción Geométrica #7",
          description:
            "<p>Óleo sobre lienzo de gran formato. Parte de la serie <em>Geometrías Urbanas</em> que explora la intersección entre arquitectura contemporánea y campos de color vibrante. Las formas triangulares y rectangulares evocan fachadas de cristal al atardecer.</p><p><strong>Artista:</strong> Ana Martínez</p><p><strong>Año:</strong> 2024</p><p><strong>Técnica:</strong> Óleo sobre lienzo</p><p><strong>Dimensiones:</strong> 120 × 80 cm</p><p><strong>Serie:</strong> Geometrías Urbanas (7/12)</p>",
        },
        {
          id: "pintura-2",
          type: "lightbox",
          position: { yaw: "90deg", pitch: "0deg" },
          tooltip: "Paisaje Onírico — Ver en detalle",
          lightboxSrc: "/images/obras/paisaje-onirico.jpg",
          lightboxCaption:
            "Carlos Ruiz — Paisaje Onírico, 2023. Acrílico sobre lienzo, 150 × 200 cm. Inspirado en los paisajes del Pirineo aragonés al amanecer.",
        },
        {
          id: "pintura-3",
          type: "lightbox",
          position: { yaw: "-45deg", pitch: "3deg" },
          tooltip: "Retrato en Azul — Ver en detalle",
          lightboxSrc: "/images/obras/retrato-azul.jpg",
          lightboxCaption:
            "María López — Retrato en Azul, 2024. Técnica mixta sobre lienzo, 90 × 70 cm. Período azul de la artista, influencia de la nueva figuración española.",
        },
        {
          id: "pintura-4",
          type: "info",
          position: { yaw: "-110deg", pitch: "2deg" },
          tooltip: "Naturaleza Muerta Contemporánea",
          title: "Naturaleza Muerta Contemporánea",
          description:
            "<p>Reinterpretación del bodegón clásico español con objetos cotidianos del siglo XXI: un smartphone, auriculares inalámbricos y una taza de café de diseño, dispuestos sobre un paño de terciopelo granate siguiendo la composición de Zurbarán.</p><p><strong>Artista:</strong> Pablo Sánchez-Blanco</p><p><strong>Año:</strong> 2024</p><p><strong>Técnica:</strong> Óleo sobre tabla</p><p><strong>Dimensiones:</strong> 65 × 90 cm</p>",
        },
        {
          id: "pintura-5",
          type: "lightbox",
          position: { yaw: "155deg", pitch: "4deg" },
          tooltip: "Composición en Rojo y Negro — Ver en detalle",
          lightboxSrc: "/images/obras/composicion-rojo-negro.jpg",
          lightboxCaption:
            "Elena Torres — Composición en Rojo y Negro, 2023. Acrílico y tinta china sobre lienzo, 180 × 140 cm. Expresionismo abstracto contemporáneo.",
        },
        {
          id: "pintura-6",
          type: "info",
          position: { yaw: "50deg", pitch: "-4deg" },
          tooltip: "Ventana al Mediterráneo",
          title: "Ventana al Mediterráneo",
          description:
            "<p>Luminoso paisaje que captura la luz del Mediterráneo a través de una ventana abierta con contraventanas de madera azul. La paleta cálida de ocres, blancos y azules evoca la tradición impresionista adaptada al paisaje levantino.</p><p><strong>Artista:</strong> Joaquín Sorolla (homenaje por Lucía Herrera)</p><p><strong>Año:</strong> 2024</p><p><strong>Técnica:</strong> Óleo sobre lienzo</p><p><strong>Dimensiones:</strong> 100 × 130 cm</p>",
        },
      ],
    },
  ],
};
