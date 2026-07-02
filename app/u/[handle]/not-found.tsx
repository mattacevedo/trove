export default function ProfileNotFound() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-lg flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="font-heading text-2xl font-bold">Profile not found</h1>
      <p className="text-foreground/70">
        This profile does not exist or has not been published.
      </p>
    </div>
  );
}
