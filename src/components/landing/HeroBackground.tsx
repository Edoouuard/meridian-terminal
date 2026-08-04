import { HERO_BACKGROUND_IMAGE } from "@/lib/heroArt";

/**
 * A calm hero section: the photo sits behind a dark scrim as a plain CSS fixed background
 * (a gentle parallax as the page scrolls past it, no JS). Text and the CTA are the point,
 * not the image, so nothing here fades, scales, or otherwise competes for attention.
 */
export function HeroBackground({ children }: { children: React.ReactNode }) {
  return (
    <section className="hero-simple">
      <div className="hero-simple-bg" style={{ backgroundImage: `url(${HERO_BACKGROUND_IMAGE})` }} aria-hidden="true" />
      <div className="hero-simple-scrim" aria-hidden="true" />
      <div className="hero-simple-content">{children}</div>
    </section>
  );
}
