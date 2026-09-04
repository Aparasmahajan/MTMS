import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Prod Tracker — Flow One',
  description: 'Getting change activities into production: modules, deliverables and who changed what.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Barlow / Barlow Condensed with a real fallback stack in globals.css, so the
            app still reads correctly if the font host is unreachable. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;700&family=Barlow+Condensed:wght@400;600&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
