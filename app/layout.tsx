import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "KEYWAVE — ブラウザ・ピアノ",
  description: "キーボードで演奏・録音できる、あなたのためのブラウザ楽器。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ja"><body>{children}</body></html>;
}
