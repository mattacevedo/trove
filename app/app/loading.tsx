export default function WalletLoading() {
  return (
    <div>
      <div className="mb-6 h-8 w-40 animate-pulse rounded bg-foreground/10" />
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <li
            key={i}
            className="h-32 animate-pulse rounded-lg border border-foreground/10 bg-foreground/5"
          />
        ))}
      </ul>
    </div>
  );
}
