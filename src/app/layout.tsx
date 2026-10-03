import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Roundtable — every phone hears the room",
  description: "Live, speaker-aware captions shaped by the phones around the table.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
