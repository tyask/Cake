import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

const roundedFont = localFont({
  src: [
    { path: "../public/fonts/m-plus-rounded-1c/m-plus-rounded-1c-400.woff2", weight: "400", style: "normal" },
    { path: "../public/fonts/m-plus-rounded-1c/m-plus-rounded-1c-500.woff2", weight: "500", style: "normal" },
    { path: "../public/fonts/m-plus-rounded-1c/m-plus-rounded-1c-700.woff2", weight: "700", style: "normal" },
    { path: "../public/fonts/m-plus-rounded-1c/m-plus-rounded-1c-800.woff2", weight: "800", style: "normal" },
    { path: "../public/fonts/m-plus-rounded-1c/m-plus-rounded-1c-900.woff2", weight: "900", style: "normal" },
  ],
  variable: "--font-cake",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

export const metadata: Metadata = {
  title: "Cake",
  description: "個人とふたりの家計を、ひとつの場所で管理するアプリ",
  icons: {
    icon: [
      { url: "/brand/cake-geometric-icon.svg", type: "image/svg+xml", sizes: "any" },
      { url: "/brand/cake-icon-32.png", type: "image/png", sizes: "32x32" },
    ],
    apple: [{ url: "/brand/cake-apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#FACC15",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body className={roundedFont.variable}>{children}</body>
    </html>
  );
}
