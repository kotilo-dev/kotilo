/**
 * Placeholder for a route whose screen lands in a later M2 wave. Uses the screen title style
 * (DESIGN_SYSTEM §3: 26px / 700 / -0.02em).
 */
import { useStrings } from "./i18n";

export function PlaceholderPage({ title }: { title: string }) {
  const s = useStrings();
  return (
    <section className="flex h-full flex-col gap-2 overflow-auto bg-bg px-8 py-7" aria-labelledby="page-title">
      <h1 id="page-title" className="m-0 text-display font-bold leading-[1.2] tracking-[-0.02em] text-text">
        {title}
      </h1>
      <p className="m-0 text-muted">{s.placeholder.comingSoon}</p>
    </section>
  );
}
