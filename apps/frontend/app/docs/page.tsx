import type { Metadata } from 'next';
import { Docs } from '@/components/docs/Docs';

export const metadata: Metadata = {
  title: 'Docs · Unveil',
  description: 'Integrate Unveil into your Stellar app with unveil-sdk: encrypted photos, on-chain NDAs, deposits and watermarked viewing.',
};

export default function DocsPage() {
  return <Docs />;
}
