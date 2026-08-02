import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cake — ふたりの家計管理",
  description: "個人とふたりの家計を、ひとつの場所で管理するアプリ",
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
