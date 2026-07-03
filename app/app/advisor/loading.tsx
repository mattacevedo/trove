export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-5xl p-4" role="status" aria-live="polite">
      <span className="sr-only">Loading advisor…</span>
      <div className="h-8 w-40 animate-pulse rounded bg-foreground/10" />
      <div className="mt-4 h-32 w-full animate-pulse rounded bg-foreground/5" />
    </div>
  );
}
