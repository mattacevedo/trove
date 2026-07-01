import type { Metadata } from "next";
import { lexend, sourceSans } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trove",
  description:
    "Your credentials, verified — with an AI advisor for your next opportunity.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${lexend.variable} ${sourceSans.variable}`}>
      <body className="font-body antialiased">{children}</body>
    </html>
  );
}
