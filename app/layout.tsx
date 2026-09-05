import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'ai3drender — furniture photos to exhibition renders',
  description:
    'Turn furniture photographs into specified, versioned 3D assets and stage them in ' +
    'photorealistic exhibition environments.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-shell-950 text-shell-100">{children}</body>
    </html>
  );
}
