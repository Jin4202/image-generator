import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "AI Art Direction Studio",
  description: "참조, 구도, 생성 이력을 보존하는 로컬 이미지 작업실",
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="ko"><body>{children}</body></html>;
}
