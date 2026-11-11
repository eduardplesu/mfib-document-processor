import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MFIB Document Processor",
  description: "Procesare securizată de documente și extragere OCR"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ro"><body>{children}</body></html>;
}
