import type { Metadata } from 'next';
import { JetBrains_Mono, VT323 } from 'next/font/google';
import './globals.css';

const mono = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-mono' });
const display = VT323({ subsets: ['latin'], weight: '400', variable: '--font-display' });

export const metadata: Metadata = {
  title: 'Unveil',
  description: 'Reveal who you are to one party, under an NDA backed by a deposit on Stellar.',
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='13' r='7' fill='%2339ff6a'/%3E%3Cpath d='M12 18h8l2 11H10z' fill='%2339ff6a'/%3E%3C/svg%3E",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${mono.variable} ${display.variable}`}>
      <body>{children}</body>
    </html>
  );
}
