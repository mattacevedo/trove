export function MessageBubble({
  role,
  content,
}: {
  role: "user" | "assistant";
  content: string;
}) {
  const isUser = role === "user";
  return (
    <div
      role="article"
      className={
        isUser
          ? "ml-auto max-w-[80%] rounded-lg bg-primary px-3 py-2 text-white"
          : "mr-auto max-w-[80%] rounded-lg border border-foreground/15 bg-white px-3 py-2"
      }
    >
      <span className="sr-only">{isUser ? "You said:" : "Advisor said:"}</span>
      {content}
    </div>
  );
}
