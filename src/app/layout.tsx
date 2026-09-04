import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Claude Key Pool",
  description: "Local proxy and automatic API key pool rotator for Claude CLI",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full bg-canvas text-body" suppressHydrationWarning>{children}</body>
    </html>
  );
}
