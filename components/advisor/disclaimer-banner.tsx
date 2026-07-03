/** Persistent, non-dismissible guidance-not-guarantee banner (design doc §6 safety). Rendered
 *  independent of model output so a confused/jailbroken reply can never suppress it. */
export function DisclaimerBanner() {
  return (
    <p
      role="note"
      className="rounded-md border border-[var(--color-unverified)] bg-[var(--color-unverified)]/5 px-3 py-2 text-sm text-foreground"
    >
      Trove&apos;s advisor gives guidance based on your credentials — not a guarantee of jobs,
      admission, or financial aid.
    </p>
  );
}
