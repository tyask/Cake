import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hello Next.js",
  description: "Vercel にデプロイできるシンプルな Next.js サンプルアプリ",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
