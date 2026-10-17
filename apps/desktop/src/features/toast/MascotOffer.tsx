/**
 * M6 one-time suggestion: the first time an agent starts working while the mascot is off and was
 * never offered, a small card (same floating card as `UpdatePrompt`) offers to turn it on. Either
 * button stores `buddy.mascotOffered`, so it never comes back.
 */
import { useStrings } from "../../app/strings";
import { Button } from "../../app/ui/Button";
import { useMascotSettingsStore } from "../settings/mascotSettings";
import { useUpdateStore } from "../update/updateStore";
import { platformFeatures } from "../../lib/platform";

export function MascotOffer() {
  const s = useStrings().mascot;
  const visible = useMascotSettingsStore((st) => st.offerVisible);
  const answer = useMascotSettingsStore((st) => st.answerOffer);
  // The update card sits in the same spot and wins; the suggestion waits until it is gone.
  const updatePrompt = useUpdateStore((st) => st.prompt);
  if (!visible || updatePrompt || !platformFeatures().mascot) return null;

  return (
    <section
      role="region"
      aria-label={s.offerLabel}
      data-testid="mascot-offer"
      className="fixed bottom-9 right-3 z-[90] flex w-[340px] animate-rise flex-col gap-3 rounded-panel border border-border bg-surface-4 p-4 text-ui text-text shadow-float"
    >
      <p className="m-0 text-body text-text-2">{s.offerText}</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => void answer(false)}>
          {s.offerDismiss}
        </Button>
        <Button variant="primary" onClick={() => void answer(true)}>
          {s.offerTurnOn}
        </Button>
      </div>
    </section>
  );
}
